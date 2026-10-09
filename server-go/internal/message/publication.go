package message

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"raft.local/server-go/internal/channel"
)

// PublicationRef is the durable reference shape the realtime publisher
// dequeues (publication.Publication minus transport bookkeeping).
type PublicationRef struct {
	WorkspaceID   string
	ObjectType    string
	ObjectID      string
	EventType     string
	Revision      int64
	SubjectUserID string // owner of a private state object; "" for shared
}

// ThreadFacts is the thread:updated fact bundle: what the shared thread
// summary currently is. The presenter renders the exact frozen wire payload
// (parentMessageId, threadChannelId, replyCount, lastReplyAt ISO string,
// participantIds, plus the server identity); the sync-core window fields of
// the original emit stay their honest zero values at the wire layer in this
// phase, byte-identical to the previous projection.
type ThreadFacts struct {
	ParentMessageID string
	ThreadChannelID string
	ReplyCount      int
	LastReplyAtMS   *int64
	ParticipantIDs  []string
}

// ConversationContextFacts is the creation-time identity projection
// (channelType plus the thread's parent anchor when present).
type ConversationContextFacts struct {
	ChannelType       string
	ParentMessageID   string
	ParentChannelID   string
	ParentChannelType string
}

// ViewerSnapshotFacts is the receiver-private reaction-viewer state of one
// message: who owns it (workspace + message + viewer version) and the
// reacted-emoji set. Rendered per-user only.
type ViewerSnapshotFacts struct {
	WorkspaceID   string
	MessageID     string
	ViewerVersion int64
	ReactedEmojis []string
}

// PublicationProjection is the current re-projection of one publication
// intent. PrivacyClass tells the publisher which room family may receive it:
// shared facts go to authorized conversation audiences; viewer-private state
// goes ONLY to the subject user's private scope.
type PublicationProjection struct {
	WorkspaceID         string
	ChannelID           string // the conversation the fact lives in
	PrivacyClass        string // "shared" | "viewer_private"
	Message             *Projection
	ConversationContext *ConversationContextFacts // message:new only
	Viewer              *ViewerSnapshotFacts      // reaction_viewer:updated only
	Thread              *ThreadFacts              // thread:updated only
}

// ProjectPublication re-projects a dequeued publication against CURRENT
// database facts on one snapshot. It performs no authorization itself: the
// publisher must re-check the audience (workspace membership, conversation
// read/interest) at admission time using ChannelID/SubjectUserID here.
// A missing fact (deleted message/thread) returns (nil, nil): the publisher
// completes the publication without a payload.
func (s *Store) ProjectPublication(ctx context.Context, ref PublicationRef) (*PublicationProjection, error) {
	var out *PublicationProjection
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		switch ref.ObjectType {
		case "message":
			msg, err := s.getMessage(ctx, ex, ref.WorkspaceID, ref.ObjectID)
			if err != nil {
				return err
			}
			if msg == nil {
				return nil
			}
			projections, err := s.ProjectMessages(ctx, ex, ref.WorkspaceID, []*Message{msg})
			if err != nil {
				return err
			}
			if len(projections) != 1 {
				return nil
			}
			out = &PublicationProjection{
				WorkspaceID:  ref.WorkspaceID,
				ChannelID:    msg.ChannelID,
				PrivacyClass: "shared",
				Message:      projections[0],
			}
			if ref.EventType == "message:new" || ref.EventType == "message:updated" {
				// The original pipeline attaches the SAME frontend
				// conversation context to both broadcast faces: message:new
				// (messageService.ts:3250-3256) and message:updated — the
				// reaction/aggregate emit builds the identical
				// buildFrontendConversationContext projection (thread: the
				// parent message plus its channel; ordinary channels: the
				// storage channel type) before sealing (5715-5721). Without
				// it here, a thread reaction's message:updated loses its
				// thread scope on the client.
				context, err := s.conversationContextFor(ctx, ex, ref.WorkspaceID, msg.ChannelID)
				if err != nil {
					return err
				}
				out.ConversationContext = context
			}
		case "reaction_viewer":
			if ref.SubjectUserID == "" {
				return fmt.Errorf("viewer publication without subject user")
			}
			msg, err := s.getMessage(ctx, ex, ref.WorkspaceID, ref.ObjectID)
			if err != nil {
				return err
			}
			if msg == nil {
				return nil
			}
			state, err := s.viewerState(ctx, ex, msg.ID, ref.SubjectUserID)
			if err != nil {
				return err
			}
			emojis := state.ReactedEmojis
			if emojis == nil {
				emojis = []string{}
			}
			out = &PublicationProjection{
				WorkspaceID:  ref.WorkspaceID,
				ChannelID:    msg.ChannelID,
				PrivacyClass: "viewer_private",
				Viewer: &ViewerSnapshotFacts{
					WorkspaceID:   ref.WorkspaceID,
					MessageID:     msg.ID,
					ViewerVersion: state.ViewerVersion,
					ReactedEmojis: emojis,
				},
			}
		case "thread":
			row := ex.QueryRowContext(ctx, `SELECT parent_message_id FROM channels
				WHERE id = ? AND workspace_id = ? AND type = 'thread' AND deleted_at IS NULL`,
				ref.ObjectID, ref.WorkspaceID)
			var parentMessage string
			if err := row.Scan(&parentMessage); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					// The durable fact is gone (missing, deleted or foreign
					// workspace): complete without a payload.
					return nil
				}
				// Infrastructure failure: defer the intent for retry, never
				// complete it as if the fact were gone (phase-4 §7.3).
				return fmt.Errorf("read thread parent channel: %w", err)
			}
			summaries, err := s.threadSummariesForParents(ctx, ex, ref.WorkspaceID, "", []*Message{{ID: parentMessage}}, "")
			if err != nil {
				return err
			}
			summary, ok := summaries[parentMessage]
			if !ok {
				return nil
			}
			out = &PublicationProjection{
				WorkspaceID:  ref.WorkspaceID,
				ChannelID:    ref.ObjectID,
				PrivacyClass: "shared",
				Thread: &ThreadFacts{
					ParentMessageID: parentMessage,
					ThreadChannelID: summary.ThreadChannelID,
					ReplyCount:      summary.ReplyCount,
					LastReplyAtMS:   summary.LastReplyAt,
					ParticipantIDs:  summary.ParticipantIDs,
				},
			}
		default:
			return fmt.Errorf("unknown publication object type %q", ref.ObjectType)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// conversationContextFor builds the creation-time identity projection
// (channelType plus the parent anchor for threads).
func (s *Store) conversationContextFor(ctx context.Context, ex dbExecutor, workspaceID, channelID string) (*ConversationContextFacts, error) {
	var channelType string
	var parentRaw any
	err := ex.QueryRowContext(ctx, `SELECT type, parent_message_id FROM channels
		WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, channelID, workspaceID).
		Scan(&channelType, &parentRaw)
	if err != nil {
		return nil, fmt.Errorf("conversation context channel: %w", err)
	}
	out := &ConversationContextFacts{ChannelType: channelType}
	if channelType == "thread" {
		if v, ok := parentRaw.(string); ok && v != "" {
			out.ParentMessageID = v
			var parentChannelID, parentChannelType string
			parentErr := ex.QueryRowContext(ctx, `SELECT pm.channel_id, pc.type
				FROM messages pm JOIN channels pc ON pc.id = pm.channel_id
				WHERE pm.id = ? AND pm.workspace_id = ?`, v, workspaceID).
				Scan(&parentChannelID, &parentChannelType)
			if parentErr == nil && parentChannelType != "thread" {
				out.ParentChannelID = parentChannelID
				out.ParentChannelType = parentChannelType
			}
		}
	}
	return out, nil
}

// LiveEligibility answers the LIVE (socket push) admission question, which
// is deliberately distinct from the sync/resume interest rule:
//
//   - non-thread conversations: base content read authorization;
//   - threads on a PUBLIC root channel: any base-authorized viewer is
//     eligible (explicit join/history readers may receive live updates);
//   - threads on a private/DM root: ONLY an active follower.
//
// ViaFollow reports that a thread's eligibility came from the follow row, so
// the publisher can drop the delivery when the follow disappears without
// re-running the whole chain.
type LiveEligibility struct {
	Eligible  bool
	ViaFollow bool
	RootType  string
}

// LiveEligibilityForChannel resolves the live admission for one viewer.
func (s *Store) LiveEligibilityForChannel(ctx context.Context, workspaceID, channelID, userID string) (LiveEligibility, error) {
	out := LiveEligibility{}
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		conv, err := s.authorizeRead(ctx, ex, workspaceID, channelID, userID)
		if err != nil {
			if errors.Is(err, ErrConversationDenied) || errors.Is(err, ErrNotServerMember) {
				return nil
			}
			return err
		}
		if conv == nil || conv.Channel == nil || conv.Root == nil {
			return nil
		}
		out.RootType = conv.Root.Type
		if conv.Channel.Type != channel.TypeThread {
			out.Eligible = true
			return nil
		}
		if conv.Root.Type == channel.TypeChannel {
			// Public parent: explicit viewers are live-eligible.
			out.Eligible = true
			return nil
		}
		// Private/DM parent chain: live is active followers only.
		following, err := s.channels.HasActiveThreadFollowTx(ctx, ex, workspaceID, userID, conv.Channel.ID)
		if err != nil {
			return err
		}
		out.Eligible = following
		out.ViaFollow = following
		return nil
	})
	if err != nil {
		return LiveEligibility{}, err
	}
	return out, nil
}

// AudienceForChannel reports whether userID may currently stream channelID
// (the publisher's admission check for shared conversation facts on the
// SYNC/RESUME path: every thread, public or private, needs an active follow).
// Live push admission is LiveEligibilityForChannel; private viewer state
// bypasses both and goes only to SubjectUserID.
func (s *Store) AudienceForChannel(ctx context.Context, workspaceID, channelID, userID string) (bool, error) {
	var allowed bool
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		ok, err := s.syncAudience(ctx, ex, workspaceID, channelID, userID)
		if err != nil {
			if errors.Is(err, ErrConversationDenied) {
				allowed = false
				return nil
			}
			return err
		}
		allowed = ok
		return nil
	})
	if err != nil {
		return false, err
	}
	return allowed, nil
}
