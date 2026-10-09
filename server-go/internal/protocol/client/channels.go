// Channel wire shapes: the raw channel row projection exactly as the legacy
// API serializes the drizzle select() row. Pure protocol leaf: the mapping
// from channel domain facts lives in internal/transport/presenter.

package client

// ChannelDTO is the raw channel row exactly as the legacy API serializes the
// drizzle select() (camelCase keys, nulls stay nulls, ISO millisecond
// timestamps). Transport embeds it in the list/detail/create projections and
// the channel:updated payloads.
type ChannelDTO struct {
	ID               string  `json:"id"`
	ServerID         string  `json:"serverId"`
	Name             string  `json:"name"`
	Description      *string `json:"description"`
	Type             string  `json:"type"`
	SystemKind       *string `json:"systemKind"`
	GuestVisible     bool    `json:"guestVisible"`
	GuestJoinable    bool    `json:"guestJoinable"`
	ParentMessageID  *string `json:"parentMessageId"`
	CreatedAt        string  `json:"createdAt"`
	ArchivedAt       *string `json:"archivedAt"`
	ArchivedByUserID *string `json:"archivedByUserId"`
	ArchivedByAgent  *string `json:"archivedByAgentId"`
	DeletedAt        *string `json:"deletedAt"`
}
