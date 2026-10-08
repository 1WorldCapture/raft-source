// User record shape and scanning. Nullable SQL columns map to pointer or
// tri-state fields; the DTO projection happens in transport.
package auth

import "time"

// User mirrors the account-phase user row.
type User struct {
	ID                              string
	Email                           string
	Name                            string
	DisplayName                     *string
	Description                     *string
	AvatarURL                       *string
	EmailVerified                   bool
	PasswordHash                    string
	PasswordCredentialEstablishedAt *time.Time
	PreferredLanguage               *string
	DisplayLanguage                 *string
	PreferredTimezone               *string
	FirstObservedTimezone           *string
	FirstObservedTimezoneAt         *time.Time
	LastObservedTimezone            *string
	LastObservedTimezoneAt          *time.Time
	AutoTranslationEnabled          *bool
	PreferredTranslationMode        *string
	PreferredTranslationDisplay     *string
	PreferredTimeFormat             *string
	PreferredMessageBodyFontSize    *string
	ReferralSource                  *string
	ReferralSourceOther             *string
	ReferralSourceSkippedAt         *time.Time
	SignupRole                      *string
	SignupSurveyCompletedAt         *time.Time
	ProfileSetupCompletedAt         *time.Time
	ProfileSetupSuggestedHandle     *string
	CreatedAt                       time.Time
	UpdatedAt                       time.Time
}

// NeedsIdentitySetup mirrors shared accountNeedsIdentitySetup.
func (u *User) NeedsIdentitySetup() bool {
	return u.Name == "" || HasPlaceholderHandle(u.Name)
}

// AccountToken is a one-shot email-verification or password-reset token row.
type AccountToken struct {
	ID        string
	UserID    string
	Kind      AccountTokenKind
	TokenHash string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// AccountTokenKind discriminates account_tokens.kind.
type AccountTokenKind string

const (
	AccountTokenEmailVerification AccountTokenKind = "email_verification"
	AccountTokenPasswordReset     AccountTokenKind = "password_reset"
)

// LegalAcceptance records one accepted version pair.
type LegalAcceptance struct {
	ID             string
	UserID         string
	TermsVersion   string
	PrivacyVersion string
	TermsURL       string
	PrivacyURL     string
	Source         string
	IPHash         *string
	UserAgentHash  *string
	Locale         *string
	AcceptedAt     time.Time
}

// LegalAcceptanceInput is the client-provided acceptance payload.
type LegalAcceptanceInput struct {
	AcceptTerms    bool
	TermsVersion   string
	PrivacyVersion string
}

// LegalAcceptanceMetadata is request evidence for the audit row.
type LegalAcceptanceMetadata struct {
	IPAddress *string
	UserAgent *string
	Locale    *string
}
