// Typed domain errors. The transport layer maps each to the exact legacy
// status/body; nothing here leaks internal diagnostics.
package agent

import "errors"

// Error is a domain error with the legacy wire status and stable code.
// Code is empty for plain-message legacy bodies (TS res.json({error})).
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// AsError unwraps err into *Error, or nil when it is not a domain error.
func AsError(err error) *Error {
	var domain *Error
	if errors.As(err, &domain) {
		return domain
	}
	return nil
}

func errf(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// Frequently reused errors (exact TS bodies).
var (
	ErrAgentNotFound = errf(404, "", "Agent not found")

	// ErrSetupChangedRetry is the create-vs-reset CAS failure
	// (TS ServerSetupChangedRetryError -> 409 with the code as message).
	ErrSetupChangedRetry = errf(409, "SERVER_SETUP_CHANGED_RETRY",
		"SERVER_SETUP_CHANGED_RETRY: server setup changed while this request was waiting; retry from the current setup screen")

	// Post-verify liveness (TS authenticateAgentCredential). Distinct from a
	// bad key, which stays a nil lookup so callers can say "invalid credential".
	ErrAuthenticatedAgentGone  = errf(401, "", "Agent no longer exists")
	ErrAuthenticatedServerGone = errf(401, "", "Server no longer exists")

	// Credential surface errors (stable Tier-1 codes).
	ErrTokenInvalid  = errf(401, "token_invalid", "token_invalid")
	ErrTokenRevoked  = errf(401, "token_revoked", "token_revoked")
	ErrTokenExpired  = errf(401, "token_expired", "token_expired")
	ErrTokenConsumed = errf(410, "token_consumed", "token_consumed")
	ErrAgentMissing  = errf(410, "agent_missing", "agent_missing")

	// Bootstrap surface gates.
	ErrBootstrapDisabled = errf(404, "self_hosted_runner_bootstrap_disabled",
		"Self-hosted runner bootstrap is not enabled")
	ErrDeviceLoginDisabled = errf(404, "device_login_disabled",
		"Device login (and the agent credential mint surface that depends on it) is not enabled")
)
