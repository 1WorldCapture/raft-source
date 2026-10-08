package message

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Test identities (fixed UUIDs keep cross-references readable).
const (
	txAlice    = "11111111-1111-4111-8111-111111111111"
	txBob      = "22222222-2222-4222-8222-222222222222"
	txCara     = "33333333-3333-4333-8333-333333333333"
	txWS       = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	txWS2      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	txFamAlice = "fa111111-1111-4111-8111-111111111111"
	txFamBob   = "fa222222-2222-4222-8222-222222222222"
	txFamCara  = "fa333333-3333-4333-8333-333333333333"
)

// fixture is one temp SQLite database with the real migration set, the
// channel store and the message store over a fixed clock.
type fixture struct {
	t        *testing.T
	db       *sql.DB
	channels *channel.Store
	store    *Store
	clock    *clock.Fixed
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	channels := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	store := NewStoreWithOptionsForTest(handle, channels, fixed)
	return &fixture{t: t, db: handle, channels: channels, store: store, clock: fixed}
}

// claimsFor builds verified-JWT-shaped claims for a seeded identity.
func claimsFor(userID, familyID string) auth.AccessTokenClaims {
	return auth.AccessTokenClaims{
		Subject:   userID,
		Type:      "access",
		FamilyID:  familyID,
		IssuedAt:  time.Date(2026, 10, 8, 11, 0, 0, 0, time.UTC),
		ExpiresAt: time.Date(2026, 10, 8, 13, 0, 0, 0, time.UTC),
	}
}

func (f *fixture) seed() {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	users := []struct{ id, name, display string }{
		{txAlice, "alice", "Alice"},
		{txBob, "bob", "Bob"},
		{txCara, "cara", "Cara"},
	}
	for _, u := range users {
		if _, err := f.db.Exec(`INSERT INTO users (id, email, name, display_name, password_hash, email_verified, created_at, updated_at)
			VALUES (?,?,?,?,?,1,?,?)`, u.id, u.name+"@example.test", u.name, u.display, "x", now, now); err != nil {
			f.t.Fatal(err)
		}
	}
	families := map[string]string{txAlice: txFamAlice, txBob: txFamBob, txCara: txFamCara}
	for userID, family := range families {
		if _, err := f.db.Exec(`INSERT INTO session_families (id, user_id, created_at) VALUES (?,?,?)`,
			family, userID, now); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, ws := range []struct{ id, slug, owner string }{{txWS, "alpha", txAlice}, {txWS2, "beta", txBob}} {
		if _, err := f.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
			ws.id, "WS "+ws.slug, ws.slug, ws.owner, now); err != nil {
			f.t.Fatal(err)
		}
	}
	members := []struct{ ws, user, role string }{
		{txWS, txAlice, "owner"},
		{txWS, txBob, "member"},
		{txWS, txCara, "member"},
		{txWS2, txBob, "owner"},
	}
	for _, m := range members {
		if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?,?,?,0,?)`, m.ws, m.user, m.role, now); err != nil {
			f.t.Fatal(err)
		}
	}
}

// seedChannel inserts one channel row plus roster membership rows.
func (f *fixture) seedChannel(id, name, channelType string, members ...string) {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?,?,?,?,?)`, id, txWS, name, channelType, now); err != nil {
		f.t.Fatal(err)
	}
	for _, m := range members {
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES (?,?, 'member', ?)`, id, m, now); err != nil {
			f.t.Fatal(err)
		}
	}
}

// send is the shorthand creator over the fixture workspace.
func (f *fixture) send(user, family, channelID, content string, randomID *string, mentions []Mention) (*CreateResult, error) {
	return f.store.Create(context.Background(), claimsFor(user, family), txWS, CreateInput{
		ChannelID: channelID, Content: content, RandomID: randomID, Mentions: mentions,
	})
}

func stringPtr(v string) *string { return &v }

// seedChannelRoster adds members to an already-seeded channel.
func (f *fixture) seedChannelRoster(members ...string) {
	f.t.Helper()
	now := f.clock.Now().UnixMilli()
	for _, m := range members {
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES (?,?, 'member', ?)`, txGeneral, m, now); err != nil {
			f.t.Fatal(err)
		}
	}
}
