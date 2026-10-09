package app

import (
	"context"
	"database/sql"
	"errors"
	apprealtime "raft.local/server-go/internal/application/realtime"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/publication"
	"raft.local/server-go/internal/transport/socketio/core"
)

func TestM4PublisherFrozenGuestGateAppliesToEverySharedAudience(t *testing.T) {
	f := newRTFixture(t, nil)
	f.rt.stopPub()
	ctx := context.Background()
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE workspace_memberships SET role='guest' WHERE workspace_id=? AND user_id=?`, rtWS, rtBob)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	created := f.create(rtAlice, rtGeneral, "members-only public-channel content")
	threadID := f.ensureThread(created.ID)
	f.create(rtAlice, threadID, "members-only thread reply")
	f.connect("ordinary", rtAlice, rtWS)
	f.connect("guest", rtBob, rtWS)

	for _, scope := range []string{rtGeneral, rtSecret, threadID} {
		audience, exists, err := f.rt.pub.ResolveConversationAudience(ctx, rtWS, scope)
		if err != nil || !exists {
			t.Fatalf("resolve %s: exists=%v err=%v", scope, exists, err)
		}
		if _, leaked := audience.Live[rtBob]; leaked {
			t.Errorf("guest entered live audience of %s", scope)
		}
		if _, leaked := audience.Counting[rtBob]; leaked {
			t.Errorf("guest entered unread audience of %s", scope)
		}
	}
	refs := []publication.Publication{
		{ObjectType: "message", ObjectID: created.ID, EventType: core.EventMessageNew},
		{ObjectType: "message", ObjectID: created.ID, EventType: core.EventMessageUpdated},
		{ObjectType: "channel", ObjectID: rtGeneral, EventType: channel.PublicationEventChannelUpdated},
		{ObjectType: "channel", ObjectID: rtGeneral, EventType: channel.PublicationEventMembersUpdated, SubjectUserID: rtBob},
		{ObjectType: "thread", ObjectID: threadID, EventType: core.EventThreadUpdated},
	}
	for _, ref := range refs {
		ref.WorkspaceID, ref.Revision = rtWS, 1
		if err := f.rt.pub.Publish(ctx, ref); err != nil {
			t.Fatal(err)
		}
		firstPayload(t, f, "ordinary", ref.EventType)
	}
	settle()
	for _, event := range []string{core.EventMessageNew, core.EventMessageUpdated, core.EventChannelUpdated, core.EventChannelMembers, core.EventThreadUpdated, core.EventUnreadSummary} {
		if len(f.transport.payloads("guest", event)) != 0 {
			t.Errorf("guest received forbidden shared event %s", event)
		}
	}
}

func TestM4PublisherPrivateThreadRequiresCurrentParentAuthority(t *testing.T) {
	f := newRTFixture(t, nil)
	f.rt.stopPub()
	ctx := context.Background()
	parent := f.create(rtAlice, rtSecret, "private root")
	var threadID string
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		thread, err := f.runtime.channels.EnsureThreadTx(ctx, tx, rtWS, rtSecret, parent.ID, rtAlice)
		if err == nil {
			threadID = thread.ID
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	f.followThread(threadID, rtBob, true)
	reply := f.create(rtAlice, threadID, "private reply after follow")
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM channel_humans WHERE channel_id=? AND user_id=?`, rtSecret, rtBob)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("authorized", rtAlice, rtWS)
	f.connect("former-member", rtBob, rtWS)
	audience, exists, err := f.rt.pub.ResolveConversationAudience(ctx, rtWS, threadID)
	if err != nil || !exists {
		t.Fatalf("thread audience: exists=%v err=%v", exists, err)
	}
	if _, leaked := audience.Live[rtBob]; leaked {
		t.Error("active follow incorrectly replaced the removed private-parent permission")
	}
	if _, leaked := audience.Counting[rtBob]; leaked {
		t.Error("inaccessible thread entered former member's counting audience")
	}
	for _, ref := range []publication.Publication{
		{ObjectType: "message", ObjectID: reply.ID, EventType: core.EventMessageNew},
		{ObjectType: "thread", ObjectID: threadID, EventType: core.EventThreadUpdated},
		{ObjectType: "thread_follow", ObjectID: threadID, EventType: core.EventThreadFollowers},
	} {
		ref.WorkspaceID, ref.Revision = rtWS, 1
		if err := f.rt.pub.Publish(ctx, ref); err != nil {
			t.Fatal(err)
		}
		firstPayload(t, f, "authorized", ref.EventType)
	}
	settle()
	for _, event := range []string{core.EventMessageNew, core.EventThreadUpdated, core.EventThreadFollowers, core.EventUnreadSummary} {
		if len(f.transport.payloads("former-member", event)) != 0 {
			t.Errorf("private-parent permission loss failed to block %s", event)
		}
	}
}

func TestM4MalformedKnownPublicationUsesPermanentFailureBudget(t *testing.T) {
	f := newRTFixture(t, nil)
	f.rt.stopPub()
	ctx := context.Background()
	ref := publication.Publication{WorkspaceID: rtWS, ObjectType: "reaction_viewer", ObjectID: "malformed-ownerless-reference", EventType: core.EventReactionViewer, Revision: 1}
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		return publication.Enqueue(ctx, tx, ref)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runtime.publications.DrainOnce(ctx, f.rt.pub.Publish); !errors.Is(err, publication.ErrPublicationRetry) {
		t.Fatalf("unprojectable reference must initially remain retryable: %v", err)
	}
	var attempts int
	var published sql.NullInt64
	if err := f.handle.QueryRow(`SELECT attempts,published_at FROM realtime_publications WHERE object_id=?`, ref.ObjectID).Scan(&attempts, &published); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || published.Valid {
		t.Fatalf("first failure did not remain pending: attempts=%d published=%v", attempts, published)
	}
	if err := db.WithWriteTx(ctx, f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE realtime_publications SET attempts=?,next_attempt_at=0 WHERE object_id=?`, apprealtime.UnknownParkAttempts, ref.ObjectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runtime.publications.DrainOnce(ctx, f.rt.pub.Publish); err != nil {
		t.Fatalf("known-type permanent failure exceeded its retry budget without being parked: %v", err)
	}
	if err := f.handle.QueryRow(`SELECT published_at FROM realtime_publications WHERE object_id=?`, ref.ObjectID).Scan(&published); err != nil || !published.Valid {
		t.Fatalf("parked reference still consumes pending budget: published=%v err=%v", published, err)
	}
	if f.rt.pub.Stats().Parked != 1 || f.rt.pub.Stats().Unknown != 2 {
		t.Fatalf("permanent failure was not explicitly accounted: %+v", f.rt.pub.Stats())
	}
}
