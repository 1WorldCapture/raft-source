package message

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

func TestPublicationProjectionsForParentPublisher(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	created, err := f.send(txAlice, txFamAlice, txGeneral, "pub", nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Shared message:new projection carries the full DTO + context, shared.
	proj, err := f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "message", ObjectID: created.Message.ID,
		EventType: "message:new", Revision: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proj == nil || proj.Message == nil || proj.PrivacyClass != "shared" {
		t.Fatalf("message:new projection: %+v", proj)
	}
	if proj.ChannelID != txGeneral || proj.Message.ID != created.Message.ID {
		t.Fatalf("projection coordinates: %+v", proj)
	}
	if proj.ConversationContext == nil || proj.ConversationContext.ChannelType != "channel" {
		t.Fatalf("conversation context: %+v", proj.ConversationContext)
	}

	// Audience admission for the shared fact.
	ok, err := f.store.AudienceForChannel(context.Background(), txWS, txGeneral, txBob)
	if err != nil || !ok {
		t.Fatalf("bob audience: %v %v", ok, err)
	}
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)
	ok, err = f.store.AudienceForChannel(context.Background(), txWS, private, txBob)
	if err != nil || ok {
		t.Fatalf("private audience leak: %v %v", ok, err)
	}

	// Viewer-private projection: only the subject user's state, never shared.
	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, created.Message.ID, "x"); err != nil {
		t.Fatal(err)
	}
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "reaction_viewer", ObjectID: created.Message.ID,
		EventType: "reaction_viewer:updated", Revision: 2, SubjectUserID: txAlice,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proj == nil || proj.PrivacyClass != "viewer_private" || proj.Viewer == nil {
		t.Fatalf("viewer projection: %+v", proj)
	}
	if len(proj.Viewer.ReactedEmojis) != 1 || proj.Viewer.ViewerVersion != 1 {
		t.Fatalf("viewer facts: %+v", proj.Viewer)
	}

	// Thread projection: thread:updated carries the thread summary facts.
	var threadID string
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
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "thread", ObjectID: threadID,
		EventType: "thread:updated", Revision: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if proj == nil || proj.Thread == nil || proj.Thread.ReplyCount != 1 ||
		proj.Thread.ParentMessageID != created.Message.ID || proj.Thread.LastReplyAtMS == nil {
		t.Fatalf("thread projection: %+v", proj)
	}

	// Deleted/missing facts project to nil (publisher completes, no payload).
	proj, err = f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "message", ObjectID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		EventType: "message:new", Revision: 1,
	})
	if err != nil || proj != nil {
		t.Fatalf("missing fact must be nil: %+v %v", proj, err)
	}
}
