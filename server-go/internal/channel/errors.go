// Typed channel-domain failures. Transport maps each code to the exact legacy
// HTTP status/body; anything else is an infrastructure error (500), never an
// authentication failure.
package channel

import "errors"

// Domain error codes used by the channel use cases.
const (
	CodeInvalidInput = "INVALID_INPUT"
	CodeForbidden    = "FORBIDDEN"
	CodeNotFound     = "NOT_FOUND"
	CodeConflict     = "CONFLICT"
)

// CapabilityRequiredMessage is the TS lock failure ("Channel capability
// required"). Routes rewrite it to the sentence each catch already uses.
const CapabilityRequiredMessage = "Channel capability required"

// VisibilityMembershipRequiredMessage is the PATCH visibility membership rule.
const VisibilityMembershipRequiredMessage = "You must be a member of this channel to change its visibility"

// NotServerMemberMessage matches requireServer when the live membership is gone.
const NotServerMemberMessage = "Not a member of this server"

// DomainError is a typed business failure with the legacy message sentence.
type DomainError struct {
	Code    string
	Message string
}

func (e *DomainError) Error() string { return e.Message }

// AsDomainError extracts a DomainError, or nil for wrapped/other errors.
func AsDomainError(err error) *DomainError {
	var de *DomainError
	if errors.As(err, &de) {
		return de
	}
	return nil
}

// ArchivedNameCollisionError ports the TS class: the requested name is held by
// an archived (not deleted) channel, so creation refuses with a 409 payload
// that names the archived channel.
type ArchivedNameCollisionError struct {
	ChannelName         string
	ArchivedChannelID   string
	ArchivedChannelType string
}

func (e *ArchivedNameCollisionError) Error() string {
	return "Channel name \"" + e.ChannelName + "\" is held by an archived channel"
}

// AsArchivedNameCollision extracts the collision type, or nil.
func AsArchivedNameCollision(err error) *ArchivedNameCollisionError {
	var e *ArchivedNameCollisionError
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// Role mutation machine codes (TS ChannelMembershipRoleMutationError.code).
const (
	RoleCodeChannelNotFound     = "channel_not_found"
	RoleCodeCapabilityRequired  = "channel_capability_required"
	RoleCodeChannelArchived     = "channel_archived"
	RoleCodeAdminSelfDemote     = "channel_admin_self_demote_forbidden"
	RoleCodeMemberRequired      = "channel_member_required"
	RoleCodeMembershipConflict  = "channel_membership_conflict"
	RoleCodeGuestAdminForbidden = "guest_channel_admin_forbidden"
	RoleCodeUnsupportedShape    = "unsupported_channel_shape"
	RoleCodeProtectedServerRole = "protected_server_role"
)

// RoleMutationError ports ChannelMembershipRoleMutationError.
type RoleMutationError struct {
	Code    string
	Message string
}

func (e *RoleMutationError) Error() string { return e.Message }

// AsRoleMutationError extracts the typed role mutation failure, or nil.
func AsRoleMutationError(err error) *RoleMutationError {
	var e *RoleMutationError
	if errors.As(err, &e) {
		return e
	}
	return nil
}
