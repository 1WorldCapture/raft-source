package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/realtime"
	"raft.local/server-go/internal/transport/socketio/core"
)

func TestM4PrivatePublicationRechecksScopeAndFiltersBulkResidue(t *testing.T) {
	f := newRTFixture(t, nil)
	f.rt.stopPub()
	ctx := context.Background()
	public := f.create(rtAlice, rtGeneral, "visible")
	private := f.create(rtAlice, rtSecret, "formerly visible")
	for _, scope := range []struct {
		id  string
		seq int64
	}{{rtGeneral, public.Seq}, {rtSecret, private.Seq}} {
		if _, err := f.runtime.readstate.MarkRead(ctx, rtClaims(rtBob), rtWS, scope.id, scope.seq); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM channel_humans WHERE channel_id=? AND user_id=?`, rtSecret, rtBob)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("fresh-bob", rtBob, rtWS)
	for _, ref := range []realtime.Publication{
		{ObjectType: "read_state", EventType: core.EventReadState},
		{ObjectType: "notification_prefs", EventType: core.EventNotifPrefs},
		{ObjectType: "message_display_prefs", EventType: core.EventDisplayPrefs},
	} {
		ref.WorkspaceID, ref.ObjectID, ref.SubjectUserID, ref.Revision = rtWS, rtSecret, rtBob, 1
		if err := f.rt.pub.publish(ctx, ref); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.rt.pub.publish(ctx, realtime.Publication{
		WorkspaceID: rtWS, ObjectType: "read_state_bulk", ObjectID: rtWS,
		EventType: core.EventReadStateBulk, SubjectUserID: rtBob, Revision: 1,
	}); err != nil {
		t.Fatal(err)
	}
	bulk := firstPayload(t, f, "fresh-bob", core.EventReadStateBulk)
	scopes, ok := bulk["scopes"].([]any)
	if !ok {
		t.Fatalf("missing bulk scopes: %v", bulk)
	}
	foundPublic := false
	for _, item := range scopes {
		scope := item.(map[string]any)
		if scope["scopeId"] == rtSecret {
			t.Error("private read-state residue leaked into the current bulk snapshot")
		}
		foundPublic = foundPublic || scope["scopeId"] == rtGeneral
	}
	if !foundPublic {
		t.Error("authorized public read state was omitted")
	}
	settle()
	for _, event := range []string{core.EventReadState, core.EventNotifPrefs, core.EventDisplayPrefs} {
		if len(f.transport.payloads("fresh-bob", event)) != 0 {
			t.Errorf("inaccessible private scope still produced %s", event)
		}
	}
}

// A public thread is base-readable workspace-wide, but its message live
// stream is subscribed per socket. An explicit viewer and active follower
// receive it; a passive workspace socket does not implicitly subscribe.
func TestM4PublicThreadMessageLiveHonorsPerSocketInterest(t *testing.T) {
	f := newRTFixture(t, nil)
	f.rt.stopPub()
	parent := f.create(rtAlice, rtGeneral, "public root")
	threadID := f.ensureThread(parent.ID)
	f.connect("follower", rtAlice, rtWS)
	f.connect("viewer", rtBob, rtWS)
	f.connect("same-user-passive-tab", rtBob, rtWS)
	f.connect("passive", rtCara, rtWS)
	f.send("viewer", core.EventJoinChannel, threadID)
	settle()
	reply := f.create(rtAlice, threadID, "only the subscribed thread stream")
	if err := f.rt.pub.publish(context.Background(), realtime.Publication{
		WorkspaceID: rtWS, ObjectType: "message", ObjectID: reply.ID, EventType: core.EventMessageNew, Revision: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for _, connID := range []string{"follower", "viewer"} {
		payload := firstPayload(t, f, connID, core.EventMessageNew)
		if payload["id"] != reply.ID {
			t.Fatalf("wrong thread message delivered: %v", payload)
		}
	}
	settle()
	for _, connID := range []string{"same-user-passive-tab", "passive"} {
		for _, raw := range f.transport.payloads(connID, core.EventMessageNew) {
			var payload map[string]any
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			if payload["id"] == reply.ID {
				t.Errorf("public thread bypassed per-socket interest for %s", connID)
			}
		}
	}
}
