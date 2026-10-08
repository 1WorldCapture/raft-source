package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Queryer is the current transaction or pinned snapshot. Claims must originate
// from TokenSigner.VerifyAccessToken; accepting this struct from a client body
// would discard the cryptographic authentication boundary.
type Queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// ValidateHumanTx rechecks the live user + owned session family at the actual
// database read/write boundary. An HTTP middleware check alone is insufficient:
// the request may have waited behind a logout/reset/member change transaction.
// Database failures remain database failures (not an authoritative 401).
func ValidateHumanTx(ctx context.Context, ex Queryer, claims AccessTokenClaims, now time.Time) error {
	if claims.Subject == "" || claims.Type != "access" || claims.FamilyID == "" ||
		!claims.ExpiresAt.After(now) || claims.IssuedAt.After(now) {
		return ErrTokenInvalid
	}
	var name string
	var verified bool
	err := ex.QueryRowContext(ctx, `SELECT u.name, u.email_verified
		FROM users u JOIN session_families f ON f.user_id = u.id
		WHERE u.id = ? AND f.id = ? AND f.revoked_at IS NULL`,
		claims.Subject, claims.FamilyID).Scan(&name, &verified)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTokenInvalid
	}
	if err != nil {
		return err
	}
	// Match RequireVerifiedProfileComplete's real identity predicate, not an
	// invented requirement that legacy migrated users have a timestamp set.
	if !verified || name == "" || HasPlaceholderHandle(name) {
		return ErrTokenInvalid
	}
	return nil
}
