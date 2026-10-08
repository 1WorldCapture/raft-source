// Machine read-model projection for a freshly admitted machine, mirroring
// services/machineReadModel.ts buildMachineReadModel for the facts a brand
// new machine can prove, in the same wire shape M2's
// workspace/directories.go established for the machines list.
package computer

import (
	"context"
	"database/sql"
	"fmt"
)

// machineReadModelByID loads one machine row of the workspace and projects
// the read model. A machine that just registered has no live connection, no
// Computer link and no assigned agents, so the derived fields are their
// honest constants — nothing fabricated.
func (s *Store) machineReadModelByID(ctx context.Context, machineID, workspaceID string) (map[string]any, error) {
	var id, wsID, userID, name string
	var description, apiKeyPrefix, runtimes, hostname, osName, daemonVersion sql.NullString
	var lastHeartbeat, statusChangedAt sql.NullInt64
	var lastStatus sql.NullString
	var createdAt int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, user_id, name, description, api_key_prefix, runtimes,
		       hostname, os, daemon_version, last_heartbeat, created_at,
		       last_status, status_changed_at
		FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID,
	).Scan(&id, &wsID, &userID, &name, &description, &apiKeyPrefix, &runtimes,
		&hostname, &osName, &daemonVersion, &lastHeartbeat, &createdAt,
		&lastStatus, &statusChangedAt)
	if err != nil {
		return nil, fmt.Errorf("computer: read model: %w", err)
	}

	model := map[string]any{
		"id":                            id,
		"serverId":                      wsID,
		"userId":                        userID,
		"name":                          name,
		"description":                   nullString(description),
		"apiKeyPrefix":                  nullString(apiKeyPrefix),
		"runtimes":                      []string{},
		"hostname":                      nullString(hostname),
		"os":                            nullString(osName),
		"daemonVersion":                 nullString(daemonVersion),
		"lastHeartbeat":                 nil,
		"createdAt":                     isoMillisTime(createdAt),
		"status":                        "offline",
		"statusVersion":                 0,
		"runtimeVersions":               map[string]string{},
		"computerVersion":               nil,
		"hostKind":                      nil,
		"isComputer":                    false,
		"computerAttachedByCurrentUser": false,
		"agentCount":                    0,
		"creator":                       nil,
		"statusSince":                   nil,
		"computerUpgradeAvailable":      nil,
		"computerBroadcastPolicy":       nil,
	}
	if lastHeartbeat.Valid {
		model["lastHeartbeat"] = isoMillisTime(lastHeartbeat.Int64)
	}
	return model, nil
}

func nullString(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}
