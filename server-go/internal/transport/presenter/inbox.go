package presenter

import (
	"time"

	"raft.local/server-go/internal/readstate"
)

// inboxWireTime renders the legacy ISO-8601 millisecond wire form.
func inboxWireTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// InboxItemWire renders the exact TS InboxItem JSON shape (JSON key order is
// not significant to the consumers; Go's map marshaling sorts keys stably).
// This is a byte-identical port of the retired readstate domain encoder: the
// wire shape is owned here, the InboxItem facts stay exported by readstate.
func InboxItemWire(item readstate.InboxItem) map[string]any {
	latestSeq := any(nil)
	if item.LatestActivitySeq != nil {
		latestSeq = formatUint64(uint64(*item.LatestActivitySeq))
	}
	nullString := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	readState := any(map[string]any{"kind": "absent"})
	if item.ReadState != nil {
		switch item.ReadState.Kind {
		case "present":
			present := map[string]any{
				"kind":             "present",
				"readStateVersion": item.ReadState.Version,
				"maxReadSeq":       formatUint64(uint64(item.ReadState.MaxReadSeq)),
			}
			if item.ReadState.LatestValid {
				present["latestActivity"] = map[string]any{
					"messageId": item.ReadState.LatestID,
					"seq":       formatUint64(uint64(item.ReadState.LatestSeq)),
				}
			} else {
				present["latestActivity"] = nil
			}
			readState = present
		default:
			readState = map[string]any{"kind": item.ReadState.Kind}
		}
	}
	if item.Kind == "thread" {
		var lastReplyAt any
		if item.LatestReplyAtMS != nil {
			lastReplyAt = inboxWireTime(*item.LatestReplyAtMS)
		}
		wire := map[string]any{
			"kind":                     "thread",
			"threadChannelId":          item.ScopeID,
			"parentMessageId":          item.ParentMessageID,
			"parentChannelId":          item.ParentChannelID,
			"parentChannelName":        item.ParentChannelName,
			"parentChannelType":        item.ParentChannelType,
			"parentMessagePreview":     item.ParentMessagePreview,
			"parentMessageSenderType":  item.ParentSenderType,
			"parentMessageSenderId":    item.ParentSenderID,
			"latestActivityPreview":    item.LastMessagePreview,
			"latestActivitySenderKind": item.LastSenderType,
			"latestActivitySenderId":   item.LastSenderID,
			"latestActivitySenderName": nullString(item.LastSenderName),
			"latestActivityMessageId":  item.LastMessageID,
			"latestActivitySeq":        latestSeq,
			"firstUnreadMessageId":     nullString(item.FirstUnreadMessageID),
			"firstMentionMessageId":    nullString(item.FirstMentionMessageID),
			"lastActivityAt":           inboxWireTime(item.LastActivityAtMS),
			"lastReplyAt":              lastReplyAt,
			"replyCount":               item.ReplyCount,
			"unreadCount":              item.UnreadCount,
			"hasMention":               item.HasMention,
			"taskNumber":               nil,
			"taskStatus":               nil,
			"taskClaimedByName":        nil,
			"readState":                readState,
			"isFollowing":              item.IsFollowing,
		}
		if item.UnfollowedAtMS != nil {
			wire["unfollowedAt"] = inboxWireTime(*item.UnfollowedAtMS)
		}
		if item.DoneAtMS != nil {
			wire["doneAt"] = inboxWireTime(*item.DoneAtMS)
		}
		return wire
	}
	wire := map[string]any{
		"kind":                  item.Kind,
		"channelId":             item.ChannelID,
		"channelName":           item.ChannelName,
		"channelType":           item.ChannelType,
		"lastMessageId":         item.LastMessageID,
		"latestActivitySeq":     latestSeq,
		"firstUnreadMessageId":  nullString(item.FirstUnreadMessageID),
		"firstMentionMessageId": nullString(item.FirstMentionMessageID),
		"lastMessageAt":         inboxWireTime(item.LastActivityAtMS),
		"lastMessagePreview":    item.LastMessagePreview,
		"lastMessageSenderKind": item.LastSenderType,
		"lastMessageSenderId":   item.LastSenderID,
		"lastMessageSenderName": nullString(item.LastSenderName),
		"unreadCount":           item.UnreadCount,
		"hasMention":            item.HasMention,
		"readState":             readState,
	}
	if item.DoneAtMS != nil {
		wire["doneAt"] = inboxWireTime(*item.DoneAtMS)
	}
	return wire
}
