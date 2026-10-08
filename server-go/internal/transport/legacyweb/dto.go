// UserDTO projection for the legacy web client. Field set, nullability and
// derivation rules mirror the TS toPublicUser; dates are ISO-8601 UTC with
// millisecond precision (the legacy JSON.stringify(Date) shape).
package legacyweb

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"raft.local/server-go/internal/auth"
)

// UserDTO is the wire shape of a user.
type UserDTO struct {
	ID                           string  `json:"id"`
	Email                        string  `json:"email"`
	GravatarHash                 string  `json:"gravatarHash"`
	Name                         string  `json:"name"`
	DisplayName                  *string `json:"displayName"`
	Description                  *string `json:"description"`
	AvatarURL                    *string `json:"avatarUrl"`
	EmailVerified                bool    `json:"emailVerified"`
	PreferredLanguage            *string `json:"preferredLanguage"`
	DisplayLanguage              *string `json:"displayLanguage"`
	PreferredTimezone            *string `json:"preferredTimezone"`
	FirstObservedTimezone        *string `json:"firstObservedTimezone"`
	FirstObservedTimezoneAt      *string `json:"firstObservedTimezoneAt"`
	LastObservedTimezone         *string `json:"lastObservedTimezone"`
	LastObservedTimezoneAt       *string `json:"lastObservedTimezoneAt"`
	PreferredTranslationMode     string  `json:"preferredTranslationMode"`
	AutoTranslationEnabled       bool    `json:"autoTranslationEnabled"`
	PreferredTranslationDisplay  string  `json:"preferredTranslationDisplay"`
	PreferredTimeFormat          *string `json:"preferredTimeFormat"`
	PreferredMessageBodyFontSize *string `json:"preferredMessageBodyFontSize"`
	ReferralSource               *string `json:"referralSource"`
	ReferralSourceOther          *string `json:"referralSourceOther"`
	ReferralSourceSkippedAt      *string `json:"referralSourceSkippedAt"`
	ProfileSetupCompletedAt      *string `json:"profileSetupCompletedAt"`
	ProfileSetupSuggestedHandle  *string `json:"profileSetupSuggestedHandle"`
	SignupSurveyCompletedAt      *string `json:"signupSurveyCompletedAt"`
	SignupRole                   *string `json:"signupRole"`
	ProfileSetupProvider         *string `json:"profileSetupProvider"`
}

// FormatDateMS renders t (nil -> null sentinel) as millisecond UTC ISO-8601.
func FormatDateMS(t *time.Time) *string {
	if t == nil {
		return nil
	}
	v := t.UTC().Format("2006-01-02T15:04:05.000Z")
	return &v
}

// GravatarHash is sha256 of the trimmed lowercase email.
func GravatarHash(email string) string {
	sum := sha256.Sum256([]byte(trimLower(email)))
	return hex.EncodeToString(sum[:])
}

func trimLower(s string) string {
	start, end := 0, len(s)
	for start < end && isSpaceByte(s[start]) {
		start++
	}
	for end > start && isSpaceByte(s[end-1]) {
		end--
	}
	lowered := []byte(s[start:end])
	for i, c := range lowered {
		if c >= 'A' && c <= 'Z' {
			lowered[i] = c + ('a' - 'A')
		}
	}
	return string(lowered)
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// UserToDTO projects the domain user.
func UserToDTO(u *auth.User) UserDTO {
	translationMode := "auto"
	if u.PreferredTranslationMode != nil {
		translationMode = *u.PreferredTranslationMode
	} else if u.AutoTranslationEnabled != nil && !*u.AutoTranslationEnabled {
		translationMode = "off"
	}
	translationDisplay := "translated"
	if u.PreferredTranslationDisplay != nil {
		translationDisplay = *u.PreferredTranslationDisplay
	}
	// Rolling-deploy parity: an absent last pair falls back to the first pair.
	lastTZ := u.LastObservedTimezone
	lastTZAt := u.LastObservedTimezoneAt
	if lastTZ == nil {
		lastTZ = u.FirstObservedTimezone
	}
	if lastTZAt == nil {
		lastTZAt = u.FirstObservedTimezoneAt
	}
	return UserDTO{
		ID:                           u.ID,
		Email:                        u.Email,
		GravatarHash:                 GravatarHash(u.Email),
		Name:                         u.Name,
		DisplayName:                  u.DisplayName,
		Description:                  u.Description,
		AvatarURL:                    u.AvatarURL,
		EmailVerified:                u.EmailVerified,
		PreferredLanguage:            u.PreferredLanguage,
		DisplayLanguage:              u.DisplayLanguage,
		PreferredTimezone:            u.PreferredTimezone,
		FirstObservedTimezone:        u.FirstObservedTimezone,
		FirstObservedTimezoneAt:      dateString(FormatDateMS(u.FirstObservedTimezoneAt)),
		LastObservedTimezone:         lastTZ,
		LastObservedTimezoneAt:       dateString(FormatDateMS(lastTZAt)),
		PreferredTranslationMode:     translationMode,
		AutoTranslationEnabled:       translationMode == "auto",
		PreferredTranslationDisplay:  translationDisplay,
		PreferredTimeFormat:          u.PreferredTimeFormat,
		PreferredMessageBodyFontSize: u.PreferredMessageBodyFontSize,
		ReferralSource:               u.ReferralSource,
		ReferralSourceOther:          u.ReferralSourceOther,
		ReferralSourceSkippedAt:      dateString(FormatDateMS(u.ReferralSourceSkippedAt)),
		ProfileSetupCompletedAt:      dateString(FormatDateMS(u.ProfileSetupCompletedAt)),
		ProfileSetupSuggestedHandle:  u.ProfileSetupSuggestedHandle,
		SignupSurveyCompletedAt:      dateString(FormatDateMS(u.SignupSurveyCompletedAt)),
		SignupRole:                   u.SignupRole,
		// Password-only accounts have no social identity to report.
		ProfileSetupProvider: nil,
	}
}

func dateString(s *string) *string { return s }

// MarshalJSON on the DTO is default; the helper keeps json import used.
var _ = json.Marshal
