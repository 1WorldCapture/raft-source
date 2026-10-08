// Machine edit and delete, plus the post-hash authorization recheck shared
// with registration and key rotation. Ported from routes/servers.ts
// PATCH/DELETE /:id/machines/:machineId and services/machineService.ts
// updateMachine/deleteMachine.
//
// M3 has no agent_migrations or agent_runtime_profiles tables. Those TS
// conflict branches (MACHINE_HAS_ACTIVE_MIGRATION,
// MACHINE_HAS_ACTIVE_RUNTIME_PROFILE) and their stale-profile clearing are
// deferred. This code does not invent those tables and does not detach live
// agents to force a delete.
package computer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Machine delete conflict codes that this slice actually enforces. The
// migration and runtime-profile codes exist in TS and are intentionally not
// emitted until those tables exist.
const (
	MachineDeleteAssignedAgents        = "MACHINE_HAS_ASSIGNED_AGENTS"
	MachineDeleteAssignedAgentsMessage = "Cannot delete computer while it has agents assigned. Remove or migrate all agents first."
)

// MachineDeleteConflictError is the 409 body source for a refused delete.
// Code and Error() are the wire code and error sentence.
type MachineDeleteConflictError struct {
	Code    string
	message string
}

func (e *MachineDeleteConflictError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

// MachinePatch is a validated name/description update. Name nil leaves the
// name. DescriptionSet with Description nil stores NULL.
type MachinePatch struct {
	Name           *string
	Description    *string
	DescriptionSet bool
}

// MachineRecord is the PATCH response: the machines row in the TS camelCase
// shape, without verifier material. api_key_hash and api_key_fingerprint are
// never serialized or logged.
type MachineRecord struct {
	ID                        string          `json:"id"`
	ServerID                  string          `json:"serverId"`
	UserID                    string          `json:"userId"`
	Name                      string          `json:"name"`
	Description               *string         `json:"description"`
	APIKeyPrefix              *string         `json:"apiKeyPrefix"`
	Runtimes                  json.RawMessage `json:"runtimes"`
	Hostname                  *string         `json:"hostname"`
	OS                        *string         `json:"os"`
	DaemonVersion             *string         `json:"daemonVersion"`
	ComputerVersion           *string         `json:"computerVersion"`
	ComputerVersionReportedAt *string         `json:"computerVersionReportedAt"`
	LastHeartbeat             *string         `json:"lastHeartbeat"`
	LastStatus                *string         `json:"lastStatus"`
	StatusChangedAt           *string         `json:"statusChangedAt"`
	CreatedAt                 string          `json:"createdAt"`
	LegacyKeyMigratedAt       *string         `json:"legacyKeyMigratedAt"`
}

// RoleHasMachineCapability reports whether a live workspace role holds one of
// the machine-management capabilities (owner and admin hold all four;
// member and guest hold none). Creator authority is a separate check.
func RoleHasMachineCapability(role, capability string) bool {
	return grantsMachineCapability(role, capability)
}

// grantsMachineCapability is the owner/admin slice of hasServerCapability for
// the machine management actions. member and guest hold none of these.
func grantsMachineCapability(role, capability string) bool {
	switch capability {
	case "registerMachines", "editMachines", "removeMachines", "rotateMachineKeys":
		return role == "owner" || role == "admin"
	default:
		return false
	}
}

// liveActorRole re-reads the caller's membership against a live, non-deleted
// workspace. joint_storage and a missing row are an empty role (the write
// then fails closed as ErrNotAuthorized).
func (s *Store) liveActorRole(ctx context.Context, ex executor, workspaceID, userID string) (string, error) {
	var role, kind string
	err := ex.QueryRowContext(ctx, `
		SELECT m.role, w.kind
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&role, &kind)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("computer: live actor role: %w", err)
	}
	if kind == "joint_storage" {
		return "", nil
	}
	return role, nil
}

// requireMachineCapability authorizes a machine write from live state.
// machineID empty skips the binding read (registration). Otherwise the
// machine must still belong to the workspace. The creator may act without
// the capability; every other member needs it. Membership is resolved before
// the binding so a non-member does not learn whether the machine id exists.
func (s *Store) requireMachineCapability(ctx context.Context, tx *sql.Tx, workspaceID, actorUserID, machineID, capability string) error {
	role, err := s.liveActorRole(ctx, tx, workspaceID, actorUserID)
	if err != nil {
		return err
	}
	if role == "" {
		return ErrNotAuthorized
	}
	// The TS /:id/machines guest wall is absolute: creator authority does not
	// survive a demotion to guest that lands before this transaction commits.
	if role == "guest" {
		return ErrForbidden
	}
	if machineID == "" {
		if !grantsMachineCapability(role, capability) {
			return ErrForbidden
		}
		return nil
	}
	var owner string
	err = tx.QueryRowContext(ctx, `
		SELECT user_id FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrMachineNotFound
	}
	if err != nil {
		return fmt.Errorf("computer: machine binding: %w", err)
	}
	if owner != actorUserID && !grantsMachineCapability(role, capability) {
		return ErrForbidden
	}
	return nil
}

// MachineBinding is the pre-transaction existence read used by HTTP to answer
// 404/403 before body validation. The transaction repeats it.
func (s *Store) MachineBinding(ctx context.Context, workspaceID, machineID string) (string, error) {
	var owner string
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrMachineNotFound
	}
	if err != nil {
		return "", fmt.Errorf("computer: machine binding: %w", err)
	}
	return owner, nil
}

// UpdateMachine applies a name and/or description change after re-reading
// live membership, capability and the machine binding in the write
// transaction.
func (s *Store) UpdateMachine(ctx context.Context, workspaceID, machineID, actorUserID string, patch MachinePatch) (MachineRecord, error) {
	if patch.Name == nil && !patch.DescriptionSet {
		return MachineRecord{}, fmt.Errorf("computer: empty machine patch")
	}
	var record MachineRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireMachineCapability(ctx, tx, workspaceID, actorUserID, machineID, "editMachines"); err != nil {
			return err
		}
		args := make([]any, 0, 4)
		query := "UPDATE machines SET "
		if patch.Name != nil {
			query += "name = ?"
			args = append(args, *patch.Name)
		}
		if patch.DescriptionSet {
			if patch.Name != nil {
				query += ", "
			}
			query += "description = ?"
			if patch.Description == nil {
				args = append(args, nil)
			} else {
				args = append(args, *patch.Description)
			}
		}
		query += " WHERE id = ? AND workspace_id = ?"
		args = append(args, machineID, workspaceID)
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("computer: update machine: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrMachineNotFound
		}
		record, err = loadMachineRecord(ctx, tx, machineID, workspaceID)
		return err
	})
	if err != nil {
		return MachineRecord{}, err
	}
	return record, nil
}

// DeleteMachine refuses while any non-deleted agent is bound to the machine
// (409 MACHINE_HAS_ASSIGNED_AGENTS). It does not null those bindings to make
// the delete succeed. On success, computers still linked to the machine are
// revoked in the same transaction before the machine row is deleted, so
// ON DELETE SET NULL cannot drop the link first. A failure rolls the revoke
// back with the delete.
func (s *Store) DeleteMachine(ctx context.Context, workspaceID, machineID, actorUserID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireMachineCapability(ctx, tx, workspaceID, actorUserID, machineID, "removeMachines"); err != nil {
			return err
		}
		var assigned string
		err := tx.QueryRowContext(ctx, `
			SELECT id FROM agents
			WHERE machine_id = ? AND deleted_at IS NULL
			LIMIT 1`, machineID).Scan(&assigned)
		if err == nil {
			return &MachineDeleteConflictError{
				Code:    MachineDeleteAssignedAgents,
				message: MachineDeleteAssignedAgentsMessage,
			}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("computer: assigned agents: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE computers
			SET revoked_at = ?, revoked_reason = 'machine_deleted'
			WHERE machine_id = ? AND revoked_at IS NULL`, s.now(), machineID); err != nil {
			return fmt.Errorf("computer: revoke before machine delete: %w", err)
		}
		res, err := tx.ExecContext(ctx, `
			DELETE FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID)
		if err != nil {
			return fmt.Errorf("computer: delete machine: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrMachineNotFound
		}
		return nil
	})
}

func loadMachineRecord(ctx context.Context, ex executor, machineID, workspaceID string) (MachineRecord, error) {
	var rec MachineRecord
	var description, prefix, runtimes, hostname, osName, daemonVersion, computerVersion, lastStatus sql.NullString
	var versionReported, heartbeat, statusChanged, createdAt, migratedAt sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT id, workspace_id, user_id, name, description, api_key_prefix, runtimes,
		       hostname, os, daemon_version, computer_version, computer_version_reported_at,
		       last_heartbeat, last_status, status_changed_at, created_at, legacy_key_migrated_at
		FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID).Scan(
		&rec.ID, &rec.ServerID, &rec.UserID, &rec.Name, &description, &prefix, &runtimes,
		&hostname, &osName, &daemonVersion, &computerVersion, &versionReported,
		&heartbeat, &lastStatus, &statusChanged, &createdAt, &migratedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return MachineRecord{}, ErrMachineNotFound
	}
	if err != nil {
		return MachineRecord{}, fmt.Errorf("computer: load machine: %w", err)
	}
	rec.Description = nullStringPtr(description)
	rec.APIKeyPrefix = nullStringPtr(prefix)
	rec.Hostname = nullStringPtr(hostname)
	rec.OS = nullStringPtr(osName)
	rec.DaemonVersion = nullStringPtr(daemonVersion)
	rec.ComputerVersion = nullStringPtr(computerVersion)
	rec.LastStatus = nullStringPtr(lastStatus)
	if runtimes.Valid && json.Valid([]byte(runtimes.String)) {
		rec.Runtimes = json.RawMessage(runtimes.String)
	}
	rec.ComputerVersionReportedAt = nullMillisPtr(versionReported)
	rec.LastHeartbeat = nullMillisPtr(heartbeat)
	rec.StatusChangedAt = nullMillisPtr(statusChanged)
	rec.LegacyKeyMigratedAt = nullMillisPtr(migratedAt)
	if createdAt.Valid {
		rec.CreatedAt = isoMillisTime(createdAt.Int64)
	}
	return rec, nil
}

func nullStringPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func nullMillisPtr(v sql.NullInt64) *string {
	if !v.Valid {
		return nil
	}
	s := isoMillisTime(v.Int64)
	return &s
}
