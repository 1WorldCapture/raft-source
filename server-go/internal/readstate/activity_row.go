package readstate

import (
	"context"
	"encoding/json"
	"strings"

	"raft.local/server-go/internal/auth"
)

// actorKind validates the wire actor vocabulary (agents exist in the frozen
// schema even though M4 sends no agent messages).
func actorKind(v string) string {
	switch v {
	case "user", "agent", "system", "external_projection":
		return v
	}
	return "user"
}

func parentActorKind(v string) string {
	switch v {
	case "user", "agent", "external_projection":
		return v
	}
	return "user"
}

func channelKind(v string) string {
	switch v {
	case "channel", "private", "joint", "dm":
		return v
	}
	return "channel"
}

// ActivityRowPayload ports normalizeRow: the wire ActivityRow WITHOUT
// rowVersion. latestActivitySeq/maxReadSeq/readStateVersion are canonical
// decimal strings; the payload digest and the change journal store exactly
// this shape.
func (i InboxItem) ActivityRowPayload() map[string]any {
	latestSeq := formatUint64(uint64(*i.LatestActivitySeq))
	maxRead := int64(0)
	version := int64(0)
	if i.ReadState != nil && i.ReadState.Kind == "present" {
		maxRead = i.ReadState.MaxReadSeq
		version = i.ReadState.Version
	}
	firstUnread := any(nil)
	if i.FirstUnreadMessageID != nil {
		firstUnread = *i.FirstUnreadMessageID
	}
	firstMention := any(nil)
	if i.FirstMentionMessageID != nil {
		firstMention = *i.FirstMentionMessageID
	}
	senderName := any(nil)
	if i.LastSenderName != nil {
		senderName = *i.LastSenderName
	}
	if i.Kind == "thread" {
		var lastReplyAt any
		if i.LatestReplyAtMS != nil {
			lastReplyAt = wireTime(*i.LatestReplyAtMS)
		}
		return map[string]any{
			"type":                     "thread",
			"rowId":                    i.ScopeID,
			"threadChannelId":          i.ScopeID,
			"parentMessageId":          i.ParentMessageID,
			"parentChannelId":          i.ParentChannelID,
			"parentChannelName":        i.ParentChannelName,
			"parentChannelKind":        channelKind(i.ParentChannelType),
			"parentMessagePreview":     i.ParentMessagePreview,
			"parentMessageSenderKind":  parentActorKind(i.ParentSenderType),
			"parentMessageSenderId":    i.ParentSenderID,
			"latestActivityPreview":    i.LastMessagePreview,
			"latestActivitySenderKind": actorKind(i.LastSenderType),
			"latestActivitySenderId":   i.LastSenderID,
			"latestActivitySenderName": senderName,
			"latestActivityMessageId":  i.LastMessageID,
			"isFollowing":              i.IsFollowing,
			"latestActivitySeq":        latestSeq,
			"firstUnreadMessageId":     firstUnread,
			"firstMentionMessageId":    firstMention,
			"lastActivityAt":           wireTime(i.LastActivityAtMS),
			"lastReplyAt":              lastReplyAt,
			"replyCount":               i.ReplyCount,
			"unreadCount":              i.UnreadCount,
			"hasMention":               i.HasMention,
			"taskNumber":               nil,
			"taskStatus":               nil,
			"taskClaimedByName":        nil,
			"maxReadSeq":               formatUint64(uint64(maxRead)),
			"readStateVersion":         formatUint64(uint64(version)),
		}
	}
	kind := channelKind(i.ChannelType)
	if i.Kind == "dm" {
		kind = "dm"
	}
	return map[string]any{
		"type":                  i.Kind,
		"rowId":                 i.ScopeID,
		"channelId":             i.ChannelID,
		"channelName":           i.ChannelName,
		"channelKind":           kind,
		"lastMessageId":         i.LastMessageID,
		"lastMessagePreview":    i.LastMessagePreview,
		"lastMessageSenderKind": actorKind(i.LastSenderType),
		"lastMessageSenderId":   i.LastSenderID,
		"lastMessageSenderName": senderName,
		"latestActivitySeq":     latestSeq,
		"firstUnreadMessageId":  firstUnread,
		"firstMentionMessageId": firstMention,
		"lastActivityAt":        wireTime(i.LastActivityAtMS),
		"unreadCount":           i.UnreadCount,
		"hasMention":            i.HasMention,
		"maxReadSeq":            formatUint64(uint64(maxRead)),
		"readStateVersion":      formatUint64(uint64(version)),
	}
}

// encodeJSON renders a compact document (numbers stay numbers).
func encodeJSON(value any) string {
	buf, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(buf)
}

// decodeJSONObject parses a stored payload back into a generic map. Numbers
// decode as float64 only for enumeration; every numeric field this package
// re-emits is re-rendered from its own exact source, never from these floats.
func decodeJSONObject(raw string) (map[string]any, error) {
	var decoded map[string]any
	dec := json.NewDecoder(strings.NewReader(raw))
	if err := dec.Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

// decodeWindowMetadata parses the stored scope metadata document.
func decodeWindowMetadata(raw string) (WindowMetadata, error) {
	var metadata WindowMetadata
	if err := json.Unmarshal([]byte(raw), &metadata); err != nil {
		return WindowMetadata{}, err
	}
	return metadata, nil
}

// InboxItemsInTx runs the Inbox projection on an existing transaction
// executor (the Activity reconcile path) so the canonical window and the
// journal writes share one consistency boundary.
func (s *Store) InboxItemsInTx(ctx context.Context, ex Executor, claims auth.AccessTokenClaims, workspaceID string, query InboxQuery) (InboxPage, error) {
	var page InboxPage
	if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
		return page, err
	}
	role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
	if err != nil {
		return page, err
	}
	if role == "" {
		return page, forbidden("Not a member of this server")
	}
	if role == "guest" {
		return InboxPage{Items: []InboxItem{}, Groups: []InboxGroup{}}, nil
	}
	filter := query.Filter
	if filter == "" {
		filter = FilterAll
	}
	includeUnfollowed := filter == FilterAll
	items, err := s.assembleInboxItems(ctx, ex, workspaceID, claims.Subject, filter, includeUnfollowed)
	if err != nil {
		return page, err
	}
	return assembleInboxPage(items, query)
}
