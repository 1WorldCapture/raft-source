// PATCH /api/auth/me: preference updates with the legacy validation order and
// error sentences, plus explicit input caps.
package humanapi

import (
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"regexp"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
)

var storedAvatarPathPattern = regexp.MustCompile(`^/api/avatars/users/[0-9a-f]{32}\.(png|webp|gif|jpeg|jpg)$`)

func (h *Handlers) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body == nil {
		body = map[string]any{}
	}

	// 1. Password change first, exactly like the legacy route.
	currentPassword, currentOK, _ := bodyString(body, "currentPassword")
	newPassword, newOK, _ := bodyString(body, "newPassword")
	if currentOK && currentPassword != "" && newOK && newPassword != "" {
		if len(newPassword) < 8 {
			httpx.WriteError(w, http.StatusBadRequest, "New password must be at least 8 characters")
			return
		}
		if len(newPassword) > auth.MaxPasswordLength {
			httpx.WriteError(w, http.StatusBadRequest, "New password must be at most 1024 characters")
			return
		}
		if err := h.Auth.ChangePassword(r.Context(), authn.UserID(r), currentPassword, newPassword); err != nil {
			if domain := auth.AsError(err); domain != nil && domain.Code == auth.ErrCodeCurrentPasswordWrong {
				httpx.WriteErrorCode(w, http.StatusUnauthorized, "AUTH_CURRENT_PASSWORD_INCORRECT", domain.Message)
				return
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to update profile")
			return
		}
	}

	patch, err := buildProfilePatch(body, time.Now())
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	var user *auth.User
	if patch != nil {
		user, err = h.Auth.ApplyProfilePatch(r.Context(), authn.UserID(r), *patch)
	} else {
		user, err = h.Users(r.Context(), authn.UserID(r))
	}
	if err != nil && !errors.Is(err, auth.ErrNotFound) {
		httpx.WriteAuthUnavailable(w)
		return
	}
	if user == nil {
		httpx.WriteInvalidToken(w)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, UserToDTO(user))
}

// buildProfilePatch validates every recognized PATCH field. A nil patch means
// "no profile columns changed". Hardening divergences vs the legacy route:
// displayName is length-checked, avatarUrl must be a stored-avatar path, and
// the password cap is explicit.
func buildProfilePatch(body map[string]any, now time.Time) (*auth.ProfilePatch, error) {
	patch := auth.ProfilePatch{}
	touched := false

	if raw, present := body["displayName"]; present {
		s, ok := raw.(string)
		if !ok {
			return nil, errText("displayName must be a string")
		}
		trimmed := strings.TrimSpace(s)
		if trimmed == "" || len([]rune(trimmed)) > auth.MaxDisplayNameLength {
			return nil, errText("Display name must be between 1 and 80 characters")
		}
		patch.DisplayName = &trimmed
		touched = true
	}

	if raw, present := body["description"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok || len(s) > auth.MaxDescriptionLength {
				return nil, errText("Description must be a string of at most 3000 characters")
			}
			trimmed := strings.TrimSpace(s)
			if trimmed == "" {
				patch.Description = clearedString()
			} else {
				patch.Description = &trimmed
			}
		} else {
			patch.Description = clearedString()
		}
		touched = true
	}

	if raw, present := body["avatarUrl"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok || !storedAvatarPathPattern.MatchString(s) {
				return nil, errText("avatarUrl must be a server-stored avatar path or null")
			}
			patch.AvatarURL = &s
		} else {
			patch.AvatarURL = clearedString()
		}
		touched = true
	}

	if raw, present := body["preferredLanguage"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok {
				return nil, errText("preferredLanguage must be a string or null")
			}
			normalized := auth.NormalizeTranslationLanguageCode(s)
			if normalized == "" {
				return nil, errText("preferredLanguage must be a supported language tag")
			}
			patch.PreferredLanguage = &normalized
		} else {
			patch.PreferredLanguage = clearedString()
		}
		touched = true
	}

	if raw, present := body["displayLanguage"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok {
				return nil, errText("displayLanguage must be a string or null")
			}
			normalized := auth.NormalizeDisplayLocale(s)
			if normalized == "" {
				return nil, errText("displayLanguage must be a supported UI display locale")
			}
			patch.DisplayLanguage = &normalized
		} else {
			patch.DisplayLanguage = clearedString()
		}
		touched = true
	}

	if raw, present := body["preferredTimezone"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok {
				return nil, errText("preferredTimezone must be a string or null")
			}
			timezone, err := auth.ParseIANATimezone(s, "preferredTimezone")
			if err != nil {
				return nil, err
			}
			patch.PreferredTimezone = &timezone
		} else {
			patch.PreferredTimezone = clearedString()
		}
		touched = true
	}

	translationModeSet := false
	if raw, present := body["preferredTranslationMode"]; present {
		s, ok := raw.(string)
		if !ok {
			return nil, errText("preferredTranslationMode must be auto, manual, or off")
		}
		value := strings.ToLower(strings.TrimSpace(s))
		if value != "auto" && value != "manual" && value != "off" {
			return nil, errText("preferredTranslationMode must be auto, manual, or off")
		}
		patch.PreferredTranslationMode = &value
		auto := value == "auto"
		patch.AutoTranslationEnabled = &auto
		translationModeSet = true
		touched = true
	}

	if raw, present := body["autoTranslationEnabled"]; present && !translationModeSet {
		b, ok := raw.(bool)
		if !ok {
			return nil, errText("autoTranslationEnabled must be a boolean")
		}
		patch.AutoTranslationEnabled = &b
		mode := "off"
		if b {
			mode = "auto"
		}
		patch.PreferredTranslationMode = &mode
		touched = true
	}

	if raw, present := body["preferredTranslationDisplay"]; present {
		s, ok := raw.(string)
		if !ok {
			return nil, errText("preferredTranslationDisplay must be translated, original, or bilingual")
		}
		value := strings.ToLower(strings.TrimSpace(s))
		if value != "translated" && value != "original" && value != "bilingual" {
			return nil, errText("preferredTranslationDisplay must be translated, original, or bilingual")
		}
		patch.PreferredTranslationDisplay = &value
		touched = true
	}

	if raw, present := body["preferredTimeFormat"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok {
				return nil, errText("preferredTimeFormat must be 12h, 24h, or null")
			}
			normalized := auth.NormalizeTimeFormatPreference(s)
			if normalized == "" {
				return nil, errText("preferredTimeFormat must be 12h, 24h, or null")
			}
			patch.PreferredTimeFormat = &normalized
		} else {
			patch.PreferredTimeFormat = clearedString()
		}
		touched = true
	}

	if raw, present := body["preferredMessageBodyFontSize"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok {
				return nil, errText("preferredMessageBodyFontSize must be sm, md, lg, or null")
			}
			value := strings.ToLower(strings.TrimSpace(s))
			if value == "" {
				patch.PreferredMessageBodyFontSize = clearedString()
			} else if value != "sm" && value != "md" && value != "lg" {
				return nil, errText("preferredMessageBodyFontSize must be sm, md, lg, or null")
			} else {
				patch.PreferredMessageBodyFontSize = &value
			}
		} else {
			patch.PreferredMessageBodyFontSize = clearedString()
		}
		touched = true
	}

	stampedAt := now
	if raw, present := body["signupRole"]; present {
		if raw != nil {
			s, ok := raw.(string)
			if !ok || !auth.IsSignupRole(s) {
				return nil, errText("Invalid signupRole")
			}
			patch.SignupRole = &s
		} else {
			patch.SignupRole = clearedString()
		}
		patch.SignupSurveyCompletedAt = &stampedAt
		touched = true
	}

	referralSource, referralIsString, referralAbsent := bodyString(body, "referralSource")
	referralPresent := !referralAbsent
	if referralPresent && !referralIsString && body["referralSource"] != nil {
		return nil, errText("referralSource must be a string or null")
	}
	if referralPresent {
		if referralSource != "" {
			if !auth.IsAcceptedReferralSource(referralSource) {
				return nil, errText("Invalid referralSource")
			}
			patch.ReferralSource = &referralSource
			other := ""
			if referralSource == "other" {
				if rawOther, ok := body["referralSourceOther"]; ok && rawOther != nil {
					s, isStr := rawOther.(string)
					if !isStr {
						return nil, errText("referralSourceOther must be a string")
					}
					trimmed := strings.TrimSpace(s)
					if len(trimmed) > 200 {
						trimmed = trimmed[:200]
					}
					if trimmed != "" {
						other = trimmed
					}
				}
			}
			if other != "" {
				patch.ReferralSourceOther = &other
			} else {
				patch.ReferralSourceOther = clearedString()
			}
		} else {
			patch.ReferralSource = clearedString()
			patch.ReferralSourceOther = clearedString()
		}
		patch.ReferralSourceSkippedAt = clearedTime()
		touched = true
	} else if _, otherPresent := body["referralSourceOther"]; otherPresent {
		return nil, errText("referralSource is required when referralSourceOther is provided")
	}

	if raw, present := body["referralSourceSkipped"]; present {
		b, ok := raw.(bool)
		if !ok {
			return nil, errText("referralSourceSkipped must be a boolean")
		}
		if b {
			stamp := stampedAt
			patch.ReferralSourceSkippedAt = &stamp
			touched = true
		}
	}

	if !touched {
		return nil, nil
	}
	return &patch, nil
}

type patchError struct{ message string }

func (e *patchError) Error() string { return e.message }

func errText(message string) error { return &patchError{message: message} }

// clearedString is the "write NULL" sentinel for patchable string columns.
func clearedString() *string { v := ""; return &v }

// clearedTime is the "write NULL" sentinel for patchable timestamp columns.
func clearedTime() *time.Time { v := time.Time{}; return &v }
