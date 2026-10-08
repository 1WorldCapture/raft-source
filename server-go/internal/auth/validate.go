// Validation rules ported from @botiverse/raft-shared so the Go server
// enforces the same username/email/preference contracts as the legacy TS
// server. Keep this file in sync with packages/shared/src when contracts move.
package auth

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	// NameMinLengthUsers is the minimum length for user/server names (5).
	NameMinLengthUsers = 5
	// NameMaxLength matches shared NAME_MAX_LENGTH.
	NameMaxLength = 32
	// ProfileSetupPlaceholderPrefix marks reserved pending handles.
	ProfileSetupPlaceholderPrefix = "pending_"
	// MaxEmailLength / MaxPasswordLength are input size caps the legacy server
	// implicitly got from its 100kb JSON body limit; here they are explicit.
	MaxEmailLength    = 320
	MaxPasswordLength = 1024
	// MaxDisplayNameLength matches the legacy complete-profile bound.
	MaxDisplayNameLength = 80
	// MaxDescriptionLength matches MAX_USER_DESCRIPTION_LENGTH.
	MaxDescriptionLength = 3000
	// MaxTimezoneLength matches MAX_PREFERRED_TIMEZONE_LENGTH.
	MaxTimezoneLength = 128

	TermsVersionCurrent   = "2026-05-12"
	PrivacyVersionCurrent = "2026-05-12"
	TermsURLCurrent       = "https://raft.build/terms"
	PrivacyURLCurrent     = "https://raft.build/privacy"
)

// LegalVersions mirrors shared LegalAcceptanceVersions.
type LegalVersions struct {
	TermsVersion   string `json:"termsVersion"`
	PrivacyVersion string `json:"privacyVersion"`
	TermsURL       string `json:"termsUrl"`
	PrivacyURL     string `json:"privacyUrl"`
}

// CurrentLegalVersions returns the acceptance versions this server records.
func CurrentLegalVersions() LegalVersions {
	return LegalVersions{
		TermsVersion:   TermsVersionCurrent,
		PrivacyVersion: PrivacyVersionCurrent,
		TermsURL:       TermsURLCurrent,
		PrivacyURL:     PrivacyURLCurrent,
	}
}

// nameRegex matches shared NAME_REGEX: leading letter, then letters/digits/
// underscore/hyphen, using Unicode categories.
var nameRegex = regexp.MustCompile(`^[\p{L}][\p{L}\p{N}_-]*$`)

// reservedAgentNames matches shared RESERVED_AGENT_NAMES.
var reservedAgentNames = map[string]struct{}{
	"all": {}, "human": {}, "humans": {}, "agent": {}, "agents": {},
	"here": {}, "idle": {}, "busy": {}, "system": {},
}

// NameValidationReason is the structured why, mirroring the shared type.
type NameValidationReason struct {
	Code      string // required | tooShort | tooLong | pattern
	MinLength int
}

// ValidateNameReason validates a name against the shared rules.
func ValidateNameReason(name string, minLength int) *NameValidationReason {
	trimmed := strings.TrimSpace(name)
	if len(trimmed) == 0 {
		return &NameValidationReason{Code: "required"}
	}
	if len([]rune(trimmed)) < minLength {
		return &NameValidationReason{Code: "tooShort", MinLength: minLength}
	}
	if len([]rune(trimmed)) > NameMaxLength {
		return &NameValidationReason{Code: "tooLong"}
	}
	if !nameRegex.MatchString(trimmed) {
		return &NameValidationReason{Code: "pattern"}
	}
	return nil
}

// ValidateName returns the legacy English error sentence or nil.
func ValidateName(name, label string, minLength int) string {
	reason := ValidateNameReason(name, minLength)
	if reason == nil {
		return ""
	}
	switch reason.Code {
	case "required":
		return fmt.Sprintf("%s is required", label)
	case "tooShort":
		return fmt.Sprintf("%s must be at least %d characters", label, reason.MinLength)
	case "tooLong":
		return fmt.Sprintf("%s must be at most %d characters", label, NameMaxLength)
	default:
		return fmt.Sprintf("%s must start with a letter and can only contain letters, numbers, hyphens, and underscores", label)
	}
}

// IsReservedAgentName checks the shared reserved handle list (case-insensitive,
// optional leading @).
func IsReservedAgentName(name string) bool {
	normalized := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	_, ok := reservedAgentNames[normalized]
	return ok
}

// HasPlaceholderHandle reports whether name is still a pending_ reservation.
func HasPlaceholderHandle(name string) bool {
	return name != "" && strings.HasPrefix(strings.ToLower(name), ProfileSetupPlaceholderPrefix)
}

// AccountNeedsIdentitySetup mirrors shared accountNeedsIdentitySetup: ask the
// handle fact, not the completion-stamp proxy.
func AccountNeedsIdentitySetup(name string, _ *int64) bool {
	return name == "" || HasPlaceholderHandle(name)
}

// NormalizeEmail mirrors the legacy trim + lowercase normalization.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// emailPattern is the legacy simple address shape used elsewhere in shared.
var emailPattern = regexp.MustCompile(`^[^\s@,]+@[^\s@,]+\.[^\s@]+$`)

// ValidateEmailAddress checks shape and length; empty returns "required".
func ValidateEmailAddress(email string) string {
	trimmed := strings.TrimSpace(email)
	if trimmed == "" {
		return "Email is required"
	}
	if len(trimmed) > MaxEmailLength {
		return fmt.Sprintf("Email must be at most %d characters", MaxEmailLength)
	}
	if !emailPattern.MatchString(trimmed) {
		return "Invalid email address"
	}
	return ""
}

// translationLanguageSet / aliases mirror shared translationLanguages.ts.
var translationLanguageSet = map[string]struct{}{
	"en": {}, "zh-cn": {}, "zh-tw": {}, "ja": {}, "ko": {},
	"es": {}, "fr": {}, "de": {}, "pt-br": {}, "it": {},
}

var translationLanguageAliases = map[string]string{
	"zh": "zh-cn", "zh-hans": "zh-cn", "zh-hant": "zh-tw",
}

// NormalizeTranslationLanguageCode mirrors the shared normalizer; returns ""
// when unsupported.
func NormalizeTranslationLanguageCode(language string) string {
	normalized := strings.ToLower(strings.TrimSpace(language))
	if normalized == "" {
		return ""
	}
	if alias, ok := translationLanguageAliases[normalized]; ok {
		return alias
	}
	if _, ok := translationLanguageSet[normalized]; ok {
		return normalized
	}
	base := strings.SplitN(normalized, "-", 2)[0]
	if _, ok := translationLanguageSet[base]; ok {
		return base
	}
	return ""
}

// NormalizeDisplayLocale mirrors shared displayLocales.ts: only en / zh-cn are
// renderable; region/script variants collapse within a shipped base only.
func NormalizeDisplayLocale(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return ""
	}
	if value == "en" || strings.HasPrefix(value, "en-") {
		return "en"
	}
	if value == "zh-cn" || value == "zh" || value == "zh-hans" || value == "zh-hans-cn" {
		return "zh-cn"
	}
	return ""
}

// NormalizeTimeFormatPreference returns "12h"/"24h" or "".
func NormalizeTimeFormatPreference(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "12h" || normalized == "24h" {
		return normalized
	}
	return ""
}

// referralSourceOptions and signupRoleOptions mirror the shared taxonomies.
var referralSourceOptions = map[string]struct{}{
	"twitter_x": {}, "linkedin": {}, "friend_colleague": {}, "search": {},
	"hn_reddit": {}, "podcast_blog_newsletter": {}, "other": {},
}

var signupRoleOptions = map[string]struct{}{
	"software_engineer": {}, "engineering_leader": {}, "founder": {}, "product": {},
	"design": {}, "data_ml": {}, "devops_it": {}, "student": {}, "other": {},
}

// IsAcceptedReferralSource checks write-side option membership.
func IsAcceptedReferralSource(value string) bool {
	_, ok := referralSourceOptions[value]
	return ok
}

// IsSignupRole checks write-side role membership.
func IsSignupRole(value string) bool {
	_, ok := signupRoleOptions[value]
	return ok
}

// ParseIANATimezone mirrors parseIanaTimezone: non-empty, <=128 chars, and a
// zone the platform can load. The binary embeds the tz database via
// time/tzdata so behavior is hermetic across hosts.
func ParseIANATimezone(raw, fieldName string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%s must be a non-empty IANA timezone", fieldName)
	}
	if len(value) > MaxTimezoneLength {
		return "", fmt.Errorf("%s must be at most 128 characters", fieldName)
	}
	if _, err := time.LoadLocation(value); err != nil {
		return "", fmt.Errorf("%s must be an IANA timezone", fieldName)
	}
	return value, nil
}

// ParseCanonicalBrowserTimezone mirrors parseCanonicalBrowserTimezone: the
// canonical zone must round-trip and look like a zone path (or be UTC).
func ParseCanonicalBrowserTimezone(raw string) (string, error) {
	timezone, err := ParseIANATimezone(raw, "timezone")
	if err != nil {
		return "", err
	}
	if timezone != "UTC" && !strings.Contains(timezone, "/") {
		return "", fmt.Errorf("timezone must be a canonical IANA timezone")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return "", fmt.Errorf("timezone must be a canonical IANA timezone")
	}
	// Go canonicalizes aliases (e.g. Asia/Calcutta -> Asia/Kolkata).
	canonical := location.String()
	if canonical != "UTC" && !strings.Contains(canonical, "/") {
		return "", fmt.Errorf("timezone must be a canonical IANA timezone")
	}
	return canonical, nil
}

// SlugifyUserName mirrors slugifyUserName: lowercase slug with a letter prefix
// and a >=5 character floor, used to derive suggested handles.
func SlugifyUserName(seed string) string {
	trimmed := strings.TrimSpace(seed)
	var lowered strings.Builder
	for _, r := range trimmed {
		lowered.WriteRune(unicode.ToLower(r))
	}
	normalized := regexpNonSlug.ReplaceAllString(lowered.String(), "-")
	normalized = strings.Trim(normalized, "-")
	if normalized == "" {
		normalized = "user-account"
	}
	if !regexpASCIILetterStart.MatchString(normalized) {
		normalized = "user-" + normalized
	}
	normalized = regexpDashRun.ReplaceAllString(normalized, "-")
	normalized = strings.Trim(normalized, "-")
	if normalized == "" {
		normalized = "user-account"
	}
	if len(normalized) < 5 {
		normalized += "-user"
	}
	return normalized
}

var (
	regexpNonSlug          = regexp.MustCompile(`[^a-z0-9_-]+`)
	regexpASCIILetterStart = regexp.MustCompile(`^[a-z]`)
	regexpDashRun          = regexp.MustCompile(`-+`)
)
