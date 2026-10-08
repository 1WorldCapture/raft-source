// Computer attach and revocation, ported from
// services/computerCredentialService.ts (attachComputer/ensureComputerMachine)
// plus the route gates in routes/computerAttach.ts.
package computer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

const maxComputerNameLen = 200

// AttachResult is the successful sk_computer_* issuance. APIKey is the raw
// key and is returned exactly once.
type AttachResult struct {
	APIKey          string
	ServerMachineID string
	MachineID       string
	WorkspaceID     string
	ServerSlug      string
	Resumed         bool
}

// AttachComputer establishes this host's Computer attachment for one server,
// identified by slug at the trust boundary. Authorization collapses
// missing/soft-deleted workspace and non-membership into not_authorized
// (zero enumeration); a member without the registerMachines capability gets
// the distinct requires_admin. A duplicate live display name for the same
// attaching user fails closed with computer_name_collision. The Computer row
// and its backing machines row are created in ONE transaction; the machine's
// generated sk_machine_* raw key is intentionally discarded (TS
// ensureComputerMachine).
func (s *Store) AttachComputer(ctx context.Context, userID string, serverSlug, name string) (AttachResult, error) {
	if serverSlug == "" {
		return AttachResult{}, &AttachError{Code: AttachNotAuthorized}
	}
	if name == "" || len(name) > maxComputerNameLen {
		return AttachResult{}, &AttachError{Code: AttachNotAuthorized}
	}

	var workspaceID, slug string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, slug FROM workspaces WHERE slug = ? AND deleted_at IS NULL`, serverSlug,
	).Scan(&workspaceID, &slug)
	if errors.Is(err, sql.ErrNoRows) {
		return AttachResult{}, &AttachError{Code: AttachNotAuthorized}
	}
	if err != nil {
		return AttachResult{}, fmt.Errorf("computer: resolve slug: %w", err)
	}

	role, err := s.memberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		return AttachResult{}, err
	}
	if role == "" {
		return AttachResult{}, &AttachError{Code: AttachNotAuthorized}
	}
	if !hasCapability(role, "registerMachines") {
		return AttachResult{}, &AttachError{Code: AttachRequiresAdmin}
	}

	var existing int
	err = s.db.QueryRowContext(ctx, `
		SELECT 1 FROM computers
		WHERE workspace_id = ? AND attached_by_user_id = ? AND name = ? AND revoked_at IS NULL`,
		workspaceID, userID, name).Scan(&existing)
	if err == nil {
		return AttachResult{}, &AttachError{Code: AttachNameCollision}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return AttachResult{}, fmt.Errorf("computer: collision check: %w", err)
	}

	apiKey, apiKeyHash, apiKeyPrefix, err := GenerateComputerKeyMaterial(s.argon)
	if err != nil {
		return AttachResult{}, err
	}
	// The discarded machine key still gets a real credential row: the
	// machine must authenticate as a machine plane member under the linked
	// identity model, and the hash must exist for the link to be meaningful.
	machineKey, machineHash, machinePrefix, machineFingerprint, err := GenerateMachineKeyMaterial(s.argon)
	if err != nil {
		return AttachResult{}, err
	}
	_ = machineKey

	var result AttachResult
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		computerID := NewID()
		machineID := NewID()
		now := s.now()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO machines (id, workspace_id, user_id, name, api_key_hash,
				api_key_prefix, api_key_fingerprint, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			machineID, workspaceID, userID, name, machineHash, machinePrefix, machineFingerprint, now); err != nil {
			return fmt.Errorf("computer: insert machine: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO computers (id, workspace_id, name, api_key_hash, api_key_prefix,
				attached_by_user_id, machine_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			computerID, workspaceID, name, apiKeyHash, apiKeyPrefix, userID, machineID, now); err != nil {
			return fmt.Errorf("computer: insert computer: %w", err)
		}
		result = AttachResult{
			APIKey:          apiKey,
			ServerMachineID: computerID,
			MachineID:       machineID,
			WorkspaceID:     workspaceID,
			ServerSlug:      slug,
			Resumed:         false,
		}
		return nil
	})
	if err != nil {
		return AttachResult{}, err
	}
	return result, nil
}

// RevokeComputer soft-revokes one Computer attachment. Rows are never
// deleted; revocation is effective immediately on the next Authenticate
// (the revoked row fails closed with computer_revoked).
func (s *Store) RevokeComputer(ctx context.Context, computerID string, byUserID string, reason string) error {
	var rev sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT revoked_at FROM computers WHERE id = ?`, computerID).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrMachineNotFound
	}
	if err != nil {
		return fmt.Errorf("computer: revoke read: %w", err)
	}
	if rev.Valid {
		return nil // idempotent, like the TS soft-revoke writers
	}
	var by any
	if byUserID != "" {
		by = byUserID
	}
	var why any
	if reason != "" {
		why = reason
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE computers SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ?
		WHERE id = ? AND revoked_at IS NULL`, s.now(), by, why, computerID); err != nil {
		return fmt.Errorf("computer: revoke: %w", err)
	}
	return nil
}
