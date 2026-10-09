package realtime

// Message-fact projections: message:new / message:updated, the
// receiver-private reaction viewer snapshot, thread:updated and dm:new
// appearance, and the thread-followers interest event.

import (
	"context"

	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/publication"
)

func (d *Dispatcher) publishMessageFact(ctx context.Context, ref publication.Publication) error {
	serial0 := d.serial()
	projection, err := d.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: ref.ObjectType, ObjectID: ref.ObjectID,
		EventType: ref.EventType, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Message == nil {
		d.completed.Add(1)
		return nil
	}
	audience, exists, err := d.resolveConversationAudience(ctx, ref.WorkspaceID, projection.ChannelID)
	if err != nil {
		return err
	}
	if !exists {
		d.completed.Add(1)
		return nil
	}
	if d.serial() != serial0 || audience.Serial != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}

	var payload any
	switch ref.EventType {
	case EventMessageNew:
		// The sealed creation payload facts: the shared message plus the
		// creation-time conversation context. The presenter renders the
		// exact sealed socket DTO; nothing here encodes client wire.
		channelType := "channel"
		if cc := projection.ConversationContext; cc != nil && cc.ChannelType != "" {
			channelType = cc.ChannelType
		}
		payload = MessageNewFacts{
			Message: projection.Message, ChannelType: channelType,
			ConversationContext: projection.ConversationContext,
		}
	case EventMessageUpdated:
		// The original reaction/aggregate emit attaches the same frontend
		// conversation context as message:new (messageService.ts:5715-5721):
		// without it, a thread reaction's message:updated loses its thread
		// scope on the client.
		payload = MessageUpdatedFacts{
			Message: projection.Message, ConversationContext: projection.ConversationContext,
		}
	default:
		return d.unprojectable(ref)
	}
	if err := d.deliverContext(ctx, audience, ref.WorkspaceID, ref.EventType, payload); err != nil {
		return err
	}
	d.published.Add(1)

	if ref.EventType == EventMessageNew {
		// DM message activity also re-announces the conversation itself: a
		// passive peer (sidebar-hidden, socket admitted before the DM
		// existed, never in any room for it) refreshes on {channelId}
		// exactly like the original pipeline (messageService.ts).
		if audience.ChannelType == "dm" {
			if err := d.deliverContext(ctx, audience, ref.WorkspaceID, EventDMNew, DMNewEventPayload{ChannelID: projection.ChannelID}); err != nil {
				return err
			}
		}
		// Unread invalidation for every other counting audience member.
		if err := d.fanoutUnreadSummary(ctx, audience, ref.WorkspaceID, projection.Message.SenderID); err != nil {
			return err
		}
	}
	return nil
}

// ---- viewer-private reaction snapshot --------------------------------------

func (d *Dispatcher) publishViewerSnapshot(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		return d.unprojectable(ref)
	}
	serial0 := d.serial()
	projection, err := d.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: ref.ObjectType, ObjectID: ref.ObjectID,
		EventType: ref.EventType, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Viewer == nil {
		d.completed.Add(1)
		return nil
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	// Viewer-private state goes ONLY to the subject's user+workspace
	// intersection — never a shared channel room, whatever the
	// projection's ChannelID is.
	if err := d.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventReactionViewer,
		ReactionViewerEventPayload{Facts: projection.Viewer}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// ---- thread facts -----------------------------------------------------------

func (d *Dispatcher) publishThreadUpdated(ctx context.Context, ref publication.Publication) error {
	serial0 := d.serial()
	projection, err := d.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: "thread", ObjectID: ref.ObjectID,
		EventType: EventThreadUpdated, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Thread == nil {
		d.completed.Add(1)
		return nil
	}
	audience, exists, err := d.resolveConversationAudience(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		d.completed.Add(1)
		return nil
	}
	if d.serial() != serial0 || audience.Serial != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	// The projector carries the shared thread summary facts only — no
	// receiver-private unreadCount/firstUnreadMessageId/readState ever rides
	// this event; the workspace identity is the publication's own.
	if err := d.deliverContext(ctx, audience, ref.WorkspaceID, EventThreadUpdated,
		ThreadUpdatedEventPayload{Facts: projection.Thread, WorkspaceID: ref.WorkspaceID}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// ---- DM appearance -----------------------------------------------------------

// MessageNewFacts carries the message:new semantic payload: the shared
// message row and its creation-time conversation context. The presenter
// renders the sealed socket DTO.
type MessageNewFacts struct {
	Message             *message.Projection
	ChannelType         string
	ConversationContext *message.ConversationContextFacts
}

// MessageUpdatedFacts carries the message:updated semantic payload: the
// message row and the same frontend conversation context as message:new.
type MessageUpdatedFacts struct {
	Message             *message.Projection
	ConversationContext *message.ConversationContextFacts
}

// ThreadUpdatedEventPayload is the thread:updated semantic payload: the
// shared summary facts plus the workspace identity (the presenter renders
// the frozen wire payload from both).
type ThreadUpdatedEventPayload struct {
	Facts       *message.ThreadFacts
	WorkspaceID string
}

// ReactionViewerEventPayload is the receiver-private reaction-viewer
// semantic payload; the presenter renders the {serverId,messageId,
// viewerVersion,reactedEmojis} wire object.
type ReactionViewerEventPayload struct {
	Facts *message.ViewerSnapshotFacts
}

// DMNewEventPayload is the semantic {channelId} notification — never a
// channel DTO.
type DMNewEventPayload struct {
	ChannelID string
}

func (d *Dispatcher) publishDMNew(ctx context.Context, ref publication.Publication) error {
	audience, exists, err := d.resolveConversationAudience(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists || audience.ChannelType != "dm" {
		d.completed.Add(1)
		return nil
	}
	if d.audienceStale(audience) {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if err := d.deliverContext(ctx, audience, ref.WorkspaceID, EventDMNew, DMNewEventPayload{ChannelID: ref.ObjectID}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// ---- thread follower interest -------------------------------------------------

// ThreadFollowersEventPayload is {threadChannelId} only — follower-private
// state itself is never broadcast.
type ThreadFollowersEventPayload struct {
	ThreadChannelID string
}

func (d *Dispatcher) publishFollowersUpdated(ctx context.Context, ref publication.Publication) error {
	threadID := ref.ObjectID
	if ref.ScopeID != "" {
		threadID = ref.ScopeID
	}
	audience, exists, err := d.resolveConversationAudience(ctx, ref.WorkspaceID, threadID)
	if err != nil {
		return err
	}
	if !exists {
		d.completed.Add(1)
		return nil
	}
	if d.audienceStale(audience) {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if err := d.deliverContext(ctx, audience, ref.WorkspaceID, EventThreadFollowers,
		ThreadFollowersEventPayload{ThreadChannelID: threadID}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}
