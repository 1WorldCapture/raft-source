package app

// Outbox publisher tests: every case drives a REAL domain mutation (message /
// channel / readstate store over the real migration set), lets the commit
// listener wake the real outbox worker, and asserts the frames the assembled
// gateway delivered — payload shapes, privacy classes and authorized
// audiences. Process state, negative and failpoint cases included; no TCP.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	apprealtime "raft.local/server-go/internal/application/realtime"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/publication"
	"raft.local/server-go/internal/transport/socketio/core"
)

// ensureThread creates (or resolves) the thread of a parent message.
func (f *rtFixture) ensureThread(parentMessageID string) string {
	f.t.Helper()
	var threadID string
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		thread, err := f.runtime.channels.EnsureThreadTx(context.Background(), tx, rtWS, rtGeneral, parentMessageID, rtAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	})
	if err != nil {
		f.t.Fatalf("ensure thread: %v", err)
	}
	return threadID
}

func (f *rtFixture) followThread(threadID, user string, follow bool) {
	f.t.Helper()
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return f.runtime.channels.SetThreadFollowTx(context.Background(), tx, rtWS, threadID, user, follow, false)
	})
	if err != nil {
		f.t.Fatalf("set thread follow: %v", err)
	}
}

// firstPayload waits for the first frame of event on connID and decodes it.
func firstPayload(t *testing.T, f *rtFixture, connID, event string) map[string]any {
	t.Helper()
	var out map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		raw := f.transport.payloads(connID, event)
		if len(raw) == 0 {
			return false
		}
		if err := json.Unmarshal(raw[len(raw)-1], &out); err != nil {
			t.Fatalf("decode %s: %v", event, err)
		}
		return true
	}, event+" delivered to "+connID)
	return out
}

// settle gives late deliveries a moment before negative assertions.
func settle() { time.Sleep(150 * time.Millisecond) }

func hasKeys(payload map[string]any, keys ...string) bool {
	for _, k := range keys {
		if _, ok := payload[k]; !ok {
			return false
		}
	}
	return true
}

func lacksKeys(payload map[string]any, keys ...string) bool {
	for _, k := range keys {
		if _, ok := payload[k]; ok {
			return false
		}
	}
	return true
}

// ---- shared message facts --------------------------------------------------

func TestM4PublisherSharedMessageNewAndUnreadSummary(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)

	created := f.create(rtAlice, rtGeneral, "hello")

	aliceNew := firstPayload(t, f, "alice", core.EventMessageNew)
	if aliceNew["id"] != created.ID || aliceNew["channelId"] != rtGeneral {
		t.Fatalf("message:new coordinates: %v/%v", aliceNew["id"], aliceNew["channelId"])
	}
	if _, ok := aliceNew["seq"].(float64); !ok {
		t.Fatalf("seq must be a JSON number: %T", aliceNew["seq"])
	}
	// Sealed socket projection: storage-only columns are REMOVED on this
	// event surface (unlike resume rows, which seal by null).
	if !lacksKeys(aliceNew, "searchText", "agentSendKey", "searchVector", "senderHandle") {
		t.Fatalf("sealed columns present on message:new: %v", aliceNew)
	}
	cc, ok := aliceNew["conversationContext"].(map[string]any)
	if !ok || cc["channelType"] != "channel" {
		t.Fatalf("conversationContext: %v", aliceNew["conversationContext"])
	}

	// The same shared payload reached the other room member.
	bobNew := firstPayload(t, f, "bob", core.EventMessageNew)
	if bobNew["id"] != created.ID {
		t.Fatalf("bob message:new id: %v", bobNew["id"])
	}

	// Unread invalidation: the counting audience EXCLUDING the sender.
	bobSummary := firstPayload(t, f, "bob", core.EventUnreadSummary)
	if bobSummary["serverId"] != rtWS || !lacksKeys(bobSummary, "count", "unreadCount") {
		t.Fatalf("unread summary hint shape: %v", bobSummary)
	}
	settle()
	if got := f.transport.payloads("alice", core.EventUnreadSummary); len(got) != 0 {
		t.Fatalf("sender must not be invalidated for own message: %v", got)
	}
}

func TestM4PublisherThreadLiveRules(t *testing.T) {
	f := newRTFixture(t, nil)
	// Authority design note: thread creation bumps the workspace epoch and
	// evicts every workspace socket, so the thread is created BEFORE any
	// connection exists; only the REPLY (a message fact, no epoch bump) is
	// delivered live.
	parent := f.create(rtAlice, rtSecret, "private root")
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		thread, err := f.runtime.channels.EnsureThreadTx(context.Background(), tx, rtWS, rtSecret, parent.ID, rtAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)

	// Alice (author) auto-followed at ensure time; bob is a roster member of
	// the private parent (base-authorized, free to join the room) but does
	// NOT follow. He explicitly joins the thread room.
	f.send("bob", core.EventJoinChannel, threadID)
	settle()
	f.create(rtAlice, threadID, "private reply")

	// Alice (active follower) receives the reply live. The parent message's
	// own intent may replay here too (a stale serial defers it past the
	// thread-creation commit), so assert on the THREAD's frame specifically.
	var aliceNew map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads("alice", core.EventMessageNew) {
			var p map[string]any
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if p["channelId"] == threadID {
				aliceNew = p
				return true
			}
		}
		return false
	}, "alice receives the thread reply live")
	cc := aliceNew["conversationContext"].(map[string]any)
	if cc["channelType"] != "thread" || cc["parentMessageId"] != parent.ID {
		t.Fatalf("thread conversation context: %v", cc)
	}
	settle()
	// Bob — in the ROOM but not a follower — must receive NOTHING for this
	// private-parent thread, not the reply and not the thread summary.
	for _, ev := range f.transport.events("bob") {
		switch ev {
		case core.EventMessageNew, core.EventThreadUpdated, core.EventThreadFollowers:
			for _, raw := range f.transport.payloads("bob", ev) {
				var p map[string]any
				if err := json.Unmarshal(raw, &p); err != nil {
					t.Fatal(err)
				}
				if p["channelId"] == threadID || p["threadChannelId"] == threadID {
					t.Fatalf("private-parent thread event leaked to non-follower room member: %s %v", ev, p)
				}
			}
		}
	}
}

func TestM4PublisherPublicThreadIncludesExplicitViewers(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "public root")
	threadID := f.ensureThread(parent.ID) // epoch bump: before connections
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	// Bob never follows; he only joins the (public-parent) thread room.
	f.send("bob", core.EventJoinChannel, threadID)
	settle()
	reply := f.create(rtAlice, threadID, "public reply")

	// A pre-connection parent intent may legitimately retry after the
	// thread-creation authority commit. Wait for the target ID rather than
	// treating the first unrelated message:new frame as the thread reply.
	for _, connID := range []string{"alice", "bob"} {
		rtWaitUntil(t, 15*time.Second, func() bool {
			for _, raw := range f.transport.payloads(connID, core.EventMessageNew) {
				var payload map[string]any
				if err := json.Unmarshal(raw, &payload); err != nil {
					t.Fatal(err)
				}
				if payload["id"] == reply.ID && payload["channelId"] == threadID {
					return true
				}
			}
			return false
		}, "public-parent thread reply reaches follower/viewer "+connID)
	}
}

// ---- viewer-private reaction state ----------------------------------------

func TestM4PublisherReactionViewerIsPrivateToSubject(t *testing.T) {
	f := newRTFixture(t, nil)
	created := f.create(rtAlice, rtGeneral, "react to me")
	f.connect("alice-ws", rtAlice, rtWS)
	f.connect("alice-acct", rtAlice, "")
	f.connect("bob", rtBob, rtWS)

	if _, err := f.runtime.messages.AddReaction(context.Background(), message.NewClaims(rtClaims(rtAlice)),
		rtWS, created.ID, "tada"); err != nil {
		t.Fatal(err)
	}
	viewer := firstPayload(t, f, "alice-ws", core.EventReactionViewer)
	if viewer["messageId"] != created.ID || viewer["serverId"] != rtWS {
		t.Fatalf("viewer snapshot: %v", viewer)
	}
	if _, ok := viewer["viewerVersion"].(float64); !ok {
		t.Fatalf("viewerVersion must be a number: %v", viewer["viewerVersion"])
	}
	emojis, ok := viewer["reactedEmojis"].([]any)
	if !ok || len(emojis) != 1 || emojis[0] != "tada" {
		t.Fatalf("reactedEmojis: %v", viewer["reactedEmojis"])
	}
	settle()
	// The account-level socket of the SAME user (no workspace binding) and
	// other members never see viewer-private state.
	if got := f.transport.payloads("alice-acct", core.EventReactionViewer); len(got) != 0 {
		t.Fatalf("viewer snapshot crossed workspace binding: %v", got)
	}
	if got := f.transport.payloads("bob", core.EventReactionViewer); len(got) != 0 {
		t.Fatalf("viewer snapshot leaked to another member: %v", got)
	}
	// The reaction mutation ALSO bumps the shared aggregate: message:updated
	// reaches the room, sealed, without any viewer-private field.
	updated := firstPayload(t, f, "bob", core.EventMessageUpdated)
	if !lacksKeys(updated, "searchText", "agentSendKey", "searchVector", "senderHandle") {
		t.Fatalf("sealed columns on message:updated: %v", updated)
	}
	if _, ok := updated["reactionViewer"]; ok {
		t.Fatalf("viewer state must not ride the shared aggregate")
	}
}

// ---- DM appearance ----------------------------------------------------------

func TestM4PublisherDMNewReachesParticipantsOnly(t *testing.T) {
	f := newRTFixture(t, nil)
	// The DM channel is created BEFORE connections exist: its creation
	// bumps the workspace authority epoch, which evicts every workspace
	// socket (the approved conservative design); live dm:new can only land
	// on connections that survive. Requeue the exact durable intent shape
	// (channel worker key: object channel / event dm:new / revision =
	// transition millis) to exercise the delivery path deterministically.
	var dmID string
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		dm, err := f.runtime.channels.EnsureDMTx(context.Background(), tx, rtWS, rtAlice, rtBob)
		if err != nil {
			return err
		}
		dmID = dm.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	f.connect("cara", rtCara, rtWS)
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(context.Background(), tx, publication.Publication{
			WorkspaceID: rtWS, ObjectType: "channel", ObjectID: dmID,
			EventType: "dm:new", Revision: time.Now().UnixMilli(), ScopeID: dmID,
		})
	}); err != nil {
		t.Fatal(err)
	}
	aliceDM := firstPayload(t, f, "alice", core.EventDMNew)
	if aliceDM["channelId"] != dmID || !lacksKeys(aliceDM, "name", "members", "kind") {
		t.Fatalf("dm:new must be exactly {channelId}: %v", aliceDM)
	}
	firstPayload(t, f, "bob", core.EventDMNew)
	settle()
	if got := f.transport.payloads("cara", core.EventDMNew); len(got) != 0 {
		t.Fatalf("dm:new leaked to a non-participant: %v", got)
	}
}

// ---- thread summary / follower interest --------------------------------------

func TestM4PublisherThreadUpdatedCarriesSummaryFacts(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	threadID := f.ensureThread(parent.ID) // epoch bump: before connections
	f.followThread(threadID, rtBob, true) // bob's user epoch bump: pre-connect
	f.create(rtAlice, threadID, "first reply")
	f.connect("bob", rtBob, rtWS)
	f.create(rtAlice, threadID, "second reply")

	// The outbox may deliver the creation/reply-1 intents before the second
	// reply commits; the CURRENT-fact projection converges — wait for the
	// frame that reflects both replies.
	var payload map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads("bob", core.EventThreadUpdated) {
			var p map[string]any
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if rc, _ := p["replyCount"].(float64); rc >= 2 {
				payload = p
				return true
			}
		}
		return false
	}, "thread:updated converges to the current reply count")
	if payload["threadChannelId"] != threadID || payload["parentMessageId"] != parent.ID {
		t.Fatalf("thread:updated anchors: %v", payload)
	}
	if payload["serverId"] != rtWS {
		t.Fatalf("thread:updated serverId: %v", payload["serverId"])
	}
	if payload["lastReplyAt"] == nil {
		t.Fatalf("lastReplyAt missing")
	}
}

func TestM4PublisherFollowersUpdatedHint(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	threadID := f.ensureThread(parent.ID) // epoch bump: before connections
	f.connect("bob", rtBob, rtWS)
	f.send("bob", core.EventJoinChannel, threadID)
	settle()
	// A different user's follow mutates only that user's epoch; bob's
	// connection survives and receives the authorized-audience hint.
	f.followThread(threadID, rtAlice, true)

	payload := firstPayload(t, f, "bob", core.EventThreadFollowers)
	if payload["threadChannelId"] != threadID || !lacksKeys(payload, "followers", "users") {
		t.Fatalf("followers hint must be exactly {threadChannelId}: %v", payload)
	}
}

// ---- readstate private events -------------------------------------------------

func TestM4PublisherReadStateEventsAreUserWorkspacePrivate(t *testing.T) {
	f := newRTFixture(t, nil)
	created := f.create(rtAlice, rtGeneral, "to read")
	f.connect("bob-ws", rtBob, rtWS)
	f.connect("bob-acct", rtBob, "")
	f.connect("alice", rtAlice, rtWS)

	if _, err := f.runtime.readstate.MarkRead(context.Background(), rtClaims(rtBob), rtWS, rtGeneral, created.Seq); err != nil {
		t.Fatal(err)
	}
	read := firstPayload(t, f, "bob-ws", core.EventReadState)
	if read["serverId"] != rtWS || read["scopeId"] != rtGeneral {
		t.Fatalf("read_state scope: %v", read)
	}
	if read["maxReadSeq"].(float64) != float64(created.Seq) {
		t.Fatalf("maxReadSeq: %v", read["maxReadSeq"])
	}
	if read["readStateVersion"].(float64) < 1 {
		t.Fatalf("readStateVersion must be real: %v", read["readStateVersion"])
	}
	// The read ALSO invalidates the actor's own unread summary.
	firstPayload(t, f, "bob-ws", core.EventUnreadSummary)
	settle()
	if got := f.transport.payloads("bob-acct", core.EventReadState); len(got) != 0 {
		t.Fatalf("read state crossed the workspace binding: %v", got)
	}
	if got := f.transport.payloads("alice", core.EventReadState); len(got) != 0 {
		t.Fatalf("read state leaked to another user: %v", got)
	}
}

func TestM4PublisherBulkReadAndPrefsEvents(t *testing.T) {
	f := newRTFixture(t, nil)
	first := f.create(rtAlice, rtGeneral, "one")
	second := f.create(rtAlice, rtSecret, "two")
	f.connect("bob", rtBob, rtWS)

	if _, err := f.runtime.readstate.MarkInboxReadLatest(context.Background(), rtClaims(rtBob), rtWS); err != nil {
		t.Fatal(err)
	}
	// readstate deliberately enqueues per-scope read_state intents only (the
	// scope list of a bulk event is request state, not a durable object).
	// Both changed scopes must arrive as their own versioned events.
	seen := map[string]bool{}
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads("bob", core.EventReadState) {
			var p map[string]any
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if id, _ := p["scopeId"].(string); id != "" {
				seen[id] = true
			}
		}
		return seen[rtGeneral] && seen[rtSecret]
	}, "per-scope read_state events for the read-all set")
	if maxRead, _ := first.Seq, 0; maxRead >= second.Seq {
		t.Fatalf("fixture ordering")
	}
	// The bulk projector stays wired for the durable intent shape; drive it
	// with the exact key readstate used to write (object read_state_bulk,
	// revision = millis) and assert the projected scopes match current rows.
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(context.Background(), tx, publication.Publication{
			WorkspaceID: rtWS, ObjectType: "read_state_bulk", ObjectID: rtWS,
			EventType: "read_state:updated_bulk", Revision: time.Now().UnixMilli(),
			SubjectUserID: rtBob, ScopeID: rtWS,
		})
	}); err != nil {
		t.Fatal(err)
	}
	bulk := firstPayload(t, f, "bob", core.EventReadStateBulk)
	scopes, ok := bulk["scopes"].([]any)
	if !ok || len(scopes) < 2 {
		t.Fatalf("bulk scopes must cover the read set: %v", bulk["scopes"])
	}
	covered := map[string]bool{}
	for _, raw := range scopes {
		scope := raw.(map[string]any)
		if !hasKeys(scope, "scopeId", "maxReadSeq", "readStateVersion") {
			t.Fatalf("bulk scope shape: %v", scope)
		}
		covered[scope["scopeId"].(string)] = true
	}
	if !covered[rtGeneral] || !covered[rtSecret] {
		t.Fatalf("bulk scopes missing channels: %v", covered)
	}

	mute, err := f.runtime.readstate.SetNotificationSettings(context.Background(), rtClaims(rtBob), rtWS, rtGeneral, true)
	if err != nil {
		t.Fatal(err)
	}
	prefs := firstPayload(t, f, "bob", core.EventNotifPrefs)
	if prefs["scopeId"] != rtGeneral || prefs["serverId"] != rtWS {
		t.Fatalf("prefs scope: %v", prefs)
	}
	inner := prefs["prefs"].(map[string]any)
	if inner["activityMuted"] != true || inner["muteFromSeq"] == nil {
		t.Fatalf("mute prefs: %v", inner)
	}
	if prefs["prefsVersion"].(float64) != float64(mute.PrefsVersion) {
		t.Fatalf("prefsVersion: %v vs %v", prefs["prefsVersion"], mute.PrefsVersion)
	}

	display, err := f.runtime.readstate.SetDisplaySettings(context.Background(), rtClaims(rtBob), rtWS, rtGeneral, false)
	if err != nil {
		t.Fatal(err)
	}
	dp := firstPayload(t, f, "bob", core.EventDisplayPrefs)
	dinner := dp["prefs"].(map[string]any)
	if dinner["collapseLongMessages"] != false {
		t.Fatalf("display prefs: %v", dinner)
	}
	if dp["prefsVersion"].(float64) != float64(display.PrefsVersion) {
		t.Fatalf("display prefsVersion: %v vs %v", dp["prefsVersion"], display.PrefsVersion)
	}
}

// ---- completion / failpoint semantics ------------------------------------------

func TestM4PublisherDeletedFactCompletesWithoutDelivery(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("bob", rtBob, rtWS)
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(context.Background(), tx, publication.Publication{
			WorkspaceID: rtWS, ObjectType: "message", ObjectID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			EventType: "message:new", Revision: 1,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 15*time.Second, func() bool {
		var pending int
		if err := f.handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NULL`).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		return pending == 0
	}, "deleted-fact publication completed")
	settle()
	if got := f.transport.payloads("bob", core.EventMessageNew); len(got) != 0 {
		t.Fatalf("deleted fact delivered: %v", got)
	}
	stats := f.rt.Stats()
	if stats.Publisher.Completed < 1 {
		t.Fatalf("completed counter: %+v", stats.Publisher)
	}
}

func TestM4PublisherUnknownIntentStaysPending(t *testing.T) {
	f := newRTFixture(t, nil)
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(context.Background(), tx, publication.Publication{
			WorkspaceID: rtWS, ObjectType: "bogus", ObjectID: "x", EventType: "nope", Revision: 1,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	// Wait on the DURABLE row state, not the in-memory counter: the store
	// marks the retry in its own transaction after publish returned.
	rtWaitUntil(t, 15*time.Second, func() bool {
		var attempts int
		var published sql.NullInt64
		if err := f.handle.QueryRow(`SELECT attempts, published_at FROM realtime_publications
			WHERE workspace_id = ? AND object_type = 'bogus'`, rtWS).Scan(&attempts, &published); err != nil {
			t.Fatal(err)
		}
		return attempts >= 1 && !published.Valid
	}, "unknown intent deferred and still pending")
	if stats := f.rt.Stats(); stats.Publisher.Unknown < 1 {
		t.Fatalf("unknown counter: %+v", stats.Publisher)
	}
}

func TestM4PublisherTransientDatabaseFailureDefers(t *testing.T) {
	// A second, isolated assembly whose database goes away: every projection
	// read fails, the publication must be DEFERRED (error), never marked
	// processed, and the store keeps the durable intent.
	handle, err := db.Open(t.TempDir() + "/raft.db")
	if err != nil {
		t.Fatal(err)
	}
	channels := channel.NewStoreWithOptions(handle, channel.Options{})
	runtime, err := buildChat(handle, channels, keys.NewRoot([]byte(rtSecretKey)))
	if err != nil {
		t.Fatal(err)
	}
	signer := auth.NewTokenSigner([]byte(rtSecretKey), 15*time.Minute)
	rt, err := assembleRealtime(runtime, signer, realtimeConfig{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, newRecordingTransport())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rt.Close() }()
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}

	ref := publication.Publication{WorkspaceID: rtWS, ObjectType: "message",
		ObjectID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", EventType: "message:new", Revision: 1}
	if err := rt.pub.Publish(context.Background(), ref); err == nil {
		t.Fatalf("transient database failure must defer, not fake success")
	}
	if stats := rt.Stats(); stats.Publisher.Deferred != 1 {
		t.Fatalf("deferred counter: %+v", stats.Publisher)
	}
	// The store-level drain fails too and retains the intent.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := runtime.publications.DrainOnce(ctx, rt.pub.Publish); err == nil {
		t.Fatalf("drain against a closed database must fail")
	}
}

// ---- review-driven semantics: serial binding, dm activity, parking ------

func TestM4PublisherStaleAudienceSerialStopsDelivery(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)

	// Resolve the policy audience under the CURRENT authority serial...
	audience, exists, err := f.rt.pub.ResolveConversationAudience(context.Background(), rtWS, rtGeneral)
	if err != nil || !exists {
		t.Fatalf("audience: %v %v", exists, err)
	}
	if _, ok := audience.Live[rtBob]; !ok {
		t.Fatalf("bob must be in the live policy set of a public channel")
	}
	// ...then a permission-relevant commit lands BEFORE the guarded publish.
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE channels SET name = 'general-flipped' WHERE id = ?`, rtGeneral)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// The serial binding inside the guarded predicate must refuse every send
	// for the stale audience snapshot (no newly-valid connection can accept
	// a pre-change audience).
	f.rt.pub.Deliver(audience, rtWS, core.EventMessageNew, map[string]any{"id": "stale"})
	settle()
	if got := f.transport.payloads("alice", core.EventMessageNew); len(got) != 0 {
		t.Fatalf("stale audience delivered to alice: %v", got)
	}
	if got := f.transport.payloads("bob", core.EventMessageNew); len(got) != 0 {
		t.Fatalf("stale audience delivered to bob: %v", got)
	}

	// The permission-relevant commit also evicted the workspace sockets (the
	// conservative 0012 design); a reconnected socket is admitted under the
	// NEW authority, and a freshly resolved audience delivers to it.
	f.connect("bob2", rtBob, rtWS)
	fresh, exists, err := f.rt.pub.ResolveConversationAudience(context.Background(), rtWS, rtGeneral)
	if err != nil || !exists {
		t.Fatalf("fresh audience: %v %v", exists, err)
	}
	f.rt.pub.Deliver(fresh, rtWS, core.EventMessageNew, map[string]any{"id": "fresh"})
	rtWaitUntil(t, 15*time.Second, func() bool {
		return len(f.transport.payloads("bob2", core.EventMessageNew)) > 0
	}, "fresh audience delivers")
}

func TestM4PublisherDMMessageActivityAnnouncesDMNew(t *testing.T) {
	f := newRTFixture(t, nil)
	var dmID string
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		dm, err := f.runtime.channels.EnsureDMTx(context.Background(), tx, rtWS, rtAlice, rtBob)
		if err != nil {
			return err
		}
		dmID = dm.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	f.connect("cara", rtCara, rtWS)

	f.create(rtAlice, dmID, "dm hello")

	// Both participants get the message live; the passive peer ALSO gets the
	// {channelId} re-announcement exactly like the original pipeline.
	firstPayload(t, f, "bob", core.EventMessageNew)
	dm := firstPayload(t, f, "bob", core.EventDMNew)
	if dm["channelId"] != dmID {
		t.Fatalf("dm:new channelId: %v", dm["channelId"])
	}
	firstPayload(t, f, "alice", core.EventMessageNew)
	settle()
	if got := f.transport.payloads("cara", core.EventMessageNew); len(got) != 0 {
		t.Fatalf("dm message leaked to a non-participant: %v", got)
	}
	if got := f.transport.payloads("cara", core.EventDMNew); len(got) != 0 {
		t.Fatalf("dm:new leaked to a non-participant: %v", got)
	}
}

func TestM4PublisherThreadUpdatedHasNoReceiverPrivateFields(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	threadID := f.ensureThread(parent.ID)
	f.followThread(threadID, rtBob, true)
	f.create(rtAlice, threadID, "reply")
	f.connect("bob", rtBob, rtWS)
	f.create(rtAlice, threadID, "another reply")

	var payload map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads("bob", core.EventThreadUpdated) {
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			return true
		}
		return false
	}, "thread:updated delivered")
	// Shared aggregate only: per-receiver unread projections never ride a
	// broadcast thread event.
	for _, key := range []string{"unreadCount", "firstUnreadMessageId", "readState", "maxReadSeq"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("receiver-private field %q on thread:updated: %v", key, payload)
		}
	}
}

func TestM4PublisherUnknownIntentParksAfterRetryBudget(t *testing.T) {
	f := newRTFixture(t, nil)
	before := f.rt.Stats().Publisher
	// Under the budget: deferred (stays pending).
	err := f.rt.pub.Dispatch(context.Background(), publication.Publication{
		WorkspaceID: rtWS, ObjectType: "bogus", ObjectID: "x", EventType: "nope", Revision: 1, Attempts: 0})
	var unknown *apprealtime.ErrUnknownPublication
	if !errors.As(err, &unknown) {
		t.Fatalf("under-budget unknown must defer: %v", err)
	}
	// At/over the budget: parked (processed) with the dedicated counter —
	// never silently, and never occupying the bounded backlog forever.
	if err := f.rt.pub.Dispatch(context.Background(), publication.Publication{
		WorkspaceID: rtWS, ObjectType: "bogus", ObjectID: "x", EventType: "nope", Revision: 1,
		Attempts: apprealtime.UnknownParkAttempts}); err != nil {
		t.Fatalf("over-budget unknown must park: %v", err)
	}
	after := f.rt.Stats().Publisher
	if after.Parked != before.Parked+1 {
		t.Fatalf("parked counter: %d -> %d", before.Parked, after.Parked)
	}
}

// ---- review round 2: message:updated context + channel state events ------

func TestM4PublisherMessageUpdatedThreadContextFromReaction(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	threadID := f.ensureThread(parent.ID) // epoch bump: before connections
	f.create(rtAlice, threadID, "reply")
	f.connect("bob", rtBob, rtWS)
	// Match the original messageService.ts producer's channel-room fanout:
	// this test exercises an explicit thread viewer, not a passive socket.
	f.send("bob", core.EventJoinChannel, threadID)
	settle()

	// A reaction on the thread reply bumps the shared aggregate: the
	// message:update broadcast must still classify the thread scope.
	if _, err := f.runtime.messages.AddReaction(context.Background(), message.NewClaims(rtClaims(rtAlice)),
		rtWS, latestMessageID(t, f, threadID), "tada"); err != nil {
		t.Fatal(err)
	}
	var updated map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads("bob", core.EventMessageUpdated) {
			var p map[string]any
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if p["channelId"] == threadID {
				updated = p
				return true
			}
		}
		return false
	}, "thread message:updated delivered")
	cc, ok := updated["conversationContext"].(map[string]any)
	if !ok || cc["channelType"] != "thread" || cc["parentMessageId"] != parent.ID {
		t.Fatalf("thread conversation context on message:updated: %v", updated["conversationContext"])
	}
	for _, sealed := range []string{"searchText", "agentSendKey", "searchVector", "senderHandle"} {
		if _, present := updated[sealed]; present {
			t.Fatalf("sealed column %q on message:updated", sealed)
		}
	}
	for _, private := range []string{"reactionViewer", "readState", "activityMuted"} {
		if _, present := updated[private]; present {
			t.Fatalf("viewer-private field %q leaked onto message:updated", private)
		}
	}
	// The actor's own viewer-private snapshot is a separate event that bob
	// never sees (bob has no alice-subject socket here).
	settle()
	if got := f.transport.payloads("bob", core.EventReactionViewer); len(got) != 0 {
		t.Fatalf("viewer snapshot leaked to another member: %v", got)
	}
}

// latestMessageID returns the newest committed message id in a channel.
func latestMessageID(t *testing.T, f *rtFixture, channelID string) string {
	t.Helper()
	var id string
	if err := f.handle.QueryRow(`SELECT id FROM messages
		WHERE workspace_id = ? AND channel_id = ? ORDER BY seq DESC LIMIT 1`, rtWS, channelID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// enqueueChannelIntent requeues the channel worker's exact durable intent
// shape post-connection. Real producer paths commit together with an
// authority bump that (by the conservative 0012 design) evicts every
// workspace socket first, so live frames can only land on connections that
// survive; the intent/vocabulary tested here is byte-identical to what
// internal/channel/publications.go writes.
func (f *rtFixture) enqueueChannelIntent(t *testing.T, event, channelID, subject string) {
	t.Helper()
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(context.Background(), tx, publication.Publication{
			WorkspaceID:   rtWS,
			ObjectType:    "channel",
			ObjectID:      channelID,
			EventType:     event,
			Revision:      time.Now().UnixMilli(),
			SubjectUserID: subject,
			ScopeID:       channelID,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
}

func channelEventPayload(t *testing.T, f *rtFixture, connID, event, channelID string) map[string]any {
	t.Helper()
	var found map[string]any
	rtWaitUntil(t, 15*time.Second, func() bool {
		for _, raw := range f.transport.payloads(connID, event) {
			var payload map[string]any
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatalf("decode %s: %v", event, err)
			}
			id, _ := payload["channelId"].(string)
			if ch, ok := payload["channel"].(map[string]any); ok {
				id, _ = ch["id"].(string)
			}
			if id == channelID {
				found = payload
				return true
			}
		}
		return false
	}, event+" for the expected channel delivered to "+connID)
	return found
}

func waitChannelIntents(t *testing.T, f *rtFixture, channelID string) {
	t.Helper()
	rtWaitUntil(t, 15*time.Second, func() bool {
		var pending int
		if err := f.handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications
			WHERE object_type = 'channel' AND object_id = ? AND published_at IS NULL`, channelID).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		return pending == 0
	}, "channel intents completed")
}

func TestM4PublisherChannelUpdatedAudiencesAndPayload(t *testing.T) {
	f := newRTFixture(t, nil)
	// Real producer integration: creation writes the durable intent on the
	// same transaction and the outbox completes it (delivery races the
	// creation-time workspace eviction by design).
	town, err := f.runtime.channels.CreateChannel(context.Background(), channel.CreateInput{
		WorkspaceID: rtWS, Name: "town-square", Type: channel.TypeChannel,
		CreatorUserID: rtAlice, InitialUserIDs: []string{rtBob},
	})
	if err != nil {
		t.Fatal(err)
	}
	war, err := f.runtime.channels.CreateChannel(context.Background(), channel.CreateInput{
		WorkspaceID: rtWS, Name: "warroom", Type: channel.TypePrivate,
		CreatorUserID: rtAlice, InitialUserIDs: []string{rtBob},
	})
	if err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 15*time.Second, func() bool {
		var pending int
		if err := f.handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications
			WHERE object_type = 'channel' AND event_type = 'channel:updated' AND published_at IS NULL`).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		return pending == 0
	}, "creation intents completed")

	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	f.connect("cara", rtCara, rtWS)

	// Public channel: server-wide policy audience (cara is a member without
	// any roster row and still receives the current projection).
	f.enqueueChannelIntent(t, channel.PublicationEventChannelUpdated, town.ID, "")
	aliceFrame := channelEventPayload(t, f, "alice", core.EventChannelUpdated, town.ID)
	inner := aliceFrame["channel"].(map[string]any)
	if inner["id"] != town.ID || inner["name"] != "town-square" || inner["serverId"] != rtWS || inner["type"] != "channel" {
		t.Fatalf("channel:updated payload: %v", inner)
	}
	channelEventPayload(t, f, "cara", core.EventChannelUpdated, town.ID)
	// Raw row projection only: viewer-private enrichment never rides the
	// broadcast.
	for _, private := range []string{"readState", "maxReadSeq", "activityMuted", "collapseLongMessages", "joined"} {
		if _, present := inner[private]; present {
			t.Fatalf("viewer-private field %q on broadcast channel:updated", private)
		}
	}

	// Private channel: roster-only audience; cara never receives.
	f.enqueueChannelIntent(t, channel.PublicationEventChannelUpdated, war.ID, "")
	bobFrame := channelEventPayload(t, f, "bob", core.EventChannelUpdated, war.ID)
	if bobFrame["channel"].(map[string]any)["id"] != war.ID {
		t.Fatalf("private channel:updated id: %v", bobFrame["channel"])
	}
	caraPublic := len(f.transport.payloads("cara", core.EventChannelUpdated))
	settle()
	if got := len(f.transport.payloads("cara", core.EventChannelUpdated)); got != caraPublic {
		t.Fatalf("private channel:updated leaked to a non-roster member (%d -> %d frames)", caraPublic, got)
	}
}

func TestM4PublisherMembersUpdatedPairAndTargetedJoin(t *testing.T) {
	f := newRTFixture(t, nil)
	war, err := f.runtime.channels.CreateChannel(context.Background(), channel.CreateInput{
		WorkspaceID: rtWS, Name: "warroom", Type: channel.TypePrivate,
		CreatorUserID: rtAlice, InitialUserIDs: []string{rtBob},
	})
	if err != nil {
		t.Fatal(err)
	}
	if added, err := f.runtime.channels.AddHumanTx(context.Background(), war.ID, rtCara, "member"); err != nil || !added {
		t.Fatalf("real membership gain before delivery: added=%v err=%v", added, err)
	}
	waitChannelIntents(t, f, war.ID)

	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	f.connect("cara", rtCara, rtWS)

	// Membership GAINED for cara: the members-updated pair. Roster audience
	// (private) receives {channelId}; cara additionally receives the targeted
	// channel:updated with joined:true — exactly the TS pair.
	f.enqueueChannelIntent(t, channel.PublicationEventMembersUpdated, war.ID, rtCara)
	hint := firstPayload(t, f, "alice", core.EventChannelMembers)
	if hint["channelId"] != war.ID || len(hint) != 1 {
		t.Fatalf("members-updated payload must be exactly {channelId}: %v", hint)
	}
	firstPayload(t, f, "cara", core.EventChannelMembers)
	joined := firstPayload(t, f, "cara", core.EventChannelUpdated)
	inner := joined["channel"].(map[string]any)
	if inner["id"] != war.ID || inner["joined"] != true {
		t.Fatalf("targeted joined projection: %v", inner)
	}
	settle()
	// Only the subject gets the joined frame; roster peers get the hint only.
	if got := f.transport.payloads("alice", core.EventChannelUpdated); len(got) != 0 {
		t.Fatalf("targeted joined frame leaked to a roster peer: %v", got)
	}
	if got := f.transport.payloads("bob", core.EventChannelUpdated); len(got) != 0 {
		t.Fatalf("targeted joined frame leaked to a roster peer: %v", got)
	}

	// Removal (subject empty): no targeted frame at all. Use the REAL removal
	// producer — its authority bump evicts the workspace sockets first, so
	// assert on the intent completing (delivered-to-zero is the honest
	// post-eviction outcome), then requeue the same shape minus subject for
	// the delivery-path negative.
	if err := f.runtime.channels.RemoveHumanTx(context.Background(), war.ID, rtCara); err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 15*time.Second, func() bool {
		var pending int
		if err := f.handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications
			WHERE object_type = 'channel' AND event_type = 'channel:members-updated' AND published_at IS NULL`).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		return pending == 0
	}, "removal intent completed")
	f.connect("alice2", rtAlice, rtWS)
	f.connect("cara2", rtCara, rtWS)
	joinedCount := len(f.transport.payloads("alice2", core.EventChannelUpdated))
	hintCount := len(f.transport.payloads("alice2", core.EventChannelMembers))
	f.enqueueChannelIntent(t, channel.PublicationEventMembersUpdated, war.ID, "")
	rtWaitUntil(t, 15*time.Second, func() bool {
		return len(f.transport.payloads("alice2", core.EventChannelMembers)) > hintCount
	}, "subjectless members-updated hint delivered")
	if got := len(f.transport.payloads("alice2", core.EventChannelUpdated)); got != joinedCount {
		t.Fatalf("subjectless intent must not produce targeted joined frames: %d -> %d", joinedCount, got)
	}
	// Replay an old gain reference AFTER removal: the subject alone is not
	// authority, even with a fresh, authenticated workspace connection.
	f.enqueueChannelIntent(t, channel.PublicationEventMembersUpdated, war.ID, rtCara)
	waitChannelIntents(t, f, war.ID)
	settle()
	for _, event := range []string{core.EventChannelUpdated, core.EventChannelMembers} {
		if got := len(f.transport.payloads("cara2", event)); got != 0 {
			t.Fatalf("revoked private member received %s after stale gain replay", event)
		}
	}
}

func TestM4PublisherChannelEventsDeletedScopeCompletes(t *testing.T) {
	f := newRTFixture(t, nil)
	doomed, err := f.runtime.channels.CreateChannel(context.Background(), channel.CreateInput{
		WorkspaceID: rtWS, Name: "doomed", Type: channel.TypeChannel, CreatorUserID: rtAlice,
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	// Deletion itself stays fail-closed on the authority side (no intent);
	// any intent that references the deleted channel must complete without a
	// delivery rather than retry forever or resurrect a projection.
	if err := f.runtime.channels.DeleteChannel(context.Background(), rtWS, doomed.ID, rtAlice); err != nil {
		t.Fatal(err)
	}
	f.connect("bob", rtBob, rtWS)
	f.enqueueChannelIntent(t, channel.PublicationEventChannelUpdated, doomed.ID, "")
	f.enqueueChannelIntent(t, channel.PublicationEventMembersUpdated, doomed.ID, rtBob)
	rtWaitUntil(t, 15*time.Second, func() bool {
		var pending int
		if err := f.handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications
			WHERE object_type = 'channel' AND object_id = ? AND published_at IS NULL`, doomed.ID).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		return pending == 0
	}, "deleted-channel intents completed without delivery")
	settle()
	for _, event := range []string{core.EventChannelUpdated, core.EventChannelMembers} {
		if got := f.transport.payloads("bob", event); len(got) != 0 {
			t.Fatalf("%s delivered for a deleted channel: %v", event, got)
		}
	}
	stats := f.rt.Stats()
	if stats.Publisher.Completed < 2 {
		t.Fatalf("deleted-scope completions: %+v", stats.Publisher)
	}
}
