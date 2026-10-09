package messaging_test

import (
	"testing"
)

// The durable intent sequence of one send must match the ORIGINAL pipeline's
// row order in realtime_publications: for a NEW thread reply the read_state
// and unread_summary wakes (emitted by the same-transaction read advance)
// commit BEFORE message:new and thread:updated, exactly like the baseline
// send path (auto-follow -> markReadLatest -> publication intents). A replay
// records nothing; a plain channel message records only message:new.
func TestSendHumanPublicationOrderMatchesBaseline(t *testing.T) {
	e := newAdvanceEnv(t)
	var cursor int64
	intents := func(step string, want [][3]string) [][3]string {
		t.Helper()
		rows, err := e.db.Query(`SELECT id, object_type, object_id, event_type, revision
			FROM realtime_publications WHERE id > ? ORDER BY id`, cursor)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var got [][3]string
		for rows.Next() {
			var id, revision int64
			var r [3]string
			if err := rows.Scan(&id, &r[0], &r[1], &r[2], &revision); err != nil {
				t.Fatal(err)
			}
			cursor = id
			got = append(got, r)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("%s: %d intents, want %d: %v", step, len(got), len(want), got)
		}
		for i, w := range want {
			g := got[i]
			if g[0] != w[0] || g[2] != w[2] || (w[1] != "" && g[1] != w[1]) {
				t.Fatalf("%s: intent %d = %v, want %v (full sequence %v)", step, i, g, w, got)
			}
		}
		return got
	}

	// A plain channel message: exactly one intent, message:new.
	parent, err := e.send("alice", e.generalID, "thread root", nil)
	if err != nil {
		t.Fatal(err)
	}
	intents("plain channel send", [][3]string{
		{"message", parent.Message.ID, "message:new"},
	})

	// Thread creation WITH its first reply: the thread appearance intent
	// (channel-owned, revision 1) commits first, then the reply's read
	// advance wakes, then the reply's message:new / thread:updated — the
	// baseline conversation worker's exact order.
	created, err := e.svc.CreateThread(t.Context(), e.claims("alice"), e.ws, "alice",
		e.generalID, parent.Message.ID, true, "first reply")
	if err != nil {
		t.Fatal(err)
	}
	intents("create thread with first reply", [][3]string{
		{"channel", created.ThreadID, "thread:updated"},        // thread appearance, revision 1 (channel-owned)
		{"thread_follow", "", "thread:followers-updated"},      // the parent author's follow intent
		{"read_state", created.ThreadID, "read_state:updated"}, // the reply's own read advance
		{"unread_summary", e.ws, "unread_summary:changed"},
		{"message", "", "message:new"}, // the first reply
		{"thread", created.ThreadID, "thread:updated"},
	})

	// A later thread reply through SendHuman keeps the same order: read
	// advance wakes BEFORE the message/thread intents.
	rid := "order-reply-1"
	reply, err := e.send("bob", created.ThreadID, "second reply", &rid)
	if err != nil {
		t.Fatal(err)
	}
	intents("second thread reply", [][3]string{
		{"thread_follow", "", "thread:followers-updated"},      // the replier's auto-follow
		{"read_state", created.ThreadID, "read_state:updated"}, // his own read advance
		{"unread_summary", e.ws, "unread_summary:changed"},
		{"message", reply.Message.ID, "message:new"},
		{"thread", created.ThreadID, "thread:updated"},
	})

	// A replay adds no rows at all.
	if _, err := e.send("bob", created.ThreadID, "second reply", &rid); err != nil {
		t.Fatal(err)
	}
	intents("replay", nil)

	// A plain channel message still records only message:new.
	if _, err := e.send("alice", e.generalID, "not a thread", nil); err != nil {
		t.Fatal(err)
	}
	intents("second channel message", [][3]string{
		{"message", "", "message:new"},
	})
}

// The reply's thread:updated revision is the reply's own seq (the original
// emit's revision source) and message:new keeps revision 1; the read_state
// wake carries the advanced version.
func TestSendHumanIntentRevisionsMatchBaseline(t *testing.T) {
	e := newAdvanceEnv(t)
	parent, err := e.send("alice", e.generalID, "thread root", nil)
	if err != nil {
		t.Fatal(err)
	}
	created, err := e.svc.CreateThread(t.Context(), e.claims("alice"), e.ws, "alice",
		e.generalID, parent.Message.ID, true, "first reply")
	if err != nil {
		t.Fatal(err)
	}
	var threadRev int64
	if err := e.db.QueryRow(`SELECT revision FROM realtime_publications
		WHERE object_type = 'thread' AND event_type = 'thread:updated'
		  AND object_id = ? AND revision > 1`, created.ThreadID).Scan(&threadRev); err != nil {
		t.Fatal(err)
	}
	var lastSeq int64
	if err := e.db.QueryRow(`SELECT MAX(seq) FROM messages WHERE channel_id = ?`, created.ThreadID).Scan(&lastSeq); err != nil {
		t.Fatal(err)
	}
	if threadRev != lastSeq {
		t.Fatalf("reply thread:updated revision = %d, want the reply seq %d", threadRev, lastSeq)
	}
	var msgRev int64
	if err := e.db.QueryRow(`SELECT revision FROM realtime_publications
		WHERE object_type = 'message' AND event_type = 'message:new' AND object_id =
		  (SELECT id FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1)`, created.ThreadID).Scan(&msgRev); err != nil {
		t.Fatal(err)
	}
	if msgRev != 1 {
		t.Fatalf("message:new revision = %d, want 1", msgRev)
	}
}
