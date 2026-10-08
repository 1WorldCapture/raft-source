package readstate

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Fixture identities (UUID-shaped to pass wire validation).
const (
	fxAlice    = "11111111-1111-4111-8111-111111111111"
	fxBob      = "22222222-2222-4222-8222-222222222222"
	fxGuest    = "33333333-3333-4333-8333-333333333333"
	fxStranger = "44444444-4444-4444-8444-444444444444"
	fxWS       = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	fxWS2      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	fxGeneral  = "cccccccc-cccc-4ccc-8ccc-cccccccccc01"
	fxSecret   = "cccccccc-cccc-4ccc-8ccc-cccccccccc02"
	fxDM       = "cccccccc-cccc-4ccc-8ccc-cccccccccc03"
	fxDM2      = "cccccccc-cccc-4ccc-8ccc-cccccccccc04"
	fxThread   = "cccccccc-cccc-4ccc-8ccc-cccccccccc05"
	fxThread2  = "cccccccc-cccc-4ccc-8ccc-cccccccccc06"
	fxParent   = "dddddddd-dddd-4ddd-8ddd-dddddddddd01"
	fxParent2  = "dddddddd-dddd-4ddd-8ddd-dddddddddd02"
)

// fixture owns a migrated database plus the 0011 draft schema and a store.
type fixture struct {
	t      *testing.T
	db     *sql.DB
	store  *Store
	clock  *concurrentFixtureClock
	claims map[string]auth.AccessTokenClaims
	family map[string]string
	baseMS int64
}

// schemaDraftPath points at the integrator-facing draft; the test applies the
// exact file the parent will copy into migrations/0011.
func schemaDraftPath(t *testing.T) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "contracts", "m4-readstate-schema.sql"),
		filepath.Join("..", "..", "..", "server-go", "contracts", "m4-readstate-schema.sql"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			abs, err := filepath.Abs(candidate)
			if err != nil {
				t.Fatal(err)
			}
			return abs
		}
	}
	t.Fatal("schema draft not found relative to the package")
	return ""
}

// applySchemaDraft executes the 0011 draft inside one transaction (the same
// way migrations run) and is idempotent, so the fixture works whether or not
// the parent has already landed the numbered migration.
func applySchemaDraft(t *testing.T, handle *sql.DB) {
	t.Helper()
	body, err := os.ReadFile(schemaDraftPath(t))
	if err != nil {
		t.Fatalf("read schema draft: %v", err)
	}
	tx, err := handle.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(string(body)); err != nil {
		_ = tx.Rollback()
		t.Fatalf("apply schema draft: %v", err)
	}
	if _, err := tx.Exec(`PRAGMA foreign_key_check`); err != nil {
		_ = tx.Rollback()
		t.Fatalf("foreign key check: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	applySchemaDraft(t, handle)
	fixed := newConcurrentFixtureClock(time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC))
	channels := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	fx := &fixture{
		t:      t,
		db:     handle,
		store:  NewStore(handle, channels),
		clock:  fixed,
		claims: map[string]auth.AccessTokenClaims{},
		family: map[string]string{},
	}
	fx.store.SetClock(fixed.Now)
	fx.seed()
	return fx
}

func (f *fixture) seed() {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	users := []struct{ id, name string }{
		{fxAlice, "alice"},
		{fxBob, "bob"},
		{fxGuest, "guest"},
		{fxStranger, "stranger"},
	}
	for _, u := range users {
		if _, err := f.db.Exec(`INSERT INTO users (id, email, name, display_name, password_hash,
			email_verified, profile_setup_completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'x', 1, ?, ?, ?)`,
			u.id, u.name+"@example.test", u.name, u.name, now, now, now); err != nil {
			f.t.Fatal(err)
		}
		// A live session family so the default human validation passes.
		familyID := u.id + "f"
		if _, err := f.db.Exec(`INSERT INTO session_families (id, user_id, created_at)
			VALUES (?, ?, ?)`, familyID, u.id, now); err != nil {
			f.t.Fatal(err)
		}
		f.family[u.id] = familyID
		expiry := f.clock.Now().Add(15 * time.Minute)
		f.claims[u.id] = auth.AccessTokenClaims{
			Subject:   u.id,
			Type:      "access",
			FamilyID:  familyID,
			IssuedAt:  f.clock.Now(),
			ExpiresAt: expiry,
		}
	}
	for _, ws := range []struct{ id, slug, owner string }{
		{fxWS, "alpha", fxAlice},
		{fxWS2, "beta", fxStranger},
	} {
		if _, err := f.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
			VALUES (?, ?, ?, ?, ?)`, ws.id, "WS "+ws.slug, ws.slug, ws.owner, now); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, m := range []struct{ ws, user, role string }{
		{fxWS, fxAlice, "owner"},
		{fxWS, fxBob, "member"},
		{fxWS, fxGuest, "guest"},
		{fxWS2, fxStranger, "owner"},
	} {
		if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, ?)`, m.ws, m.user, m.role, now); err != nil {
			f.t.Fatal(err)
		}
	}
	f.addChannel(fxGeneral, "general", "channel", nil)
	f.addChannel(fxSecret, "secret", "private", nil)
	f.addChannel(fxDM, "dm-alice-bob", "dm", nil)
	f.addChannel(fxDM2, "dm-self", "dm", nil)
	parentOne := fxParent
	parentTwo := fxParent2
	f.addChannel(fxThread, "thread-1", "thread", &parentOne)
	f.addChannel(fxThread2, "thread-2", "thread", &parentTwo)
	for _, membership := range []struct{ channel, user string }{
		{fxGeneral, fxAlice}, {fxGeneral, fxBob},
		{fxSecret, fxAlice}, {fxSecret, fxBob},
		{fxDM, fxAlice}, {fxDM, fxBob},
		{fxDM2, fxAlice},
	} {
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
			VALUES (?, ?, 'member', 1, ?)`, membership.channel, membership.user, now); err != nil {
			f.t.Fatal(err)
		}
	}
	// Canonical DM pairs (0010): alice<bob and alice self-DM.
	if _, err := f.db.Exec(`INSERT INTO direct_messages (workspace_id, user_low, user_high, channel_id)
		VALUES (?, ?, ?, ?)`, fxWS, fxAlice, fxBob, fxDM); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO direct_messages (workspace_id, user_low, user_high, channel_id)
		VALUES (?, ?, ?, ?)`, fxWS, fxAlice, fxAlice, fxDM2); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) addChannel(id, name, channelType string, parentMessageID *string) {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	var parent any
	if parentMessageID != nil {
		parent = *parentMessageID
	}
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, id, fxWS, name, channelType, parent, now); err != nil {
		f.t.Fatal(err)
	}
}

// advance moves the fixture clock forward by ms milliseconds.
func (f *fixture) advance(ms int64) {
	f.t.Helper()
	f.clock.Advance(time.Duration(ms) * time.Millisecond)
}

// insertMessage appends one chat message and returns its global seq.
func (f *fixture) insertMessage(channelID, sender, content string, mentioned ...string) int64 {
	f.t.Helper()
	f.advance(10)
	now := f.clock.Now().UnixMilli()
	messageID := fmt.Sprintf("msg-%s-%s-%d", sender, content, now)
	res, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, random_id, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'chat', NULL, ?, ?)`,
		messageID, fxWS, channelID, sender, content, "digest-"+content, now)
	if err != nil {
		f.t.Fatal(err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		f.t.Fatal(err)
	}
	for _, mentionedUser := range mentioned {
		if _, err := f.db.Exec(`INSERT INTO message_mentions (message_id, user_id, workspace_id)
			VALUES (?, ?, ?)`, messageID, mentionedUser, fxWS); err != nil {
			f.t.Fatal(err)
		}
	}
	return seq
}

// seedThreadParents writes the two thread parent messages into #general.
func (f *fixture) seedThreadParents() {
	f.t.Helper()
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, 'parent one', 'chat', 'd1', ?)`,
		fxParent, fxWS, fxGeneral, fxAlice, f.clock.Now().UnixMilli()); err != nil {
		f.t.Fatal(err)
	}
	f.advance(10)
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, 'parent two', 'chat', 'd2', ?)`,
		fxParent2, fxWS, fxGeneral, fxAlice, f.clock.Now().UnixMilli()); err != nil {
		f.t.Fatal(err)
	}
}

// follow seeds a thread_follows row (the channel worker's table).
func (f *fixture) follow(userID, threadChannelID string, unfollowed bool) {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	var unfollowedAt any
	if unfollowed {
		unfollowedAt = now
	}
	parent := fxParent
	if threadChannelID == fxThread2 {
		parent = fxParent2
	}
	if _, err := f.db.Exec(`INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id,
		parent_message_id, followed_at, unfollowed_at, revision)
		VALUES (?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT (workspace_id, user_id, thread_channel_id) DO UPDATE SET
		unfollowed_at = excluded.unfollowed_at`,
		fxWS, userID, threadChannelID, parent, now, unfollowedAt); err != nil {
		f.t.Fatal(err)
	}
}

// readStateRow loads the stored cursor row for assertions.
func (f *fixture) readStateRow(userID, channelID string) (int64, int64, bool) {
	f.t.Helper()
	var lastRead, version int64
	err := f.db.QueryRow(`SELECT last_read_seq, read_state_version
		FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		fxWS, userID, channelID).Scan(&lastRead, &version)
	if err == sql.ErrNoRows {
		return 0, 0, false
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return lastRead, version, true
}

// doneRow loads the stored Done row.
func (f *fixture) doneRow(userID, channelID string) (through int64, doneAt sql.NullInt64, present bool) {
	f.t.Helper()
	err := f.db.QueryRow(`SELECT done_through_activity_seq, done_at
		FROM user_channel_done_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		fxWS, userID, channelID).Scan(&through, &doneAt)
	if err == sql.ErrNoRows {
		return 0, sql.NullInt64{}, false
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return through, doneAt, true
}

func (f *fixture) ctx() context.Context { return context.Background() }

// countRows counts a table filtered to the fixture workspace.
func (f *fixture) countRows(table string) int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
