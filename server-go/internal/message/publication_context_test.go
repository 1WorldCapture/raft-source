package message

// Regression tests for the conversation-context projection of the two shared
// broadcast faces (message:new and message:updated). The original pipeline
// attaches the SAME buildFrontendConversationContext projection to both:
// message:new at messageService.ts:3250-3256 and the reaction/aggregate emit
// at 5715-5721 — a thread reaction's message:updated without its thread
// context loses its scope on the client. These tests pin the canonical
// context for new/updated/reaction paths and the sealed, viewer-free socket
// payload shape.

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

func projectRef(eventType, objectID string, revision int64) PublicationRef {
	return PublicationRef{
		WorkspaceID: txWS, ObjectType: "message", ObjectID: objectID,
		EventType: eventType, Revision: revision,
	}
}

func TestPublicationContextOnNewAndUpdatedOrdinaryChannel(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	created, err := f.send(txAlice, txFamAlice, txGeneral, "ctx", nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, eventType := range []string{"message:new", "message:updated"} {
		projection, err := f.store.ProjectPublication(context.Background(), projectRef(eventType, created.Message.ID, 1))
		if err != nil {
			t.Fatal(err)
		}
		if projection == nil || projection.Message == nil {
			t.Fatalf("%s projection missing", eventType)
		}
		cc := projection.ConversationContext
		if cc == nil {
			t.Fatalf("%s must carry conversationContext (TS attaches it to BOTH broadcast faces)", eventType)
		}
		if cc.ChannelType != "channel" {
			t.Fatalf("%s context channelType: %+v", eventType, cc)
		}
		if cc.ParentMessageID != "" || cc.ParentChannelID != "" || cc.ParentChannelType != "" {
			t.Fatalf("ordinary channel context must not carry thread anchors: %+v", cc)
		}
		if projection.PrivacyClass != "shared" {
			t.Fatalf("%s privacy class: %v", eventType, projection.PrivacyClass)
		}
	}
}

func TestPublicationContextOnThreadNewUpdatedAndReaction(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	parent, err := f.send(txAlice, txFamAlice, txGeneral, "thread root", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent.Message.ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reply, err := f.send(txAlice, txFamAlice, threadID, "reply", nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	assertThreadContext := func(t *testing.T, eventType string, cc *ConversationContextDTO) {
		t.Helper()
		if cc == nil {
			t.Fatalf("%s on a thread must carry conversationContext", eventType)
		}
		if cc.ChannelType != "thread" {
			t.Fatalf("%s thread context channelType: %+v", eventType, cc)
		}
		if cc.ParentMessageID != parent.Message.ID {
			t.Fatalf("%s parent anchor: %+v", eventType, cc)
		}
		if cc.ParentChannelID != txGeneral || cc.ParentChannelType != "channel" {
			t.Fatalf("%s parent channel anchors: %+v", eventType, cc)
		}
	}

	// Creation and aggregate faces share the same thread projection.
	newProjection, err := f.store.ProjectPublication(context.Background(), projectRef("message:new", reply.Message.ID, 1))
	if err != nil {
		t.Fatal(err)
	}
	assertThreadContext(t, "message:new", newProjection.ConversationContext)

	updatedProjection, err := f.store.ProjectPublication(context.Background(), projectRef("message:updated", reply.Message.ID, 2))
	if err != nil {
		t.Fatal(err)
	}
	assertThreadContext(t, "message:updated", updatedProjection.ConversationContext)

	// THE regression: a reaction mutates the aggregate (message:updated,
	// revision = bumped messages.revision) and must still classify the
	// message's thread scope.
	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, reply.Message.ID, "tada"); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := f.db.QueryRow(`SELECT revision FROM messages WHERE id = ?`, reply.Message.ID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision < 2 {
		t.Fatalf("reaction must bump the shared revision: %d", revision)
	}
	reactionProjection, err := f.store.ProjectPublication(context.Background(), projectRef("message:updated", reply.Message.ID, revision))
	if err != nil {
		t.Fatal(err)
	}
	assertThreadContext(t, "reaction message:updated", reactionProjection.ConversationContext)
	if reactionProjection.PrivacyClass != "shared" {
		t.Fatalf("reaction aggregate privacy: %v", reactionProjection.PrivacyClass)
	}

	// The reaction's PRIVATE viewer snapshot stays a separate, subject-scoped
	// projection: it never rides the shared aggregate or its context.
	viewerProjection, err := f.store.ProjectPublication(context.Background(), PublicationRef{
		WorkspaceID: txWS, ObjectType: "reaction_viewer", ObjectID: reply.Message.ID,
		EventType: "reaction_viewer:updated", Revision: revision, SubjectUserID: txAlice,
	})
	if err != nil {
		t.Fatal(err)
	}
	if viewerProjection == nil || viewerProjection.PrivacyClass != "viewer_private" || viewerProjection.Viewer == nil {
		t.Fatalf("viewer projection: %+v", viewerProjection)
	}
}

func TestSocketUpdatedInContextSealsAndCarriesContext(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	created, err := f.send(txAlice, txFamAlice, txGeneral, "seal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := f.store.ProjectPublication(context.Background(), projectRef("message:updated", created.Message.ID, 1))
	if err != nil || projection == nil {
		t.Fatalf("projection: %v %v", projection, err)
	}

	payload := SocketMessageUpdatedInContext(projection.Message, projection.ConversationContext)
	if _, ok := payload["conversationContext"]; !ok {
		t.Fatalf("message:updated socket payload must carry the conversation context")
	}
	for _, sealed := range []string{"searchText", "searchVector", "agentSendKey", "senderHandle"} {
		if _, ok := payload[sealed]; ok {
			t.Fatalf("sealed storage column %q present on message:updated payload", sealed)
		}
	}
	for _, viewerPrivate := range []string{"reactionViewer", "readState", "maxReadSeq", "activityMuted", "collapseLongMessages"} {
		if _, ok := payload[viewerPrivate]; ok {
			t.Fatalf("viewer-private field %q leaked onto the shared payload", viewerPrivate)
		}
	}
	// A nil context must not fabricate one (omitempty anchors stay absent).
	bare := SocketMessageUpdatedInContext(projection.Message, nil)
	if _, ok := bare["conversationContext"]; ok {
		t.Fatalf("nil context must stay nil, never fabricated")
	}
}
