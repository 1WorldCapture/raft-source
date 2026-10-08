// Channel wire projections for the legacy-web surface. The base row shape
// comes from channel.Wire; these views add exactly the fields the TS list /
// detail / create exits attach, including the honest "no data yet" values for
// the M4/M5 domains (read cursors, last message, joint metadata).
package legacyweb

import (
	"encoding/json"

	"raft.local/server-go/internal/channel"
)

// readStateFrontier is the #632 absent-cursor shape ({kind:"absent"}): no
// read-cursor rows exist in this phase, and absence is a fact, not "all read".
type readStateFrontier struct {
	Kind string `json:"kind"`
}

// channelView is the shared list/detail/create projection body.
type channelView struct {
	channel.Wire
	Joined                   bool              `json:"joined"`
	ChannelRole              *string           `json:"channelRole"`
	ChannelAdminBasis        *string           `json:"channelAdminBasis"`
	ChannelCapabilities      map[string]bool   `json:"channelCapabilities"`
	ChannelAuthorityRevision *int64            `json:"channelAuthorityRevision"`
	MaxReadSeq               int64             `json:"maxReadSeq"`
	ReadStateVersion         int64             `json:"readStateVersion"`
	ReadState                readStateFrontier `json:"readState"`
	ActivityMuted            *bool             `json:"activityMuted,omitempty"`
	MuteFromSeq              any               `json:"muteFromSeq,omitempty"`
	PrefsVersion             *int64            `json:"prefsVersion,omitempty"`
	ActivityMuteSupported    *bool             `json:"activityMuteSupported,omitempty"`
	CollapseLongMessages     *bool             `json:"collapseLongMessages,omitempty"`
	DisplayPrefsVersion      *int64            `json:"displayPrefsVersion,omitempty"`
	LastMessageAt            any               `json:"lastMessageAt,omitempty"`
	LastMessagePreview       any               `json:"lastMessagePreview,omitempty"`
	JointChannelID           any               `json:"jointChannelId"`
	JointRole                any               `json:"jointRole"`
	JointPeerServerID        any               `json:"jointPeerServerId"`
	JointPeerServerName      any               `json:"jointPeerServerName"`
	JointPeerServerSlug      any               `json:"jointPeerServerSlug"`
	JointPeerStatus          any               `json:"jointPeerStatus"`
	JointServers             []any             `json:"jointServers"`
	JointPendingInvites      []any             `json:"jointPendingInvites"`
	JointBillingLocked       any               `json:"jointBillingLocked"`
}

// addAuthority attaches the viewer's channel authority projection
// (attachHumanChannelAuthorization). A nil context yields role/basis/revision
// null and an all-false capability map, exactly like the TS path.
func (v *channelView) addAuthority(ac *channel.ActorContext) {
	if ac != nil {
		if ac.IsChannelMember {
			role := ac.ChannelRole
			v.ChannelRole = &role
			rev := ac.ChannelAuthorityRevision
			v.ChannelAuthorityRevision = &rev
		}
		if basis := channel.GetChannelAdminBasis(
			ac.ServerRole, ac.ChannelRole, ac.IsChannelMember, ac.SupportsChannelRoles); basis != "" {
			v.ChannelAdminBasis = &basis
		}
	}
	v.ChannelCapabilities = channel.CapabilityMap(ac)
}

// addMuteState attaches the per-user activity-mute fields. With no mute-state
// table (M4 domain) the honest values are the no-row defaults, including the
// announcement default-mute. Fields appear only when the channel type has a
// user-reachable control (TS {} vs state spread).
func (v *channelView) addMuteState(c *channel.Channel, includeSupported bool) {
	supported := channel.SupportsActivityMute(c.Type)
	if includeSupported {
		s := supported
		v.ActivityMuteSupported = &s
	}
	if !supported {
		return
	}
	muted := false
	var muteFromSeq any
	prefs := int64(0)
	if channel.IsAnnouncementChannel(c) {
		// ANNOUNCEMENT_DEFAULT_MUTE: a human who never touched the setting
		// sees the hourly progress channel muted.
		muted = true
		muteFromSeq = 0
	} else {
		// A nil interface is dropped by omitempty; the wire value is JSON null.
		muteFromSeq = json.RawMessage("null")
	}
	v.ActivityMuted = &muted
	v.MuteFromSeq = muteFromSeq
	v.PrefsVersion = &prefs
}

// addDisplayPrefs attaches the per-user message-display defaults (no rows
// exist in this phase: collapse on, version 0).
func (v *channelView) addDisplayPrefs() {
	collapse := true
	version := int64(0)
	v.CollapseLongMessages = &collapse
	v.DisplayPrefsVersion = &version
}

// jointMetadata attaches the non-joint joint-channel metadata (all null/empty
// — no joint channels can exist in this phase).
func (v *channelView) jointMetadata() {
	v.JointChannelID = nil
	v.JointRole = nil
	v.JointPeerServerID = nil
	v.JointPeerServerName = nil
	v.JointPeerServerSlug = nil
	v.JointPeerStatus = nil
	v.JointServers = []any{}
	v.JointPendingInvites = []any{}
	v.JointBillingLocked = nil
}

// listView builds one GET /api/channels item (lastMessageAt/preview are null:
// no messages exist).
func channelListItem(c channel.Channel, joined bool, ac *channel.ActorContext) channelView {
	v := baseChannelView(c, joined)
	v.addAuthority(ac)
	v.addMuteState(&c, true)
	v.addDisplayPrefs()
	// List is the only exit that attaches last-message fields. With no
	// messages table the honest values are JSON null, not omitted keys.
	v.LastMessageAt = json.RawMessage("null")
	v.LastMessagePreview = json.RawMessage("null")
	v.jointMetadata()
	return v
}

// detailView builds one GET /api/channels/:id item. TS does not call
// attachLastMessageAt on this exit, so last-message keys stay absent.
func channelDetailView(c channel.Channel, joined bool, ac *channel.ActorContext) channelView {
	v := baseChannelView(c, joined)
	v.addAuthority(ac)
	v.addMuteState(&c, true)
	v.addDisplayPrefs()
	v.jointMetadata()
	return v
}

func baseChannelView(c channel.Channel, joined bool) channelView {
	return channelView{
		Wire:      c.Wire(),
		Joined:    joined,
		ReadState: readStateFrontier{Kind: "absent"},
	}
}

// createView builds the POST /api/channels response: authority + mute state
// (type-supported) + read-state + jointInvites empty; no display-pref or
// last-message fields.
type createView struct {
	channelView
	JointInvites []any `json:"jointInvites"`
	JointInvite  any   `json:"jointInvite"`
}

func channelCreateView(c channel.Channel, ac *channel.ActorContext) createView {
	v := createView{
		channelView:  baseChannelView(c, true),
		JointInvites: []any{},
		JointInvite:  nil,
	}
	v.addAuthority(ac)
	v.addMuteState(&c, true)
	v.jointMetadata()
	return v
}

// rosterHumanWire / rosterAgentWire project the members panel rows. Keys the
// TS row never carried (channelRole on derived audience rows) stay absent.
type rosterHumanWire struct {
	ID                   string  `json:"id"`
	ServerID             string  `json:"serverId"`
	ServerName           string  `json:"serverName"`
	ServerSlug           string  `json:"serverSlug"`
	Name                 string  `json:"name"`
	DisplayName          *string `json:"displayName"`
	Description          *string `json:"description"`
	AvatarURL            *string `json:"avatarUrl"`
	GravatarHash         string  `json:"gravatarHash"`
	Role                 string  `json:"role"`
	ServerRole           string  `json:"serverRole"`
	ChannelRole          *string `json:"channelRole,omitempty"`
	EffectiveChannelRole string  `json:"effectiveChannelRole"`
	ChannelAdminBasis    *string `json:"channelAdminBasis"`
	CanChangeChannelRole bool    `json:"canChangeChannelRole"`
}

type rosterAgentWire struct {
	ID                   string  `json:"id"`
	ServerID             string  `json:"serverId"`
	ServerName           string  `json:"serverName"`
	ServerSlug           string  `json:"serverSlug"`
	Name                 string  `json:"name"`
	DisplayName          *string `json:"displayName"`
	Status               string  `json:"status"`
	AvatarURL            *string `json:"avatarUrl"`
	ChannelRole          *string `json:"channelRole,omitempty"`
	ServerRole           *string `json:"serverRole,omitempty"`
	EffectiveChannelRole string  `json:"effectiveChannelRole"`
	ChannelAdminBasis    *string `json:"channelAdminBasis"`
	CanChangeChannelRole bool    `json:"canChangeChannelRole"`
}

func rosterHumanWireFrom(h channel.RosterHuman) rosterHumanWire {
	return rosterHumanWire{
		ID: h.ID, ServerID: h.ServerID, ServerName: h.ServerName, ServerSlug: h.ServerSlug,
		Name: h.Name, DisplayName: h.DisplayName, Description: h.Description,
		AvatarURL: h.AvatarURL, GravatarHash: h.GravatarHash,
		Role: h.ServerRole, ServerRole: h.ServerRole, ChannelRole: h.ChannelRole,
		EffectiveChannelRole: h.EffectiveChannelRole, ChannelAdminBasis: h.ChannelAdminBasis,
		CanChangeChannelRole: h.CanChangeChannelRole,
	}
}

func rosterAgentWireFrom(a channel.RosterAgent) rosterAgentWire {
	return rosterAgentWire{
		ID: a.ID, ServerID: a.ServerID, ServerName: a.ServerName, ServerSlug: a.ServerSlug,
		Name: a.Name, DisplayName: a.DisplayName, Status: a.Status, AvatarURL: a.AvatarURL,
		ChannelRole: a.ChannelRole, ServerRole: a.ServerRole,
		EffectiveChannelRole: a.EffectiveChannelRole, ChannelAdminBasis: a.ChannelAdminBasis,
		CanChangeChannelRole: a.CanChangeChannelRole,
	}
}

// guestsRosterAgent/Human are the reduced guest-viewer shapes (TS 3116-3140);
// unreachable under the frozen disabled guest gate but kept for the day the
// gate opens.
type guestRosterAgentWire struct {
	ID                   string  `json:"id"`
	ServerID             string  `json:"serverId"`
	Name                 string  `json:"name"`
	DisplayName          *string `json:"displayName"`
	AvatarURL            *string `json:"avatarUrl"`
	Status               string  `json:"status"`
	ProfileProjection    string  `json:"profileProjection"`
	EffectiveChannelRole string  `json:"effectiveChannelRole"`
	CanChangeChannelRole bool    `json:"canChangeChannelRole"`
}

type guestRosterHumanWire struct {
	ID                   string  `json:"id"`
	Name                 string  `json:"name"`
	DisplayName          *string `json:"displayName"`
	AvatarURL            *string `json:"avatarUrl"`
	GravatarHash         string  `json:"gravatarHash"`
	EffectiveChannelRole string  `json:"effectiveChannelRole"`
	CanChangeChannelRole bool    `json:"canChangeChannelRole"`
}
