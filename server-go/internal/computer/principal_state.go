package computer

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
)

func credentialRevision(encodedVerifier string) string {
	digest := sha256.Sum256([]byte(encodedVerifier))
	return hex.EncodeToString(digest[:])
}

// ValidatePrincipal cheaply revalidates a previously proven connection
// principal against durable key revision, revocation and resource binding.
// It is NOT an alternative to initial Authenticate: a missing proof revision
// fails closed. No Argon derivation is needed for each inbound daemon event.
func (s *Store) ValidatePrincipal(ctx context.Context, p Principal) error {
	return validatePrincipal(ctx, s.db, p)
}

// ValidatePrincipalTx belongs inside a machine-owned domain write transaction.
// Rotation/revocation/reassignment committed before that transaction therefore
// prevents any subsequent status write, even if the socket close is delayed.
func ValidatePrincipalTx(ctx context.Context, tx *sql.Tx, p Principal) error {
	if tx == nil {
		return fmt.Errorf("computer: missing principal validation transaction")
	}
	return validatePrincipal(ctx, tx, p)
}

func validatePrincipal(ctx context.Context, q executor, p Principal) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.Kind == KindComputer {
		var workspaceID string
		var machineID, verifier, linkedWorkspace, liveWorkspace sql.NullString
		var revokedAt, workspaceDeleted sql.NullInt64
		err := q.QueryRowContext(ctx, `
			SELECT c.workspace_id, c.machine_id, c.api_key_hash, c.revoked_at,
			       m.workspace_id, w.id, w.deleted_at
			FROM computers c
			LEFT JOIN machines m ON m.id = c.machine_id
			LEFT JOIN workspaces w ON w.id = c.workspace_id
			WHERE c.id = ?`, p.ComputerID).
			Scan(&workspaceID, &machineID, &verifier, &revokedAt,
				&linkedWorkspace, &liveWorkspace, &workspaceDeleted)
		if errors.Is(err, sql.ErrNoRows) {
			return &AuthError{Reason: ReasonComputerNotFound, Stage: StageComputerLookup}
		}
		if err != nil {
			return fmt.Errorf("computer: validate connection principal: %w", err)
		}
		if revokedAt.Valid {
			return &AuthError{Reason: ReasonComputerRevoked, Stage: StageComputerLookup}
		}
		if !verifier.Valid || p.CredentialRevision == "" || !hmac.Equal([]byte(p.CredentialRevision), []byte(credentialRevision(verifier.String))) {
			return &AuthError{Reason: ReasonComputerKeyMismatch, Stage: StageComputerLookup}
		}
		if !machineID.Valid || !linkedWorkspace.Valid || machineID.String != p.MachineID || linkedWorkspace.String != workspaceID || workspaceID != p.WorkspaceID {
			return &AuthError{Reason: ReasonComputerMachineUnlinked, Stage: StageMachineLookup}
		}
		if !liveWorkspace.Valid || workspaceDeleted.Valid {
			return &AuthError{Reason: ReasonServerNotFound, Stage: StageServerLookup}
		}
		return nil
	}
	if p.Kind == KindLegacyMachine {
		var workspaceID, userID string
		var verifier, liveWorkspace sql.NullString
		var migratedAt, workspaceDeleted sql.NullInt64
		err := q.QueryRowContext(ctx, `
			SELECT m.workspace_id, m.user_id, m.api_key_hash, m.legacy_key_migrated_at,
			       w.id, w.deleted_at
			FROM machines m LEFT JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.id = ?`, p.MachineID).
			Scan(&workspaceID, &userID, &verifier, &migratedAt, &liveWorkspace, &workspaceDeleted)
		if errors.Is(err, sql.ErrNoRows) {
			return &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
		}
		if err != nil {
			return fmt.Errorf("computer: validate legacy connection principal: %w", err)
		}
		if migratedAt.Valid {
			return &AuthError{Reason: ReasonLegacyKeyMigrated, Stage: StageLegacyMigration}
		}
		if !verifier.Valid || p.CredentialRevision == "" || !hmac.Equal([]byte(p.CredentialRevision), []byte(credentialRevision(verifier.String))) || workspaceID != p.WorkspaceID || userID != p.UserID {
			return &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
		}
		if !liveWorkspace.Valid || workspaceDeleted.Valid {
			return &AuthError{Reason: ReasonServerNotFound, Stage: StageServerLookup}
		}
		return nil
	}
	return &AuthError{Reason: ReasonInvalidKeyFormat, Stage: StageFormat}
}
