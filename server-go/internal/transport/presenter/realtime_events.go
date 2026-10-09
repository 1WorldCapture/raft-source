// Package presenter maps application read models and semantic notification
// payloads onto the client-protocol wire shapes. It is a pure mapping layer:
// no database, no authorization, no network.
package presenter

import (
	"encoding/json"

	apprealtime "raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/readstate"
)

// RealtimePayload converts one semantic notification payload onto its
// protocol wire shape. Payloads that are already wire DTOs (the viewer
// snapshot, the thread summary) pass through unchanged; the event-family
// payloads map onto the protocol/client types so the wire vocabulary has
// exactly one home. Both value and pointer forms are accepted.
func RealtimePayload(event string, payload any) any {
	switch p := payload.(type) {
	case apprealtime.MessageNewFacts:
		v := p
		return messageNewWire(&v)
	case *apprealtime.MessageNewFacts:
		if p == nil {
			return nil
		}
		return messageNewWire(p)
	case apprealtime.MessageUpdatedFacts:
		v := p
		return SocketMessageUpdatedInContext(MessageWire(v.Message), ConversationContextWire(v.ConversationContext))
	case *apprealtime.MessageUpdatedFacts:
		if p == nil {
			return nil
		}
		return SocketMessageUpdatedInContext(MessageWire(p.Message), ConversationContextWire(p.ConversationContext))
	case apprealtime.ReadStateEventPayload:
		v := p
		return readStateWire(&v)
	case *apprealtime.ReadStateEventPayload:
		if p == nil {
			return nil
		}
		return readStateWire(p)
	case apprealtime.ReadStateBulkEventPayload:
		v := p
		return readStateBulkWire(&v)
	case *apprealtime.ReadStateBulkEventPayload:
		if p == nil {
			return nil
		}
		return readStateBulkWire(p)
	case apprealtime.UnreadSummaryEventPayload:
		return client.UnreadSummaryEvent{ServerID: p.ServerID}
	case *apprealtime.UnreadSummaryEventPayload:
		if p == nil {
			return nil
		}
		return client.UnreadSummaryEvent{ServerID: p.ServerID}
	case apprealtime.DMNewEventPayload:
		return client.DMNewPayload{ChannelID: p.ChannelID}
	case *apprealtime.DMNewEventPayload:
		if p == nil {
			return nil
		}
		return client.DMNewPayload{ChannelID: p.ChannelID}
	case apprealtime.ThreadUpdatedEventPayload:
		if p.Facts == nil {
			return nil
		}
		return ThreadUpdatedWire(p.Facts, p.WorkspaceID)
	case *apprealtime.ThreadUpdatedEventPayload:
		if p == nil || p.Facts == nil {
			return nil
		}
		return ThreadUpdatedWire(p.Facts, p.WorkspaceID)
	case apprealtime.ReactionViewerEventPayload:
		if p.Facts == nil {
			return nil
		}
		return ViewerSnapshotWire(p.Facts)
	case *apprealtime.ReactionViewerEventPayload:
		if p == nil || p.Facts == nil {
			return nil
		}
		return ViewerSnapshotWire(p.Facts)
	case apprealtime.ChannelMembersEventPayload:
		return client.ChannelMembersPayload{ChannelID: p.ChannelID}
	case *apprealtime.ChannelMembersEventPayload:
		if p == nil {
			return nil
		}
		return client.ChannelMembersPayload{ChannelID: p.ChannelID}
	case apprealtime.ThreadFollowersEventPayload:
		return client.ThreadFollowersPayload{ThreadChannelID: p.ThreadChannelID}
	case *apprealtime.ThreadFollowersEventPayload:
		if p == nil {
			return nil
		}
		return client.ThreadFollowersPayload{ThreadChannelID: p.ThreadChannelID}
	case apprealtime.NotificationPrefsEventPayload:
		return notificationPrefsWire(&p)
	case *apprealtime.NotificationPrefsEventPayload:
		if p == nil {
			return nil
		}
		return notificationPrefsWire(p)
	case apprealtime.DisplayPrefsEventPayload:
		return displayPrefsWire(&p)
	case *apprealtime.DisplayPrefsEventPayload:
		if p == nil {
			return nil
		}
		return displayPrefsWire(p)
	case apprealtime.ChannelUpdatedEventPayload:
		return client.ChannelUpdatedPayload{Channel: channelWireBytes(p.Channel)}
	case *apprealtime.ChannelUpdatedEventPayload:
		if p == nil {
			return nil
		}
		return client.ChannelUpdatedPayload{Channel: channelWireBytes(p.Channel)}
	case apprealtime.ChannelMembershipGainedEventPayload:
		return membershipGainedWire(p.Channel)
	case *apprealtime.ChannelMembershipGainedEventPayload:
		if p == nil {
			return nil
		}
		return membershipGainedWire(p.Channel)
	default:
		return payload
	}
}

// messageNewWire renders the sealed creation payload: full shared DTO minus
// storage-only columns, plus the creation-time conversation context.
func messageNewWire(f *apprealtime.MessageNewFacts) any {
	parent := &client.ThreadParentRef{}
	if cc := f.ConversationContext; cc != nil {
		parent.ParentMessageID = cc.ParentMessageID
		parent.ParentChannelID = cc.ParentChannelID
		parent.ParentChannelType = cc.ParentChannelType
	}
	return SocketMessageNew(MessageWire(f.Message), f.ChannelType, parent)
}

func readStateWire(p *apprealtime.ReadStateEventPayload) client.ReadStateEvent {
	return client.ReadStateEvent{ServerID: p.ServerID, ScopeID: p.ScopeID, MaxReadSeq: p.MaxReadSeq, ReadStateVersion: p.ReadStateVersion}
}

func readStateBulkWire(p *apprealtime.ReadStateBulkEventPayload) client.ReadStateBulkEvent {
	scopes := make([]client.ReadStateEvent, 0, len(p.Scopes))
	for i := range p.Scopes {
		scopes = append(scopes, readStateWire(&p.Scopes[i]))
	}
	return client.ReadStateBulkEvent{ServerID: p.ServerID, Scopes: scopes}
}

func notificationPrefsWire(p *apprealtime.NotificationPrefsEventPayload) client.NotificationPrefsPayload {
	out := client.NotificationPrefsPayload{ServerID: p.ServerID, ScopeID: p.ScopeID, PrefsVersion: p.PrefsVersion}
	out.Prefs.ActivityMuted = p.Prefs.ActivityMuted
	out.Prefs.MuteFromSeq = p.Prefs.MuteFromSeq
	return out
}

func displayPrefsWire(p *apprealtime.DisplayPrefsEventPayload) client.DisplayPrefsPayload {
	out := client.DisplayPrefsPayload{ServerID: p.ServerID, ScopeID: p.ScopeID, PrefsVersion: p.PrefsVersion}
	out.Prefs.CollapseLongMessages = p.Prefs.CollapseLongMessages
	return out
}

// membershipGainedWire renders the targeted channel:updated variant a
// newly-added human receives: the current channel projection with joined
// true INLINED into the channel object (the exact TS shape).
func membershipGainedWire(c channel.Channel) any {
	return map[string]any{"channel": struct {
		client.ChannelDTO
		Joined bool `json:"joined"`
	}{ChannelDTO: ChannelWire(c), Joined: true}}
}

func channelWireBytes(c channel.Channel) json.RawMessage {
	raw, err := json.Marshal(ChannelWire(c))
	if err != nil {
		// client.ChannelDTO is a plain JSON struct; marshaling cannot fail. A
		// failure would be a programming error, so fail loudly.
		panic("presenter: channel wire encode: " + err.Error())
	}
	return raw
}

// ReadFrontierUnion renders the #632 InboxScopeReadFrontier union JSON from
// the readstate SSOT facts — byte-identical to the domain's own
// ReadFrontierJSONTx output (a sorted-key map marshal of the same fields).
func ReadFrontierUnion(f *readstate.ReadFrontier) json.RawMessage {
	if f == nil || f.Kind != "present" {
		return json.RawMessage(`{"kind":"absent"}`)
	}
	payload := map[string]any{
		"kind":             "present",
		"readStateVersion": f.Version,
		"maxReadSeq":       formatUint64(uint64(f.MaxReadSeq)),
	}
	if f.LatestValid {
		payload["latestActivity"] = map[string]any{
			"messageId": f.LatestID,
			"seq":       formatUint64(uint64(f.LatestSeq)),
		}
	} else {
		payload["latestActivity"] = nil
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		panic("presenter: read frontier encode: " + err.Error())
	}
	return json.RawMessage(buf)
}

func formatUint64(v uint64) string {
	// decimal, no exponent — identical to the JS Number string form used by
	// the original server for the safe-integer range.
	if v == 0 {
		return "0"
	}
	digits := []byte{}
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	return string(digits)
}
