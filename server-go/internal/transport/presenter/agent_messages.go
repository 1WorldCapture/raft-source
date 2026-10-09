// Agent-facing message projection: the single mapping from transport-neutral
// message facts onto the Agent CLI HTTP envelopes (protocol/client/
// agent_messages.go). The facts carry agent-facing identities (snake_case
// sender_type already mapped to human/agent/system, thread channels named
// "thread-<shortid>") so this file stays a pure projection with no database,
// authorization or business rules — mirroring the original TS split where the
// route layer renders and the orchestrator owns the facts.
package presenter

import (
	"raft.local/server-go/internal/protocol/client"
)

// AgentMessageFacts is the transport-neutral input for one agent-visible
// message row (an inbox event or a history window entry). Seq==0 means the
// row has no message seq (id-only events); TimestampMS is Unix milliseconds.
// SenderType is already agent-facing: "human" | "agent" | "system" |
// "third_party_app". For thread rows ChannelName is "thread-<shortid>" and
// the parent fields are set, exactly like the daemon wire snapshots.
type AgentMessageFacts struct {
	Seq               int64
	MessageID         string
	TimestampMS       int64
	SenderType        string
	SenderName        string
	SenderDescription *string
	ChannelID         string
	ChannelName       string
	ChannelType       string
	ParentChannelName *string
	ParentChannelType *string
	Content           string
	Mentioned         bool
	NonMemberMention  bool
	ThreadID          *string
	ReplyCount        *int64
}

// AgentHistoryFacts is one authorized history window plus the viewer's own
// last-read cursor. Messages are oldest-to-newest; HasOlder/HasNewer carry
// the window cursors the CLI turns into --before/--after hints.
type AgentHistoryFacts struct {
	Messages    []AgentMessageFacts
	HasOlder    bool
	HasNewer    bool
	LastReadSeq *int64
}

// AgentMessageWire projects one fact row onto the CLI envelope. Both the
// snake_case fields and the camelCase echoes carry the same values because
// the inbox formatter reads snake_case and the history formatter reads
// camelCase first; a single projection keeps them from drifting. Attachments
// keep the always-present empty array; task facts are omitted (not faked)
// while tasks are unimplemented.
func AgentMessageWire(f AgentMessageFacts) client.AgentMessageEnvelope {
	ts := client.MillisISO(f.TimestampMS)
	return client.AgentMessageEnvelope{
		Seq:                  f.Seq,
		ID:                   f.MessageID,
		MessageID:            f.MessageID,
		Timestamp:            ts,
		CreatedAt:            ts,
		SenderType:           f.SenderType,
		SenderTypeEcho:       f.SenderType,
		SenderName:           agentSenderName(f),
		SenderNameEcho:       agentSenderName(f),
		SenderDescription:    f.SenderDescription,
		SenderDescriptionCam: f.SenderDescription,
		ChannelID:            f.ChannelID,
		ChannelName:          f.ChannelName,
		ChannelType:          f.ChannelType,
		ParentName:           f.ParentChannelName,
		ParentType:           f.ParentChannelType,
		Content:              f.Content,
		Mentioned:            f.Mentioned,
		NonMemberMention:     f.NonMemberMention,
		Attachments:          []client.AgentAttachmentEnvelope{},
		ThreadID:             f.ThreadID,
		ReplyCount:           f.ReplyCount,
	}
}

// AgentMessageWireList projects a fact list, always returning a non-nil slice
// so the JSON envelope carries [] rather than null.
func AgentMessageWireList(fs []AgentMessageFacts) []client.AgentMessageEnvelope {
	out := make([]client.AgentMessageEnvelope, 0, len(fs))
	for _, f := range fs {
		out = append(out, AgentMessageWire(f))
	}
	return out
}

// agentSenderName keeps the CLI's "unknown" fallback for nameless senders
// (formatSenderHandle: m.sender_name ?? "unknown"); system rows arrive with
// their literal name already.
func agentSenderName(f AgentMessageFacts) string {
	if f.SenderName == "" {
		return "unknown"
	}
	return f.SenderName
}
