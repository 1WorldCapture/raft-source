package messaging_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// The complete human send use case pairs every NEW thread reply with the
// author's own read advance in the SAME transaction (the original pipeline's
// replied auto-follow + markReadLatest). A randomId replay never re-advances
// the frontier; a plain channel message never touches it.

type advanceEnv struct {
	t         *testing.T
	db        *sql.DB
	channels  *channel.Store
	messages  *message.Store
	readstate *readstate.Store
	svc       *messaging.Service

	ws, threadID, generalID string
}

func newAdvanceEnv(t *testing.T) *advanceEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStore(handle)
	msgs := message.NewStore(handle, channels)
	states := readstate.NewStore(handle, channels)
	svc, err := messaging.NewService(channels, msgs, states)
	if err != nil {
		t.Fatal(err)
	}
	env := &advanceEnv{t: t, db: handle, channels: channels, messages: msgs, readstate: states, svc: svc,
		ws: "aaaaaaa1-0000-4000-8000-000000000001", threadID: "aaaaaaa1-0000-4000-8000-000000000002", generalID: "aaaaaaa1-0000-4000-8000-000000000003"}
	env.seed()
	return env
}

func (e *advanceEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *advanceEnv) seed() {
	e.t.Helper()
	now := time.Now().UnixMilli()
	e.exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES ('alice', 'a@t', 'alice', 'x', 1, 1, 0, 0), ('bob', 'b@t', 'bob', 'x', 1, 1, 0, 0)`)
	e.exec(`INSERT INTO session_families (id, user_id, created_at) VALUES ('fam-alice', 'alice', 0), ('fam-bob', 'bob', 0)`)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', 'alice', 0)`, e.ws)
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, 'alice', 'owner', 0), (?, 'bob', 'member', 0)`, e.ws, e.ws)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', ?)`, e.generalID, e.ws, now)
	e.exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, 'alice', 'member', ?), (?, 'bob', 'member', ?)`, e.generalID, now, e.generalID, now)
}

// openThread sends one parent message and ensures the unique thread on it.
func (e *advanceEnv) openThread() {
	e.t.Helper()
	parent, err := e.send("alice", e.generalID, "thread root", nil)
	if err != nil {
		e.t.Fatal(err)
	}
	err = platformdb.WithWriteTx(context.Background(), e.db, func(tx *sql.Tx) error {
		thread, err := e.channels.EnsureThreadTx(context.Background(), tx, e.ws, e.generalID, parent.Message.ID, "alice")
		if err != nil {
			return err
		}
		e.threadID = thread.ID
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *advanceEnv) claims(user string) auth.AccessTokenClaims {
	now := time.Now()
	return auth.AccessTokenClaims{Subject: user, Type: "access", FamilyID: "fam-" + user, IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour)}
}

func (e *advanceEnv) send(user, channelID, content string, randomID *string) (*message.CreateResult, error) {
	return e.svc.SendHuman(context.Background(), e.claims(user), e.ws, message.CreateInput{
		ChannelID: channelID, Content: content, RandomID: randomID,
	})
}

func (e *advanceEnv) maxRead(user, channelID string) (int64, bool) {
	e.t.Helper()
	var seq int64
	err := e.db.QueryRow(`SELECT last_read_seq FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`, e.ws, user, channelID).Scan(&seq)
	if err == sql.ErrNoRows {
		return 0, false
	}
	if err != nil {
		e.t.Fatal(err)
	}
	return seq, true
}

func TestSendHumanThreadReplyAdvancesReplierCursor(t *testing.T) {
	e := newAdvanceEnv(t)
	e.openThread()

	first, err := e.send("alice", e.threadID, "first reply", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := e.maxRead("alice", e.threadID); !ok || got != first.Message.Seq {
		t.Fatalf("alice frontier = %d (present=%v), want her own reply seq %d in the same commit", got, ok, first.Message.Seq)
	}
	// Bob's reply advances only BOB's frontier.
	second, err := e.send("bob", e.threadID, "second reply", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := e.maxRead("alice", e.threadID); got != first.Message.Seq {
		t.Fatalf("alice frontier moved by bob's reply: %d", got)
	}
	if got, ok := e.maxRead("bob", e.threadID); !ok || got != second.Message.Seq {
		t.Fatalf("bob frontier = %d (present=%v), want his own reply seq %d", got, ok, second.Message.Seq)
	}

	// A randomId replay returns the original message and NEVER re-advances:
	// the frontier stays at the original reply's seq even though newer
	// messages exist.
	rid := "replay-advance-1"
	third, err := e.send("bob", e.threadID, "third reply", &rid)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := e.maxRead("bob", e.threadID)
	replayed, err := e.send("bob", e.threadID, "third reply", &rid)
	if err != nil || !replayed.Replayed || replayed.Message.ID != third.Message.ID {
		t.Fatalf("replay identity: %+v %v", replayed, err)
	}
	if got, _ := e.maxRead("bob", e.threadID); got != before {
		t.Fatalf("replay re-advanced the frontier: %d -> %d", before, got)
	}

	// A plain channel message never touches the read frontier.
	if _, err := e.send("alice", e.generalID, "not a thread", nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.maxRead("alice", e.generalID); ok {
		t.Fatal("channel message advanced a read frontier")
	}

	// Every send left exactly its publication intents; the replays added none.
	var pubs int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'message'`).Scan(&pubs); err != nil {
		t.Fatal(err)
	}
	if pubs != 5 { // thread root + 3 replies + 1 channel message
		t.Fatalf("publications = %d, want 5 (replays add none)", pubs)
	}
}
