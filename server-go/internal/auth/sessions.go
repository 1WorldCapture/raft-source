// Session families and refresh rotation with transactionally persisted,
// encrypted same-successor receipts. Unbound Web retries get a short grace
// window; installation-bound retries get the explicit durable window.
// Revocation is checked before issuing or recovering any successor.
//
// Divergence from the legacy TS server (documented in README): reusing a
// rotated refresh token BEYOND the grace window now revokes the whole family
// (RFC 9700 4.14 recommendation) instead of returning a bare 401. Within the
// grace window the same successor is returned, preserving the multi-tab
// recovery contract the web client depends on.
package auth

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

// SessionService owns session persistence and rotation policy.
type SessionService struct {
	db          *sql.DB
	store       *Store
	signer      *TokenSigner
	receiptKey  []byte
	refreshTTL  time.Duration
	replayGrace time.Duration
	durableTTL  time.Duration
	now         func() time.Time
}

// NewSessionService wires dependencies. receiptKey may be nil only when
// durable receipts are disabled (not used in production paths).
func NewSessionService(db *sql.DB, store *Store, signer *TokenSigner, receiptKey []byte, refreshTTL, replayGrace, durableTTL time.Duration) *SessionService {
	return &SessionService{
		db:          db,
		store:       store,
		signer:      signer,
		receiptKey:  append([]byte(nil), receiptKey...),
		refreshTTL:  refreshTTL,
		replayGrace: replayGrace,
		durableTTL:  durableTTL,
		now:         time.Now,
	}
}

// SetClock overrides the clock (tests).
func (s *SessionService) SetClock(now func() time.Time) { s.now = now }

// IssuedSession is a freshly created or rotated session.
type IssuedSession struct {
	SessionID    string
	FamilyID     string
	UserID       string
	RefreshToken string
	ExpiresAt    time.Time
}

// CreateSession opens a new family with its first refresh token.
func (s *SessionService) CreateSession(ctx context.Context, userID string) (*IssuedSession, error) {
	var issued *IssuedSession
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		issued, err = s.createSessionTx(ctx, tx, userID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return issued, nil
}

func (s *SessionService) createSessionTx(ctx context.Context, tx *sql.Tx, userID string) (*IssuedSession, error) {
	now := s.now()
	familyID := NewUUID()
	sessionID := NewUUID()
	refreshToken := NewOpaqueToken()
	expiresAt := now.Add(s.refreshTTL)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO session_families (id, user_id, created_at) VALUES (?,?,?)`,
		familyID, userID, now.UnixMilli()); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
		sessionID, userID, familyID, HashToken(refreshToken), expiresAt.UnixMilli(), now.UnixMilli()); err != nil {
		return nil, err
	}
	return &IssuedSession{
		SessionID: sessionID, FamilyID: familyID, UserID: userID,
		RefreshToken: refreshToken, ExpiresAt: expiresAt,
	}, nil
}

// LiveSession is a validated refresh token row.
type LiveSession struct {
	ID        string
	UserID    string
	FamilyID  string
	ExpiresAt time.Time
}

// ValidateSession resolves a refresh token to its live row; expired rows are
// deleted and reported as absent.
func (s *SessionService) ValidateSession(ctx context.Context, refreshToken string) (*LiveSession, error) {
	hash := HashToken(refreshToken)
	row := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, family_id, expires_at FROM sessions WHERE token_hash = ?
		 AND EXISTS (SELECT 1 FROM session_families f WHERE f.id = sessions.family_id AND f.user_id = sessions.user_id AND f.revoked_at IS NULL)`, hash)
	live, err := scanLiveSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !live.ExpiresAt.After(s.now()) {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, live.ID)
		return nil, nil
	}
	return live, nil
}

func scanLiveSession(row *sql.Row) (*LiveSession, error) {
	var ls LiveSession
	var expires int64
	if err := row.Scan(&ls.ID, &ls.UserID, &ls.FamilyID, &expires); err != nil {
		return nil, err
	}
	ls.ExpiresAt = time.UnixMilli(expires).UTC()
	return &ls, nil
}

// RefreshBinding identifies a client-bound refresh attempt (attempt header +
// installation header). Both ids are pattern-validated upstream.
type RefreshBinding struct {
	AttemptID      string
	InstallationID string
}

// RefreshOutcome describes what happened during a refresh attempt.
type RefreshOutcome struct {
	Session       *IssuedSession
	Replayed      bool
	FamilyRevoked bool
}

// Refresh rotates (or replays) a refresh token.
func (s *SessionService) Refresh(ctx context.Context, refreshToken string, binding *RefreshBinding) (*RefreshOutcome, error) {
	if binding != nil {
		return s.refreshDurable(ctx, refreshToken, *binding)
	}
	return s.refreshUnbound(ctx, refreshToken)
}

// Unbound Web retries use the SAME transactional, encrypted receipt mechanism,
// but only for replayGrace. Persisting the receipt in the rotation transaction
// prevents a lost response or process restart from revoking a legitimate session.
func (s *SessionService) refreshUnbound(ctx context.Context, refreshToken string) (*RefreshOutcome, error) {
	return s.refreshDurable(ctx, refreshToken, RefreshBinding{})
}

// refreshDurable serves clients that bind attempts: rotation writes an
// encrypted successor receipt; replays must match the binding and stay within
// the durable TTL.
func (s *SessionService) refreshDurable(ctx context.Context, refreshToken string, binding RefreshBinding) (*RefreshOutcome, error) {
	predecessorHash := HashToken(refreshToken)
	var outcome *RefreshOutcome
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		var live *LiveSession
		row := tx.QueryRowContext(ctx,
			`SELECT id, user_id, family_id, expires_at FROM sessions WHERE token_hash = ?
			 AND EXISTS (SELECT 1 FROM session_families f WHERE f.id = sessions.family_id AND f.user_id = sessions.user_id AND f.revoked_at IS NULL)`, predecessorHash)
		l, err := scanLiveSession(row)
		if errors.Is(err, sql.ErrNoRows) {
			live = nil
		} else if err != nil {
			return err
		} else {
			live = l
		}

		if live != nil && live.ExpiresAt.After(now) {
			res, err := tx.ExecContext(ctx,
				`DELETE FROM sessions WHERE token_hash = ? AND expires_at > ?`,
				predecessorHash, now.UnixMilli())
			if err != nil {
				return err
			}
			affected, _ := res.RowsAffected()
			if affected > 0 {
				successor := NewOpaqueToken()
				sessionID := NewUUID()
				expiresAt := now.Add(s.refreshTTL)
				if _, err := tx.ExecContext(ctx,
					`INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
					sessionID, live.UserID, live.FamilyID, HashToken(successor), expiresAt.UnixMilli(), now.UnixMilli()); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx,
					`INSERT INTO session_token_predecessors (token_hash, session_id, user_id, family_id, expires_at, created_at)
					 VALUES (?,?,?,?,?,?)`,
					predecessorHash, live.ID, live.UserID, live.FamilyID, live.ExpiresAt.UnixMilli(), now.UnixMilli()); err != nil {
					return err
				}
				sealed, err := sealSuccessor(s.receiptKey, successor, receiptIdentity{
					PredecessorHash: predecessorHash, PredecessorSessionID: live.ID,
					UserID: live.UserID, FamilyID: live.FamilyID, SuccessorSessionID: sessionID,
					AttemptID: binding.AttemptID, InstallationID: binding.InstallationID,
				})
				if err != nil {
					return err
				}
				receiptTTL := s.durableTTL
				if binding.AttemptID == "" && binding.InstallationID == "" {
					receiptTTL = s.replayGrace
				}
				if _, err := tx.ExecContext(ctx,
					`INSERT INTO session_refresh_rotation_receipts (
						id, predecessor_token_hash, predecessor_session_id, user_id, family_id, successor_session_id,
						attempt_id, installation_id, successor_token_ciphertext, successor_token_iv, successor_token_auth_tag,
						expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
					NewUUID(), predecessorHash, live.ID, live.UserID, live.FamilyID, sessionID,
					binding.AttemptID, binding.InstallationID, sealed.ciphertext, sealed.iv, sealed.authTag,
					now.Add(receiptTTL).UnixMilli(), now.UnixMilli()); err != nil {
					return err
				}
				outcome = &RefreshOutcome{Session: &IssuedSession{
					SessionID: sessionID, FamilyID: live.FamilyID, UserID: live.UserID,
					RefreshToken: successor, ExpiresAt: expiresAt,
				}}
				return nil
			}
		}

		// Not consumable: look for the durable receipt.
		var recID, recPredSession, recUser, recFamily, recSuccessor, recAttempt, recInstall, recCT, recIV, recTag string
		var recExpires, recCreated int64
		err = tx.QueryRowContext(ctx,
			`SELECT id, predecessor_session_id, user_id, family_id, successor_session_id,
				attempt_id, installation_id, successor_token_ciphertext, successor_token_iv, successor_token_auth_tag,
				expires_at, created_at
			 FROM session_refresh_rotation_receipts WHERE predecessor_token_hash = ?`, predecessorHash).
			Scan(&recID, &recPredSession, &recUser, &recFamily, &recSuccessor,
				&recAttempt, &recInstall, &recCT, &recIV, &recTag, &recExpires, &recCreated)
		if errors.Is(err, sql.ErrNoRows) {
			// Janitor may already have removed an expired encrypted receipt.
			// Hash-only lineage still identifies out-of-window replay.
			var oldUser, oldFamily string
			lookupErr := tx.QueryRowContext(ctx, `SELECT user_id, family_id FROM session_token_predecessors WHERE token_hash = ? AND expires_at > ?`, predecessorHash, now.UnixMilli()).Scan(&oldUser, &oldFamily)
			if errors.Is(lookupErr, sql.ErrNoRows) {
				return nil
			}
			if lookupErr != nil {
				return lookupErr
			}
			revoked, revokeErr := s.revokeFamilyTx(ctx, tx, oldUser, oldFamily, "replay_detected", now)
			if revokeErr != nil {
				return revokeErr
			}
			outcome = &RefreshOutcome{FamilyRevoked: revoked}
			return nil
		}
		if err != nil {
			return err
		}
		expiresAt := time.UnixMilli(recExpires).UTC()
		if !expiresAt.After(now) {
			if _, err := tx.ExecContext(ctx, `DELETE FROM session_refresh_rotation_receipts WHERE id = ?`, recID); err != nil {
				return err
			}
			revoked, err := s.revokeFamilyTx(ctx, tx, recUser, recFamily, "replay_detected", now)
			if err != nil {
				return err
			}
			outcome = &RefreshOutcome{FamilyRevoked: revoked}
			return nil
		}
		if recAttempt != binding.AttemptID || recInstall != binding.InstallationID {
			// Binding mismatch: suspected cross-client replay; revoke family.
			if _, rerr := s.revokeFamilyTx(ctx, tx, recUser, recFamily, "replay_detected", now); rerr != nil {
				return rerr
			}
			outcome = &RefreshOutcome{FamilyRevoked: true}
			return nil
		}
		// Successor must still be live and the family unrevoked.
		var succHash string
		var succExpires int64
		succErr := tx.QueryRowContext(ctx,
			`SELECT token_hash, expires_at FROM sessions WHERE id = ? AND user_id = ? AND family_id = ?`,
			recSuccessor, recUser, recFamily).Scan(&succHash, &succExpires)
		if succErr != nil && !errors.Is(succErr, sql.ErrNoRows) {
			return succErr
		}
		var revokedAt any
		famErr := tx.QueryRowContext(ctx,
			`SELECT revoked_at FROM session_families WHERE id = ? AND user_id = ?`, recFamily, recUser).Scan(&revokedAt)
		if famErr != nil && !errors.Is(famErr, sql.ErrNoRows) {
			return famErr
		}
		successorLive := succErr == nil && time.UnixMilli(succExpires).UTC().After(now)
		familyLive := famErr == nil && revokedAt == nil
		if !successorLive || !familyLive {
			_, _ = tx.ExecContext(ctx, `DELETE FROM session_refresh_rotation_receipts WHERE id = ?`, recID)
			return nil
		}
		successorToken, err := openSuccessor(s.receiptKey, sealedSuccessor{ciphertext: recCT, iv: recIV, authTag: recTag}, receiptIdentity{
			PredecessorHash: predecessorHash, PredecessorSessionID: recPredSession,
			UserID: recUser, FamilyID: recFamily, SuccessorSessionID: recSuccessor,
			AttemptID: recAttempt, InstallationID: recInstall,
		})
		if err != nil || HashToken(successorToken) != succHash {
			_, _ = tx.ExecContext(ctx, `DELETE FROM session_refresh_rotation_receipts WHERE id = ?`, recID)
			return nil
		}
		outcome = &RefreshOutcome{Session: &IssuedSession{
			SessionID: recSuccessor, FamilyID: recFamily, UserID: recUser,
			RefreshToken: successorToken, ExpiresAt: time.UnixMilli(succExpires).UTC(),
		}, Replayed: true}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return outcome, nil
}

// Logout revokes the family a refresh token belongs to — including when the
// token was already rotated away (predecessor lineage) or is covered by a
// still-live durable receipt. Always idempotent.
func (s *SessionService) Logout(ctx context.Context, refreshToken string) (bool, error) {
	hash := HashToken(refreshToken)
	revoked := false
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		var sessionID, userID, familyID string
		var expires int64
		err := tx.QueryRowContext(ctx,
			`SELECT id, user_id, family_id, expires_at FROM sessions WHERE token_hash = ?`, hash).
			Scan(&sessionID, &userID, &familyID, &expires)
		switch {
		case err == nil:
			// Retain hash-only authority so a retry can still resolve the
			// family after the session row is consumed (idempotent).
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO session_token_predecessors (token_hash, session_id, user_id, family_id, expires_at, created_at)
				 VALUES (?,?,?,?,?,?)
				 ON CONFLICT(token_hash) DO NOTHING`,
				hash, sessionID, userID, familyID, expires, now.UnixMilli()); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hash); err != nil {
				return err
			}
		case errors.Is(err, sql.ErrNoRows):
			// fall through to lineage lookups
		default:
			return err
		}
		if familyID == "" {
			var sessionID any
			err = tx.QueryRowContext(ctx,
				`SELECT session_id, user_id, family_id FROM session_token_predecessors WHERE token_hash = ?`, hash).
				Scan(&sessionID, &userID, &familyID)
			if errors.Is(err, sql.ErrNoRows) {
				var expires2 int64
				err = tx.QueryRowContext(ctx,
					`SELECT user_id, family_id, expires_at FROM session_refresh_rotation_receipts
					 WHERE predecessor_token_hash = ? AND expires_at > ?`, hash, now.UnixMilli()).
					Scan(&userID, &familyID, &expires2)
				if errors.Is(err, sql.ErrNoRows) {
					return nil
				}
				if err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
		}
		if userID == "" || familyID == "" {
			return nil
		}
		did, err := s.revokeFamilyTx(ctx, tx, userID, familyID, "logout", now)
		if err != nil {
			return err
		}
		revoked = did
		return nil
	})
	if err != nil {
		return false, err
	}
	return revoked, nil
}

// RevokeAllUserSessions kills every family for a user (password reset/change).
func (s *SessionService) RevokeAllUserSessions(ctx context.Context, exec executor, userID string, reason string) error {
	run := func(tx *sql.Tx) error {
		now := s.now()
		if _, err := tx.ExecContext(ctx,
			`UPDATE session_families SET revoked_at = ?, revoked_reason = ?
			 WHERE user_id = ? AND revoked_at IS NULL`, now.UnixMilli(), reason, userID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
		return err
	}
	if tx, ok := exec.(*sql.Tx); ok {
		return run(tx)
	}
	return s.withTx(ctx, func(tx *sql.Tx) error { return run(tx) })
}

// FamilyRevoked reports whether the family is currently revoked.
func (s *SessionService) FamilyRevoked(ctx context.Context, familyID string) (bool, error) {
	var revokedAt any
	err := s.db.QueryRowContext(ctx,
		`SELECT revoked_at FROM session_families WHERE id = ?`, familyID).Scan(&revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return revokedAt != nil, nil
}

func (s *SessionService) revokeFamilyTx(ctx context.Context, tx *sql.Tx, userID, familyID, reason string, now time.Time) (bool, error) {
	res, err := tx.ExecContext(ctx,
		`UPDATE session_families SET revoked_at = ?, revoked_reason = ?
		 WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		now.UnixMilli(), reason, familyID, userID)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM sessions WHERE family_id = ? AND user_id = ?`, familyID, userID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM session_refresh_rotation_receipts WHERE family_id = ? AND user_id = ?`, familyID, userID); err != nil {
		return false, err
	}
	return affected > 0, nil
}

// CleanupExpired removes expired sessions, lineage rows and receipts. Called
// periodically by the app janitor.
func (s *SessionService) CleanupExpired(ctx context.Context) error {
	now := s.now().UnixMilli()
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM session_token_predecessors WHERE expires_at <= ?`, now); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM session_refresh_rotation_receipts WHERE expires_at <= ?`, now); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now)
	return err
}

func (s *SessionService) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// ── AES-256-GCM sealing of successor receipts ──

type receiptIdentity struct {
	PredecessorHash      string
	PredecessorSessionID string
	UserID               string
	FamilyID             string
	SuccessorSessionID   string
	AttemptID            string
	InstallationID       string
}

type sealedSuccessor struct{ ciphertext, iv, authTag string }

func sealSuccessor(key []byte, token string, id receiptIdentity) (sealedSuccessor, error) {
	if len(key) != 32 {
		return sealedSuccessor{}, errors.New("receipt key must be 32 bytes")
	}
	block, err := newGCM(key)
	if err != nil {
		return sealedSuccessor{}, err
	}
	iv := randomBytes(12)
	out := block.Seal(nil, iv, []byte(token), receiptAAD(id))
	// Persist body and tag separately for schema parity with the legacy
	// receipts table; Open recombines them.
	body, tag := out[:len(out)-block.Overhead()], out[len(out)-block.Overhead():]
	return sealedSuccessor{
		ciphertext: base64.RawURLEncoding.EncodeToString(body),
		iv:         base64.RawURLEncoding.EncodeToString(iv),
		authTag:    base64.RawURLEncoding.EncodeToString(tag),
	}, nil
}

func openSuccessor(key []byte, sealed sealedSuccessor, id receiptIdentity) (string, error) {
	if len(key) != 32 {
		return "", errors.New("receipt key must be 32 bytes")
	}
	block, err := newGCM(key)
	if err != nil {
		return "", err
	}
	iv, err := base64.RawURLEncoding.DecodeString(sealed.iv)
	if err != nil {
		return "", err
	}
	ct, err := base64.RawURLEncoding.DecodeString(sealed.ciphertext)
	if err != nil {
		return "", err
	}
	tag, err := base64.RawURLEncoding.DecodeString(sealed.authTag)
	if err != nil {
		return "", err
	}
	if len(iv) != block.NonceSize() || len(tag) != block.Overhead() {
		return "", errors.New("invalid encrypted receipt dimensions")
	}
	combined := append(append([]byte{}, ct...), tag...)
	plain, err := block.Open(nil, iv, combined, receiptAAD(id))
	if err != nil {
		return "", fmt.Errorf("unseal successor: %w", err)
	}
	return string(plain), nil
}

// receiptAAD binds each sealed successor to its full identity using the same
// length-prefixed construction as the legacy server, so tampering with any
// receipt field (or swapping receipts between rows) fails authentication.
func receiptAAD(id receiptIdentity) []byte {
	fields := []string{
		"v1",
		id.PredecessorHash, id.PredecessorSessionID, id.UserID, id.FamilyID,
		id.SuccessorSessionID, id.AttemptID, id.InstallationID,
	}
	aad := ""
	for _, f := range fields {
		aad += fmt.Sprintf("%d:%s|", len(f), f)
	}
	return []byte(aad)
}
