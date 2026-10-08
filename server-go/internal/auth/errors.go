// Domain error taxonomy. Transport maps each code to the exact legacy HTTP
// status/body; services never format HTTP themselves.
package auth

import "errors"

// Error is a typed domain failure.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Domain error codes.
const (
	ErrCodeInvalidEmail         = "invalid_email"
	ErrCodeInvalidPassword      = "invalid_password"
	ErrCodeEmailRegistered      = "email_already_registered"
	ErrCodeUsernameTaken        = "username_taken"
	ErrCodeLegalRequired        = "legal_acceptance_required"
	ErrCodeTermsChanged         = "terms_changed"
	ErrCodeInvalidCredentials   = "invalid_credentials"
	ErrCodeEmailAlreadyVerified = "email_already_verified"
	ErrCodeResendRateLimited    = "resend_rate_limited"
	ErrCodeResendCooldown       = "resend_cooldown"
	ErrCodeInvalidVerifyToken   = "invalid_verification_token"
	ErrCodeInvalidResetToken    = "invalid_reset_token"
	ErrCodeCurrentPasswordWrong = "current_password_incorrect"
	ErrCodeUserNotFound         = "user_not_found"
	ErrCodeProfileNameInvalid   = "PROFILE_SETUP_NAME_INVALID"
	ErrCodeProfileNameReserved  = "PROFILE_SETUP_NAME_RESERVED"
	ErrCodeProfileNameTaken     = "PROFILE_SETUP_NAME_TAKEN"
	ErrCodeProfileAlreadyDone   = "PROFILE_SETUP_ALREADY_COMPLETED"
	ErrCodeProfileUserNotFound  = "PROFILE_SETUP_USER_NOT_FOUND"
)

// NewError builds a domain error.
func NewError(code, message string) *Error { return &Error{Code: code, Message: message} }

// AsError extracts a domain error, or nil.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// Sentinel for "not found" lookups distinct from domain failures.
var ErrNotFoundSentinel = ErrNotFound
