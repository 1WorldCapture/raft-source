package message

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// The wire projection of one message. Every key mirrors the committed TS
// surface: the drizzle row (camelCase) plus the enrichment fields the
// original handlers emit. M4-disabled facts stay present with their honest
// null/empty values instead of disappearing.
//
// Presence semantics (canonicalMessageManifest): reactions/mentions/
// attachments are ALWAYS present on history/context/sync surfaces with
// explicit empty arrays meaning "cleared"; the send response carries only the
// sender-subset the TS pipeline attaches at creation time.

// millisISO renders the legacy JSON.stringify(Date) shape.
func millisISO(unixMilli int64) string {
	return time.UnixMilli(unixMilli).UTC().Format("2006-01-02T15:04:05.000Z")
}

// MessageDTO is the full enriched projection used by history, context, sync,
// reaction mutation responses and message:updated.
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

// SendResponseMessageDTO is the creation-time subset: the row plus senderName,
// senderMembershipStatus, attachments and the resolved mentions. The original
// send pipeline does not attach reactions/handle/description on this surface.
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

// userDirectoryProfile is the directory projection for senders.
type userDirectoryProfile struct {
	Handle      string
	Name        string
	Description *string
}

// userDirectory loads the minimal directory projection for the given user ids
// (name/displayName/description), exactly like the TS batch sender lookup.
func (s *Store) userDirectory(ctx context.Context, ex dbExecutor, ids map[string]bool) (map[string]userDirectoryProfile, error) {
	out := map[string]userDirectoryProfile{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids))
	for id := range ids {
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT id, name, display_name, description FROM users
		WHERE id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("directory lookup: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var displayName, description *string
		if err := rows.Scan(&id, &name, &displayName, &description); err != nil {
			return nil, err
		}
		profile := userDirectoryProfile{Handle: name, Name: name}
		if displayName != nil && *displayName != "" {
			profile.Name = *displayName
		}
		profile.Description = description
		out[id] = profile
	}
	return out, rows.Err()
}

// membershipStatuses resolves the senderMembershipStatus projection for user
// senders: "active" while the sender still belongs to the message's
// workspace, "removed" otherwise (the Go schema keeps no departure-reason
// table, so the left/removed split of the TS surface collapses to removed).
func (s *Store) membershipStatuses(ctx context.Context, ex dbExecutor, workspaceID string, msgs []*Message) (map[string]string, error) {
	ids := map[string]bool{}
	for _, m := range msgs {
		if m.SenderType == "user" && m.MessageType != "system" {
			ids[m.SenderID] = true
		}
	}
	statuses := map[string]string{}
	if len(ids) == 0 {
		return statuses, nil
	}
	args := []any{workspaceID}
	for id := range ids {
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT user_id FROM workspace_memberships
		WHERE workspace_id = ? AND user_id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		statuses[id] = "active"
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for id := range ids {
		if statuses[id] == "" {
			statuses[id] = "removed"
		}
	}
	return statuses, nil
}

// reactionsForMessages loads the shared aggregates: per message, per emoji,
// real row counts and the reactor name list in first-reaction order.
func (s *Store) reactionsForMessages(ctx context.Context, ex dbExecutor, messageIDs []string) (map[string][]ReactionSummary, error) {
	out := map[string][]ReactionSummary{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT r.message_id, r.emoji, r.user_id,
		COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), 'Unknown user')
		FROM message_reactions r LEFT JOIN users u ON u.id = r.user_id
		WHERE r.message_id IN (`+placeholders(len(messageIDs))+`)
		ORDER BY r.created_at, r.rowid`, anyStrings(messageIDs)...)
	if err != nil {
		return nil, fmt.Errorf("reaction aggregate: %w", err)
	}
	defer rows.Close()
	byMessage := map[string]map[string]*ReactionSummary{}
	for rows.Next() {
		var messageID, emoji, userID, name string
		if err := rows.Scan(&messageID, &emoji, &userID, &name); err != nil {
			return nil, err
		}
		emojis := byMessage[messageID]
		if emojis == nil {
			emojis = map[string]*ReactionSummary{}
			byMessage[messageID] = emojis
		}
		summary := emojis[emoji]
		if summary == nil {
			summary = &ReactionSummary{Emoji: emoji, ReactorIDs: []string{}, ReactorNames: []string{}}
			emojis[emoji] = summary
		}
		summary.Count++
		summary.ReactorIDs = append(summary.ReactorIDs, userID)
		summary.ReactorNames = append(summary.ReactorNames, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for messageID, emojis := range byMessage {
		list := make([]ReactionSummary, 0, len(emojis))
		for _, summary := range emojis {
			list = append(list, *summary)
		}
		out[messageID] = list
	}
	return out, nil
}

// mentionsForMessages loads mention facts per message in insertion order.
func (s *Store) mentionsForMessages(ctx context.Context, ex dbExecutor, messageIDs []string) (map[string][]Mention, error) {
	out := map[string][]Mention{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT mm.message_id, mm.user_id, u.name
		FROM message_mentions mm JOIN users u ON u.id = mm.user_id
		WHERE mm.message_id IN (`+placeholders(len(messageIDs))+`)
		ORDER BY mm.rowid`, anyStrings(messageIDs)...)
	if err != nil {
		return nil, fmt.Errorf("mention read: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var m Mention
		if err := rows.Scan(&messageID, &m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "user"
		out[messageID] = append(out[messageID], m)
	}
	return out, rows.Err()
}

// ProjectMessages builds the full DTO list for one snapshot read. Sender
// profiles, membership status, reactions and mentions come from the same
// snapshot executor as the rows themselves.
func (s *Store) ProjectMessages(ctx context.Context, ex dbExecutor, workspaceID string, msgs []*Message) ([]*MessageDTO, error) {
	if len(msgs) == 0 {
		return []*MessageDTO{}, nil
	}
	senderIDs := map[string]bool{}
	for _, m := range msgs {
		switch {
		case m.SenderType == "user" && m.MessageType != "system":
			senderIDs[m.SenderID] = true
		case m.MessageType == "system" || m.SenderID == "system":
			// "System" label, exactly like the TS nameMap seed.
		}
	}
	profiles, err := s.userDirectory(ctx, ex, senderIDs)
	if err != nil {
		return nil, err
	}
	statuses, err := s.membershipStatuses(ctx, ex, workspaceID, msgs)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		ids = append(ids, m.ID)
	}
	reactions, err := s.reactionsForMessages(ctx, ex, ids)
	if err != nil {
		return nil, err
	}
	mentions, err := s.mentionsForMessages(ctx, ex, ids)
	if err != nil {
		return nil, err
	}

	out := make([]*MessageDTO, 0, len(msgs))
	for _, m := range msgs {
		dto := &MessageDTO{
			ID: m.ID, Seq: m.Seq, ChannelID: m.ChannelID,
			SenderType: m.SenderType, SenderID: m.SenderID,
			RandomID: m.RandomID, MessageType: m.MessageType, Content: m.Content,
			ThreadID:     m.ThreadID,
			CreatedAt:    millisISO(m.CreatedAtUnix),
			UpdatedAt:    millisISO(m.CreatedAtUnix),
			Reactions:    []ReactionSummaryDTO{},
			Mentions:     []MentionDTO{},
			Attachments:  []AttachmentDTO{},
			SenderName:   "Unknown",
			SenderHandle: "Unknown",
		}
		if m.MessageType == "system" || m.SenderID == "system" {
			dto.SenderName = "System"
			dto.SenderHandle = "System"
		} else if prof, ok := profiles[m.SenderID]; ok {
			dto.SenderName = orDefault(prof.Name, "User")
			dto.SenderHandle = orDefault(prof.Handle, "User")
			dto.SenderDescription = prof.Description
		}
		if m.SenderType == "user" && m.MessageType != "system" {
			status := statuses[m.SenderID]
			dto.SenderMembershipStatus = &status
		}
		for _, r := range reactions[m.ID] {
			dto.Reactions = append(dto.Reactions, ReactionSummaryDTO{
				Emoji: r.Emoji, Count: r.Count, ReactorIDs: r.ReactorIDs, ReactorNames: r.ReactorNames,
			})
		}
		for _, mn := range mentions[m.ID] {
			dto.Mentions = append(dto.Mentions, MentionDTO{Type: mn.Type, ID: mn.ID, Name: mn.Name})
		}
		out = append(out, dto)
	}
	return out, nil
}

// SendResponseMessage builds the creation-surface subset for one committed or
// replayed message. senderMembershipStatus is "active": the sender passed the
// posting authorization inside the same transaction that committed the row.
func (s *Store) SendResponseMessage(ctx context.Context, ex dbExecutor, msg *Message, mentions []Mention) (*SendResponseMessageDTO, error) {
	profile, err := s.userDirectory(ctx, ex, map[string]bool{msg.SenderID: true})
	if err != nil {
		return nil, err
	}
	senderName := "User"
	if prof, ok := profile[msg.SenderID]; ok {
		senderName = orDefault(prof.Name, "User")
	}
	dto := &SendResponseMessageDTO{
		ID: msg.ID, Seq: msg.Seq, ChannelID: msg.ChannelID,
		SenderType: msg.SenderType, SenderID: msg.SenderID,
		RandomID: msg.RandomID, MessageType: msg.MessageType, Content: msg.Content,
		ThreadID:    msg.ThreadID,
		CreatedAt:   millisISO(msg.CreatedAtUnix),
		UpdatedAt:   millisISO(msg.CreatedAtUnix),
		SenderName:  senderName,
		Attachments: []AttachmentDTO{},
		Mentions:    []MentionDTO{},
	}
	if msg.SenderType == "user" && msg.MessageType != "system" {
		active := "active"
		dto.SenderMembershipStatus = &active
	}
	for _, m := range mentions {
		dto.Mentions = append(dto.Mentions, MentionDTO{Type: m.Type, ID: m.ID, Name: m.Name})
	}
	return dto, nil
}

// sortEmojis is the deterministic reactedEmojis order (TS: ORDER BY emoji then
// .sort()).
func sortEmojis(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

// Socket projection helpers for the realtime worker. The canonical manifest
// seals storage-only columns (agentSendKey/searchText/searchVector) and the
// non-canonical senderHandle at the socket boundary
// (projectRichMessageSocketPayload, canonicalMessageManifest exclusions);
// message:new additionally carries the creation-time conversationContext.
// These functions are the single projection seam so the transport cannot
// drift from the sealed set.

// ConversationContextDTO is buildFrontendConversationContext's wire shape.
type ConversationContextDTO struct {
	ChannelType       string `json:"channelType"`
	ParentMessageID   string `json:"parentMessageId,omitempty"`
	ParentChannelID   string `json:"parentChannelId,omitempty"`
	ParentChannelType string `json:"parentChannelType,omitempty"`
}

// SocketMessageNew projects a committed message for the message:new
// broadcast: the full enriched DTO minus the sealed storage columns, plus
// the conversation context (thread context needs the parent channel facts).
func SocketMessageNew(dto *MessageDTO, channelType string, parent *ThreadParentRef) map[string]any {
	payload := SocketMessageUpdated(dto)
	payload["conversationContext"] = ConversationContextDTO{
		ChannelType:       channelType,
		ParentMessageID:   stringOrEmpty(parent.ParentMessageID),
		ParentChannelID:   stringOrEmpty(parent.ParentChannelID),
		ParentChannelType: parent.ParentChannelType,
	}
	return payload
}

// ThreadParentRef carries the thread anchor facts for the context projection.
type ThreadParentRef struct {
	ParentMessageID   string
	ParentChannelID   string
	ParentChannelType string
}

// SocketMessageUpdated projects message:updated: shared aggregate changes
// only, storage-only fields sealed, no private viewer state.
func SocketMessageUpdated(dto *MessageDTO) map[string]any {
	raw, err := json.Marshal(dto)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return map[string]any{}
	}
	for _, sealed := range []string{"agentSendKey", "searchText", "searchVector", "senderHandle"} {
		delete(payload, sealed)
	}
	return payload
}

func stringOrEmpty(v string) string { return v }
