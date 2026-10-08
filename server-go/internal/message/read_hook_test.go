package message

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

// hookCall records one invocation of the injected readstate seam.
type hookCall struct {
	claims    auth.AccessTokenClaims
	workspace string
	thread    string
}

func recordingHook(calls *[]hookCall, fail bool) ThreadReplyReadHook {
	return func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, threadID string) error {
		*calls = append(*calls, hookCall{claims: claims, workspace: workspaceID, thread: threadID})
		if fail {
			return errors.New("readstate unavailable")
		}
		return nil
	}
}

// TestThreadReplyReadHookSameTransaction covers the readstate seam: a NEW
// human thread reply invokes the hook with the author's verified claims
// inside the SAME transaction; a randomId replay never re-invokes it; a
// channel (non-thread) message never invokes it; a hook failure rolls the
// whole reply back; two different authors each get their own invocation.
func TestThreadReplyReadHookSameTransaction(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	parent := f.sendMsg(t, txGeneral, "root")
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent.ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var calls []hookCall
	f.store.SetThreadReplyReadHook(recordingHook(&calls, false))
	if !f.store.HasThreadReplyReadHook() {
		t.Fatal("hook wiring flag must reflect the injection")
	}

	// New reply: the hook fires once, inside the committing transaction,
	// with the AUTHOR's claims and the thread channel.
	if _, err := f.send(txAlice, txFamAlice, threadID, "first reply", nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("one hook call per new reply: %d", len(calls))
	}
	if calls[0].claims.Subject != txAlice || calls[0].claims.FamilyID != txFamAlice ||
		calls[0].workspace != txWS || calls[0].thread != threadID {
		t.Fatalf("hook invocation facts: %+v", calls[0])
	}

	// Two authors: the second reply fires for ITS author.
	if _, err := f.send(txBob, txFamBob, threadID, "second reply", nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[1].claims.Subject != txBob || calls[1].claims.FamilyID != txFamBob {
		t.Fatalf("second author hook: %+v", calls)
	}

	// randomId replay returns the original message and NEVER re-invokes:
	// the seeded reply fires once, the replayed request adds nothing.
	before := len(calls)
	seed, err := f.send(txAlice, txFamAlice, threadID, "seed", stringPtr("replay-1"), nil)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if len(calls) != before+1 {
		t.Fatalf("seeding reply fires once: %d -> %d", before, len(calls))
	}
	replay, err := f.send(txAlice, txFamAlice, threadID, "seed", stringPtr("replay-1"), nil)
	if err != nil || !replay.Replayed || replay.Message.ID != seed.Message.ID {
		t.Fatalf("replay identity: %+v %v", replay, err)
	}
	if len(calls) != before+1 {
		t.Fatalf("replay must not re-invoke the hook: %d -> %d", before, len(calls))
	}

	// A plain channel message never invokes the thread hook.
	before = len(calls)
	if _, err := f.send(txAlice, txFamAlice, txGeneral, "not a thread", nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(calls) != before {
		t.Fatalf("channel message must not fire the thread hook: %d -> %d", before, len(calls))
	}

	// Hook failure: the whole reply transaction rolls back — no message row,
	// no follow churn, no publication.
	f.store.SetThreadReplyReadHook(recordingHook(&calls, true))
	if _, err := f.send(txAlice, txFamAlice, threadID, "doomed reply", nil, nil); err == nil {
		t.Fatal("hook failure must abort the send")
	}
	var doomed int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE content = 'doomed reply'`).Scan(&doomed)
	if doomed != 0 {
		t.Fatalf("rollback left a phantom message: %d", doomed)
	}
	var pubs int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'message'`).Scan(&pubs)
	if pubs != 5 { // parent + 3 committed replies + 1 channel message
		t.Fatalf("rollback left phantom publications: %d", pubs)
	}
}

// TestThreadReplyReadHookWiringBoundary documents that a store constructed
// without the hook still commits pure message facts (unit-separable), while
// HasThreadReplyReadHook tells the assembly the product path is incomplete.
func TestThreadReplyReadHookWiringBoundary(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	parent := f.sendMsg(t, txGeneral, "root")
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent.ID, txAlice)
		threadID = thread.ID
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if f.store.HasThreadReplyReadHook() {
		t.Fatal("fresh store is unwired by construction")
	}
	if _, err := f.send(txAlice, txFamAlice, threadID, "fact only", nil, nil); err != nil {
		t.Fatalf("pure fact path must stay unit-separable: %v", err)
	}
}
