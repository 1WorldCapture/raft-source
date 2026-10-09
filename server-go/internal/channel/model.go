// Package channel owns the M3A channel slice: public/private channels, the
// human and agent rosters, basic channel authority and visibility. It ports
// the TS channelService semantics onto the Go schema (channels/channel_humans
// from 0003, channel_agents + role events from 0006) and never touches
// message/read-cursor state (M4/M5).
package channel

import (
	"database/sql"
	"time"
)

// Channel is one row of the channels table (TS channels select()).
type Channel struct {
	ID               string
	WorkspaceID      string
	Name             string
	Description      *string
	Type             string // channel | private | joint | dm | thread
	SystemKind       *string
	GuestVisible     bool
	GuestJoinable    bool
	ParentMessageID  *string
	CreatedAt        time.Time
	ArchivedAt       *time.Time
	ArchivedByUserID *string
	ArchivedByAgent  *string
	DeletedAt        *time.Time
}

// Channel types.
const (
	TypeChannel      = "channel"
	TypePrivate      = "private"
	TypeJoint        = "joint"
	TypeDM           = "dm"
	TypeThread       = "thread"
	systemAllName    = "all"
	announcementName = "announcement"
)

// System channel predicates (TS isAllSystemChannel/isAnnouncementChannel/
// isEnabledAllChannel/hasImplicitServerMembership).
func IsAllSystemChannel(c *Channel) bool {
	return c.Name == systemAllName && (c.Type == TypeChannel || c.Type == TypePrivate)
}

func IsEnabledAllChannel(c *Channel) bool {
	return IsAllSystemChannel(c) && c.Type == TypeChannel
}

func IsAnnouncementChannel(c *Channel) bool {
	return c.SystemKind != nil && *c.SystemKind == "announcement" && c.Type == TypeChannel
}

// HasImplicitServerMembership: the enabled #all and the announcement channel
// derive their audience from server membership (no roster rows).
func HasImplicitServerMembership(c *Channel) bool {
	return IsEnabledAllChannel(c) || IsAnnouncementChannel(c)
}

// requiresExplicitMembership mirrors the TS private/joint visibility rule.
func requiresExplicitMembership(channelType string) bool {
	return channelType == TypePrivate || channelType == TypeJoint
}

// ALLChannelVisibilityRefusal is the exact TS sentence for refusing #all
// visibility through the generic PATCH field.
const ALLChannelVisibilityRefusal = "The #all channel cannot be hidden or restored by changing channel visibility. " +
	"Only a human can do it, from channel settings or server settings."

// channelColumns is the full column list used by every channel read.
const channelColumns = `c.id, c.workspace_id, c.name, c.description, c.type, c.system_kind,
	c.guest_visible, c.guest_joinable, c.parent_message_id, c.created_at,
	c.archived_at, c.archived_by_user_id, c.archived_by_agent_id, c.deleted_at`

func scanChannel(scanner interface{ Scan(dest ...any) error }) (*Channel, error) {
	var c Channel
	var description, systemKind, parentMessage, archivedByUser, archivedByAgent sql.NullString
	var archivedAt, deletedAt sql.NullInt64
	var guestVisible, guestJoinable int
	var createdAt int64
	if err := scanner.Scan(&c.ID, &c.WorkspaceID, &c.Name, &description, &c.Type, &systemKind,
		&guestVisible, &guestJoinable, &parentMessage, &createdAt,
		&archivedAt, &archivedByUser, &archivedByAgent, &deletedAt); err != nil {
		return nil, err
	}
	applyChannelNulls(&c, description, systemKind, parentMessage, archivedByUser, archivedByAgent,
		guestVisible, guestJoinable, createdAt, archivedAt, deletedAt)
	return &c, nil
}

// applyChannelNulls copies the scanned nullable channel columns onto the
// struct. Shared by scanChannel and the M4 projections that append columns
// after the channel row.
func applyChannelNulls(c *Channel, description, systemKind, parentMessage, archivedByUser, archivedByAgent sql.NullString,
	guestVisible, guestJoinable int, createdAt int64, archivedAt, deletedAt sql.NullInt64) {
	if description.Valid {
		v := description.String
		c.Description = &v
	}
	if systemKind.Valid {
		v := systemKind.String
		c.SystemKind = &v
	}
	if parentMessage.Valid {
		v := parentMessage.String
		c.ParentMessageID = &v
	}
	if archivedByUser.Valid {
		v := archivedByUser.String
		c.ArchivedByUserID = &v
	}
	if archivedByAgent.Valid {
		v := archivedByAgent.String
		c.ArchivedByAgent = &v
	}
	c.GuestVisible = guestVisible != 0
	c.GuestJoinable = guestJoinable != 0
	c.CreatedAt = time.UnixMilli(createdAt).UTC()
	if archivedAt.Valid {
		t := time.UnixMilli(archivedAt.Int64).UTC()
		c.ArchivedAt = &t
	}
	if deletedAt.Valid {
		t := time.UnixMilli(deletedAt.Int64).UTC()
		c.DeletedAt = &t
	}
}
