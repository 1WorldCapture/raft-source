package message

import (
	"database/sql"
	"time"
)

// Message is one committed row of the messages table (migration 0010).
//
// seq is the global creation sequence (SQLite AUTOINCREMENT PRIMARY KEY)
// allocated inside the writing transaction; it is never edited afterwards.
// ThreadID follows the frozen TS contract: it is the parent message's pointer
// to its thread CHANNEL; a thread reply stores ChannelID=threadChannel and
// ThreadID=nil.
type Message struct {
	Seq           int64
	ID            string
	WorkspaceID   string
	ChannelID     string
	SenderType    string // "user" in M4; schema also reserves agent/external_projection
	SenderID      string
	Content       string
	MessageType   string // "chat" | "system"
	RandomID      *string
	RequestDigest string
	ThreadID      *string
	Revision      int64
	CreatedAt     time.Time
	CreatedAtUnix int64
}

// messageColumns is the read column list for every message query.
const messageColumns = `m.seq, m.id, m.workspace_id, m.channel_id, m.sender_type, m.sender_id,
	m.content, m.message_type, m.random_id, m.request_digest, m.thread_id, m.revision, m.created_at`

func scanMessage(scanner interface{ Scan(dest ...any) error }) (*Message, error) {
	var msg Message
	var randomID, threadID sql.NullString
	if err := scanner.Scan(&msg.Seq, &msg.ID, &msg.WorkspaceID, &msg.ChannelID,
		&msg.SenderType, &msg.SenderID, &msg.Content, &msg.MessageType,
		&randomID, &msg.RequestDigest, &threadID, &msg.Revision, &msg.CreatedAtUnix); err != nil {
		return nil, err
	}
	if randomID.Valid {
		v := randomID.String
		msg.RandomID = &v
	}
	if threadID.Valid {
		v := threadID.String
		msg.ThreadID = &v
	}
	msg.CreatedAt = time.UnixMilli(msg.CreatedAtUnix).UTC()
	return &msg, nil
}

// Mention is one persisted human mention fact (message_mentions).
// Name is the directory handle projected at send time; the client-supplied
// display string is never trusted as identity.
type Mention struct {
	Type string // "user"
	ID   string
	Name string
}

// ReactionSummary is the shared per-emoji aggregate projected onto the
// message DTO. Count is derived from real rows, never blind arithmetic.
type ReactionSummary struct {
	Emoji        string
	Count        int
	ReactorIDs   []string
	ReactorNames []string
}

// SenderProfile carries the directory projection for one message sender.
type SenderProfile struct {
	Name             string // displayName || name || "User"
	Handle           string // name
	Description      *string
	MembershipStatus string // "active" | "removed" | "left" for user senders; "" for system
}
