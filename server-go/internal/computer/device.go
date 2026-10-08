// Device-code user login grant, ported branch-for-branch from
// services/deviceAuthService.ts. The grant establishes an approved USER
// identity only; the route layer issues the actual session and the grant
// never mints sk_* principals. Rows are soft state and never deleted.
package computer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	defaultDeviceCodeTTL       = 10 * time.Minute
	defaultPollIntervalSeconds = 5
	maxClientNameLen           = 200
)

// TokenUseObservation records where a grant was consumed (audit only).
type TokenUseObservation struct {
	IP        string
	UserAgent string
}

// DeviceGrantIssued is the authorize-phase result. DeviceCode is the raw
// secret and is returned exactly once.
type DeviceGrantIssued struct {
	DeviceCode          string
	UserCode            string
	ExpiresInSeconds    int
	PollIntervalSeconds int
}

// CreateDeviceAuthorization is the unauthenticated authorize phase.
func (s *Store) CreateDeviceAuthorization(ctx context.Context, clientName string, ttl time.Duration) (DeviceGrantIssued, error) {
	if clientName != "" && len(clientName) > maxClientNameLen {
		return DeviceGrantIssued{}, fmt.Errorf("computer: clientName too long")
	}
	if ttl <= 0 {
		ttl = defaultDeviceCodeTTL
	}
	deviceCode, err := newDeviceCode()
	if err != nil {
		return DeviceGrantIssued{}, err
	}
	userCode, err := newUserCode()
	if err != nil {
		return DeviceGrantIssued{}, err
	}
	hash, err := hashSecret(s.argon, deviceCode)
	if err != nil {
		return DeviceGrantIssued{}, err
	}
	var client any
	if clientName != "" {
		client = clientName
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO device_authorizations
			(id, device_code_lookup_hash, device_code_hash, user_code, status,
			 client_name, expires_at, poll_interval_seconds, created_at)
		VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
		NewID(), DeviceCodeLookupHash(s.pepper, deviceCode), hash, userCode,
		client, s.now()+ttl.Milliseconds(), defaultPollIntervalSeconds, s.now()); err != nil {
		return DeviceGrantIssued{}, fmt.Errorf("computer: insert device grant: %w", err)
	}
	return DeviceGrantIssued{
		DeviceCode:          deviceCode,
		UserCode:            userCode,
		ExpiresInSeconds:    int(ttl.Seconds()),
		PollIntervalSeconds: defaultPollIntervalSeconds,
	}, nil
}

// ApproveResult is the approve-phase outcome. Err holds one of the closed
// codes user_code_invalid | already_resolved | expired; OK is exclusive.
type ApproveResult struct {
	OK  bool
	Err string
}

// ApproveDeviceAuthorization is the USER-authenticated approve phase. CAS:
// only a still-pending, unexpired grant flips; every miss folds into the
// uniform user_code_invalid (zero enumeration).
func (s *Store) ApproveDeviceAuthorization(ctx context.Context, userCode, userID string, approve bool) (ApproveResult, error) {
	if userCode == "" {
		return ApproveResult{Err: UserCodeInvalid}, nil
	}
	var id string
	var status string
	var expiresAt int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, status, expires_at FROM device_authorizations
		WHERE user_code = ?`, normalizeUserCode(userCode)).Scan(&id, &status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ApproveResult{Err: UserCodeInvalid}, nil
	}
	if err != nil {
		return ApproveResult{}, fmt.Errorf("computer: locate grant: %w", err)
	}
	if status != "pending" {
		return ApproveResult{Err: AlreadyResolved}, nil
	}
	if expiresAt <= s.now() {
		return ApproveResult{Err: Expired}, nil
	}
	var res sql.Result
	if approve {
		res, err = s.db.ExecContext(ctx, `
			UPDATE device_authorizations
			SET status = 'approved', approved_by_user_id = ?, approved_at = ?
			WHERE id = ? AND status = 'pending'`, userID, s.now(), id)
	} else {
		res, err = s.db.ExecContext(ctx, `
			UPDATE device_authorizations
			SET status = 'denied', denied_at = ?
			WHERE id = ? AND status = 'pending'`, s.now(), id)
	}
	if err != nil {
		return ApproveResult{}, fmt.Errorf("computer: resolve grant: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return ApproveResult{}, fmt.Errorf("computer: resolve grant rows: %w", err)
	}
	if n == 0 {
		return ApproveResult{Err: AlreadyResolved}, nil
	}
	return ApproveResult{OK: true}, nil
}

// ConsumeResult is the token-phase outcome; Err holds one of the closed
// codes device_code_invalid | authorization_pending | access_denied |
// expired_token | device_code_consumed.
type ConsumeResult struct {
	OK               bool
	ApprovedByUserID string
	Err              string
}

// ConsumeDeviceAuthorization is the unauthenticated token-phase poll:
// HMAC-locate, argon2-verify, distinct terminal states, then a CAS
// single-consume on status='approved' (losing racers read
// device_code_consumed).
func (s *Store) ConsumeDeviceAuthorization(ctx context.Context, deviceCode string, obs TokenUseObservation) (ConsumeResult, error) {
	if deviceCode == "" {
		return ConsumeResult{Err: DeviceCodeInvalid}, nil
	}
	var id, hash, status string
	var approvedBy sql.NullString
	var expiresAt, consumedAt, revokedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, device_code_hash, status, approved_by_user_id, expires_at, consumed_at, revoked_at
		FROM device_authorizations
		WHERE device_code_lookup_hash = ?`, DeviceCodeLookupHash(s.pepper, deviceCode),
	).Scan(&id, &hash, &status, &approvedBy, &expiresAt, &consumedAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ConsumeResult{Err: DeviceCodeInvalid}, nil
	}
	if err != nil {
		return ConsumeResult{}, fmt.Errorf("computer: locate device code: %w", err)
	}
	if !verifySecret(hash, deviceCode) {
		return ConsumeResult{Err: DeviceCodeInvalid}, nil
	}
	if revokedAt.Valid {
		return ConsumeResult{Err: AccessDenied}, nil
	}
	if consumedAt.Valid {
		return ConsumeResult{Err: DeviceCodeConsumed}, nil
	}
	if expiresAt.Int64 <= s.now() {
		return ConsumeResult{Err: ExpiredToken}, nil
	}
	if status == "denied" {
		return ConsumeResult{Err: AccessDenied}, nil
	}
	if status != "approved" || !approvedBy.Valid {
		return ConsumeResult{Err: AuthorizationPending}, nil
	}
	var ip, ua any
	if obs.IP != "" {
		ip = obs.IP
	}
	if obs.UserAgent != "" {
		ua = obs.UserAgent
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE device_authorizations
		SET status = 'consumed', consumed_at = ?, consumed_ip = ?, consumed_user_agent = ?
		WHERE id = ? AND status = 'approved'`, s.now(), ip, ua, id)
	if err != nil {
		return ConsumeResult{}, fmt.Errorf("computer: consume grant: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return ConsumeResult{}, fmt.Errorf("computer: consume grant rows: %w", err)
	}
	if n == 0 {
		return ConsumeResult{Err: DeviceCodeConsumed}, nil
	}
	return ConsumeResult{OK: true, ApprovedByUserID: approvedBy.String}, nil
}

// normalizeUserCode mirrors userCode.trim().toUpperCase() on approve.
func normalizeUserCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}
