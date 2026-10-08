package message

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"raft.local/server-go/internal/channel"
)

// PublicationRef is the durable reference shape the realtime publisher
// dequeues (realtime.Publication minus transport bookkeeping).
type PublicationRef struct {
	WorkspaceID   string
	ObjectType    string
	ObjectID      string
	EventType     string
	Revision      int64
	SubjectUserID string // owner of a private state object; "" for shared
}

// ThreadUpdatedDTO is the EXACT thread:updated wire payload, ported from the
// ordinary-channel emit in messageService.ts (payload = parentMessageId,
// threadChannelId, ...threadInfo, parentChannelId, serverId,
// syncCoreReplyWindow, latestReply) with the sync-core discussion graph
// shapes from packages/shared/src/discussionGraph.ts.
type ThreadUpdatedDTO struct {
	ParentMessageID     string                    `json:"parentMessageId"`
	ThreadChannelID     string                    `json:"threadChannelId"`
	ReplyCount          int                       `json:"replyCount"`
	LastReplyAt         *string                   `json:"lastReplyAt"`
	ParticipantIDs      []string                  `json:"participantIds"`
	ParentChannelID     string                    `json:"parentChannelId"`
	ServerID            string                    `json:"serverId"`
	SyncCoreReplyWindow ThreadSyncWindow          `json:"syncCoreReplyWindow"`
	LatestReply         *ThreadLatestReplyMessage `json:"latestReply"`
}

// ThreadSyncWindow is buildThreadRepliesSyncWindow's exact output.
type ThreadSyncWindow struct {
	Producer   string                  `json:"producer"`
	Discussion ThreadRepliesDiscussion `json:"discussion"`
	Window     SyncScopeWindowDTO      `json:"window"`
}

// ThreadRepliesDiscussion is messageRepliesDiscussion's exact output.
type ThreadRepliesDiscussion struct {
	Root     MessageRefDTO `json:"root"`
	Relation struct {
		Kind string `json:"kind"`
	} `json:"relation"`
	ParentScopeKey SyncScopeKeyDTO `json:"parentScopeKey"`
	Backing        string          `json:"backing"`
}

// MessageRefDTO is messageRef's wire shape.
type MessageRefDTO struct {
	Kind     string `json:"kind"`
	ServerID string `json:"serverId"`
	ID       string `json:"id"`
}

// SyncScopeKeyDTO is the {serverId,scopeKind,scopeId} scope key.
type SyncScopeKeyDTO struct {
	ServerID  string `json:"serverId"`
	ScopeKind string `json:"scopeKind"`
	ScopeID   string `json:"scopeId"`
}

// SyncScopeWindowDTO is syncScopeWindow()'s wire shape.
type SyncScopeWindowDTO struct {
	Kind        string  `json:"kind"`
	ScopeCursor *string `json:"scopeCursor"`
	Epoch       *string `json:"epoch"`
}

// ThreadLatestReplyMessage is projectThreadLatestReplyPayload's output: the
// sealed message DTO plus senderDisplayName (mirrors senderName) and a null
// senderAvatarUrl for non-external senders, plus the creation-time
// conversation context.
type ThreadLatestReplyMessage struct {
	MessageDTO
	SenderDisplayName string                  `json:"senderDisplayName"`
	SenderAvatarURL   *string                 `json:"senderAvatarUrl"`
	ConversationCtx   *ConversationContextDTO `json:"conversationContext"`
}

// MarshalJSON flattens the embedded message DTO and appends the latestReply
// extras, preserving the exact key set of the TS projection.
func (t ThreadLatestReplyMessage) MarshalJSON() ([]byte, error) {
	base, err := json.Marshal(t.MessageDTO)
	if err != nil {
		return nil, err
	}
	var flat map[string]any
	if err := json.Unmarshal(base, &flat); err != nil {
		return nil, err
	}
	for _, sealed := range []string{"agentSendKey", "searchText", "searchVector", "senderHandle"} {
		delete(flat, sealed)
	}
	flat["senderDisplayName"] = t.SenderDisplayName
	flat["senderAvatarUrl"] = t.SenderAvatarURL
	if t.ConversationCtx != nil {
		flat["conversationContext"] = t.ConversationCtx
	}
	return json.Marshal(flat)
}

// PublicationProjection is the current re-projection of one publication
// intent. PrivacyClass tells the publisher which room family may receive it:
// shared facts go to authorized conversation audiences; viewer-private state
// goes ONLY to the subject user's private scope.
type PublicationProjection struct {
	WorkspaceID         string
	ChannelID           string // the conversation the fact lives in
	PrivacyClass        string // "shared" | "viewer_private"
	Message             *MessageDTO
	ConversationContext *ConversationContextDTO    // message:new only
	Viewer              *ReactionViewerSnapshotDTO // reaction_viewer:updated only
	Thread              *ThreadUpdatedDTO          // thread:updated only
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
			dtos, err := s.ProjectMessages(ctx, ex, ref.WorkspaceID, []*Message{msg})
			if err != nil {
				return err
			}
			if len(dtos) != 1 {
				return nil
			}
			out = &PublicationProjection{
				WorkspaceID:  ref.WorkspaceID,
				ChannelID:    msg.ChannelID,
				PrivacyClass: "shared",
				Message:      dtos[0],
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
				Viewer: &ReactionViewerSnapshotDTO{
					ServerID:      ref.WorkspaceID,
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
				Thread: &ThreadUpdatedDTO{
					ParentMessageID: parentMessage,
					ThreadChannelID: summary.ThreadChannelID,
					ReplyCount:      summary.ReplyCount,
					LastReplyAt:     summary.LastReplyAt,
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
func (s *Store) conversationContextFor(ctx context.Context, ex dbExecutor, workspaceID, channelID string) (*ConversationContextDTO, error) {
	var channelType string
	var parentRaw any
	err := ex.QueryRowContext(ctx, `SELECT type, parent_message_id FROM channels
		WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, channelID, workspaceID).
		Scan(&channelType, &parentRaw)
	if err != nil {
		return nil, fmt.Errorf("conversation context channel: %w", err)
	}
	out := &ConversationContextDTO{ChannelType: channelType}
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

// SocketMessageUpdatedInContext projects the message:updated broadcast
// payload: the sealed shared aggregate plus the same conversationContext the
// original reaction/aggregate emit carries (withFrontendConversationContext
// at messageService.ts:5715-5721). A nil context yields the plain sealed
// aggregate (the ordinary-channel projection always supplies a context, so
// nil only means "caller has none", never a fabricated one).
func SocketMessageUpdatedInContext(dto *MessageDTO, context *ConversationContextDTO) map[string]any {
	payload := SocketMessageUpdated(dto)
	if context != nil {
		payload["conversationContext"] = *context
	}
	return payload
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
