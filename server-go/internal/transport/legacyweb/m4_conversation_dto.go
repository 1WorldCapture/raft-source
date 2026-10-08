// DTO projections for the M4 conversation surface. Field names and JSON
// shapes follow the original TS routes and the web client's consumed types
// (channels.ts / channelService.ts / threadStore.ts); receiver-private
// read/mute/display projections are owned by the readstate slice and are
// added there, never invented here.
package legacyweb

import (
	"encoding/json"
	"time"

	"raft.local/server-go/internal/channel"
)

// m4DMChannel is the DM row of GET /api/channels/dm and POST /api/channels/dm
// (unified peer model; peerType stays "user" — the agent branch is refused
// before creation).
type m4DMChannel struct {
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

func m4DMChannelView(serverID string, v channel.DMView, readState json.RawMessage) m4DMChannel {
	out := m4DMChannel{
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
	if v.LastMessageAt != nil {
		out.LastMessageAt = &milliTimeDTO{time.UnixMilli(*v.LastMessageAt).UTC()}
	}
	return out
}

// m4ThreadSummary is ThreadSummary of the web threadStore (channel threads
// map: parentMessageId → summary).
type m4ThreadSummary struct {
	ThreadChannelID      string                 `json:"threadChannelId"`
	ReplyCount           int                    `json:"replyCount"`
	LastReplyAt          *milliTimeDTO          `json:"lastReplyAt"`
	ParticipantIDs       []string               `json:"participantIds"`
	UnreadCount          int                    `json:"unreadCount"`
	FirstUnreadMessageID *string                `json:"firstUnreadMessageId"`
	LatestReplies        []m4ThreadReplyPreview `json:"latestReplies"`
}

type m4ThreadReplyPreview struct {
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

func m4ThreadSummaryView(s channel.ThreadSummary) m4ThreadSummary {
	out := m4ThreadSummary{
		ThreadChannelID:      s.ThreadChannelID,
		ReplyCount:           s.ReplyCount,
		ParticipantIDs:       s.ParticipantIDs,
		UnreadCount:          s.UnreadCount,
		FirstUnreadMessageID: s.FirstUnreadMessageID,
		LatestReplies:        make([]m4ThreadReplyPreview, 0, len(s.LatestReplies)),
	}
	if s.LastReplyAt != nil {
		out.LastReplyAt = &milliTimeDTO{time.UnixMilli(*s.LastReplyAt).UTC()}
	}
	for _, r := range s.LatestReplies {
		out.LatestReplies = append(out.LatestReplies, m4ThreadReplyPreview{
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

// m4ThreadInfo is the GET /channels/{id}/threads/{messageId} body and the
// spread of POST /channels/{id}/threads.
type m4ThreadInfo struct {
	ThreadChannelID string        `json:"threadChannelId"`
	ReplyCount      int           `json:"replyCount"`
	LastReplyAt     *milliTimeDTO `json:"lastReplyAt"`
	ParticipantIDs  []string      `json:"participantIds"`
}

func m4ThreadInfoView(i *channel.ThreadInfo) m4ThreadInfo {
	out := m4ThreadInfo{
		ThreadChannelID: i.ThreadChannelID,
		ReplyCount:      i.ReplyCount,
		ParticipantIDs:  i.ParticipantIDs,
	}
	if i.LastReplyAt != nil {
		out.LastReplyAt = &milliTimeDTO{time.UnixMilli(*i.LastReplyAt).UTC()}
	}
	return out
}

// m4FollowedThread is the followed-thread row consumed by the web threadStore
// (task claimants stay null-and-absent; readState fields arrive with the
// readstate slice).
type m4FollowedThread struct {
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

func m4FollowedThreadView(t channel.FollowedThread) m4FollowedThread {
	out := m4FollowedThread{
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
