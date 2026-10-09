package messaging_test

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

// An immediate replay can hide a mistakenly repeated MarkReadLatest because
// its latest cursor is already equal. Rewind and explicitly unfollow first:
// now a repeated side effect would observably destroy a real user decision.
func TestSendHumanReplayPreservesSubsequentUnreadAndUnfollow(t *testing.T) {
	e := newAdvanceEnv(t)
	e.openThread()
	rid := "replay-keeps-later-user-intent"
	original, err := e.send("alice", e.threadID, "original reply", &rid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.send("bob", e.threadID, "newer unread reply", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.readstate.MarkUnread(t.Context(), e.claims("alice"), e.ws, e.threadID); err != nil {
		t.Fatal(err)
	}
	if err := platformdb.WithWriteTx(t.Context(), e.db, func(tx *sql.Tx) error {
		return e.channels.SetThreadFollowTx(t.Context(), tx, e.ws, e.threadID, "alice", false, false)
	}); err != nil {
		t.Fatal(err)
	}
	before := atomicDatabaseFacts(t, e.db)
	replayed, err := e.send("alice", e.threadID, "original reply", &rid)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Replayed || replayed.Message.ID != original.Message.ID || replayed.Message.Seq != original.Message.Seq {
		t.Fatal("replay did not return the original committed identity")
	}
	assertAtomicFactsUnchanged(t, before, atomicDatabaseFacts(t, e.db))
}

func TestSendHumanReadFailureRollsBackEarlierMessageAndFollow(t *testing.T) {
	e := newAdvanceEnv(t)
	e.openThread()
	if err := platformdb.WithWriteTx(t.Context(), e.db, func(tx *sql.Tx) error {
		return e.channels.SetThreadFollowTx(t.Context(), tx, e.ws, e.threadID, "alice", false, false)
	}); err != nil {
		t.Fatal(err)
	}
	installReadFailureAfterFacts(t, e.db, true)
	before := atomicDatabaseFacts(t, e.db)
	rid := "rolled-back-reply"
	_, err := e.send("alice", e.threadID, "atomic-failure-reply", &rid)
	assertInjectedReadFailure(t, err)
	assertAtomicFactsUnchanged(t, before, atomicDatabaseFacts(t, e.db))

	// Positive recovery: removing the test-only fault lets the SAME request
	// commit as a fresh message; failure must not consume its idempotency key.
	if _, err := e.db.ExecContext(t.Context(), `DROP TRIGGER regression_fail_read_insert`); err != nil {
		t.Fatal(err)
	}
	recovered, err := e.send("alice", e.threadID, "atomic-failure-reply", &rid)
	if err != nil || recovered == nil || recovered.Replayed {
		t.Fatalf("recovery after a fully rolled-back reply failed: %v", err)
	}
	if got, ok := e.maxRead("alice", e.threadID); !ok || got != recovered.Message.Seq {
		t.Fatal("recovered complete send omitted its required read effect")
	}
}

func TestCreateThreadFirstReplyReadFailureRollsBackEntireWorkflow(t *testing.T) {
	e := newAdvanceEnv(t)
	parent, err := e.send("alice", e.generalID, "parent before failing thread creation", nil)
	if err != nil {
		t.Fatal(err)
	}
	installReadFailureAfterFacts(t, e.db, true)
	before := atomicDatabaseFacts(t, e.db)
	_, err = e.svc.CreateThread(t.Context(), e.claims("alice"), e.ws, "alice", e.generalID,
		parent.Message.ID, true, "atomic-failure-reply")
	assertInjectedReadFailure(t, err)
	assertAtomicFactsUnchanged(t, before, atomicDatabaseFacts(t, e.db))
}

func TestFollowThreadReadFailureRollsBackThreadAndFollow(t *testing.T) {
	e := newAdvanceEnv(t)
	parent, err := e.send("alice", e.generalID, "parent before failing explicit follow", nil)
	if err != nil {
		t.Fatal(err)
	}
	installReadFailureAfterFacts(t, e.db, false)
	before := atomicDatabaseFacts(t, e.db)
	_, err = e.svc.FollowThread(t.Context(), e.claims("alice"), e.ws, "alice", parent.Message.ID)
	assertInjectedReadFailure(t, err)
	assertAtomicFactsUnchanged(t, before, atomicDatabaseFacts(t, e.db))
}

func installReadFailureAfterFacts(t *testing.T, handle *sql.DB, requireReply bool) {
	t.Helper()
	// The trigger deliberately verifies the earlier facts exist INSIDE the
	// failed transaction. Failing before any write is not equivalent evidence.
	messageCheck := ""
	if requireReply {
		messageCheck = `SELECT CASE WHEN NOT EXISTS (
			SELECT 1 FROM messages WHERE channel_id=NEW.channel_id AND content='atomic-failure-reply'
		) THEN RAISE(ABORT, 'regression fault did not observe earlier reply') END;`
	}
	_, err := handle.ExecContext(t.Context(), `CREATE TRIGGER regression_fail_read_insert
		BEFORE INSERT ON user_channel_read_states
		WHEN NEW.user_id='alice'
		BEGIN
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='thread'
			) THEN RAISE(ABORT, 'regression fault did not observe earlier thread') END;
			SELECT CASE WHEN NOT EXISTS (
				SELECT 1 FROM thread_follows WHERE thread_channel_id=NEW.channel_id
				AND user_id=NEW.user_id AND unfollowed_at IS NULL
			) THEN RAISE(ABORT, 'regression fault did not observe earlier follow') END;
			`+messageCheck+`
			SELECT RAISE(ABORT, 'injected read-state storage failure after earlier facts');
		END`)
	if err != nil {
		t.Fatal(err)
	}
}

func assertInjectedReadFailure(t *testing.T, err error) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "injected read-state storage failure after earlier facts") {
		t.Fatalf("expected the injected late read-state failure, got %v", err)
	}
}

// Snapshot EVERY real application table, including authority/activity state
// and publication references, not only messages count. The fixture has no
// background workers; only the tested operation can change these rows.
func atomicDatabaseFacts(t *testing.T, handle *sql.DB) map[string][]string {
	t.Helper()
	names, err := handle.QueryContext(t.Context(), `SELECT name FROM sqlite_schema
		WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for names.Next() {
		var name string
		if err := names.Scan(&name); err != nil {
			names.Close()
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	if err := names.Err(); err != nil {
		names.Close()
		t.Fatal(err)
	}
	names.Close()
	facts := map[string][]string{}
	for _, name := range tables {
		quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
		rows, err := handle.QueryContext(t.Context(), `SELECT * FROM `+quoted)
		if err != nil {
			t.Fatal(err)
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			t.Fatal(err)
		}
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		facts[name] = []string{}
		for rows.Next() {
			if err := rows.Scan(targets...); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			encoded, err := json.Marshal(values)
			if err != nil {
				rows.Close()
				t.Fatal(err)
			}
			facts[name] = append(facts[name], string(encoded))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		rows.Close()
		sort.Strings(facts[name])
	}
	return facts
}

func assertAtomicFactsUnchanged(t *testing.T, before, after map[string][]string) {
	t.Helper()
	if len(before) != len(after) {
		t.Error("operation changed the application table set")
	}
	for table, rows := range before {
		if !reflect.DeepEqual(rows, after[table]) {
			// Do not dump credential/session contents on a failed comparison.
			t.Errorf("operation unexpectedly changed durable rows in %s", table)
		}
	}
}
