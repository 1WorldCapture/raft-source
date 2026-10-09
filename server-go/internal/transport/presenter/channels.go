// Channel row mapping: the raw channel row onto its legacy client DTO.
package presenter

import (
	"time"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/protocol/client"
)

// ChannelWire maps the raw channel row onto the legacy client DTO — the exact
// serialization the TS API returned for a bare drizzle select() row
// (camelCase keys, nulls stay nulls, ISO millisecond timestamps). Pure
// mapping: no database, no authorization, no network.
func ChannelWire(c channel.Channel) client.ChannelDTO {
	return client.ChannelDTO{
		ID:               c.ID,
		ServerID:         c.WorkspaceID,
		Name:             c.Name,
		Description:      c.Description,
		Type:             c.Type,
		SystemKind:       c.SystemKind,
		GuestVisible:     c.GuestVisible,
		GuestJoinable:    c.GuestJoinable,
		ParentMessageID:  c.ParentMessageID,
		CreatedAt:        client.MillisISO(c.CreatedAt.UnixMilli()),
		ArchivedAt:       milliISO(c.ArchivedAt),
		ArchivedByUserID: c.ArchivedByUserID,
		ArchivedByAgent:  c.ArchivedByAgent,
		DeletedAt:        milliISO(c.DeletedAt),
	}
}

// milliISO renders an optional timestamp in the legacy ISO millisecond form
// (JSON null when absent).
func milliISO(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := client.MillisISO(t.UnixMilli())
	return &s
}
