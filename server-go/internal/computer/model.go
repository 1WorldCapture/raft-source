// Principal and the closed-set authentication denial taxonomy, ported from
// routes/daemon.ts resolveUpgradeAuth. Reasons/stages carry no ids, keys or
// prefixes, so transports may put Reason straight into the Slock-Reason
// header and traces.
package computer

import "errors"

// Principal kinds (closed set).
const (
	KindComputer      = "computer"
	KindLegacyMachine = "legacy_machine"
)

// Denial reasons (closed set; byte-identical to daemon.ts AuthDenyReason).
const (
	ReasonMissingKey              = "missing_key"
	ReasonInvalidKeyFormat        = "invalid_key_format"
	ReasonComputerNotFound        = "computer_not_found"
	ReasonComputerRevoked         = "computer_revoked"
	ReasonComputerMachineUnlinked = "computer_machine_unlinked"
	ReasonComputerKeyMismatch     = "computer_key_hash_mismatch"
	ReasonServerNotFound          = "server_not_found"
	ReasonMachineNotFound         = "machine_not_found"
	ReasonMachineKeyInvalid       = "machine_key_invalid"
	ReasonLegacyKeyMigrated       = "legacy_machine_key_migrated"
)

// Auth stages (closed set; daemon.ts AuthStage).
const (
	StageFormat          = "format"
	StageComputerLookup  = "computer_lookup"
	StageMachineLookup   = "machine_lookup"
	StageLegacyMigration = "legacy_migration"
	StageServerLookup    = "server_lookup"
)

// Principal is the resolved machine-plane identity behind one presented key.
// See docs/m3-computer-contract.md §2.1 for the field contract.
type Principal struct {
	Kind        string
	ComputerID  string
	MachineID   string
	WorkspaceID string
	UserID      string
	// CredentialRevision identifies the verified stored verifier, not the
	// presented secret. It fences key rotation on an established connection.
	CredentialRevision string `json:"-"`
}

// AuthError is a wire-safe closed-set denial. Infrastructure failures are
// plain errors instead: callers must answer 5xx, never a denial Reason.
type AuthError struct {
	Reason string
	Stage  string
}

func (e *AuthError) Error() string {
	return "computer: auth denied: " + e.Reason
}

// AsAuthError unwraps an AuthError, or returns nil for other errors.
func AsAuthError(err error) *AuthError {
	var ae *AuthError
	if errors.As(err, &ae) {
		return ae
	}
	return nil
}

// Sentinel domain errors used by the admission use cases.
var (
	// ErrNotAuthorized collapses missing/soft-deleted workspace and
	// non-membership into one answer (anti-enumeration).
	ErrNotAuthorized = errors.New("computer: not authorized")
	// ErrForbidden is a capability denial for a known member.
	ErrForbidden = errors.New("computer: forbidden")
	// ErrMachineNotFound is the cross-workspace/uniform machine miss.
	ErrMachineNotFound = errors.New("computer: machine not found")
	// ErrComputerNameCollision is the live duplicate display name.
	ErrComputerNameCollision = errors.New("computer: name collision")
)

// AttachError carries the closed attach failure set for HTTP mapping.
type AttachError struct{ Code string }

func (e *AttachError) Error() string { return "computer: attach failed: " + e.Code }

// Attach failure codes (TS attachComputer result errors).
const (
	AttachNotAuthorized = "not_authorized"
	AttachRequiresAdmin = "requires_admin"
	AttachNameCollision = "computer_name_collision"
)

// Device grant lifecycle error strings (closed set, wire codes).
const (
	DeviceCodeInvalid         = "device_code_invalid"
	AuthorizationPending      = "authorization_pending"
	AccessDenied              = "access_denied"
	ExpiredToken              = "expired_token"
	DeviceCodeConsumed        = "device_code_consumed"
	UserCodeInvalid           = "user_code_invalid"
	AlreadyResolved           = "already_resolved"
	Expired                   = "expired"
	DeviceCodeRequired        = "device_code_required"
	DeviceLoginURLUnavailable = "DEVICE_LOGIN_URL_UNAVAILABLE"
)
