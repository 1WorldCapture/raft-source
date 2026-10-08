// Account use cases: registration, login, email verification, profile
// completion, password reset/change, preferences. The service owns atomicity
// and policy; HTTP shape lives in transport.
package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"raft.local/server-go/internal/platform/db"
)

// Service wires the account use cases.
type Service struct {
	store     *Store
	sessions  *SessionService
	hasher    *PasswordHasher
	mailer    MailSender
	logger    *slog.Logger
	webOrigin *url.URL
	fromAddr  string
	now       func() time.Time
	verifyTTL time.Duration
	resetTTL  time.Duration
}

// MailSender is the outbound transport (outbox or SMTP).
type MailSender interface {
	Send(ctx context.Context, msg MailMessage) error
	Name() string
}

// MailMessage is transport-agnostic outgoing mail.
type MailMessage struct {
	From, To, Subject, HTML string
	Kind, Token             string
}

// NewService assembles the account service. fromAddr is the RFC5322 sender.
func NewService(store *Store, sessions *SessionService, hasher *PasswordHasher, mailer MailSender, logger *slog.Logger, webOrigin *url.URL, fromAddr string, verifyTTL, resetTTL time.Duration) *Service {
	if fromAddr == "" {
		fromAddr = "Raft <noreply@raft.build>"
	}
	return &Service{
		store: store, sessions: sessions, hasher: hasher, mailer: mailer,
		logger: logger, webOrigin: webOrigin, fromAddr: fromAddr,
		now: time.Now, verifyTTL: verifyTTL, resetTTL: resetTTL,
	}
}

// SetClock overrides the clock (tests).
func (s *Service) SetClock(now func() time.Time) {
	s.now = now
	s.sessions.SetClock(now)
}

// RegisterInput carries the parsed register request.
type RegisterInput struct {
	Email         string
	Password      string
	Name          string // optional seed for the suggested handle
	Legal         LegalAcceptanceInput
	LegalMetadata LegalAcceptanceMetadata
}

// Register creates the account (deferred profile) plus its first session.
// The verification email is sent after commit; a mail failure keeps the
// account intact and retryable (logged without the token).
func (s *Service) Register(ctx context.Context, input RegisterInput) (*User, *IssuedSession, error) {
	if msg := ValidateEmailAddress(input.Email); msg != "" {
		return nil, nil, NewError(ErrCodeInvalidEmail, msg)
	}
	if err := validateNewPassword(input.Password); err != nil {
		return nil, nil, err
	}
	email := NormalizeEmail(input.Email)

	if err := requireCurrentLegalAcceptance(input.Legal); err != nil {
		return nil, nil, err
	}

	// Fail fast on the common conflict before paying for Argon2.
	if existing, err := s.store.UserByEmail(ctx, email); err != nil && !errors.Is(err, ErrNotFound) {
		return nil, nil, err
	} else if existing != nil {
		return nil, nil, NewError(ErrCodeEmailRegistered, "Email is already registered")
	}

	hash, err := s.hasher.Hash(input.Password)
	if err != nil {
		return nil, nil, err
	}

	now := s.now()
	user := &User{
		ID:           NewUUID(),
		Email:        email,
		Name:         NewPendingHandle(),
		PasswordHash: hash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	seed := input.Name
	if seed == "" {
		seed = emailLocalPart(email)
	}

	verificationToken := NewOpaqueToken()
	var session *IssuedSession
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if existing, err := s.store.userByEmail(ctx, TxExecutor(tx), email); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		} else if existing != nil {
			return NewError(ErrCodeEmailRegistered, "Email is already registered")
		}
		suggested, err := s.store.SuggestAvailableUserName(ctx, tx, seed)
		if err != nil {
			return err
		}
		user.ProfileSetupSuggestedHandle = StrPtr(suggested)
		if err := s.store.InsertUser(ctx, tx, user); err != nil {
			if db.IsUniqueViolation(err, "users.email") {
				return NewError(ErrCodeEmailRegistered, "Email is already registered")
			}
			if db.IsUniqueViolation(err, "users.name") {
				return NewError(ErrCodeUsernameTaken, "Username is already taken")
			}
			return err
		}
		if err := s.store.InsertLegalAcceptance(ctx, tx, LegalAcceptance{
			ID: NewUUID(), UserID: user.ID,
			TermsVersion: TermsVersionCurrent, PrivacyVersion: PrivacyVersionCurrent,
			TermsURL: TermsURLCurrent, PrivacyURL: PrivacyURLCurrent,
			Source:        "signup",
			IPHash:        hashEvidence(input.LegalMetadata.IPAddress),
			UserAgentHash: hashEvidence(input.LegalMetadata.UserAgent),
			Locale:        input.LegalMetadata.Locale,
			AcceptedAt:    now,
		}); err != nil {
			return err
		}
		if err := s.store.InsertAccountToken(ctx, tx, AccountToken{
			ID: NewUUID(), UserID: user.ID, Kind: AccountTokenEmailVerification,
			TokenHash: HashToken(verificationToken),
			ExpiresAt: now.Add(s.verifyTTL), CreatedAt: now,
		}); err != nil {
			return err
		}
		issued, err := s.sessions.createSessionTx(ctx, tx, user.ID)
		session = issued
		return err
	})
	if err != nil {
		return nil, nil, err
	}

	if sendErr := SendVerificationEmail(ctx, s.send, user.Email, Deref(user.DisplayName), verificationToken, s.linkFor); sendErr != nil {
		s.logger.Warn("verification email delivery failed; account stays unverified and resend is available",
			"error", sendErr.Error(), "user_id", user.ID, "mailer", s.mailer.Name())
	}

	return user, session, nil
}

// Login authenticates email+password and opens a new session.
func (s *Service) Login(ctx context.Context, email, password string) (*User, *IssuedSession, error) {
	normalized := NormalizeEmail(email)
	user, err := s.store.UserByEmail(ctx, normalized)
	if errors.Is(err, ErrNotFound) {
		s.hasher.Burn() // equalize timing for missing accounts
		return nil, nil, NewError(ErrCodeInvalidCredentials, "Invalid email or password")
	}
	if err != nil {
		return nil, nil, err
	}
	if !s.hasher.Verify(password, user.PasswordHash) {
		return nil, nil, NewError(ErrCodeInvalidCredentials, "Invalid email or password")
	}
	// Argon2 stays outside the write transaction; revalidate the exact hash
	// under the lock that session creation takes.
	var issued *IssuedSession
	var current *User
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		fresh, err := s.store.userByEmail(ctx, TxExecutor(tx), normalized)
		if errors.Is(err, ErrNotFound) {
			return NewError(ErrCodeInvalidCredentials, "Invalid email or password")
		}
		if err != nil {
			return err
		}
		if fresh.PasswordHash != user.PasswordHash {
			return NewError(ErrCodeInvalidCredentials, "Invalid email or password")
		}
		if fresh.PasswordCredentialEstablishedAt == nil {
			now := s.now()
			if _, err := tx.ExecContext(ctx,
				`UPDATE users SET password_credential_established_at = ?, updated_at = ? WHERE id = ?`,
				now.UnixMilli(), now.UnixMilli(), fresh.ID); err != nil {
				return err
			}
		}
		session, err := s.sessions.createSessionTx(ctx, tx, fresh.ID)
		if err != nil {
			return err
		}
		issued = session
		current = fresh
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return current, issued, nil
}

// VerifyEmail consumes a one-shot verification token.
func (s *Service) VerifyEmail(ctx context.Context, token string) error {
	hash := HashToken(token)
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		record, err := s.store.AccountTokenByHash(ctx, tx, AccountTokenEmailVerification, hash)
		if errors.Is(err, ErrNotFound) {
			return NewError(ErrCodeInvalidVerifyToken, "Invalid or expired verification token")
		}
		if err != nil {
			return err
		}
		if !record.ExpiresAt.After(s.now()) {
			_ = s.store.DeleteAccountToken(ctx, tx, record.ID)
			return NewError(ErrCodeInvalidVerifyToken, "Invalid or expired verification token")
		}
		if err := s.store.SetEmailVerified(ctx, tx, record.UserID, s.now()); err != nil {
			return err
		}
		return s.store.DeleteAccountTokensByUser(ctx, tx, record.UserID, AccountTokenEmailVerification)
	})
	return err
}

// ResendVerification issues a fresh verification token under cooldown limits.
func (s *Service) ResendVerification(ctx context.Context, userID string) error {
	var user *User
	token := NewOpaqueToken()
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		current, err := s.store.userByID(ctx, TxExecutor(tx), userID)
		if errors.Is(err, ErrNotFound) {
			return NewError(ErrCodeUserNotFound, "User not found")
		}
		if err != nil {
			return err
		}
		if current.EmailVerified {
			return NewError(ErrCodeEmailAlreadyVerified, "Email is already verified")
		}
		user = current
		now := s.now()
		count, latest, err := s.store.EmailRequestQuota(ctx, tx, userID, AccountTokenEmailVerification, now.Add(-time.Hour))
		if err != nil {
			return err
		}
		if count >= 5 {
			return NewError(ErrCodeResendRateLimited, "Too many verification emails. Please try again later.")
		}
		if latest != nil && now.Sub(*latest) < time.Minute {
			return NewError(ErrCodeResendCooldown, "Please wait before requesting another verification email.")
		}
		if err := s.store.DeleteAccountTokensByUser(ctx, tx, userID, AccountTokenEmailVerification); err != nil {
			return err
		}
		return s.store.InsertAccountToken(ctx, tx, AccountToken{
			ID: NewUUID(), UserID: userID, Kind: AccountTokenEmailVerification,
			TokenHash: HashToken(token), ExpiresAt: now.Add(s.verifyTTL), CreatedAt: now,
		})
	})
	if err != nil {
		return err
	}
	greeting := "there"
	if user.ProfileSetupCompletedAt != nil && !user.NeedsIdentitySetup() {
		greeting = user.Name
	}
	return SendVerificationEmail(ctx, s.send, user.Email, greeting, token, s.linkFor)
}

// UsernameAvailable is the advisory precheck (read-only).
func (s *Service) UsernameAvailable(ctx context.Context, name string) bool {
	trimmed := trimSpace(name)
	if trimmed == "" {
		return false
	}
	taken, err := s.store.UserNameExists(ctx, DBExecutor(s.store.DB()), trimmed)
	if err != nil {
		return false
	}
	return !taken
}

// CompleteProfile finalizes the account handle.
func (s *Service) CompleteProfile(ctx context.Context, userID, name, displayName string) (*User, error) {
	trimmedName := trimSpace(name)
	trimmedDisplay := trimSpace(displayName)
	if nameError := ValidateName(trimmedName, "Name", NameMinLengthUsers); nameError != "" {
		return nil, NewError(ErrCodeProfileNameInvalid, nameError)
	}
	if strings.HasPrefix(lower(trimmedName), ProfileSetupPlaceholderPrefix) || IsReservedAgentName(trimmedName) {
		return nil, NewError(ErrCodeProfileNameReserved, "This username is reserved. Choose another name.")
	}
	if trimmedDisplay == "" || len([]rune(trimmedDisplay)) > MaxDisplayNameLength {
		return nil, NewError(ErrCodeProfileNameInvalid, "Display name must be between 1 and 80 characters")
	}

	now := s.now()
	var completed *User
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			`UPDATE users SET name = ?, display_name = ?, profile_setup_completed_at = ?,
			 profile_setup_suggested_handle = NULL, updated_at = ?
			 WHERE id = ? AND profile_setup_completed_at IS NULL`,
			trimmedName, trimmedDisplay, now.UnixMilli(), now.UnixMilli(), userID)
		if err != nil {
			if db.IsUniqueViolation(err, "users.name") {
				return NewError(ErrCodeProfileNameTaken, "Username is already taken")
			}
			return err
		}
		affected, _ := res.RowsAffected()
		if affected > 0 {
			fresh, err := s.store.userByID(ctx, TxExecutor(tx), userID)
			if err != nil {
				return err
			}
			completed = fresh
			return nil
		}
		existing, err := s.store.userByID(ctx, TxExecutor(tx), userID)
		if errors.Is(err, ErrNotFound) {
			return NewError(ErrCodeProfileUserNotFound, "User not found")
		}
		if err != nil {
			return err
		}
		if existing.Name != trimmedName || Deref(existing.DisplayName) != trimmedDisplay {
			return NewError(ErrCodeProfileAlreadyDone, "Profile setup is already complete")
		}
		completed = existing
		return nil
	})
	if err != nil {
		return nil, err
	}
	return completed, nil
}

// RequestPasswordReset emails a reset link when the account exists; the
// response never reveals existence.
func (s *Service) RequestPasswordReset(ctx context.Context, email string) (resultErr error) {
	defer func() {
		if resultErr != nil {
			// Keep the public response non-enumerating without hiding outages.
			s.logger.Warn("password reset request failed", "error_type", fmt.Sprintf("%T", resultErr))
		}
	}()
	normalized := NormalizeEmail(email)
	user, err := s.store.UserByEmail(ctx, normalized)
	if errors.Is(err, ErrNotFound) {
		s.hasher.Burn()
		return nil
	}
	if err != nil {
		return err
	}
	token := NewOpaqueToken()
	issued := false
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		count, _, err := s.store.EmailRequestQuota(ctx, tx, user.ID, AccountTokenPasswordReset, now.Add(-time.Hour))
		if err != nil {
			return err
		}
		if count >= 5 {
			return nil // silent: do not reveal rate state
		}
		if err := s.store.DeleteAccountTokensByUser(ctx, tx, user.ID, AccountTokenPasswordReset); err != nil {
			return err
		}
		if err := s.store.InsertAccountToken(ctx, tx, AccountToken{
			ID: NewUUID(), UserID: user.ID, Kind: AccountTokenPasswordReset,
			TokenHash: HashToken(token), ExpiresAt: now.Add(s.resetTTL), CreatedAt: now,
		}); err != nil {
			return err
		}
		issued = true
		return nil
	})
	if err != nil {
		return err
	}
	if !issued {
		return nil
	}
	if sendErr := SendPasswordResetEmail(ctx, s.send, user.Email, Deref(user.DisplayName), token, s.linkFor); sendErr != nil {
		s.logger.Warn("password reset email delivery failed; token remains valid for retrying delivery",
			"error", sendErr.Error(), "user_id", user.ID, "mailer", s.mailer.Name())
	}
	return nil
}

// ResetPassword consumes a reset token, rotates the hash and revokes every
// session (single transaction).
func (s *Service) ResetPassword(ctx context.Context, token, newPassword string) error {
	if err := validateNewPassword(newPassword); err != nil {
		return err
	}
	hash := HashToken(token)
	record, err := s.store.AccountTokenByHash(ctx, DBExecutor(s.store.DB()), AccountTokenPasswordReset, hash)
	if errors.Is(err, ErrNotFound) {
		return NewError(ErrCodeInvalidResetToken, "Invalid or expired reset token")
	}
	if err != nil {
		return err
	}
	if !record.ExpiresAt.After(s.now()) {
		_ = s.store.DeleteAccountToken(ctx, DBExecutor(s.store.DB()), record.ID)
		return NewError(ErrCodeInvalidResetToken, "Invalid or expired reset token")
	}

	newHash, err := s.hasher.Hash(newPassword)
	if err != nil {
		return err
	}
	now := s.now()
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, record.UserID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return NewError(ErrCodeInvalidResetToken, "Invalid or expired reset token")
		} else if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx,
			`DELETE FROM account_tokens WHERE id = ? AND expires_at > ?`, record.ID, now.UnixMilli())
		if err != nil {
			return err
		}
		if affected, _ := res.RowsAffected(); affected == 0 {
			return NewError(ErrCodeInvalidResetToken, "Invalid or expired reset token")
		}
		if err := s.store.UpdatePassword(ctx, tx, record.UserID, newHash, now); err != nil {
			return err
		}
		if err := s.store.DeleteAccountTokensByUser(ctx, tx, record.UserID, AccountTokenPasswordReset); err != nil {
			return err
		}
		return s.sessions.RevokeAllUserSessions(ctx, tx, record.UserID, "revoke_all")
	})
}

// ChangePassword verifies the current password then rotates the hash and
// revokes every session.
func (s *Service) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	if err := validateNewPassword(newPassword); err != nil {
		return err
	}
	user, err := s.store.UserByID(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return NewError(ErrCodeUserNotFound, "User not found")
	}
	if err != nil {
		return err
	}
	if !s.hasher.Verify(currentPassword, user.PasswordHash) {
		return NewError(ErrCodeCurrentPasswordWrong, "Current password is incorrect")
	}
	newHash, err := s.hasher.Hash(newPassword)
	if err != nil {
		return err
	}
	now := s.now()
	return s.withTx(ctx, func(tx *sql.Tx) error {
		fresh, err := s.store.userByID(ctx, TxExecutor(tx), userID)
		if errors.Is(err, ErrNotFound) {
			return NewError(ErrCodeUserNotFound, "User not found")
		}
		if err != nil {
			return err
		}
		if fresh.PasswordHash != user.PasswordHash {
			return NewError(ErrCodeCurrentPasswordWrong, "Current password is incorrect")
		}
		if err := s.store.UpdatePassword(ctx, tx, userID, newHash, now); err != nil {
			return err
		}
		if err := s.store.DeleteAccountTokensByUser(ctx, tx, userID, AccountTokenPasswordReset); err != nil {
			return err
		}
		return s.sessions.RevokeAllUserSessions(ctx, tx, userID, "revoke_all")
	})
}

// ApplyProfilePatch validates nothing (transport did) and persists + reloads.
func (s *Service) ApplyProfilePatch(ctx context.Context, userID string, patch ProfilePatch) (*User, error) {
	if err := s.store.UpdateProfile(ctx, userID, patch); err != nil {
		return nil, err
	}
	return s.store.UserByID(ctx, userID)
}

// TimezoneObservation records the canonical browser zone and returns the pair.
func (s *Service) TimezoneObservation(ctx context.Context, userID, timezone string) (*TimezoneObservationResult, error) {
	now := s.now()
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		return s.store.TimezoneObservation(ctx, tx, userID, timezone, now)
	})
	if err != nil {
		return nil, err
	}
	user, err := s.store.UserByID(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return nil, NewError(ErrCodeUserNotFound, "User not found")
	}
	if err != nil {
		return nil, err
	}
	return &TimezoneObservationResult{
		FirstObservedTimezone:   Deref(user.FirstObservedTimezone),
		FirstObservedTimezoneAt: user.FirstObservedTimezoneAt,
		LastObservedTimezone:    Deref(user.LastObservedTimezone),
		LastObservedTimezoneAt:  user.LastObservedTimezoneAt,
	}, nil
}

// TimezoneObservationResult is the endpoint projection.
type TimezoneObservationResult struct {
	FirstObservedTimezone   string
	FirstObservedTimezoneAt *time.Time
	LastObservedTimezone    string
	LastObservedTimezoneAt  *time.Time
}

// SetAvatarURL persists a validated stored-avatar path.
func (s *Service) SetAvatarURL(ctx context.Context, userID, path string) (*User, error) {
	patch := ProfilePatch{AvatarURL: StrPtr(path)}
	return s.ApplyProfilePatch(ctx, userID, patch)
}

// ── helpers ──

func (s *Service) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.store.DB().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Service) send(ctx context.Context, to, subject, htmlBody, kind, token string) error {
	return s.mailer.Send(ctx, MailMessage{
		From: s.fromAddress(), To: to, Subject: subject, HTML: htmlBody,
		Kind: kind, Token: token,
	})
}

func (s *Service) fromAddress() string { return s.fromAddr }

func (s *Service) linkFor(kind, token string) string {
	origin := "http://127.0.0.1:4301"
	if s.webOrigin != nil {
		origin = s.webOrigin.String()
	}
	switch kind {
	case "verify":
		return origin + "?verify=" + token
	case "reset":
		return origin + "?reset=" + token
	default:
		return origin
	}
}

func requireCurrentLegalAcceptance(input LegalAcceptanceInput) error {
	if !input.AcceptTerms {
		return NewError(ErrCodeLegalRequired, "LEGAL_ACCEPTANCE_REQUIRED")
	}
	if input.TermsVersion != TermsVersionCurrent || input.PrivacyVersion != PrivacyVersionCurrent {
		return NewError(ErrCodeTermsChanged, "TERMS_CHANGED")
	}
	return nil
}

func hashEvidence(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	sum := sha256Hex(*value)
	return &sum
}

func emailLocalPart(email string) string {
	for i := 0; i < len(email); i++ {
		if email[i] == '@' {
			return email[:i]
		}
	}
	return email
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

func lower(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'A' && r <= 'Z' {
			out[i] = r + ('a' - 'A')
		}
	}
	return string(out)
}

func sha256Hex(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}
