package auth

import "fmt"

// Validate in the use case as well as the HTTP boundary: internal callers
// must not be able to create/reset/change a password outside the same limits.
func validateNewPassword(password string) error {
	if len(password) < 8 {
		return NewError(ErrCodeInvalidPassword, "Password must be at least 8 characters")
	}
	if len(password) > MaxPasswordLength {
		return NewError(ErrCodeInvalidPassword, fmt.Sprintf("Password must be at most %d characters", MaxPasswordLength))
	}
	return nil
}
