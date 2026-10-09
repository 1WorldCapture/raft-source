// Message-family wire rendering: the pure mappings from message facts onto
// the protocol/client DTOs, including the frozen socket sealing rules and
// the resume envelope. No database, no authorization, no network.

package presenter

import (
	"encoding/json"
	"errors"
	"fmt"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/protocol/client"
)

// messageWire renders one enriched fact bundle onto the full wire DTO with
// the canonical presence semantics: reactions/mentions/attachments always
// present as arrays, M4-disabled facts present with their honest null/empty
// values, sender defaults exactly like the original projection.
func messageWire(p *message.Projection) *client.MessageDTO {
	dto := &client.MessageDTO{
		ID: p.ID, Seq: p.Seq, ChannelID: p.ChannelID,
		SenderType: p.SenderType, SenderID: p.SenderID,
		RandomID: p.RandomID, MessageType: p.MessageType, Content: p.Content,
		ThreadID:     p.ThreadID,
		CreatedAt:    client.MillisISO(p.CreatedAtUnix),
		UpdatedAt:    client.MillisISO(p.CreatedAtUnix),
		Reactions:    []client.ReactionSummaryDTO{},
		Mentions:     []client.MentionDTO{},
		Attachments:  []client.AttachmentDTO{},
		SenderName:   "Unknown",
		SenderHandle: "Unknown",
	}
	if p.SenderName == "System" && p.SenderHandle == "System" {
		dto.SenderName = "System"
		dto.SenderHandle = "System"
	} else if p.SenderDirectoryKnown {
		dto.SenderName = orDefault(p.SenderName, "User")
		dto.SenderHandle = orDefault(p.SenderHandle, "User")
		dto.SenderDescription = p.SenderDescription
	}
	if p.SenderMembershipStatus != nil {
		dto.SenderMembershipStatus = p.SenderMembershipStatus
	}
	for _, r := range p.Reactions {
		dto.Reactions = append(dto.Reactions, client.ReactionSummaryDTO{
			Emoji: r.Emoji, Count: r.Count, ReactorIDs: r.ReactorIDs, ReactorNames: r.ReactorNames,
		})
	}
	for _, m := range p.Mentions {
		dto.Mentions = append(dto.Mentions, client.MentionDTO{Type: m.Type, ID: m.ID, Name: m.Name})
	}
	return dto
}

// MessageWire renders one enriched fact bundle onto the full wire DTO.
func MessageWire(p *message.Projection) *client.MessageDTO { return messageWire(p) }

// MessageWireList renders a fact list.
func MessageWireList(ps []*message.Projection) []*client.MessageDTO {
	out := make([]*client.MessageDTO, 0, len(ps))
	for _, p := range ps {
		out = append(out, messageWire(p))
	}
	return out
}

// SendResponseWire renders the creation-surface subset: the row, senderName,
// senderMembershipStatus "active" (the sender passed the posting
// authorization inside the committing transaction), attachments and the
// resolved mentions — no reactions, no handle/description on this surface.
func SendResponseWire(p *message.Projection) *client.SendResponseMessageDTO {
	senderName := "User"
	if p.SenderDirectoryKnown {
		senderName = orDefault(p.SenderName, "User")
	} else if p.SenderName == "System" && p.SenderHandle == "System" {
		senderName = "System"
	}
	dto := &client.SendResponseMessageDTO{
		ID: p.ID, Seq: p.Seq, ChannelID: p.ChannelID,
		SenderType: p.SenderType, SenderID: p.SenderID,
		RandomID: p.RandomID, MessageType: p.MessageType, Content: p.Content,
		ThreadID:    p.ThreadID,
		CreatedAt:   client.MillisISO(p.CreatedAtUnix),
		UpdatedAt:   client.MillisISO(p.CreatedAtUnix),
		SenderName:  senderName,
		Attachments: []client.AttachmentDTO{},
		Mentions:    []client.MentionDTO{},
	}
	if p.SenderType == "user" && p.MessageType != "system" {
		active := "active"
		dto.SenderMembershipStatus = &active
	}
	for _, m := range p.Mentions {
		dto.Mentions = append(dto.Mentions, client.MentionDTO{Type: m.Type, ID: m.ID, Name: m.Name})
	}
	return dto
}

// ConversationContextWire renders the creation-time identity projection with
// its omitempty anchor semantics.
func ConversationContextWire(c *message.ConversationContextFacts) *client.ConversationContextDTO {
	if c == nil {
		return nil
	}
	return &client.ConversationContextDTO{
		ChannelType:       c.ChannelType,
		ParentMessageID:   c.ParentMessageID,
		ParentChannelID:   c.ParentChannelID,
		ParentChannelType: c.ParentChannelType,
	}
}

// ViewerSnapshotWire renders the receiver-private reaction-viewer state.
func ViewerSnapshotWire(v *message.ViewerSnapshotFacts) client.ReactionViewerSnapshotDTO {
	return client.ReactionViewerSnapshotDTO{
		ServerID:      v.WorkspaceID,
		MessageID:     v.MessageID,
		ViewerVersion: v.ViewerVersion,
		ReactedEmojis: v.ReactedEmojis,
	}
}

// Socket sealed projections: the canonical manifest seals storage-only
// columns (agentSendKey/searchText/searchVector) and the non-canonical
// senderHandle at the socket boundary; message:new additionally carries the
// creation-time conversation context.

// socketSealedFields are removed from every socket broadcast payload.
var socketSealedFields = []string{"agentSendKey", "searchText", "searchVector", "senderHandle"}

// SocketMessageUpdated projects message:updated: shared aggregate changes
// only, storage-only fields sealed, no private viewer state.
func SocketMessageUpdated(dto *client.MessageDTO) map[string]any {
	raw, err := json.Marshal(dto)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return map[string]any{}
	}
	for _, sealed := range socketSealedFields {
		delete(payload, sealed)
	}
	return payload
}

// SocketMessageUpdatedInContext projects the message:updated broadcast
// payload: the sealed shared aggregate plus the same conversationContext the
// original reaction/aggregate emit carries. A nil context yields the plain
// sealed aggregate — never a fabricated one.
func SocketMessageUpdatedInContext(dto *client.MessageDTO, context *client.ConversationContextDTO) map[string]any {
	payload := SocketMessageUpdated(dto)
	if context != nil {
		payload["conversationContext"] = *context
	}
	return payload
}

// SocketMessageNew projects the message:new broadcast: the sealed full DTO
// plus the creation-time conversation context (thread context needs the
// parent channel facts).
func SocketMessageNew(dto *client.MessageDTO, channelType string, parent *client.ThreadParentRef) map[string]any {
	payload := SocketMessageUpdated(dto)
	payload["conversationContext"] = client.ConversationContextDTO{
		ChannelType:       channelType,
		ParentMessageID:   parent.ParentMessageID,
		ParentChannelID:   parent.ParentChannelID,
		ParentChannelType: parent.ParentChannelType,
	}
	return payload
}

// ThreadUpdatedWire renders the frozen thread:updated payload from the
// shared summary facts. The sync-core window fields keep their honest zero
// values exactly like the previous projection (byte-identical wire).
func ThreadUpdatedWire(f *message.ThreadFacts, workspaceID string) client.ThreadUpdatedDTO {
	out := client.ThreadUpdatedDTO{
		ParentMessageID: f.ParentMessageID,
		ThreadChannelID: f.ThreadChannelID,
		ReplyCount:      f.ReplyCount,
		ParticipantIDs:  f.ParticipantIDs,
		ServerID:        workspaceID,
	}
	if f.LastReplyAtMS != nil {
		iso := client.MillisISO(*f.LastReplyAtMS)
		out.LastReplyAt = &iso
	}
	return out
}

// ThreadSummaryWire renders one history-page thread summary row.
func ThreadSummaryWire(s channel.ThreadSummary) client.ThreadSummary {
	out := client.ThreadSummary{
		ThreadChannelID:      s.ThreadChannelID,
		ReplyCount:           s.ReplyCount,
		ParticipantIDs:       s.ParticipantIDs,
		UnreadCount:          s.UnreadCount,
		FirstUnreadMessageID: s.FirstUnreadMessageID,
		LatestReplies:        []client.ThreadLatestReply{},
	}
	if s.ParticipantIDs == nil {
		out.ParticipantIDs = []string{}
	}
	if s.LastReplyAt != nil {
		iso := client.MillisISO(*s.LastReplyAt)
		out.LastReplyAt = &iso
	}
	for _, r := range s.LatestReplies {
		preview := client.ThreadLatestReply{
			MessageID:  r.MessageID,
			Seq:        r.Seq,
			Preview:    r.Preview,
			SenderID:   r.SenderID,
			SenderType: r.SenderType,
			CreatedAt:  client.MillisISO(r.CreatedAt),
		}
		if r.SenderType == "user" {
			preview.SenderName = orDefault(r.SenderName, "User")
			preview.SenderDisplayName = orDefault(r.SenderDisplayName, "User")
		} else {
			preview.SenderName = "Agent"
			preview.SenderDisplayName = "Agent"
		}
		out.LatestReplies = append(out.LatestReplies, preview)
	}
	return out
}

// ThreadSummaryWireMap renders a parent-id-keyed summary map.
func ThreadSummaryWireMap(summaries map[string]channel.ThreadSummary) map[string]client.ThreadSummary {
	out := make(map[string]client.ThreadSummary, len(summaries))
	for parent, s := range summaries {
		out[parent] = ThreadSummaryWire(s)
	}
	return out
}

// ---- resume envelope budget ----------------------------------------------
//
// The frozen Socket.IO resume byte budget over the FULLY ENCODED envelope
// (braces, keys, separators, cursor digits — never just message bodies).

// ResumeMaxEncodedBytes is the per-page default (1 MiB).
const ResumeMaxEncodedBytes = 1 << 20

// envelopeSlack covers {"messages":[…],"currentSeq":N,"hasMore":B} plus a
// conservative margin; the final exact re-check below guarantees it.
const envelopeSlack = 128

// ErrResumeMessageExceedsBudget is returned when even ONE visible message
// (with the envelope) cannot fit the configured byte budget. The gateway
// must apply its slow-consumer policy (retry with a full budget or close the
// connection) — the API never silently skips the row and never returns an
// empty-but-advanceless page that would loop forever.
var ErrResumeMessageExceedsBudget = errors.New("resume page: a single message exceeds the byte budget")

// RenderResumePage applies the resume byte budget to one facts page and
// renders the wire envelope. A page is always a seq PREFIX: when the bound
// cuts the tail, currentSeq stops at the last INCLUDED message so the next
// resume re-fetches exactly the cut rows — no visible message is ever
// skipped. rows pairs each projection with its creation seq (same order).
func RenderResumePage(projections []*message.Projection, coveredThrough int64, hasMore bool, maxEncodedBytes int64) (*client.ResumeEnvelope, error) {
	if maxEncodedBytes <= 0 {
		maxEncodedBytes = ResumeMaxEncodedBytes
	}
	dtos := MessageWireList(projections)
	if dtos == nil {
		dtos = []*client.MessageDTO{}
	}
	currentSeq := coveredThrough

	if len(dtos) > 0 {
		sizes := make([]int, len(dtos))
		var total int64
		for i, dto := range dtos {
			encoded, err := json.Marshal(dto)
			if err != nil {
				return nil, fmt.Errorf("resume encode: %w", err)
			}
			sizes[i] = len(encoded)
			total += int64(len(encoded))
		}
		kept := len(dtos)
		if total+int64(len(dtos)-1)+envelopeSlack > maxEncodedBytes {
			kept = 0
			var acc int64
			for i, size := range sizes {
				next := acc + int64(size)
				if i > 0 {
					next++ // comma separator
				}
				if i > 0 && next+envelopeSlack > maxEncodedBytes {
					break
				}
				acc = next
				kept++
			}
			if kept == 0 {
				// Not even one message fits: never admit it silently and
				// never loop — surface the typed budget error for the
				// gateway's retry/close policy.
				return nil, ErrResumeMessageExceedsBudget
			}
		}
		if kept < len(dtos) {
			dtos = dtos[:kept]
			hasMore = true
			// currentSeq regresses to the last included row's seq; the
			// dropped rows are re-fetched by the next resume, never skipped.
			if seq := projections[len(dtos)-1].Seq; seq > 0 {
				currentSeq = seq
			}
		}
		// Exact verification with the real envelope (separators, keys and
		// cursor digits included); shed the tail while it still exceeds.
		for {
			page := &client.ResumeEnvelope{Messages: dtos, CurrentSeq: currentSeq, HasMore: hasMore}
			encoded, err := json.Marshal(page)
			if err != nil {
				return nil, fmt.Errorf("resume envelope encode: %w", err)
			}
			if int64(len(encoded)) <= maxEncodedBytes || len(dtos) == 0 {
				break
			}
			dtos = dtos[:len(dtos)-1]
			hasMore = true
			if len(dtos) == 0 {
				return nil, ErrResumeMessageExceedsBudget
			}
			if seq := projections[len(dtos)-1].Seq; seq > 0 {
				currentSeq = seq
			}
		}
	}
	return &client.ResumeEnvelope{Messages: dtos, CurrentSeq: currentSeq, HasMore: hasMore}, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
