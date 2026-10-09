// DTO projections for the M4 conversation surface. Field names and JSON
// shapes follow the original TS routes and the web client's consumed types
// (channels.ts / channelService.ts / threadStore.ts); receiver-private
// read/mute/display projections are owned by the readstate slice and are
// added there, never invented here.
package humanapi

import (
	"encoding/json"
	"time"

	"raft.local/server-go/internal/channel"
)

// dmChannelWire is the DM row of GET /api/channels/dm and POST /api/channels/dm.
// peerType is the directory fact ("user" or "agent"). An empty fact stays
// "user" so older human rows keep their wire value. Agent peers have no
// gravatar.
type dmChannelWire struct {
	ID               string        `json:"id"`
	ServerID         string        `json:"serverId"`
	Name             string        `json:"name"`
	Description      *string       `json:"description"`
	Type             string        `json:"type"`
	CreatedAt        milliTimeDTO  `json:"createdAt"`
	PeerType         string        `json:"peerType"`
	PeerID           string        `json:"peerId"`
	PeerName         string        `json:"peerName"`
	PeerDisplayName  *string       `json:"peerDisplayName"`
	PeerDescription  *string       `json:"peerDescription"`
	PeerGravatarHash string        `json:"peerGravatarHash"`
	PeerAvatarURL    *string       `json:"peerAvatarUrl"`
	LastMessageAt    *milliTimeDTO `json:"lastMessageAt"`
	// ReadState is the #632 frontier serialized by the readstate seam; absent
	// while the seam is unwired (older-server tolerance), never invented here.
	ReadState json.RawMessage `json:"readState,omitempty"`
}

// milliTimeDTO renders the legacy JSON.stringify(Date) millisecond shape.
type milliTimeDTO struct{ t time.Time }

func (m milliTimeDTO) MarshalJSON() ([]byte, error) {
	return []byte(`"` + m.t.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func dmChannelWireView(serverID string, v channel.DMView, readState json.RawMessage) dmChannelWire {
	out := dmChannelWire{
		ID:               v.Channel.ID,
		ReadState:        readState,
		ServerID:         serverID,
		Name:             v.Channel.Name,
		Description:      v.Channel.Description,
		Type:             v.Channel.Type,
		CreatedAt:        milliTimeDTO{v.Channel.CreatedAt},
		PeerType:         "user",
		PeerID:           v.PeerID,
		PeerName:         v.PeerName,
		PeerDisplayName:  v.PeerDisplayName,
		PeerDescription:  v.PeerDescription,
		PeerGravatarHash: v.PeerGravatarHash,
		PeerAvatarURL:    v.PeerAvatarURL,
	}
	peerType := v.PeerType
	if peerType == "" {
		peerType = "user"
	}
	out.PeerType = peerType
	if peerType == "agent" {
		out.PeerGravatarHash = ""
	}
	if v.LastMessageAt != nil {
		out.LastMessageAt = &milliTimeDTO{time.UnixMilli(*v.LastMessageAt).UTC()}
	}
	return out
}

// threadSummaryWire is ThreadSummary of the web threadStore (channel threads
// map: parentMessageId → summary).
type threadSummaryWire struct {
	ThreadChannelID      string                   `json:"threadChannelId"`
	ReplyCount           int                      `json:"replyCount"`
	LastReplyAt          *milliTimeDTO            `json:"lastReplyAt"`
	ParticipantIDs       []string                 `json:"participantIds"`
	UnreadCount          int                      `json:"unreadCount"`
	FirstUnreadMessageID *string                  `json:"firstUnreadMessageId"`
	LatestReplies        []threadReplyPreviewWire `json:"latestReplies"`
}

type threadReplyPreviewWire struct {
	MessageID         string       `json:"messageId"`
	Seq               int64        `json:"seq"`
	Preview           string       `json:"preview"`
	SenderID          string       `json:"senderId"`
	SenderType        string       `json:"senderType"`
	SenderName        string       `json:"senderName"`
	SenderDisplayName string       `json:"senderDisplayName"`
	SenderAvatarURL   *string      `json:"senderAvatarUrl"`
	CreatedAt         milliTimeDTO `json:"createdAt"`
}

func threadSummaryWireView(s channel.ThreadSummary) threadSummaryWire {
	out := threadSummaryWire{
		ThreadChannelID:      s.ThreadChannelID,
		ReplyCount:           s.ReplyCount,
		ParticipantIDs:       s.ParticipantIDs,
		UnreadCount:          s.UnreadCount,
		FirstUnreadMessageID: s.FirstUnreadMessageID,
		LatestReplies:        make([]threadReplyPreviewWire, 0, len(s.LatestReplies)),
	}
	if s.LastReplyAt != nil {
		out.LastReplyAt = &milliTimeDTO{time.UnixMilli(*s.LastReplyAt).UTC()}
	}
	for _, r := range s.LatestReplies {
		out.LatestReplies = append(out.LatestReplies, threadReplyPreviewWire{
			MessageID:         r.MessageID,
			Seq:               r.Seq,
			Preview:           r.Preview,
			SenderID:          r.SenderID,
			SenderType:        r.SenderType,
			SenderName:        r.SenderName,
			SenderDisplayName: r.SenderDisplayName,
			SenderAvatarURL:   r.SenderAvatarURL,
			CreatedAt:         milliTimeDTO{time.UnixMilli(r.CreatedAt).UTC()},
		})
	}
	return out
}

// threadInfoWire is the GET /channels/{id}/threads/{messageId} body and the
// spread of POST /channels/{id}/threads.
type threadInfoWire struct {
	ThreadChannelID string        `json:"threadChannelId"`
	ReplyCount      int           `json:"replyCount"`
	LastReplyAt     *milliTimeDTO `json:"lastReplyAt"`
	ParticipantIDs  []string      `json:"participantIds"`
}

func threadInfoWireView(i *channel.ThreadInfo) threadInfoWire {
	out := threadInfoWire{
		ThreadChannelID: i.ThreadChannelID,
		ReplyCount:      i.ReplyCount,
		ParticipantIDs:  i.ParticipantIDs,
	}
	if i.LastReplyAt != nil {
		out.LastReplyAt = &milliTimeDTO{time.UnixMilli(*i.LastReplyAt).UTC()}
	}
	return out
}

// followedThreadWire is the followed-thread row consumed by the web threadStore
// (task claimants stay null-and-absent; readState fields arrive with the
// readstate slice).
type followedThreadWire struct {
	ThreadChannelID          string        `json:"threadChannelId"`
	ParentMessageID          string        `json:"parentMessageId"`
	ParentChannelID          string        `json:"parentChannelId"`
	ParentChannelName        string        `json:"parentChannelName"`
	ParentChannelType        string        `json:"parentChannelType"`
	ParentMessagePreview     string        `json:"parentMessagePreview"`
	ParentMessageSenderType  string        `json:"parentMessageSenderType"`
	ParentMessageSenderID    string        `json:"parentMessageSenderId"`
	LatestActivityPreview    string        `json:"latestActivityPreview"`
	LatestActivitySenderType string        `json:"latestActivitySenderType"`
	LatestActivitySenderID   string        `json:"latestActivitySenderId"`
	LatestActivityMessageID  string        `json:"latestActivityMessageId"`
	LatestActivitySeq        *string       `json:"latestActivitySeq"`
	FirstUnreadMessageID     *string       `json:"firstUnreadMessageId"`
	LastActivityAt           milliTimeDTO  `json:"lastActivityAt"`
	ReplyCount               int           `json:"replyCount"`
	LastReplyAt              *milliTimeDTO `json:"lastReplyAt"`
	UnreadCount              int           `json:"unreadCount"`
	MaxReadSeq               int64         `json:"maxReadSeq"`
	TaskID                   *string       `json:"taskId"`
	TaskNumber               *int          `json:"taskNumber"`
	TaskStatus               *string       `json:"taskStatus"`
	TaskClaimedByType        *string       `json:"taskClaimedByType"`
	TaskClaimedByID          *string       `json:"taskClaimedById"`
	TaskClaimedByName        *string       `json:"taskClaimedByName"`
}

func followedThreadWireView(t channel.FollowedThread) followedThreadWire {
	out := followedThreadWire{
		ThreadChannelID:          t.ThreadChannelID,
		ParentMessageID:          t.ParentMessageID,
		ParentChannelID:          t.ParentChannelID,
		ParentChannelName:        t.ParentChannelName,
		ParentChannelType:        t.ParentChannelType,
		ParentMessagePreview:     t.ParentMessagePreview,
		ParentMessageSenderType:  t.ParentMessageSenderType,
		ParentMessageSenderID:    t.ParentMessageSenderID,
		LatestActivityPreview:    t.LatestActivityPreview,
		LatestActivitySenderType: t.LatestActivitySenderType,
		LatestActivitySenderID:   t.LatestActivitySenderID,
		LatestActivityMessageID:  t.LatestActivityMessageID,
		LatestActivitySeq:        t.LatestActivitySeq,
		FirstUnreadMessageID:     t.FirstUnreadMessageID,
		LastActivityAt:           milliTimeDTO{time.UnixMilli(t.LastActivityAt).UTC()},
		ReplyCount:               t.ReplyCount,
		UnreadCount:              t.UnreadCount,
		MaxReadSeq:               t.MaxReadSeq,
	}
	if t.LastReplyAt != nil {
		out.LastReplyAt = &milliTimeDTO{time.UnixMilli(*t.LastReplyAt).UTC()}
	}
	return out
}
