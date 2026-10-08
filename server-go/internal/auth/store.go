// SQL persistence for accounts: users, one-shot tokens, legal acceptances.
// Session tables live in sessions.go within the same database.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrNotFound marks lookups with no row.
var ErrNotFound = errors.New("not found")

// Store owns account-table access. All methods are safe for concurrent use.
type Store struct {
	db *sql.DB
}

// NewStore wraps an open database.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// DB exposes the underlying handle for transactions owned by the service.
func (s *Store) DB() *sql.DB { return s.db }

const userColumns = `id, email, name, display_name, description, avatar_url, email_verified,
	password_hash, password_credential_established_at,
	preferred_language, display_language, preferred_timezone,
	first_observed_timezone, first_observed_timezone_at,
	last_observed_timezone, last_observed_timezone_at,
	auto_translation_enabled, preferred_translation_mode, preferred_translation_display,
	preferred_time_format, preferred_message_body_font_size,
	referral_source, referral_source_other, referral_source_skipped_at,
	signup_role, signup_survey_completed_at,
	profile_setup_completed_at, profile_setup_suggested_handle,
	created_at, updated_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanUser(row rowScanner) (*User, error) {
	var u User
	var displayName, description, avatarURL sql.NullString
	var credEstablished, firstObservedAt, lastObservedAt, referralSkipped, surveyCompleted, setupCompleted sql.NullInt64
	var preferredLanguage, displayLanguage, preferredTimezone, firstObserved, lastObserved sql.NullString
	var autoTranslation sql.NullBool
	var translationMode, translationDisplay, timeFormat, fontSize sql.NullString
	var referralSource, referralOther, signupRole, suggestedHandle sql.NullString
	var createdAt, updatedAt int64
	err := row.Scan(
		&u.ID, &u.Email, &u.Name, &displayName, &description, &avatarURL,
		&u.EmailVerified, &u.PasswordHash, &credEstablished,
		&preferredLanguage, &displayLanguage, &preferredTimezone,
		&firstObserved, &firstObservedAt, &lastObserved, &lastObservedAt,
		&autoTranslation, &translationMode, &translationDisplay,
		&timeFormat, &fontSize,
		&referralSource, &referralOther, &referralSkipped,
		&signupRole, &surveyCompleted,
		&setupCompleted, &suggestedHandle,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	u.DisplayName = NullStr(displayName)
	u.Description = NullStr(description)
	u.AvatarURL = NullStr(avatarURL)
	u.PasswordCredentialEstablishedAt = millisToTime(credEstablished)
	u.PreferredLanguage = NullStr(preferredLanguage)
	u.DisplayLanguage = NullStr(displayLanguage)
	u.PreferredTimezone = NullStr(preferredTimezone)
	u.FirstObservedTimezone = NullStr(firstObserved)
	u.FirstObservedTimezoneAt = millisToTime(firstObservedAt)
	u.LastObservedTimezone = NullStr(lastObserved)
	u.LastObservedTimezoneAt = millisToTime(lastObservedAt)
	if autoTranslation.Valid {
		v := autoTranslation.Bool
		u.AutoTranslationEnabled = &v
	}
	u.PreferredTranslationMode = NullStr(translationMode)
	u.PreferredTranslationDisplay = NullStr(translationDisplay)
	u.PreferredTimeFormat = NullStr(timeFormat)
	u.PreferredMessageBodyFontSize = NullStr(fontSize)
	u.ReferralSource = NullStr(referralSource)
	u.ReferralSourceOther = NullStr(referralOther)
	u.ReferralSourceSkippedAt = millisToTime(referralSkipped)
	u.SignupRole = NullStr(signupRole)
	u.SignupSurveyCompletedAt = millisToTime(surveyCompleted)
	u.ProfileSetupCompletedAt = millisToTime(setupCompleted)
	u.ProfileSetupSuggestedHandle = NullStr(suggestedHandle)
	u.CreatedAt = time.UnixMilli(createdAt).UTC()
	u.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return &u, nil
}

func millisToTime(ns sql.NullInt64) *time.Time {
	if !ns.Valid {
		return nil
	}
	t := time.UnixMilli(ns.Int64).UTC()
	return &t
}

func timeToMillis(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UnixMilli()
}

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// InsertUser writes a new account row. Email/name uniqueness races surface as
// the driver's constraint error, which callers map to domain conflicts.
func (s *Store) InsertUser(ctx context.Context, exec executor, u *User) error {
	now := u.CreatedAt.UnixMilli()
	_, err := exec.ExecContext(ctx, `INSERT INTO users (
		id, email, name, display_name, description, avatar_url, email_verified,
		password_hash, password_credential_established_at,
		preferred_language, display_language, preferred_timezone,
		first_observed_timezone, first_observed_timezone_at,
		last_observed_timezone, last_observed_timezone_at,
		auto_translation_enabled, preferred_translation_mode, preferred_translation_display,
		preferred_time_format, preferred_message_body_font_size,
		referral_source, referral_source_other, referral_source_skipped_at,
		signup_role, signup_survey_completed_at,
		profile_setup_completed_at, profile_setup_suggested_handle,
		created_at, updated_at
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		u.ID, u.Email, u.Name, strOrNull(u.DisplayName), strOrNull(u.Description), strOrNull(u.AvatarURL),
		u.EmailVerified, u.PasswordHash, timeToMillis(u.PasswordCredentialEstablishedAt),
		strOrNull(u.PreferredLanguage), strOrNull(u.DisplayLanguage), strOrNull(u.PreferredTimezone),
		strOrNull(u.FirstObservedTimezone), timeToMillis(u.FirstObservedTimezoneAt),
		strOrNull(u.LastObservedTimezone), timeToMillis(u.LastObservedTimezoneAt),
		boolOrNull(u.AutoTranslationEnabled), strOrNull(u.PreferredTranslationMode), strOrNull(u.PreferredTranslationDisplay),
		strOrNull(u.PreferredTimeFormat), strOrNull(u.PreferredMessageBodyFontSize),
		strOrNull(u.ReferralSource), strOrNull(u.ReferralSourceOther), timeToMillis(u.ReferralSourceSkippedAt),
		strOrNull(u.SignupRole), timeToMillis(u.SignupSurveyCompletedAt),
		timeToMillis(u.ProfileSetupCompletedAt), strOrNull(u.ProfileSetupSuggestedHandle),
		now, now)
	return err
}

func boolOrNull(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

type executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// execDB adapts *sql.DB to executor.
type execDB struct{ db *sql.DB }

func (e execDB) ExecContext(ctx context.Context, q string, a ...any) (sql.Result, error) {
	return e.db.ExecContext(ctx, q, a...)
}
func (e execDB) QueryRowContext(ctx context.Context, q string, a ...any) *sql.Row {
	return e.db.QueryRowContext(ctx, q, a...)
}
func (e execDB) QueryContext(ctx context.Context, q string, a ...any) (*sql.Rows, error) {
	return e.db.QueryContext(ctx, q, a...)
}

// UserByID loads the full user row; ErrNotFound when missing.
func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return s.userByID(ctx, execDB{s.db}, id)
}

// UserByEmail loads by the already-normalized email.
func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return s.userByEmail(ctx, execDB{s.db}, email)
}

// TxExecutor exposes an executor view of a transaction for in-tx lookups.
func TxExecutor(tx *sql.Tx) executor { return txWrapper{tx} }

type txWrapper struct{ tx *sql.Tx }

func (w txWrapper) ExecContext(ctx context.Context, q string, a ...any) (sql.Result, error) {
	return w.tx.ExecContext(ctx, q, a...)
}
func (w txWrapper) QueryRowContext(ctx context.Context, q string, a ...any) *sql.Row {
	return w.tx.QueryRowContext(ctx, q, a...)
}
func (w txWrapper) QueryContext(ctx context.Context, q string, a ...any) (*sql.Rows, error) {
	return w.tx.QueryContext(ctx, q, a...)
}

func (s *Store) userByID(ctx context.Context, exec executor, id string) (*User, error) {
	return scanFirstUser(exec.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

func (s *Store) userByEmail(ctx context.Context, exec executor, email string) (*User, error) {
	return scanFirstUser(exec.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE email = ?`, email))
}

func scanFirstUser(row *sql.Row) (*User, error) {
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// UserNameExists reports an exact, case-sensitive collision on users.name,
// mirroring the legacy uniqueness contract.
func (s *Store) UserNameExists(ctx context.Context, exec executor, name string) (bool, error) {
	var one int
	err := exec.QueryRowContext(ctx, `SELECT 1 FROM users WHERE name = ? LIMIT 1`, name).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// SuggestAvailableUserName mirrors generateAvailableUserName: slugified seed,
// numeric suffixes, then random hex fallback.
func (s *Store) SuggestAvailableUserName(ctx context.Context, exec executor, seed string) (string, error) {
	base := SlugifyUserName(seed)
	for suffix := 0; suffix < 100; suffix++ {
		candidate := base
		if suffix > 0 {
			candidate = fmt.Sprintf("%s-%d", base, suffix+1)
		}
		taken, err := s.UserNameExists(ctx, exec, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	for attempt := 0; attempt < 10; attempt++ {
		buf := make([]byte, 2)
		if _, err := readRandom(buf); err != nil {
			return "", err
		}
		candidate := fmt.Sprintf("%s-%x", base, buf)
		taken, err := s.UserNameExists(ctx, exec, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", errors.New("failed to allocate a unique username")
}

// ProfilePatch is the set of mutable profile/preference columns. Nil fields
// are left untouched.
type ProfilePatch struct {
	DisplayName                  *string
	Description                  *string
	AvatarURL                    *string
	PreferredLanguage            *string
	DisplayLanguage              *string
	PreferredTimezone            *string
	AutoTranslationEnabled       *bool
	PreferredTranslationMode     *string
	PreferredTranslationDisplay  *string
	PreferredTimeFormat          *string
	PreferredMessageBodyFontSize *string
	ReferralSource               *string
	ReferralSourceOther          *string
	ReferralSourceSkippedAt      *time.Time
	SignupRole                   *string
	SignupSurveyCompletedAt      *time.Time
}

// UpdateProfile applies non-nil patch fields and refreshes updated_at.
func (s *Store) UpdateProfile(ctx context.Context, userID string, patch ProfilePatch) error {
	sets := []string{"updated_at = ?"}
	args := []any{time.Now().UnixMilli()}
	add := func(column string, value any) {
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	// Patch semantics: a non-nil pointer writes the column; the sentinel
	// empty string / zero time writes NULL. Absent pointer leaves it alone.
	if patch.DisplayName != nil {
		add("display_name", stringOrNullWithEmpty(*patch.DisplayName))
	}
	if patch.Description != nil {
		add("description", stringOrNullWithEmpty(*patch.Description))
	}
	if patch.AvatarURL != nil {
		add("avatar_url", stringOrNullWithEmpty(*patch.AvatarURL))
	}
	if patch.PreferredLanguage != nil {
		add("preferred_language", stringOrNullWithEmpty(*patch.PreferredLanguage))
	}
	if patch.DisplayLanguage != nil {
		add("display_language", stringOrNullWithEmpty(*patch.DisplayLanguage))
	}
	if patch.PreferredTimezone != nil {
		add("preferred_timezone", stringOrNullWithEmpty(*patch.PreferredTimezone))
	}
	if patch.AutoTranslationEnabled != nil {
		add("auto_translation_enabled", *patch.AutoTranslationEnabled)
	}
	if patch.PreferredTranslationMode != nil {
		add("preferred_translation_mode", stringOrNullWithEmpty(*patch.PreferredTranslationMode))
	}
	if patch.PreferredTranslationDisplay != nil {
		add("preferred_translation_display", stringOrNullWithEmpty(*patch.PreferredTranslationDisplay))
	}
	if patch.PreferredTimeFormat != nil {
		add("preferred_time_format", stringOrNullWithEmpty(*patch.PreferredTimeFormat))
	}
	if patch.PreferredMessageBodyFontSize != nil {
		add("preferred_message_body_font_size", stringOrNullWithEmpty(*patch.PreferredMessageBodyFontSize))
	}
	if patch.ReferralSource != nil {
		add("referral_source", stringOrNullWithEmpty(*patch.ReferralSource))
	}
	if patch.ReferralSourceOther != nil {
		add("referral_source_other", stringOrNullWithEmpty(*patch.ReferralSourceOther))
	}
	if patch.ReferralSourceSkippedAt != nil {
		add("referral_source_skipped_at", timeToMillisOrZero(patch.ReferralSourceSkippedAt))
	}
	if patch.SignupRole != nil {
		add("signup_role", stringOrNullWithEmpty(*patch.SignupRole))
	}
	if patch.SignupSurveyCompletedAt != nil {
		add("signup_survey_completed_at", timeToMillisOrZero(patch.SignupSurveyCompletedAt))
	}
	args = append(args, userID)
	query := `UPDATE users SET ` + joinStrings(sets, ", ") + ` WHERE id = ?`
	_, err := s.db.ExecContext(ctx, query, args...)
	return err
}

func joinStrings(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

// TimezoneObservation records first/last browser timezone exactly like the
// legacy SQL: first only when absent; last only when not older than stored.
func (s *Store) TimezoneObservation(ctx context.Context, exec executor, userID, timezone string, now time.Time) error {
	_, err := exec.ExecContext(ctx, `UPDATE users SET
		first_observed_timezone = coalesce(first_observed_timezone, ?),
		first_observed_timezone_at = coalesce(first_observed_timezone_at, ?),
		last_observed_timezone = CASE
			WHEN last_observed_timezone_at IS NULL OR last_observed_timezone_at <= ? THEN ?
			ELSE last_observed_timezone END,
		last_observed_timezone_at = max(coalesce(last_observed_timezone_at, ?), ?),
		updated_at = ?
		WHERE id = ?`,
		timezone, now.UnixMilli(), now.UnixMilli(), timezone, now.UnixMilli(), now.UnixMilli(), now.UnixMilli(), userID)
	return err
}

// SetEmailVerified flips the verified flag.
func (s *Store) SetEmailVerified(ctx context.Context, exec executor, userID string, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`,
		now.UnixMilli(), userID)
	return err
}

// UpdatePassword writes a new hash plus the credential-established stamp.
func (s *Store) UpdatePassword(ctx context.Context, exec executor, userID, hash string, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		`UPDATE users SET password_hash = ?, password_credential_established_at = ?, updated_at = ? WHERE id = ?`,
		hash, now.UnixMilli(), now.UnixMilli(), userID)
	return err
}

// ── one-shot account tokens ──

// InsertAccountToken atomically records a hashed token and its send-attempt
// quota. Requiring a transaction prevents partial quota/token publication.
func (s *Store) InsertAccountToken(ctx context.Context, tx *sql.Tx, t AccountToken) error {
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at, created_at)
		 VALUES (?,?,?,?,?,?)`,
		t.ID, t.UserID, string(t.Kind), t.TokenHash, t.ExpiresAt.UnixMilli(), t.CreatedAt.UnixMilli()); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES (?,?,?,?)`,
		t.ID, t.UserID, string(t.Kind), t.CreatedAt.UnixMilli())
	return err
}

// AccountTokenByHash loads a token row by its hash; ErrNotFound when absent.
func (s *Store) AccountTokenByHash(ctx context.Context, exec executor, kind AccountTokenKind, hash string) (*AccountToken, error) {
	row := exec.QueryRowContext(ctx,
		`SELECT id, user_id, kind, token_hash, expires_at, created_at
		 FROM account_tokens WHERE token_hash = ? AND kind = ?`, hash, string(kind))
	var t AccountToken
	var kindRaw string
	var expires, created int64
	if err := row.Scan(&t.ID, &t.UserID, &kindRaw, &t.TokenHash, &expires, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.Kind = AccountTokenKind(kindRaw)
	t.ExpiresAt = time.UnixMilli(expires).UTC()
	t.CreatedAt = time.UnixMilli(created).UTC()
	return &t, nil
}

// EmailRequestQuota is read under the same IMMEDIATE transaction that creates
// the next token. Consuming or replacing a token cannot reset this ledger.
func (s *Store) EmailRequestQuota(ctx context.Context, tx *sql.Tx, userID string, kind AccountTokenKind, since time.Time) (int, *time.Time, error) {
	var count int
	var latest sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*), MAX(created_at) FROM account_email_requests
		WHERE user_id = ? AND kind = ? AND created_at > ?`, userID, string(kind), since.UnixMilli()).Scan(&count, &latest)
	if err != nil {
		return 0, nil, err
	}
	if !latest.Valid {
		return count, nil, nil
	}
	at := time.UnixMilli(latest.Int64).UTC()
	return count, &at, nil
}

// DeleteAccountToken removes one row (consumption).
func (s *Store) DeleteAccountToken(ctx context.Context, exec executor, id string) error {
	_, err := exec.ExecContext(ctx, `DELETE FROM account_tokens WHERE id = ?`, id)
	return err
}

// DeleteAccountTokensByUser removes every token of one kind for a user.
func (s *Store) DeleteAccountTokensByUser(ctx context.Context, exec executor, userID string, kind AccountTokenKind) error {
	_, err := exec.ExecContext(ctx,
		`DELETE FROM account_tokens WHERE user_id = ? AND kind = ?`, userID, string(kind))
	return err
}

// ── legal acceptances ──

// InsertLegalAcceptance writes the audit row.
func (s *Store) InsertLegalAcceptance(ctx context.Context, exec executor, la LegalAcceptance) error {
	_, err := exec.ExecContext(ctx,
		`INSERT INTO legal_acceptances (id, user_id, terms_version, privacy_version, terms_url, privacy_url, source, ip_hash, user_agent_hash, locale, accepted_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		la.ID, la.UserID, la.TermsVersion, la.PrivacyVersion, la.TermsURL, la.PrivacyURL,
		la.Source, strOrNull(la.IPHash), strOrNull(la.UserAgentHash), strOrNull(la.Locale), la.AcceptedAt.UnixMilli())
	return err
}

// LegalAcceptanceCount counts audit rows for a user (contract tests).
func (s *Store) LegalAcceptanceCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM legal_acceptances WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

// DBExecutor adapts a *sql.DB to the executor interface so read paths can run
// with or without a surrounding transaction.
func DBExecutor(db *sql.DB) executor { return execDB{db: db} }

// stringOrNullWithEmpty maps the clear-sentinel "" to SQL NULL.
func stringOrNullWithEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// timeToMillisOrZero maps the clear-sentinel zero time to SQL NULL.
func timeToMillisOrZero(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return t.UnixMilli()
}
