// Store is the admission data layer over the real SQLite handle. It owns the
// computers/machines credential columns and the device_authorizations table,
// and exposes Authenticate as the machine-plane seam for the legacy
// WebSocket transport.
package computer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"raft.local/server-go/internal/platform/clock"
)

// executor is satisfied by *sql.DB and *sql.Tx.
type executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Options injects the clock, the device-code pepper and argon2 parameters.
type Options struct {
	Clock clock.Clock
	// DeviceCodePepper keys the HMAC lookup hash. Required (>= 32 bytes),
	// mirroring the TS AGENT_BOOTSTRAP_TOKEN_PEPPER||JWT_SECRET contract; the
	// parent wires cfg.JWTSecret or an explicit pepper — this package never
	// reads the environment itself.
	DeviceCodePepper []byte
	// Argon zeroes out to production defaults.
	Argon Argon2Config
}

// Store reads and writes the admission tables.
type Store struct {
	db     *sql.DB
	clock  clock.Clock
	argon  Argon2Config
	pepper []byte
}

// NewStore validates options and wraps the database handle.
func NewStore(db *sql.DB, opts Options) (*Store, error) {
	if db == nil {
		return nil, fmt.Errorf("computer: nil database handle")
	}
	if len(opts.DeviceCodePepper) < minPepperKeyLength {
		return nil, fmt.Errorf("computer: device-code pepper must be at least %d bytes", minPepperKeyLength)
	}
	c := opts.Clock
	if c == nil {
		c = clock.Real{}
	}
	argon := opts.Argon.withDefaults()
	if err := validateArgonConfig(argon); err != nil {
		return nil, err
	}
	return &Store{db: db, clock: c, argon: argon, pepper: append([]byte(nil), opts.DeviceCodePepper...)}, nil
}

// DB exposes the underlying handle for parent-side wiring (read-only use is
// expected; the admission writers live on this Store).
func (s *Store) DB() *sql.DB { return s.db }

// now is the single time source, in unix milliseconds like every column.
func (s *Store) now() int64 { return s.clock.Now().UnixMilli() }

// withTx runs fn inside one transaction, rolling back on error. Transactions
// belong to use cases; no network write may happen inside fn.
func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("computer: begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("computer: commit: %w", err)
	}
	return nil
}

// Authenticate resolves one presented key exactly like daemon.ts
// resolveUpgradeAuth. See docs/m3-computer-contract.md §2.1.
func (s *Store) Authenticate(ctx context.Context, key string) (Principal, error) {
	if key == "" {
		return Principal{}, &AuthError{Reason: ReasonMissingKey, Stage: StageFormat}
	}
	if IsComputerAPIKey(key) {
		return s.authenticateComputer(ctx, key)
	}
	if IsMachineAPIKey(key) {
		return s.authenticateLegacyMachine(ctx, key)
	}
	return Principal{}, &AuthError{Reason: ReasonInvalidKeyFormat, Stage: StageFormat}
}

// authenticateComputer ports findComputerByApiKeyWithReason: prefix-indexed
// candidate lookup, argon2 proof, then a live re-read so a revoke/rotation
// committed while the proof ran cannot resurrect a stale Computer.
func (s *Store) authenticateComputer(ctx context.Context, key string) (Principal, error) {
	if len(key) < computerKeyPrefixLen {
		return Principal{}, &AuthError{Reason: ReasonComputerNotFound, Stage: StageComputerLookup}
	}
	prefix := key[:computerKeyPrefixLen]
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workspace_id, api_key_hash, machine_id, revoked_at
		FROM computers WHERE api_key_prefix = ?`, prefix)
	if err != nil {
		return Principal{}, fmt.Errorf("computer: lookup candidates: %w", err)
	}
	type candidate struct {
		id          string
		workspaceID string
		hash        sql.NullString
		machineID   sql.NullString
		revokedAt   sql.NullInt64
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.workspaceID, &c.hash, &c.machineID, &c.revokedAt); err != nil {
			rows.Close()
			return Principal{}, fmt.Errorf("computer: scan candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Principal{}, fmt.Errorf("computer: iterate candidates: %w", err)
	}
	rows.Close()

	// TS parity: zero candidates is the not-found answer; candidates that
	// all fail the proof are the mismatch answer.
	if len(candidates) == 0 {
		return Principal{}, &AuthError{Reason: ReasonComputerNotFound, Stage: StageComputerLookup}
	}
	revokedHashMatch := false
	for _, c := range candidates {
		if !c.hash.Valid || !verifySecret(c.hash.String, key) {
			continue
		}
		// Re-read after the proof: only the still-current row authorizes.
		var machineID sql.NullString
		var revokedAt sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT machine_id, revoked_at FROM computers
			WHERE id = ? AND api_key_hash = ?`, c.id, c.hash.String).Scan(&machineID, &revokedAt)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return Principal{}, fmt.Errorf("computer: re-read: %w", err)
		}
		if revokedAt.Valid {
			revokedHashMatch = true
			continue
		}
		if !machineID.Valid {
			return Principal{}, &AuthError{Reason: ReasonComputerMachineUnlinked, Stage: StageMachineLookup}
		}
		var machineWorkspace string
		err = s.db.QueryRowContext(ctx, `
			SELECT workspace_id FROM machines WHERE id = ?`, machineID.String).Scan(&machineWorkspace)
		if errors.Is(err, sql.ErrNoRows) {
			return Principal{}, &AuthError{Reason: ReasonComputerMachineUnlinked, Stage: StageMachineLookup}
		}
		if err != nil {
			return Principal{}, fmt.Errorf("computer: machine read: %w", err)
		}
		if machineWorkspace != c.workspaceID {
			return Principal{}, &AuthError{Reason: ReasonComputerMachineUnlinked, Stage: StageMachineLookup}
		}
		if err := s.workspaceLive(ctx, c.workspaceID); err != nil {
			return Principal{}, err
		}
		return Principal{
			Kind:               KindComputer,
			ComputerID:         c.id,
			MachineID:          machineID.String,
			WorkspaceID:        c.workspaceID,
			CredentialRevision: credentialRevision(c.hash.String),
		}, nil
	}
	if revokedHashMatch {
		return Principal{}, &AuthError{Reason: ReasonComputerRevoked, Stage: StageComputerLookup}
	}
	return Principal{}, &AuthError{Reason: ReasonComputerKeyMismatch, Stage: StageComputerLookup}
}

// authenticateLegacyMachine ports findMachineByApiKey + the daemon.ts legacy
// gates: prefix (or NULL-prefix legacy rows) candidate lookup, argon2 proof,
// live re-read, optional prefix/fingerprint backfill, migrated-key rejection
// and workspace liveness.
func (s *Store) authenticateLegacyMachine(ctx context.Context, key string) (Principal, error) {
	prefix := key
	if len(prefix) > machineKeyPrefixLen {
		prefix = prefix[:machineKeyPrefixLen]
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workspace_id, user_id, api_key_hash, api_key_prefix,
		       api_key_fingerprint, legacy_key_migrated_at
		FROM machines
		WHERE api_key_prefix = ? OR (api_key_prefix IS NULL AND api_key_hash IS NOT NULL)`, prefix)
	if err != nil {
		return Principal{}, fmt.Errorf("computer: machine lookup: %w", err)
	}
	type mcandidate struct {
		id          string
		workspaceID string
		userID      string
		hash        sql.NullString
		prefix      sql.NullString
		fingerprint sql.NullString
		migratedAt  sql.NullInt64
	}
	var candidates []mcandidate
	for rows.Next() {
		var c mcandidate
		if err := rows.Scan(&c.id, &c.workspaceID, &c.userID, &c.hash, &c.prefix, &c.fingerprint, &c.migratedAt); err != nil {
			rows.Close()
			return Principal{}, fmt.Errorf("computer: scan machine: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Principal{}, fmt.Errorf("computer: iterate machines: %w", err)
	}
	rows.Close()

	for _, c := range candidates {
		if !c.hash.Valid || !verifySecret(c.hash.String, key) {
			continue
		}
		// Live re-read with the same proof (rotation committed mid-verify
		// changes the hash and must not authorize).
		var hash string
		var migratedAt sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT api_key_hash, legacy_key_migrated_at FROM machines
			WHERE id = ?`, c.id).Scan(&hash, &migratedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return Principal{}, &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
		}
		if err != nil {
			return Principal{}, fmt.Errorf("computer: machine re-read: %w", err)
		}
		if hash != c.hash.String {
			return Principal{}, &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
		}
		if migratedAt.Valid {
			return Principal{}, &AuthError{Reason: ReasonLegacyKeyMigrated, Stage: StageLegacyMigration}
		}
		// Backfill prefix/fingerprint for pre-index rows (TS findMachineByApiKey).
		if !c.prefix.Valid || !c.fingerprint.Valid {
			if _, err := s.db.ExecContext(ctx, `
				UPDATE machines SET api_key_prefix = ?, api_key_fingerprint = ?
				WHERE id = ? AND api_key_hash = ?`, prefix, MachineAPIKeyFingerprint(key), c.id, hash); err != nil {
				return Principal{}, fmt.Errorf("computer: machine backfill: %w", err)
			}
		}
		if err := s.workspaceLive(ctx, c.workspaceID); err != nil {
			return Principal{}, err
		}
		return Principal{
			Kind:               KindLegacyMachine,
			MachineID:          c.id,
			WorkspaceID:        c.workspaceID,
			UserID:             c.userID,
			CredentialRevision: credentialRevision(hash),
		}, nil
	}
	return Principal{}, &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
}

// workspaceLive answers server_not_found for deleted/missing workspaces.
func (s *Store) workspaceLive(ctx context.Context, workspaceID string) error {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL`, workspaceID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return &AuthError{Reason: ReasonServerNotFound, Stage: StageServerLookup}
	}
	if err != nil {
		return fmt.Errorf("computer: workspace liveness: %w", err)
	}
	return nil
}

// MemberRole resolves the caller's workspace role with the TS getMemberRole
// semantics: deleted workspaces and non-members lose their role (empty
// string, never an error, for those two business answers).
func (s *Store) MemberRole(ctx context.Context, workspaceID, userID string) (string, error) {
	return s.memberRole(ctx, s.db, workspaceID, userID)
}

// memberRole resolves the caller's workspace role with the TS getMemberRole
// semantics: deleted workspaces and non-members lose their role.
func (s *Store) memberRole(ctx context.Context, ex executor, workspaceID, userID string) (string, error) {
	var role string
	err := ex.QueryRowContext(ctx, `
		SELECT m.role FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("computer: member role: %w", err)
	}
	return role, nil
}

// RoleHasCapability is the exported TS hasServerCapability projection for
// the machine-plane capabilities this slice gates on: owner/admin hold both,
// member/guest hold neither.
func RoleHasCapability(role, capability string) bool {
	return hasCapability(role, capability)
}

// hasCapability is the TS hasServerCapability matrix for the two capabilities
// this slice needs: owner/admin hold both; member/guest hold neither.
func hasCapability(role, capability string) bool {
	switch capability {
	case "registerMachines", "rotateMachineKeys":
		return role == "owner" || role == "admin"
	default:
		return false
	}
}

// touchComputerUse writes the best-effort last-use observability triple
// (TS recordComputerUse). Failure is swallowed: observability must not affect
// auth latency or success.
func (s *Store) touchComputerUse(ctx context.Context, computerID, ip, userAgent string) {
	_, _ = s.db.ExecContext(ctx, `
		UPDATE computers SET last_used_at = ?, last_used_ip = ?, last_used_user_agent = ?
		WHERE id = ?`, s.now(), ip, userAgent, computerID)
}

// RecordComputerUse writes the best-effort last-use observability triple
// (exported for the HTTP layer; failures are part of the contract swallow).
func (s *Store) RecordComputerUse(ctx context.Context, computerID, ip, userAgent string) {
	s.touchComputerUse(ctx, computerID, ip, userAgent)
}

// WorkspaceSlug resolves one live workspace's slug (preflight echo).
func (s *Store) WorkspaceSlug(ctx context.Context, workspaceID string) (string, bool) {
	var slug string
	err := s.db.QueryRowContext(ctx, `
		SELECT slug FROM workspaces WHERE id = ? AND deleted_at IS NULL`, workspaceID).Scan(&slug)
	if err != nil {
		return "", false
	}
	return slug, true
}
