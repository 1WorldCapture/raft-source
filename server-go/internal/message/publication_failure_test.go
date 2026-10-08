package message

// Focused regressions for the F2 review finding: the thread projector must
// distinguish "the durable fact is gone" (honest no-op completion) from
// "the lookup itself failed" (infrastructure error that defers the durable
// publication intent for retry). Conflating the two silently completed
// thread:updated intents on transient database failures.
// The same file pins the honest no-op contract for missing, soft-deleted and
// foreign-workspace thread references, and keeps the happy path intact.

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

const txMissingThread = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

// seedThreadWithReply creates a real public-channel thread carrying one
// reply, returning the thread channel id and its parent message id.
func seedThreadWithReply(t *testing.T, f *fixture) (threadID, parentMessageID string) {
	t.Helper()
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	created, err := f.send(txAlice, txFamAlice, txGeneral, "thread root", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, created.Message.ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txBob, txFamBob, threadID, "reply", nil, nil); err != nil {
		t.Fatal(err)
	}
	return threadID, created.Message.ID
}

// TestProjectPublicationThreadNoopCompletionIsHonest pins the no-op side of
// the contract: only MISSING facts complete without a payload. Missing,
// soft-deleted and cross-workspace thread references are honest no-ops.
func TestProjectPublicationThreadNoopCompletionIsHonest(t *testing.T) {
	f := newFixture(t)
	threadID, parentMessageID := seedThreadWithReply(t, f)

	// Happy path stays intact: a live thread projects its summary facts.
	proj, err := f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "thread", ObjectID: threadID,
		EventType: "thread:updated", Revision: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proj == nil || proj.Thread == nil {
		t.Fatalf("live thread must project: %+v", proj)
	}
	if proj.Thread.ParentMessageID != parentMessageID || proj.Thread.ReplyCount != 1 {
		t.Fatalf("thread facts: %+v", proj.Thread)
	}

	// Missing thread id: the fact is gone, complete without a payload.
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "thread", ObjectID: txMissingThread,
		EventType: "thread:updated", Revision: 1,
	})
	if err != nil || proj != nil {
		t.Fatalf("missing thread must be an honest no-op: %+v %v", proj, err)
	}

	// Cross-workspace reference: same honest no-op, never a payload and
	// never an error that would wedge the intent.
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS2, ObjectType: "thread", ObjectID: threadID,
		EventType: "thread:updated", Revision: 1,
	})
	if err != nil || proj != nil {
		t.Fatalf("foreign-workspace thread must be an honest no-op: %+v %v", proj, err)
	}

	// Soft-deleted thread: deleted_at hides the row, still a no-op.
	if _, err := f.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`,
		f.clock.Now().UnixMilli(), threadID); err != nil {
		t.Fatal(err)
	}
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "thread", ObjectID: threadID,
		EventType: "thread:updated", Revision: 1,
	})
	if err != nil || proj != nil {
		t.Fatalf("soft-deleted thread must be an honest no-op: %+v %v", proj, err)
	}
}

// TestProjectPublicationThreadLookupFailureDefers proves the F2 regression:
// an infrastructure failure on the thread lookup must surface as an error
// (the publisher keeps the durable intent and retries), NOT as a completed
// no-op that permanently drops the thread:updated event.
//
// The failing lookup is produced by dropping the channels table on an empty
// fixture: the SELECT inside the read snapshot then fails with a real SQL
// error (not sql.ErrNoRows). The message branch on the same broken database
// still answers an honest no-op for a missing id, proving the snapshot is
// alive and the error is specific to the broken thread lookup.
func TestProjectPublicationThreadLookupFailureDefers(t *testing.T) {
	f := newFixture(t)
	if _, err := f.db.Exec(`DROP TABLE channels`); err != nil {
		t.Fatalf("break the thread lookup surface: %v", err)
	}

	// Control: the message projector's missing-fact path still completes
	// honestly on the same (messages table intact) snapshot.
	proj, err := f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "message", ObjectID: txMissingThread,
		EventType: "message:new", Revision: 1,
	})
	if err != nil || proj != nil {
		t.Fatalf("missing message must remain an honest no-op: %+v %v", proj, err)
	}

	// The broken thread lookup must defer: an error, never (nil, nil).
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "thread", ObjectID: txMissingThread,
		EventType: "thread:updated", Revision: 1,
	})
	if err == nil {
		t.Fatalf("thread lookup infrastructure failure must return an error to defer the intent, got no-op projection %+v", proj)
	}
	if proj != nil {
		t.Fatalf("failed projection must carry no payload: %+v", proj)
	}
}
