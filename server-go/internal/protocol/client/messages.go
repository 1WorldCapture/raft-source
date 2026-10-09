// Message wire shapes: the enriched message DTO family, the socket resume
// envelope and the thread summary/updated projections exactly as the
// existing clients decode them. Pure protocol leaf: no application, domain,
// database or network imports. The mapping from domain facts lives in
// internal/transport/presenter.

package client

import (
	"encoding/json"
	"time"
)

// MillisISO renders the legacy JSON.stringify(Date) shape.
func MillisISO(unixMilli int64) string {
	return time.UnixMilli(unixMilli).UTC().Format("2006-01-02T15:04:05.000Z")
}

// MessageDTO is the full enriched projection used by history, context, sync,
// reaction mutation responses and message:updated. Presence semantics
// (canonicalMessageManifest): reactions/mentions/attachments are ALWAYS
// present with explicit empty arrays meaning "cleared"; M4-disabled facts
// stay present with their honest null/empty values.
type MessageDTO struct {
	ID                     string               `json:"id"`
	Seq                    int64                `json:"seq"`
	ChannelID              string               `json:"channelId"`
	SenderType             string               `json:"senderType"`
	SenderID               string               `json:"senderId"`
	AgentSendKey           *string              `json:"agentSendKey"`
	RandomID               *string              `json:"randomId"`
	MessageType            string               `json:"messageType"`
	Content                string               `json:"content"`
	ActionMetadata         any                  `json:"actionMetadata"`
	SearchText             *string              `json:"searchText"`
	ThreadID               *string              `json:"threadId"`
	TaskStatus             any                  `json:"taskStatus"`
	TaskNumber             any                  `json:"taskNumber"`
	TaskAssigneeType       any                  `json:"taskAssigneeType"`
	TaskAssigneeID         any                  `json:"taskAssigneeId"`
	TaskClaimedAt          any                  `json:"taskClaimedAt"`
	TaskCompletedAt        any                  `json:"taskCompletedAt"`
	CreatedAt              string               `json:"createdAt"`
	UpdatedAt              string               `json:"updatedAt"`
	CommentRef             any                  `json:"commentRef"`
	SenderName             string               `json:"senderName"`
	SenderHandle           string               `json:"senderHandle"`
	SenderDescription      *string              `json:"senderDescription"`
	SenderMembershipStatus *string              `json:"senderMembershipStatus"`
	Reactions              []ReactionSummaryDTO `json:"reactions"`
	Mentions               []MentionDTO         `json:"mentions"`
	Attachments            []AttachmentDTO      `json:"attachments"`
}

// SendResponseMessageDTO is the creation-time subset: the row plus
// senderName, senderMembershipStatus, attachments and the resolved mentions.
// The original send pipeline does not attach reactions/handle/description on
// this surface.
type SendResponseMessageDTO struct {
	ID                     string          `json:"id"`
	Seq                    int64           `json:"seq"`
	ChannelID              string          `json:"channelId"`
	SenderType             string          `json:"senderType"`
	SenderID               string          `json:"senderId"`
	AgentSendKey           *string         `json:"agentSendKey"`
	RandomID               *string         `json:"randomId"`
	MessageType            string          `json:"messageType"`
	Content                string          `json:"content"`
	ActionMetadata         any             `json:"actionMetadata"`
	SearchText             *string         `json:"searchText"`
	ThreadID               *string         `json:"threadId"`
	TaskStatus             any             `json:"taskStatus"`
	TaskNumber             any             `json:"taskNumber"`
	TaskAssigneeType       any             `json:"taskAssigneeType"`
	TaskAssigneeID         any             `json:"taskAssigneeId"`
	TaskClaimedAt          any             `json:"taskClaimedAt"`
	TaskCompletedAt        any             `json:"taskCompletedAt"`
	CreatedAt              string          `json:"createdAt"`
	UpdatedAt              string          `json:"updatedAt"`
	SenderName             string          `json:"senderName"`
	SenderMembershipStatus *string         `json:"senderMembershipStatus"`
	Attachments            []AttachmentDTO `json:"attachments"`
	Mentions               []MentionDTO    `json:"mentions"`
}

// ReactionSummaryDTO is the shared aggregate: {emoji,count,reactorIds,reactorNames}.
type ReactionSummaryDTO struct {
	Emoji        string   `json:"emoji"`
	Count        int      `json:"count"`
	ReactorIDs   []string `json:"reactorIds"`
	ReactorNames []string `json:"reactorNames"`
}

// MentionDTO is {type,id,name}.
type MentionDTO struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

// AttachmentDTO keeps the empty-array presence of the attachment family; M4
// has no attachment facts, so elements never appear.
type AttachmentDTO struct {
	ID           string  `json:"id"`
	Filename     string  `json:"filename"`
	MimeType     string  `json:"mimeType"`
	SizeBytes    int64   `json:"sizeBytes"`
	Width        *int64  `json:"width"`
	Height       *int64  `json:"height"`
	ThumbnailURL *string `json:"thumbnailUrl"`
	CommentCount int     `json:"commentCount"`
}

// ReactionViewerSnapshotDTO is the private projection of the acting viewer:
// {serverId,messageId,viewerVersion,reactedEmojis}. Never broadcast to a
// shared room.
type ReactionViewerSnapshotDTO struct {
	ServerID      string   `json:"serverId"`
	MessageID     string   `json:"messageId"`
	ViewerVersion int64    `json:"viewerVersion"`
	ReactedEmojis []string `json:"reactedEmojis"`
}

// MessageWindowDTO is the receiver_visible_messages_v1 block the transport
// embeds under messageWindow with its own coordinates.
type MessageWindowDTO struct {
	SchemaVersion         int    `json:"schemaVersion"`
	Domain                string `json:"domain"`
	ServerID              string `json:"serverId"`
	ReceiverKind          string `json:"receiverKind"`
	ReceiverID            string `json:"receiverId"`
	ScopeID               string `json:"scopeId"`
	CoveredAfterSeq       int64  `json:"coveredAfterSeq"`
	CoveredFromSeq        int64  `json:"coveredFromSeq"`
	CoveredThroughSeq     int64  `json:"coveredThroughSeq"`
	RemoteHighWaterSeq    int64  `json:"remoteHighWaterSeq"`
	HasGap                bool   `json:"hasGap"`
	HasNewer              bool   `json:"hasNewer"`
	CompleteThroughLatest bool   `json:"completeThroughLatest"`
}

// ConversationContextDTO is buildFrontendConversationContext's wire shape.
type ConversationContextDTO struct {
	ChannelType       string `json:"channelType"`
	ParentMessageID   string `json:"parentMessageId,omitempty"`
	ParentChannelID   string `json:"parentChannelId,omitempty"`
	ParentChannelType string `json:"parentChannelType,omitempty"`
}

// ThreadParentRef carries the thread anchor facts for the context
// projection (presenter input).
type ThreadParentRef struct {
	ParentMessageID   string
	ParentChannelID   string
	ParentChannelType string
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

// ResumeEnvelope is the Socket.IO sync:resume:response wire shape
// {messages, currentSeq, hasMore}.
type ResumeEnvelope struct {
	Messages   []*MessageDTO `json:"messages"`
	CurrentSeq int64         `json:"currentSeq"`
	HasMore    bool          `json:"hasMore"`
}

// ThreadSummary is the wire thread summary row (getThreadSummaries'
// ThreadSummaryResult): threadChannelId, replyCount, lastReplyAt,
// participantIds, unreadCount, firstUnreadMessageId, latestReplies.
type ThreadSummary struct {
	ThreadChannelID      string              `json:"threadChannelId"`
	ReplyCount           int                 `json:"replyCount"`
	LastReplyAt          *string             `json:"lastReplyAt"`
	ParticipantIDs       []string            `json:"participantIds"`
	UnreadCount          int                 `json:"unreadCount"`
	FirstUnreadMessageID *string             `json:"firstUnreadMessageId"`
	LatestReplies        []ThreadLatestReply `json:"latestReplies"`
}

// ThreadLatestReply is the compact preview row (message_type <> 'system',
// newest 3, rendered ascending).
type ThreadLatestReply struct {
	MessageID         string  `json:"messageId"`
	Seq               int64   `json:"seq"`
	Preview           string  `json:"preview"`
	SenderID          string  `json:"senderId"`
	SenderType        string  `json:"senderType"`
	SenderName        string  `json:"senderName"`
	SenderDisplayName string  `json:"senderDisplayName"`
	SenderAvatarURL   *string `json:"senderAvatarUrl"`
	CreatedAt         string  `json:"createdAt"`
}
