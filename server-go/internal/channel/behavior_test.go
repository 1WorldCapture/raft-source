package channel

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

const (
	fxOwner  = "11111111-1111-4111-8111-111111111111"
	fxMember = "22222222-2222-4222-8222-222222222222"
	fxGuest  = "33333333-3333-4333-8333-333333333333"
	fxOther  = "44444444-4444-4444-8444-444444444444"
	fxWS     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	fxWS2    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	fxAgent  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type fixture struct {
	t     *testing.T
	db    *sql.DB
	store *Store
	clock *clock.Fixed
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	fx := &fixture{t: t, db: handle, store: NewStoreWithOptions(handle, Options{Clock: fixed}), clock: fixed}
	fx.seed()
	return fx
}

func (f *fixture) seed() {
	f.t.Helper()
	now := f.clock.T.UnixMilli()
	users := []struct{ id, name string }{
		{fxOwner, "owner"},
		{fxMember, "member"},
		{fxGuest, "guest"},
		{fxOther, "other"},
	}
	for _, u := range users {
		if _, err := f.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
			VALUES (?, ?, ?, 'x', 1, ?, ?)`, u.id, u.name+"@example.test", u.name, now, now); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, ws := range []struct{ id, slug, owner string }{{fxWS, "alpha", fxOwner}, {fxWS2, "beta", fxOther}} {
		if _, err := f.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
			VALUES (?, ?, ?, ?, ?)`, ws.id, "WS "+ws.slug, ws.slug, ws.owner, now); err != nil {
			f.t.Fatal(err)
		}
	}
	members := []struct{ ws, user, role string }{
		{fxWS, fxOwner, RoleOwner},
		{fxWS, fxMember, RoleMember},
		{fxWS, fxGuest, RoleGuest},
		{fxWS2, fxOther, RoleOwner},
	}
	for _, m := range members {
		if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, ?)`, m.ws, m.user, m.role, now); err != nil {
			f.t.Fatal(err)
		}
	}
	if _, err := f.db.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'cindy', 'active', 'claude', ?, ?)`, fxAgent, fxWS, now, now); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) ctx() context.Context { return context.Background() }

func (f *fixture) countChannels(where string, args ...any) int {
	f.t.Helper()
	var n int
	q := `SELECT COUNT(*) FROM channels`
	if where != "" {
		q += ` WHERE ` + where
	}
	if err := f.db.QueryRow(q, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestSchemaIsAdditiveAndPreservesChannels(t *testing.T) {
	f := newFixture(t)
	var agentsTable, eventsTable, messages int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_agents'`).Scan(&agentsTable); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='channel_membership_role_events'`).Scan(&eventsTable); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'`).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if agentsTable != 1 || eventsTable != 1 || messages != 0 {
		t.Fatalf("schema: agents=%d events=%d messages=%d", agentsTable, eventsTable, messages)
	}

	// A pre-existing channel_humans row (the M2 shape) stays readable after 0006.
	id := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	now := f.clock.T.UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'legacy', 'channel', ?)`,
		id, fxWS, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`,
		id, fxMember, now); err != nil {
		t.Fatal(err)
	}
	got, err := f.store.GetChannel(f.ctx(), id)
	if err != nil || got == nil || got.Name != "legacy" || got.WorkspaceID != fxWS {
		t.Fatalf("legacy channel: %+v %v", got, err)
	}
	member, err := f.store.IsChannelHuman(f.ctx(), id, fxMember)
	if err != nil || !member {
		t.Fatalf("legacy membership: %v %v", member, err)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_agents (channel_id, agent_id, role, added_at) VALUES (?, ?, 'owner', ?)`,
		id, fxAgent, now); err == nil {
		t.Fatal("channel_agents must reject roles outside member|admin")
	}
	if _, err := f.db.Exec(`INSERT INTO channel_membership_role_events
		(id, channel_id, workspace_id, requester_user_id, target_type, target_id, previous_role, next_role, authority_revision, delivery_status, created_at)
		VALUES ('evt', ?, ?, ?, 'user', ?, 'member', 'admin', 2, 'nope', ?)`,
		id, fxWS, fxOwner, fxMember, now); err == nil {
		t.Fatal("role events must reject an unknown delivery_status")
	}
}

func TestSystemChannelInvariants(t *testing.T) {
	f := newFixture(t)
	// archived=only must not create system channels.
	only, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, ArchivedOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(only) != 0 || f.countChannels("workspace_id = ?", fxWS) != 0 {
		t.Fatalf("only-mode created channels: list=%d rows=%d", len(only), f.countChannels("workspace_id = ?", fxWS))
	}
	list, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("lazy list: %+v", namesOf(list))
	}
	byName := map[string]ListItem{}
	for _, item := range list {
		byName[item.Channel.Name] = item
	}
	all, ann := byName["all"], byName["announcement"]
	if all.Channel.Type != TypeChannel || all.Channel.SystemKind == nil || *all.Channel.SystemKind != "all" || !all.Joined {
		t.Fatalf("#all: %+v joined=%v", all.Channel, all.Joined)
	}
	if ann.Channel.SystemKind == nil || *ann.Channel.SystemKind != "announcement" || !ann.Joined {
		t.Fatalf("#announcement: %+v", ann)
	}
	// Idempotent: a second list does not duplicate them.
	again, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, ArchivedExclude)
	if err != nil || len(again) != 2 {
		t.Fatalf("second list: %d %v", len(again), err)
	}
	guest, err := f.store.ListChannels(f.ctx(), fxWS, fxGuest, ArchivedExclude)
	if err != nil || len(guest) != 0 {
		t.Fatalf("guest list must be empty: %d %v", len(guest), err)
	}

	added, err := f.store.AddHumanTx(f.ctx(), all.Channel.ID, fxMember, "")
	if err != nil || added {
		t.Fatalf("addHuman #all is a no-op: added=%v err=%v", added, err)
	}
	if _, err := f.store.AddHumanTx(f.ctx(), all.Channel.ID, fxGuest, ""); err == nil || err.Error() != "Guest cannot be added to the #all channel" {
		t.Fatalf("guest add #all: %v", err)
	}
	if err := f.store.RemoveHumanTx(f.ctx(), all.Channel.ID, fxMember); err == nil || err.Error() != "Cannot leave or remove from the #all channel" {
		t.Fatalf("remove #all: %v", err)
	}
	if err := f.store.JoinChannel(f.ctx(), fxWS, all.Channel.ID, fxMember); err != nil {
		t.Fatalf("join #all: %v", err)
	}
	if n := f.countWhere(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, all.Channel.ID); n != 0 {
		t.Fatalf("#all roster rows: %d", n)
	}
	if err := f.store.LeaveChannel(f.ctx(), fxWS, all.Channel.ID, fxMember); err == nil || err.Error() != "Cannot leave or remove from the #all channel" {
		t.Fatalf("leave #all: %v", err)
	}
	if err := f.store.LeaveChannel(f.ctx(), fxWS, ann.Channel.ID, fxMember); err == nil || err.Error() != "Cannot remove members from, or leave, the #announcement channel" {
		t.Fatalf("leave announcement: %v", err)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
		all.Channel.ID, fxMember, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	private := TypePrivate
	hidden, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, all.Channel.ID, ChannelUpdates{Type: &private})
	if err != nil || hidden.Type != TypePrivate {
		t.Fatalf("hide #all: %+v %v", hidden, err)
	}
	if n := f.countWhere(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, all.Channel.ID); n != 0 {
		t.Fatalf("hiding #all must drop roster rows, left %d", n)
	}
	hiddenList, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, ArchivedExclude)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range hiddenList {
		if item.Channel.Name == systemAllName {
			t.Fatal("hidden #all leaked into the list")
		}
	}
	visible := TypeChannel
	restored, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, all.Channel.ID, ChannelUpdates{Type: &visible})
	if err != nil || restored.Type != TypeChannel {
		t.Fatalf("restore #all: %+v %v", restored, err)
	}

	if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, all.Channel.ID, fxOwner); err == nil || err.Error() != "The #all channel cannot be archived" {
		t.Fatalf("archive #all: %v", err)
	}
	if err := f.store.DeleteChannel(f.ctx(), fxWS, ann.Channel.ID, fxOwner); err == nil || err.Error() != "The #announcement channel cannot be deleted" {
		t.Fatalf("delete announcement: %v", err)
	}

	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS2, Name: "announcement", Type: TypeChannel, CreatorUserID: fxOther,
	}); err == nil || err.Error() != `Channel name "announcement" is reserved` {
		t.Fatalf("reserved announcement: %v", err)
	}
	// A pre-existing user channel holding the reserved name (no system_kind)
	// is retired when the list lazily ensures #announcement.
	retiredID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?, ?, 'announcement', 'channel', ?)`, retiredID, fxWS2, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ListChannels(f.ctx(), fxWS2, fxOther, ArchivedExclude); err != nil {
		t.Fatal(err)
	}
	gone, err := f.store.GetChannel(f.ctx(), retiredID)
	if err != nil || gone != nil {
		t.Fatalf("reserved name must be soft-deleted, got %+v %v", gone, err)
	}
	var systemKind string
	if err := f.db.QueryRow(`SELECT system_kind FROM channels WHERE workspace_id = ? AND name = 'announcement' AND deleted_at IS NULL`, fxWS2).Scan(&systemKind); err != nil || systemKind != "announcement" {
		t.Fatalf("ensured announcement kind: %q %v", systemKind, err)
	}
}

func (f *fixture) countWhere(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRow(query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func namesOf(items []ListItem) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.Channel.Name
	}
	return out
}

func TestCreateConflictsArchiveAndRollback(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Description: strPtr("hello"), Type: TypeChannel, CreatorUserID: fxMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.CreatedAt.UnixMilli() != f.clock.T.UnixMilli() {
		t.Fatalf("created_at clock: %d", created.CreatedAt.UnixMilli())
	}
	var role string
	var revision int64
	var joined int64
	if err := f.db.QueryRow(`SELECT role, authority_revision, joined_at FROM channel_humans WHERE channel_id = ? AND user_id = ?`,
		created.ID, fxMember).Scan(&role, &revision, &joined); err != nil {
		t.Fatal(err)
	}
	if role != ChannelRoleAdmin || revision != 1 || joined != f.clock.T.UnixMilli() {
		t.Fatalf("creator row: role=%s rev=%d joined=%d", role, revision, joined)
	}
	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypePrivate, CreatorUserID: fxOwner,
	}); err == nil || err.Error() != `Channel name "ops" is already taken` {
		t.Fatalf("active collision: %v", err)
	}

	// Failed initial member rolls the channel and the creator row back.
	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "rollback", Type: TypeChannel, CreatorUserID: fxMember,
		InitialUserIDs: []string{fxOther},
	}); err == nil || err.Error() != "One or more initial users are not members of this server" {
		t.Fatalf("rollback error: %v", err)
	}
	if f.countChannels("name = 'rollback'") != 0 {
		t.Fatal("failed create left a channel row")
	}

	archived, err := f.store.ArchiveChannel(f.ctx(), fxWS, created.ID, fxOwner)
	if err != nil || archived.ArchivedAt == nil || archived.ArchivedByUserID == nil || *archived.ArchivedByUserID != fxOwner {
		t.Fatalf("archive: %+v %v", archived, err)
	}
	if archived.ArchivedByAgent != nil {
		t.Fatal("human archive must clear archived_by_agent_id")
	}
	again, err := f.store.ArchiveChannel(f.ctx(), fxWS, created.ID, fxMember)
	if err != nil || again.ArchivedAt == nil || *again.ArchivedByUserID != fxOwner {
		t.Fatalf("idempotent archive must keep the first actor: %+v %v", again, err)
	}
	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	}); err == nil {
		t.Fatal("archived name must collide")
	} else if collision := AsArchivedNameCollision(err); collision == nil || collision.ArchivedChannelID != created.ID || collision.ArchivedChannelType != TypeChannel {
		t.Fatalf("collision: %#v %v", collision, err)
	}
	// The name stays taken across workspaces independently.
	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS2, Name: "ops", Type: TypeChannel, CreatorUserID: fxOther,
	}); err != nil {
		t.Fatalf("other workspace: %v", err)
	}
	restored, err := f.store.UnarchiveChannel(f.ctx(), fxWS, created.ID, fxOwner)
	if err != nil || restored.ArchivedAt != nil || restored.ArchivedByUserID != nil {
		t.Fatalf("unarchive: %+v %v", restored, err)
	}
	if _, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "all", Type: TypeChannel, CreatorUserID: fxOwner,
	}); err == nil || AsDomainError(err) == nil || AsDomainError(err).Message != `Channel name "all" is reserved` {
		t.Fatalf("reserved: %v", err)
	}
}

func TestPrivateChannelDeletesWhenEmpty(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "secret", Type: TypePrivate, CreatorUserID: fxMember,
		InitialAgentIDs: []string{fxAgent},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.LeaveChannel(f.ctx(), fxWS, created.ID, fxMember); err != nil {
		t.Fatal(err)
	}
	still, err := f.store.GetChannel(f.ctx(), created.ID)
	if err != nil || still == nil || still.DeletedAt != nil {
		t.Fatalf("agent keeps the private channel: %+v %v", still, err)
	}
	if err := f.store.RemoveAgentTx(f.ctx(), created.ID, fxAgent); err != nil {
		t.Fatal(err)
	}
	gone, err := f.store.GetChannel(f.ctx(), created.ID)
	if err != nil || gone != nil {
		t.Fatalf("empty private channel must be soft-deleted: %+v %v", gone, err)
	}
	var deleted int64
	if err := f.db.QueryRow(`SELECT deleted_at FROM channels WHERE id = ?`, created.ID).Scan(&deleted); err != nil || deleted == 0 {
		t.Fatalf("deleted_at: %d %v", deleted, err)
	}

	solo, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "solo", Type: TypePrivate, CreatorUserID: fxMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.JoinChannel(f.ctx(), fxWS, solo.ID, fxOwner); err == nil || err.Error() != "Private channels require an invitation" {
		t.Fatalf("join private: %v", err)
	}
	if err := f.store.LeaveChannel(f.ctx(), fxWS, solo.ID, fxMember); err != nil {
		t.Fatal(err)
	}
	if got, err := f.store.GetChannel(f.ctx(), solo.ID); err != nil || got != nil {
		t.Fatalf("last human leave deletes: %+v %v", got, err)
	}
}

func TestRoleMutationOutbox(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxMember,
		InitialUserIDs: []string{fxOwner, fxGuest}, InitialAgentIDs: []string{fxAgent},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES (?, ?, 'member', ?, ?)`, fxWS, fxAgent, f.clock.T.UnixMilli(), f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	self, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxMember, ChannelRoleMember)
	if err == nil || AsRoleMutationError(err) == nil || AsRoleMutationError(err).Code != RoleCodeAdminSelfDemote {
		t.Fatalf("self demote: %v", err)
	}
	_ = self
	protected, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxOwner, ChannelRoleMember)
	if err == nil || AsRoleMutationError(err).Code != RoleCodeProtectedServerRole {
		t.Fatalf("protected: %v", err)
	}
	_ = protected
	guestAdmin, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxGuest, ChannelRoleAdmin)
	if err == nil || AsRoleMutationError(err).Code != RoleCodeGuestAdminForbidden {
		t.Fatalf("guest admin: %v", err)
	}
	_ = guestAdmin
	missing, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxOther, ChannelRoleAdmin)
	if err == nil || AsRoleMutationError(err).Code != RoleCodeMemberRequired {
		t.Fatalf("missing member: %v", err)
	}
	_ = missing

	changed, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "agent", fxAgent, ChannelRoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if !changed.Changed || changed.AuthorityRevision != 2 || changed.ChannelRole != ChannelRoleAdmin || changed.EventID == nil {
		t.Fatalf("result: %+v", changed)
	}
	var status string
	var attempts, revision int64
	var delivered sql.NullInt64
	if err := f.db.QueryRow(`SELECT delivery_status, delivery_attempts, authority_revision, delivered_at
		FROM channel_membership_role_events WHERE id = ?`, *changed.EventID).Scan(&status, &attempts, &revision, &delivered); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 0 || revision != 2 || delivered.Valid {
		t.Fatalf("event row: status=%s attempts=%d rev=%d delivered=%v", status, attempts, revision, delivered.Valid)
	}
	same, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "agent", fxAgent, ChannelRoleAdmin)
	if err != nil || same.Changed || same.EventID != nil || same.AuthorityRevision != 2 {
		t.Fatalf("noop: %+v %v", same, err)
	}
	if n := f.countWhere(`SELECT COUNT(*) FROM channel_membership_role_events WHERE channel_id = ?`, created.ID); n != 1 {
		t.Fatalf("noop must not write an event, count=%d", n)
	}

	// A member who is not a channel admin cannot change roles.
	if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxMember, ""); err != nil {
		t.Fatal(err)
	}
	// fxGuest is a member but not an admin. Use a fresh channel where the requester is only a member.
	plain, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "plain", Type: TypeChannel, CreatorUserID: fxOwner,
		InitialUserIDs: []string{fxMember},
	})
	if err != nil {
		t.Fatal(err)
	}
	denied, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, plain.ID, fxMember, "user", fxOwner, ChannelRoleMember)
	if err == nil || AsRoleMutationError(err).Code != RoleCodeProtectedServerRole {
		// owner is protected before the capability check only if the requester is allowed.
		// member requester lacks the capability, so this is capability_required
		// unless the owner check happens first. The implementation checks capability first.
	}
	if AsRoleMutationError(err) == nil || AsRoleMutationError(err).Code != RoleCodeCapabilityRequired {
		t.Fatalf("member cannot change roles: %v", err)
	}
	_ = denied

	list, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, ArchivedExclude)
	if err != nil {
		t.Fatal(err)
	}
	var allID string
	for _, item := range list {
		if item.Channel.Name == systemAllName {
			allID = item.Channel.ID
		}
	}
	if _, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, allID, fxOwner, "user", fxMember, ChannelRoleAdmin); err == nil || AsRoleMutationError(err).Code != RoleCodeUnsupportedShape {
		t.Fatalf("#all roles: %v", err)
	}
	if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, plain.ID, fxOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, plain.ID, fxOwner, "user", fxMember, ChannelRoleAdmin); err == nil || AsRoleMutationError(err).Code != RoleCodeChannelArchived {
		t.Fatalf("archived role change: %v", err)
	}
}

func TestCrossWorkspaceIsolation(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypePrivate, CreatorUserID: fxMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	access, err := f.store.CanUserAccessChannel(f.ctx(), fxWS2, created.ID, fxOther)
	if err != nil || access {
		t.Fatalf("cross-workspace access: %v %v", access, err)
	}
	if ctx, err := f.store.ResolveChannelActorContext(f.ctx(), fxWS2, created.ID, "user", fxOther); err != nil || ctx != nil {
		t.Fatalf("cross-workspace context: %+v %v", ctx, err)
	}
	otherList, err := f.store.ListChannels(f.ctx(), fxWS2, fxOther, ArchivedExclude)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range otherList {
		if item.Channel.ID == created.ID {
			t.Fatal("private channel leaked into another workspace list")
		}
	}
	// The other workspace's owner is not a member here, so they cannot see the private channel.
	see, err := f.store.CanUserAccessChannel(f.ctx(), fxWS, created.ID, fxOwner)
	if err != nil || see {
		t.Fatalf("unjoined private: %v %v", see, err)
	}
	seeMember, err := f.store.CanUserAccessChannel(f.ctx(), fxWS, created.ID, fxMember)
	if err != nil || !seeMember {
		t.Fatalf("creator private access: %v %v", seeMember, err)
	}
}

func TestConcurrentCreateUniqueIndex(t *testing.T) {
	f := newFixture(t)
	// The partial unique index rejects a second live name even if both
	// writers pass an application precheck. Two IMMEDIATE transactions
	// serialize; exactly one insert commits.
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, 2)
	ids := make([]string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			created, err := f.store.CreateChannel(context.Background(), CreateInput{
				WorkspaceID: fxWS, Name: "race", Type: TypeChannel, CreatorUserID: fxMember,
			})
			errs[i] = err
			if created != nil {
				ids[i] = created.ID
			}
		}(i)
	}
	close(start)
	wg.Wait()
	wins, losses := 0, 0
	for _, err := range errs {
		if err == nil {
			wins++
			continue
		}
		if AsDomainError(err) != nil && AsDomainError(err).Code == CodeConflict {
			losses++
			continue
		}
		t.Fatalf("unexpected race error: %v", err)
	}
	if wins != 1 || losses != 1 {
		t.Fatalf("want 1 win and 1 conflict, got wins=%d losses=%d errs=%v", wins, losses, errs)
	}
	if f.countChannels("workspace_id = ? AND name = 'race' AND deleted_at IS NULL", fxWS) != 1 {
		t.Fatal("unique index left more than one live row")
	}
}

func TestRosterProjectionAndHiddenDirectory(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxMember,
		InitialUserIDs: []string{fxOwner}, InitialAgentIDs: []string{fxAgent},
	})
	if err != nil {
		t.Fatal(err)
	}
	roster, err := f.store.GetChannelMembers(f.ctx(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster.Humans) != 2 || len(roster.Agents) != 1 {
		t.Fatalf("roster: humans=%d agents=%d", len(roster.Humans), len(roster.Agents))
	}
	if roster.Agents[0].ServerRole != nil {
		t.Fatalf("missing agent_members row must project as SQL NULL, got %v", *roster.Agents[0].ServerRole)
	}
	roster.Project(true, fxOwner)
	if roster.Agents[0].ServerRole == nil || *roster.Agents[0].ServerRole != RoleMember {
		t.Fatalf("projected agent server role: %v", roster.Agents[0].ServerRole)
	}
	if !roster.Agents[0].CanChangeChannelRole {
		t.Fatal("owner can change an ordinary agent's channel role")
	}
	var ownerHuman *RosterHuman
	for i := range roster.Humans {
		if roster.Humans[i].ID == fxOwner {
			ownerHuman = &roster.Humans[i]
		}
		if roster.Humans[i].GravatarHash != gravatarHash(roster.Humans[i].ID+"@example.test") && roster.Humans[i].ID == fxMember {
			// email is name@example.test, not id.
		}
	}
	if ownerHuman == nil || ownerHuman.CanChangeChannelRole {
		t.Fatal("owner target is not role-changeable")
	}
	memberHash := gravatarHash("member@example.test")
	found := false
	for _, h := range roster.Humans {
		if h.ID == fxMember {
			found = true
			if h.GravatarHash != memberHash || h.ServerRole != RoleMember || h.ChannelRole == nil || *h.ChannelRole != ChannelRoleAdmin {
				t.Fatalf("member row: %+v", h)
			}
			if h.EffectiveChannelRole != RoleAdmin || h.ChannelAdminBasis == nil || *h.ChannelAdminBasis != "channel_role" {
				t.Fatalf("member projection: %+v", h)
			}
		}
	}
	if !found {
		t.Fatal("member missing from roster")
	}

	list, err := f.store.ListChannels(f.ctx(), fxWS, fxMember, ArchivedExclude)
	if err != nil {
		t.Fatal(err)
	}
	var allID string
	for _, item := range list {
		if IsAllSystemChannel(&item.Channel) {
			allID = item.Channel.ID
		}
	}
	if _, err := f.db.Exec(`UPDATE workspaces SET hide_humans_from_members = 1, slug = 'community' WHERE id = ?`, fxWS); err != nil {
		t.Fatal(err)
	}
	hide, err := f.store.ShouldHideHumanDirectory(f.ctx(), fxWS, fxMember)
	if err != nil || !hide {
		t.Fatalf("member directory hide: %v %v", hide, err)
	}
	hideOwner, err := f.store.ShouldHideHumanDirectory(f.ctx(), fxWS, fxOwner)
	if err != nil || hideOwner {
		t.Fatalf("owner is not filtered: %v %v", hideOwner, err)
	}
	audience, err := f.store.GetChannelMembers(f.ctx(), allID)
	if err != nil {
		t.Fatal(err)
	}
	visible := 0
	for _, h := range audience.Humans {
		if ExposeHumanInHiddenDirectory(h, fxMember) {
			visible++
		}
	}
	// member themself + community owner. Guest is not in the derived audience.
	if visible != 2 {
		t.Fatalf("hidden #all directory visible humans: %d", visible)
	}
	agents, err := f.store.GetChannelAgents(f.ctx(), allID)
	if err != nil || len(agents) != 1 || agents[0].ID != fxAgent || agents[0].ChannelRole != nil || agents[0].ServerRole != nil {
		t.Fatalf("derived agents: %+v %v", agents, err)
	}
}
