// Legacy machine admission: registration, key rotation and the migration
// roster, ported from services/machineService.ts (registerMachine /
// regenerateApiKey), services/legacyMachineService.ts and the gates in
// routes/servers.ts.
package computer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// MachineRegistered is the register-machine result: the wire read model plus
// the raw sk_machine_* key returned exactly once.
type MachineRegistered struct {
	ReadModel map[string]any
	APIKey    string
}

// RegisterMachine creates a real machine row with a fresh credential. Key
// material is derived before the transaction (argon2 must not sit inside the
// write lock). The insert re-reads live membership and the registerMachines
// capability and commits only when both still hold. Plan quotas are unlimited
// for every current plan (raft-shared maxMachines=-1), so no artificial cap
// is invented here. The raw key is returned to the caller and is never logged.
func (s *Store) RegisterMachine(ctx context.Context, workspaceID, userID, name string) (MachineRegistered, error) {
	apiKey, apiKeyHash, apiKeyPrefix, apiKeyFingerprint, err := GenerateMachineKeyMaterial(s.argon)
	if err != nil {
		return MachineRegistered{}, err
	}
	machineID := NewID()
	createdAt := s.now()
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireMachineCapability(ctx, tx, workspaceID, userID, "", "registerMachines"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO machines (id, workspace_id, user_id, name, api_key_hash,
				api_key_prefix, api_key_fingerprint, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			machineID, workspaceID, userID, name, apiKeyHash, apiKeyPrefix, apiKeyFingerprint, createdAt); err != nil {
			return fmt.Errorf("computer: register machine: %w", err)
		}
		return nil
	})
	if err != nil {
		return MachineRegistered{}, err
	}
	model, err := s.machineReadModelByID(ctx, machineID, workspaceID)
	if err != nil {
		return MachineRegistered{}, err
	}
	return MachineRegistered{ReadModel: model, APIKey: apiKey}, nil
}

// RotateMachineKey replaces a machine's credential. Key material is derived
// before the transaction. actorRole is not an authorization source: after the
// hash, a short transaction re-reads the machine binding and the actor's live
// membership. The creator or a live rotateMachineKeys role may commit; a
// missing machine in this workspace is ErrMachineNotFound, a missing
// membership is ErrNotAuthorized, and a present member without authority is
// ErrForbidden. The previous raw key is not logged and is not returned.
func (s *Store) RotateMachineKey(ctx context.Context, workspaceID, machineID, actorUserID, actorRole string) (string, error) {
	_ = actorRole
	apiKey, apiKeyHash, apiKeyPrefix, apiKeyFingerprint, err := GenerateMachineKeyMaterial(s.argon)
	if err != nil {
		return "", err
	}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireMachineCapability(ctx, tx, workspaceID, actorUserID, machineID, "rotateMachineKeys"); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE machines SET api_key_hash = ?, api_key_prefix = ?, api_key_fingerprint = ?
			WHERE id = ? AND workspace_id = ?`,
			apiKeyHash, apiKeyPrefix, apiKeyFingerprint, machineID, workspaceID)
		if err != nil {
			return fmt.Errorf("computer: rotate: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrMachineNotFound
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return apiKey, nil
}

// LegacyRosterEntry serializes to the exact TS LegacyMachineRosterEntry wire
// shape. APIKeyFingerprint is omitted in the includeAll (manual-pick) shape,
// exactly like the TS redaction branch.
type LegacyRosterEntry struct {
	DaemonID            string  `json:"daemonId"`
	APIKeyFingerprint   *string `json:"apiKeyFingerprint,omitempty"`
	HasFingerprint      bool    `json:"hasFingerprint"`
	MachineName         string  `json:"machineName"`
	Hostname            *string `json:"hostname"`
	LastSeenAt          *string `json:"lastSeenAt"`
	LegacyKeyMigratedAt *string `json:"legacyKeyMigratedAt"`
}

// ListLegacyMachineRoster answers the setup picker's server-side
// intersection source. Missing/soft-deleted workspace and non-membership
// collapse to ErrNotAuthorized (anti-enumeration). Default roster requires a
// non-NULL fingerprint; includeAll adds NULL-fingerprint rows and redacts
// the fingerprint bytes.
func (s *Store) ListLegacyMachineRoster(ctx context.Context, userID, serverSlug string, includeAll bool) ([]LegacyRosterEntry, error) {
	var workspaceID string
	err := s.db.QueryRowContext(ctx, `
		SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL`, serverSlug,
	).Scan(&workspaceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotAuthorized
	}
	if err != nil {
		return nil, fmt.Errorf("computer: roster workspace: %w", err)
	}
	role, err := s.memberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, ErrNotAuthorized
	}

	query := `
		SELECT id, api_key_fingerprint, name, hostname, last_heartbeat, legacy_key_migrated_at
		FROM machines WHERE user_id = ? AND workspace_id = ?`
	args := []any{userID, workspaceID}
	if !includeAll {
		query += ` AND api_key_fingerprint IS NOT NULL`
	}
	query += ` ORDER BY created_at ASC, id ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("computer: roster read: %w", err)
	}
	defer rows.Close()
	entries := make([]LegacyRosterEntry, 0)
	for rows.Next() {
		var id, name string
		var fingerprint, hostname sql.NullString
		var heartbeat, migratedAt sql.NullInt64
		if err := rows.Scan(&id, &fingerprint, &name, &hostname, &heartbeat, &migratedAt); err != nil {
			return nil, fmt.Errorf("computer: roster scan: %w", err)
		}
		entry := LegacyRosterEntry{
			DaemonID:       id,
			HasFingerprint: fingerprint.Valid && fingerprint.String != "",
			MachineName:    name,
		}
		if hostname.Valid {
			v := hostname.String
			entry.Hostname = &v
		}
		if heartbeat.Valid {
			v := isoMillisTime(heartbeat.Int64)
			entry.LastSeenAt = &v
		}
		if migratedAt.Valid {
			v := isoMillisTime(migratedAt.Int64)
			entry.LegacyKeyMigratedAt = &v
		}
		if !includeAll && entry.HasFingerprint {
			v := fingerprint.String
			entry.APIKeyFingerprint = &v
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func isoMillisTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
