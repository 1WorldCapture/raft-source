// Agent CLI HTTP wire shapes: the snake_case AgentMessage envelope family and
// the send/events/claim/ack/history/resolve-channel response DTOs exactly as
// the original clients decode them (packages/shared/src/agentApiContract.ts
// and agentApiMessageContract.ts at the frozen checkout). Pure protocol leaf:
// no application, domain, database or network imports. The mapping from
// transport-neutral facts lives in internal/transport/presenter.
package client

// AgentAttachmentEnvelope is the {id,filename} attachment stub. M5 carries no
// attachment facts, so only the always-present empty array shape is used;
// elements never appear and are never fabricated.
type AgentAttachmentEnvelope struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
}

// AgentMessageEnvelope is the agent-facing message row shared by /events,
// /events/claim and /history. The original wire carries the snake_case
// AgentMessage fields plus the camelCase echoes the CLI formatters prefer
// (_format.ts reads sender_type first for inbox lines, senderName/senderType
// first for history lines); both spellings are therefore explicit here.
//
// Presence semantics frozen from the TS passthrough schema: seq is omitted
// when absent (seq-less events), task fields are omitted entirely while tasks
// are not implemented (never faked), attachments is always an array, and
// nullable facts stay explicit nulls. Parent channel names/types are optional
// strings, not nullable: absent parents must be omitted for the original CLI.
type AgentMessageEnvelope struct {
	Seq       int64  `json:"seq,omitempty"`
	ID        string `json:"id"`
	MessageID string `json:"message_id"`

	// Timestamp is the AgentMessage timestamp; CreatedAt echoes the same
	// instant under the history formatter's preferred spelling.
	Timestamp string `json:"timestamp"`
	CreatedAt string `json:"createdAt,omitempty"`

	SenderType           string  `json:"sender_type"`
	SenderTypeEcho       string  `json:"senderType"`
	SenderName           string  `json:"sender_name"`
	SenderNameEcho       string  `json:"senderName"`
	SenderDescription    *string `json:"sender_description"`
	SenderDescriptionCam *string `json:"senderDescription,omitempty"`

	ChannelID   string  `json:"channel_id"`
	ChannelName string  `json:"channel_name"`
	ChannelType string  `json:"channel_type"`
	ParentName  *string `json:"parent_channel_name,omitempty"`
	ParentType  *string `json:"parent_channel_type,omitempty"`

	Content          string                    `json:"content"`
	Mentioned        bool                      `json:"mentioned"`
	NonMemberMention bool                      `json:"non_member_mention,omitempty"`
	Attachments      []AgentAttachmentEnvelope `json:"attachments"`

	ThreadID   *string `json:"threadId,omitempty"`
	ReplyCount *int64  `json:"replyCount,omitempty"`
}

// AgentSendSentResponse is the committed branch of the send response union
// (agentApiSendSentResponseSchema): {ok, state:"sent", messageId, messageSeq}.
// The held-freshness branch is never produced by this server (no attested
// send facts); the union stays wire-compatible because the CLI branches on
// state.
type AgentSendSentResponse struct {
	OK         bool   `json:"ok"`
	State      string `json:"state"`
	MessageID  string `json:"messageId"`
	MessageSeq int64  `json:"messageSeq"`
}

// AgentEventsResponse is the v0.8 catch-up envelope of GET /events:
// pending_notice_ids stays the frozen empty placeholder and wake_reason the
// frozen null; last_seen_msgId/last_seen_seq are delivery-batch echoes, not a
// model-seen boundary.
type AgentEventsResponse struct {
	Events           []AgentMessageEnvelope `json:"events"`
	LastSeenMsgID    *string                `json:"last_seen_msgId"`
	LastSeenSeq      *int64                 `json:"last_seen_seq"`
	ReplyTarget      *string                `json:"reply_target"`
	PendingNoticeIDs []string               `json:"pending_notice_ids"`
	WakeReason       *string                `json:"wake_reason"`
	HasMore          bool                   `json:"has_more"`
}

// AgentEventsAckBatch is the claim receipt handed back by /events/claim and
// replayed verbatim to POST /events/ack. It is the ENTIRE claim token content
// on the original wire (base64url JSON {v:1,s,m,t} built client-side): no
// server secret, lease generation or signature exists or may be required.
type AgentEventsAckBatch struct {
	Seqs               []int64  `json:"seqs"`
	MessageIDs         []string `json:"message_ids"`
	ThirdPartyEventIDs []string `json:"third_party_event_ids"`
}

// AgentEventsClaimResponse is the claim-mode body: the events envelope plus
// the ack receipt of the returned batch (nothing is acknowledged yet).
type AgentEventsClaimResponse struct {
	AgentEventsResponse
	Ack AgentEventsAckBatch `json:"ack"`
}

// AgentEventsAckResponse is {ok:true, removed_count:N}. removed_count counts
// only rows actually removed for the authenticated agent; a repeated or
// partially foreign batch honestly reports what it removed (0 on replay).
type AgentEventsAckResponse struct {
	OK           bool  `json:"ok"`
	RemovedCount int64 `json:"removed_count"`
}

// AgentHistoryResponse is the history window: oldest-to-newest messages with
// the older/newer cursors and the agent's own last-read seq (nullable).
type AgentHistoryResponse struct {
	Messages    []AgentMessageEnvelope `json:"messages"`
	HasMore     bool                   `json:"has_more"`
	HasOlder    bool                   `json:"has_older"`
	HasNewer    bool                   `json:"has_newer"`
	LastReadSeq *int64                 `json:"last_read_seq"`
}

// AgentResolveChannelResponse is {channelId} for a resolved writable target.
type AgentResolveChannelResponse struct {
	ChannelID string `json:"channelId"`
}
