// Port of the shared permission model the channel surface consumes:
// packages/shared serverPermissions.ts (role→capability matrix) and
// channelPermissions.ts (channel-local authority), plus the shared name
// validation sentences. Pure functions only — no storage here.
package channel

import (
	"strings"
	"unicode"
)

// Server roles (TS ServerRole).
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleGuest  = "guest"
)

// Channel-local roles (TS ChannelRole).
const (
	ChannelRoleMember = "member"
	ChannelRoleAdmin  = "admin"
)

// Server capability keys (subset the channel slice resolves; the matrix below
// carries the full TS grant sets for the roles this phase can hold).
const (
	CapViewChannel          = "viewChannel"
	CapCreateChannels       = "createChannels"
	CapEditChannelMetadata  = "editChannelMetadata"
	CapArchiveChannels      = "archiveChannels"
	CapDeleteChannels       = "deleteChannels"
	CapChangeChannelVis     = "changeChannelVisibility"
	CapManageGuestAccess    = "manageGuestAccess"
	CapFederateChannels     = "federateChannels"
	CapViewChannelMembers   = "viewChannelMembers"
	CapJoinPublicChannels   = "joinPublicChannels"
	CapAddChannelMembers    = "addChannelMembers"
	CapRemoveChannelMembers = "removeChannelMembers"
	CapChangeChannelRoles   = "changeChannelMemberRoles"
)

// serverCapabilities is the frozen TS matrix: owner = everything; admin =
// everything except manageBilling; member = the ten granted keys; guest =
// nothing. manageBilling never matters on this surface but stays excluded for
// admin exactly like the TS source.
var serverCapabilities = map[string]map[string]bool{
	RoleOwner:  allCapabilities(),
	RoleAdmin:  allCapabilities(),
	RoleMember: caps(CapViewChannel, CapCreateChannels, CapViewChannelMembers, CapJoinPublicChannels, CapAddChannelMembers, "viewMembers", "viewAgents", "controlAgentRuntime", "viewMachines", "assignTasks"),
	RoleGuest:  {},
}

func caps(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

func allCapabilities() map[string]bool {
	return caps(
		"viewChannel", "createChannels", "editChannelMetadata", "archiveChannels",
		"deleteChannels", "changeChannelVisibility", "manageGuestAccess",
		"federateChannels", "viewChannelMembers", "joinPublicChannels",
		"addChannelMembers", "removeChannelMembers", "changeChannelMemberRoles",
		"viewMembers", "inviteMembers", "removeMembers", "changeMemberRoles",
		"viewServerSettings", "editServerSettings", "manageIntegrations",
		"manageExternalAuth", "rotateServerSecrets", "viewAgents", "createAgents",
		"editAgents", "controlAgentRuntime", "resetAgentWorkspace", "deleteAgents",
		"migrateAgents", "issueAgentCredentials", "viewMachines", "registerMachines",
		"editMachines", "controlComputers", "removeMachines", "rotateMachineKeys",
		"assignTasks", "deleteAnyTask", "viewBilling",
	)
}

// HasServerCapability mirrors hasServerCapability: unknown roles have nothing.
func HasServerCapability(role string, capability string) bool {
	return serverCapabilities[role][capability]
}

// channelAdminCapabilities is the closed set a stored channel-admin role may
// grant (TS CHANNEL_ADMIN_CAPABILITIES).
var channelAdminCapabilities = caps(
	CapEditChannelMetadata, CapArchiveChannels, CapRemoveChannelMembers,
	CapChangeChannelRoles, CapManageGuestAccess,
)

// ChannelManagementCapabilities is the projected capability set attached to
// list/detail responses (TS CHANNEL_MANAGEMENT_CAPABILITIES order).
var ChannelManagementCapabilities = []string{
	CapEditChannelMetadata, CapArchiveChannels, CapDeleteChannels, CapChangeChannelVis,
	CapManageGuestAccess, CapFederateChannels, CapAddChannelMembers,
	CapRemoveChannelMembers, CapChangeChannelRoles,
}

// SupportsChannelRoles: only regular public/private channels other than #all
// carry stored channel roles.
func SupportsChannelRoles(channelType, name string) bool {
	return (channelType == TypeChannel || channelType == TypePrivate) && name != systemAllName
}

// HasEffectiveChannelCapability ports hasEffectiveChannelCapability: server
// authority first, then the stored channel-admin grant under the fail-closed
// role rule (a stale grant must never elevate a guest).
func HasEffectiveChannelCapability(serverRole string, channelRole string, isChannelMember, supportsChannelRoles bool, capability string) bool {
	if HasServerCapability(serverRole, capability) {
		return true
	}
	return isChannelMember &&
		supportsChannelRoles &&
		channelRole == ChannelRoleAdmin &&
		(serverRole == RoleOwner || serverRole == RoleAdmin || serverRole == RoleMember) &&
		channelAdminCapabilities[capability]
}

// GetChannelAdminBasis ports the projected basis (server_role | channel_role |
// both | null) with the same fail-closed stored-grant rule.
func GetChannelAdminBasis(serverRole string, channelRole string, isChannelMember, supportsChannelRoles bool) string {
	inherited := serverRole == RoleOwner || serverRole == RoleAdmin
	stored := isChannelMember &&
		supportsChannelRoles &&
		channelRole == ChannelRoleAdmin &&
		(serverRole == RoleOwner || serverRole == RoleAdmin || serverRole == RoleMember)
	switch {
	case inherited && stored:
		return "both"
	case inherited:
		return "server_role"
	case stored:
		return "channel_role"
	default:
		return ""
	}
}

// CanAddChannelMembers ports the object-aware add-member policy: server
// owner/admin may always add; an ordinary member must already be a channel
// member; guests and visitors never; #all/DM/threads are not addable.
func CanAddChannelMembers(serverRole string, isChannelMember bool, channelType, channelName string, archived, deleted bool) bool {
	addable := (channelType == TypeChannel || channelType == TypePrivate || channelType == TypeJoint) &&
		channelName != systemAllName
	if !addable || archived || deleted {
		return false
	}
	if serverRole == RoleOwner || serverRole == RoleAdmin {
		return true
	}
	return serverRole == RoleMember && isChannelMember
}

// CanGuestReadChannel / CanGuestJoinChannel port canGuestReadChannel /
// canGuestJoinChannel. The Go policy vector keeps the guest gate disabled, so
// callers pass gateEnabled=false and both fail closed.
func CanGuestReadChannel(gateEnabled bool, serverRole, channelType, channelName string, allChannelHidden, guestVisible, guestJoinable, isChannelMember, archived, deleted bool) bool {
	if !gateEnabled || serverRole != RoleGuest || deleted {
		return false
	}
	if channelType == TypeJoint || channelType == TypeThread {
		return false
	}
	if channelType == TypeDM || channelType == TypePrivate {
		return isChannelMember
	}
	if channelName == systemAllName {
		return !allChannelHidden && guestVisible
	}
	return isChannelMember || guestVisible
}

func CanGuestJoinChannel(gateEnabled bool, serverRole, channelType, channelName string, allChannelHidden, guestVisible, guestJoinable, isChannelMember, archived, deleted bool) bool {
	if !CanGuestReadChannel(gateEnabled, serverRole, channelType, channelName, allChannelHidden, guestVisible, guestJoinable, isChannelMember, archived, deleted) {
		return false
	}
	if archived || isChannelMember || channelName == systemAllName || channelType != TypeChannel {
		return false
	}
	return guestVisible && guestJoinable
}

// SupportsActivityMute ports channelTypeSupportsActivityMute.
func SupportsActivityMute(channelType string) bool {
	return channelType == TypeChannel || channelType == TypePrivate || channelType == TypeJoint
}

// Name validation (shared index.ts): trim, 1..32 UTF-16 units, leading letter
// then letters/digits/underscore/hyphen (Unicode). Returns the exact legacy
// sentence or "".
func ValidateChannelName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "Channel name is required"
	}
	if utf16Length(trimmed) < 1 {
		return "Channel name is required"
	}
	if utf16Length(trimmed) > 32 {
		return "Channel name must be at most 32 characters"
	}
	if !namePatternMatch(trimmed) {
		return "Channel name must start with a letter and can only contain letters, numbers, hyphens, and underscores"
	}
	return ""
}

// namePatternMatch ports NAME_REGEX /^[\p{L}][\p{L}\p{N}_-]*$/u.
func namePatternMatch(s string) bool {
	first := true
	for _, r := range s {
		switch {
		case first && unicode.IsLetter(r):
			first = false
		case !first && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'):
		default:
			return false
		}
	}
	return !first
}

// utf16Length counts UTF-16 code units the way TS string.length does.
func utf16Length(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}
