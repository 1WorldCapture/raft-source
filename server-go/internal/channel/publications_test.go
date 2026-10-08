package channel

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"raft.local/server-go/internal/realtime"
)

// fxPlainMember is a second ordinary workspace member (server role member,
// never owner/admin/guest) so channel role transitions have a legal human
// target. fxAgent2 is a second live agent for the add/remove-agent cases.
// Both are seeded on demand.
const (
	fxPlainMember = "55555555-5555-4555-8555-555555555555"
	fxAgent2      = "66666666-6666-4666-8666-666666666666"
)

func (f *fixture) ensurePlainMember(t *testing.T) {
	t.Helper()
	now := f.clock.T.UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, 'plain@example.test', 'plain', 'x', 1, ?, ?)`, fxPlainMember, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, fxWS, fxPlainMember, RoleMember, now); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) ensureSecondAgent(t *testing.T) {
	t.Helper()
	now := f.clock.T.UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'delta', 'active', 'claude', ?, ?)`, fxAgent2, fxWS, now, now); err != nil {
		t.Fatal(err)
	}
}

// intentRow is the full observable state of one realtime_publications row:
// references only. No payload column exists in the schema, which is exactly
// the no-payload guarantee these tests pin.
type intentRow struct {
	ObjectType, ObjectID, EventType string
	Revision                        int64
	SubjectUserID, ScopeID          string
}

func (f *fixture) channelIntents(eventType, channelID string) []intentRow {
	f.t.Helper()
	rows, err := f.db.Query(`SELECT object_type, object_id, event_type, revision, subject_user_id, scope_id
		FROM realtime_publications WHERE event_type = ? AND object_id = ? ORDER BY revision`,
		eventType, channelID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []intentRow
	for rows.Next() {
		var r intentRow
		if err := rows.Scan(&r.ObjectType, &r.ObjectID, &r.EventType, &r.Revision, &r.SubjectUserID, &r.ScopeID); err != nil {
			f.t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func (f *fixture) channelIntentCount(eventType, channelID string) int {
	return len(f.channelIntents(eventType, channelID))
}

// ---------------------------------------------------------------------------
// channel:updated — the channel-state family.
// ---------------------------------------------------------------------------

func TestChannelUpdatedIntentMatrix(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	id := created.ID

	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != 1 {
		t.Fatalf("create must record exactly one channel:updated intent, got %d", n)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 0 {
		t.Fatalf("create must not record members-updated intents (TS create publishes the channel only), got %d", n)
	}
	createdIntent := f.channelIntents(PublicationEventChannelUpdated, id)[0]
	if createdIntent.ObjectType != "channel" || createdIntent.ObjectID != id || createdIntent.ScopeID != id || createdIntent.SubjectUserID != "" {
		t.Fatalf("create intent references: %+v", createdIntent)
	}
	if createdIntent.Revision < 1 {
		t.Fatalf("create intent revision must be positive, got %d", createdIntent.Revision)
	}

	// Real rename: exactly one new intent with a strictly greater revision.
	rename := "renamed"
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Name: &rename}); err != nil {
		t.Fatal(err)
	}
	renamed := f.channelIntents(PublicationEventChannelUpdated, id)
	if len(renamed) != 2 || renamed[1].Revision <= renamed[0].Revision {
		t.Fatalf("rename intents: %+v", renamed)
	}

	// A same-value PATCH still performs the UPDATE (and the frozen TS route
	// publishes unconditionally after it), so it records one intent.
	same := "renamed"
	before := f.channelIntentCount(PublicationEventChannelUpdated, id)
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Name: &same}); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != before+1 {
		t.Fatalf("same-value PATCH intents: %d -> %d", before, n)
	}

	// An all-nil PATCH builds no SQL at all: no write, no intent.
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{}); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != before+1 {
		t.Fatalf("empty PATCH recorded %d new intents", n-before-1)
	}

	// Description change is a real transition.
	description := "describe"
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Description: &description}); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != before+2 {
		t.Fatalf("description change intents: %d -> %d", before, n)
	}

	// Visibility (privacy) change: one channel:updated, never members-updated
	// (the TS update route publishes the channel and revokes access; it does
	// not emit the members-updated family).
	private := TypePrivate
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Type: &private}); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != before+3 {
		t.Fatalf("privacy change intents: %d -> %d", before, n)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 0 {
		t.Fatalf("privacy change must not record members-updated, got %d", n)
	}
	public := TypeChannel
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Type: &public}); err != nil {
		t.Fatal(err)
	}

	// Archive / unarchive: intent exactly on the real transition.
	if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, id, fxOwner); err != nil {
		t.Fatal(err)
	}
	archived := f.channelIntentCount(PublicationEventChannelUpdated, id)
	if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, id, fxOwner); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != archived {
		t.Fatalf("idempotent re-archive recorded %d new intents", n-archived)
	}
	if _, err := f.store.UnarchiveChannel(f.ctx(), fxWS, id, fxOwner); err != nil {
		t.Fatal(err)
	}
	unarchived := f.channelIntentCount(PublicationEventChannelUpdated, id)
	if _, err := f.store.UnarchiveChannel(f.ctx(), fxWS, id, fxOwner); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != unarchived {
		t.Fatalf("idempotent re-unarchive recorded %d new intents", n-unarchived)
	}
	// `archived` already includes the archive intent itself, so exactly one
	// more (the unarchive) must have been added here.
	if unarchived != archived+1 {
		t.Fatalf("unarchive must add exactly one intent: %d -> %d", archived, unarchived)
	}

	// Deletion is deliberately silent: the frozen TS server emits nothing on
	// channel deletion, and revocation is enforced fail-closed elsewhere.
	if err := f.store.DeleteChannel(f.ctx(), fxWS, id, fxOwner); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, id); n != unarchived {
		t.Fatalf("delete recorded %d new channel:updated intents", n-unarchived)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 0 {
		t.Fatalf("delete recorded %d members-updated intents", n)
	}
}

// The #all visibility flip is the one update that wipes derived roster rows;
// it must stay a pure channel:updated transition (TS parity).
func TestAllChannelVisibilityFlipIsChannelUpdatedOnly(t *testing.T) {
	f := newFixture(t)
	if _, err := f.store.ListChannels(f.ctx(), fxWS, fxOwner, ArchivedExclude); err != nil {
		t.Fatal(err)
	}
	all, err := f.store.GetSystemAllChannel(f.ctx(), fxWS)
	if err != nil || all == nil {
		t.Fatalf("#all ensure: %v %v", all, err)
	}
	private := TypePrivate
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, all.ID, ChannelUpdates{Type: &private}); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, all.ID); n != 1 {
		t.Fatalf("#all visibility flip intents: %d", n)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, all.ID); n != 0 {
		t.Fatalf("#all visibility flip must not record members-updated, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// channel:members-updated — the roster family.
// ---------------------------------------------------------------------------

func TestMembersUpdatedIntentMatrix(t *testing.T) {
	f := newFixture(t)
	f.ensurePlainMember(t)
	f.ensureSecondAgent(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
		// Initial members are part of the creation and stay quiet.
		InitialUserIDs:  []string{fxPlainMember},
		InitialAgentIDs: []string{fxAgent},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := created.ID
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 0 {
		t.Fatalf("initial roster must stay quiet, got %d intents", n)
	}

	// Self-join: one intent, subject = the joining human.
	if err := f.store.JoinChannel(f.ctx(), fxWS, id, fxMember); err != nil {
		t.Fatal(err)
	}
	joinIntents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(joinIntents) != 1 || joinIntents[0].SubjectUserID != fxMember {
		t.Fatalf("join intents: %+v", joinIntents)
	}
	// Re-join of an existing member: idempotent no-op, no intent.
	if err := f.store.JoinChannel(f.ctx(), fxWS, id, fxMember); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 1 {
		t.Fatalf("re-join recorded %d new intents", n-1)
	}

	// Add member (the transport add-member path): subject = added human.
	if _, err := f.store.AddHumanTx(f.ctx(), id, fxGuest, ""); err != nil {
		t.Fatal(err)
	}
	addIntents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(addIntents) != 2 || addIntents[1].SubjectUserID != fxGuest {
		t.Fatalf("add-member intents: %+v", addIntents)
	}
	// Adding an existing member again: no new fact, no intent.
	if _, err := f.store.AddHumanTx(f.ctx(), id, fxGuest, ""); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 2 {
		t.Fatalf("re-add recorded %d new intents", n-2)
	}

	// Agent roster change: intent with empty subject (no targeted frame).
	if _, err := f.store.AddAgentTx(f.ctx(), id, fxAgent2, ""); err != nil {
		t.Fatal(err)
	}
	agentIntents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(agentIntents) != 3 || agentIntents[2].SubjectUserID != "" {
		t.Fatalf("agent add intents: %+v", agentIntents)
	}

	// Role change on a human target: subject = the target.
	if _, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, id, fxOwner, "user", fxPlainMember, ChannelRoleAdmin); err != nil {
		t.Fatal(err)
	}
	roleIntents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(roleIntents) != 4 || roleIntents[3].SubjectUserID != fxPlainMember {
		t.Fatalf("role change intents: %+v", roleIntents)
	}
	// No-op role change: no intent.
	if _, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, id, fxOwner, "user", fxPlainMember, ChannelRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 4 {
		t.Fatalf("no-op role change recorded %d new intents", n-4)
	}

	// Leave: real removal, empty subject.
	if err := f.store.LeaveChannel(f.ctx(), fxWS, id, fxMember); err != nil {
		t.Fatal(err)
	}
	leaveIntents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(leaveIntents) != 5 || leaveIntents[4].SubjectUserID != "" {
		t.Fatalf("leave intents: %+v", leaveIntents)
	}

	// Agent removal: empty subject.
	if err := f.store.RemoveAgentTx(f.ctx(), id, fxAgent2); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 6 {
		t.Fatalf("agent removal intents: %d", n)
	}

	// Removing a member who is not on the roster: no row deleted, no intent.
	if err := f.store.RemoveHumanTx(f.ctx(), id, fxOther); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, id); n != 6 {
		t.Fatalf("absent-member removal recorded %d new intents", n-6)
	}

	// Every intent of the family references the channel exactly.
	for _, row := range f.channelIntents(PublicationEventMembersUpdated, id) {
		if row.ObjectType != "channel" || row.ObjectID != id || row.ScopeID != id || row.Revision < 1 {
			t.Fatalf("members-updated references: %+v", row)
		}
	}
}

// Removing the last human from a private channel soft-deletes it (the frozen
// TS cleanup); the transition records members-updated only — never
// channel:updated, exactly like the TS remove route.
func TestEmptyPrivateChannelCleanupEmitsMembersOnly(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypePrivate, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.RemoveHumanTx(f.ctx(), created.ID, fxOwner); err != nil {
		t.Fatal(err)
	}
	if n := f.countWhere(`SELECT COUNT(*) FROM channels WHERE id = ? AND deleted_at IS NOT NULL`, created.ID); n != 1 {
		t.Fatalf("empty private channel must be soft-deleted")
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, created.ID); n != 1 {
		t.Fatalf("cleanup members-updated intents: %d", n)
	}
	if n := f.channelIntentCount(PublicationEventChannelUpdated, created.ID); n != 1 {
		t.Fatalf("create intent must remain the only channel:updated row, got %d", n)
	}
}

// The lazy system-channel ensures are not route mutations and never emit.
func TestSystemChannelEnsureEmitsNoIntents(t *testing.T) {
	f := newFixture(t)
	if _, err := f.store.ListChannels(f.ctx(), fxWS, fxOwner, ArchivedExclude); err != nil {
		t.Fatal(err)
	}
	if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE event_type IN (?, ?)`,
		PublicationEventChannelUpdated, PublicationEventMembersUpdated); n != 0 {
		t.Fatalf("lazy ensure recorded %d intents", n)
	}
}

// ---------------------------------------------------------------------------
// Revision stability, rollback, backlog, and discipline.
// ---------------------------------------------------------------------------

// A pinned clock means every transition happens in the same millisecond; the
// committed-intent frontier must still serialize strictly increasing
// revisions, including several transitions inside ONE transaction.
func TestIntentRevisionsStrictlyIncreaseWithinOneMillisecond(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	id := created.ID

	// Three membership gains in ONE transaction (the batch add shape).
	if err := f.store.InTx(f.ctx(), func(ex Executor) error {
		for _, user := range []string{fxMember, fxGuest, fxOther} {
			if user == fxOther {
				continue // fxOther is not a workspace member; keep the batch legal
			}
			if _, err := f.store.AddHuman(f.ctx(), id, user, "", ex); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	intents := f.channelIntents(PublicationEventMembersUpdated, id)
	if len(intents) != 2 {
		t.Fatalf("batch intents: %+v", intents)
	}
	for i := 1; i < len(intents); i++ {
		if intents[i].Revision <= intents[i-1].Revision {
			t.Fatalf("revisions must strictly increase: %+v", intents)
		}
	}

	// Channel-state transitions in the same millisecond keep increasing too.
	rename := "r1"
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Name: &rename}); err != nil {
		t.Fatal(err)
	}
	rename2 := "r2"
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, id, ChannelUpdates{Name: &rename2}); err != nil {
		t.Fatal(err)
	}
	updated := f.channelIntents(PublicationEventChannelUpdated, id)
	if len(updated) != 3 { // create + two renames
		t.Fatalf("channel:updated intents: %+v", updated)
	}
	for i := 1; i < len(updated); i++ {
		if updated[i].Revision <= updated[i-1].Revision {
			t.Fatalf("channel:updated revisions must strictly increase: %+v", updated)
		}
	}
}

// The roster row and its intent commit or roll back together.
func TestRosterWriteRollbackLeavesNoIntent(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("deliberate failure after the roster write")
	err = f.store.InTx(f.ctx(), func(ex Executor) error {
		if _, err := f.store.AddHuman(f.ctx(), created.ID, fxMember, "", ex); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("composed transaction must surface the caller error, got %v", err)
	}
	if n := f.humanCount(t, created.ID, fxMember); n != 0 {
		t.Fatalf("rolled-back roster write must leave no row, got %d", n)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, created.ID); n != 0 {
		t.Fatalf("rolled-back write must leave no intent, got %d", n)
	}
}

// A full publication backlog fails the mutation closed: the membership never
// commits without its intent.
func TestBacklogFullFailsRosterWritesClosed(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.seedPendingPublications(realtime.MaxPending); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxMember, ""); !errors.Is(err, realtime.ErrBacklogFull) {
		t.Fatalf("add under full backlog must fail with ErrBacklogFull, got %v", err)
	}
	if n := f.humanCount(t, created.ID, fxMember); n != 0 {
		t.Fatalf("failed-closed add must leave no roster row, got %d", n)
	}
	if err := f.store.JoinChannel(f.ctx(), fxWS, created.ID, fxMember); !errors.Is(err, realtime.ErrBacklogFull) {
		t.Fatalf("join under full backlog must fail with ErrBacklogFull, got %v", err)
	}
	if n := f.humanCount(t, created.ID, fxMember); n != 0 {
		t.Fatalf("failed-closed join must leave no roster row, got %d", n)
	}
	// Rename under a full backlog fails closed as well.
	rename := "blocked"
	if _, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, created.ID, ChannelUpdates{Name: &rename}); !errors.Is(err, realtime.ErrBacklogFull) {
		t.Fatalf("rename under full backlog must fail with ErrBacklogFull, got %v", err)
	}
	if name := f.countWhere(`SELECT COUNT(*) FROM channels WHERE id = ? AND name = 'blocked'`, created.ID); name != 0 {
		t.Fatalf("failed-closed rename must not persist")
	}
}

// seedPendingPublications fills the backlog with unrelated pending intents
// (direct rows, distinct keys, never published).
func (f *fixture) seedPendingPublications(n int) error {
	tx, err := f.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.Prepare(`INSERT INTO realtime_publications
		(workspace_id, object_type, object_id, event_type, revision, subject_user_id, scope_id, created_at)
		VALUES (?, 'seed', ?, 'seed:event', ?, '', '', ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for i := 0; i < n; i++ {
		if _, err := stmt.Exec(fxWS, fmt.Sprintf("seed-%d", i), int64(i+1), f.clock.T.UnixMilli()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// A bare *sql.DB executor (no caller transaction) is wrapped in one write
// transaction so the row and its intent stay atomic — the pre-M4 capability
// of calling roster writes directly on the store handle keeps working.
func TestRosterWriteOnBareHandleStillRecordsIntent(t *testing.T) {
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypeChannel, CreatorUserID: fxOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	added, err := f.store.AddHuman(f.ctx(), created.ID, fxMember, "", f.db)
	if err != nil || !added {
		t.Fatalf("bare-handle add: %v %v", added, err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, created.ID); n != 1 {
		t.Fatalf("bare-handle add intents: %d", n)
	}
	if err := f.store.RemoveHuman(f.ctx(), created.ID, fxMember, f.db); err != nil {
		t.Fatal(err)
	}
	if n := f.channelIntentCount(PublicationEventMembersUpdated, created.ID); n != 2 {
		t.Fatalf("bare-handle remove intents: %d", n)
	}
}

// The outbox rows carry durable references only: no channel names,
// descriptions, roles or any other payload-like value can appear.
func TestIntentRowsCarryReferencesOnly(t *testing.T) {
	f := newFixture(t)
	f.ensurePlainMember(t)
	secret := "description-must-never-ride-the-outbox"
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: TypePrivate, CreatorUserID: fxOwner,
		Description:     &secret,
		InitialUserIDs:  []string{fxPlainMember},
		InitialAgentIDs: []string{fxAgent},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxGuest, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxOwner, "user", fxPlainMember, ChannelRoleAdmin); err != nil {
		t.Fatal(err)
	}
	rows, err := f.db.Query(`SELECT object_type, object_id, event_type, revision, subject_user_id, scope_id
		FROM realtime_publications WHERE object_id = ?`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var seen int
	allowedSubjects := map[string]bool{"": true, fxGuest: true, fxPlainMember: true}
	for rows.Next() {
		var r intentRow
		if err := rows.Scan(&r.ObjectType, &r.ObjectID, &r.EventType, &r.Revision, &r.SubjectUserID, &r.ScopeID); err != nil {
			t.Fatal(err)
		}
		seen++
		if r.ObjectType != "channel" || r.ObjectID != created.ID || r.ScopeID != created.ID {
			t.Fatalf("payload-like reference: %+v", r)
		}
		if r.EventType != PublicationEventChannelUpdated && r.EventType != PublicationEventMembersUpdated {
			t.Fatalf("unexpected event: %+v", r)
		}
		if !allowedSubjects[r.SubjectUserID] {
			t.Fatalf("unexpected subject: %+v", r)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("expected committed intents")
	}
	// The schema itself has no payload column; assert the channel
	// description and member role strings appear nowhere in the table.
	var leaked int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE scope_id LIKE '%must-never%' OR object_id LIKE '%must-never%'
		   OR subject_user_id = 'admin'`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatalf("payload leaked into %d intent rows", leaked)
	}
}

// silences the unused warning when assertions evolve; keeps sql import used.
var _ = sql.ErrNoRows
