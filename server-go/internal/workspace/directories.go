// Machine directory read side (legacy GET /api/servers/:id/machines, W17).
//
// Port of the TS route + builders:
//
//	routes/servers.ts (/:id/machines), machineService.listMachines /
//	countActiveAgentsByMachine, computerCredentialService link helpers,
//	machineReadModel.buildMachineReadModel, lifecycleSinceService
//	.deriveMachineStatusSince, computerBroadcastPolicyService.
//
// M2 honesty rules (design 2.2 / route matrix W17):
//   - a real catalog query; an empty catalog is [] (never null);
//   - online-ness needs a connection layer M2 does not have, so status is
//     "offline" and online machine facts are never fabricated;
//   - live-only fields (computerVersion, hostKind, runtimeVersions,
//     daemonVersion's live half) degrade to their persisted/absent values;
//   - the Computer upgrade policy answers the TS-exact "source_missing"
//     decision because no live version source exists yet;
//   - unknown persisted states (unparseable runtimes) fail loudly instead
//     of silently reporting "no machines".
//
// NOTE for the HTTP worker: the TS route responds
//
//	{ machines: [...], latestDaemonVersion, latestComputerVersion }
//
// — the web store accepts either that wrapper or a bare array
// (machineStore: Array.isArray(data) ? data : data.machines). This function
// returns the bare array; transport wraps it with both null version fields
// to match the TS shape byte-for-byte.
package workspace

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// machineDirectoryRow is one persisted machine row (TS listMachines select).
type machineDirectoryRow struct {
	ID            string
	ServerID      string
	UserID        string
	Name          string
	Description   sql.NullString
	APIKeyPrefix  sql.NullString
	Runtimes      []byte
	Hostname      sql.NullString
	OS            sql.NullString
	DaemonVersion sql.NullString
	LastHeartbeat sql.NullInt64
	CreatedAt     int64

	// statusSince facts (TS deriveMachineStatusSince inputs).
	LastStatus      sql.NullString
	StatusChangedAt sql.NullInt64
}

// computerLink is the active computer linkage for one machine.
type computerLink struct {
	ComputerID string
	AttachedBy sql.NullString
}

// computerCreatorSummary is the public identity of the attaching human
// (TS ComputerCreatorSummary). gravatarHash is always derived server-side.
type computerCreatorSummary struct {
	Type         string  `json:"type"`
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	DisplayName  *string `json:"displayName"`
	AvatarURL    *string `json:"avatarUrl"`
	GravatarHash string  `json:"gravatarHash"`
}

// broadcastPolicyProjection is the closed computer-broadcast policy decision
// (TS projectComputerBroadcastPolicyDecision). M2 can only ever produce the
// source_missing refusal: no live Computer version source exists.
type broadcastPolicyProjection struct {
	Eligibility    string  `json:"eligibility"`
	TargetVersion  *string `json:"targetVersion"`
	TargetRole     *string `json:"targetRole"`
	MigrationClass *string `json:"migrationClass"`
	PolicyRevision *string `json:"policyRevision"`
	ReasonCode     string  `json:"reasonCode"`
}

// ListMachines returns the legacy machine directory for one workspace
// membership. Result is never nil: an empty catalog is []. A caller without
// an eligible membership gets NOT_FOUND ("Server not found"), the legacy
// route answer.
func (s *Store) ListMachines(ctx context.Context, workspaceID, userID string) ([]map[string]any, error) {
	// TS isMember: the membership row must exist and the workspace be live.
	// (joint_storage is additionally rejected by the scope middleware before
	// the handler runs; the domain check mirrors the service-layer join.)
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &DomainError{Code: CodeNotFound, Message: "Server not found"}
	}
	if err != nil {
		return nil, fmt.Errorf("read machine directory membership: %w", err)
	}

	machines := make([]map[string]any, 0)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workspace_id, user_id, name, description, api_key_prefix,
		       runtimes, hostname, os, daemon_version, last_heartbeat,
		       created_at, last_status, status_changed_at
		FROM machines
		WHERE workspace_id = ?
		ORDER BY created_at ASC, id ASC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read machines: %w", err)
	}
	defer rows.Close()
	var machineRows []machineDirectoryRow
	for rows.Next() {
		var row machineDirectoryRow
		if err := rows.Scan(&row.ID, &row.ServerID, &row.UserID, &row.Name,
			&row.Description, &row.APIKeyPrefix, &row.Runtimes, &row.Hostname,
			&row.OS, &row.DaemonVersion, &row.LastHeartbeat, &row.CreatedAt,
			&row.LastStatus, &row.StatusChangedAt); err != nil {
			return nil, fmt.Errorf("scan machine: %w", err)
		}
		machineRows = append(machineRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate machines: %w", err)
	}

	links, err := s.computerLinks(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	creators, err := s.computerCreators(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	agentCounts, err := s.machineAgentCounts(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	for _, row := range machineRows {
		if err := decodeDirectoryRuntimes(row); err != nil {
			// A corrupt payload is a record this build cannot explain; fail
			// loudly instead of silently reporting "no machines".
			return nil, fmt.Errorf("machine %s has unparseable runtimes: %w", row.ID, err)
		}
		model := s.machineReadModel(row, links, creators, agentCounts, userID)
		if err := s.applyLiveMachinePresence(ctx, row, model); err != nil {
			return nil, err
		}
		if model["status"] == ComputerStateOnline {
			if err := s.applyLiveMachineMetadata(ctx, row, model); err != nil {
				return nil, err
			}
		}
		machines = append(machines, model)
	}
	return machines, nil
}

// machineReadModel builds the exact TS MachineReadModel wire map for one
// machine, plus the route-level statusSince/computerUpgrade projections.
func (s *Store) machineReadModel(row machineDirectoryRow,
	links map[string][]computerLink, creators map[string]computerCreatorSummary,
	agentCounts map[string]int, requesterID string) map[string]any {

	// runtimes: persisted JSON array; NULL = not reported → [] on the wire
	// (TS machine.runtimes || []). ListMachines validated the JSON already.
	runtimes := []string{}
	if row.Runtimes != nil {
		if err := json.Unmarshal(row.Runtimes, &runtimes); err != nil {
			runtimes = []string{}
		}
	}
	if runtimes == nil {
		runtimes = []string{}
	}

	var lastHeartbeat any
	if row.LastHeartbeat.Valid {
		lastHeartbeat = isoMillis(unixMilliTime(row.LastHeartbeat.Int64))
	}

	activeLink, hasActiveLink := links[row.ID]
	isComputer := hasActiveLink && len(activeLink) > 0
	attachedByCurrentUser := false
	if isComputer {
		for _, link := range activeLink {
			if link.AttachedBy.Valid && link.AttachedBy.String == requesterID {
				attachedByCurrentUser = true
				break
			}
		}
	}

	var creator any
	if isComputer {
		if summary, ok := creators[row.ID]; ok {
			creator = summary
		}
	}

	model := map[string]any{
		"id":                            row.ID,
		"serverId":                      row.ServerID,
		"userId":                        row.UserID,
		"name":                          row.Name,
		"description":                   nullStringAny(row.Description),
		"apiKeyPrefix":                  nullStringAny(row.APIKeyPrefix),
		"runtimes":                      runtimes,
		"hostname":                      nullStringAny(row.Hostname),
		"os":                            nullStringAny(row.OS),
		"daemonVersion":                 nullStringAny(row.DaemonVersion),
		"lastHeartbeat":                 lastHeartbeat,
		"createdAt":                     isoMillis(unixMilliTime(row.CreatedAt)),
		"status":                        ComputerStateOffline,
		"statusVersion":                 0,
		"runtimeVersions":               map[string]string{},
		"computerVersion":               nil,
		"hostKind":                      nil,
		"isComputer":                    isComputer,
		"computerAttachedByCurrentUser": attachedByCurrentUser,
		"agentCount":                    agentCounts[row.ID],
		"creator":                       creator,
		"statusSince":                   deriveStatusSince(row),
	}
	if !isComputer {
		model["computerUpgradeAvailable"] = nil
		model["computerBroadcastPolicy"] = nil
		return model
	}
	// TS evaluates the closed broadcast policy from a LIVE version source;
	// M2 has none, and the TS-exact decision for source.version == null is
	// no_broadcast/source_missing. eligibility !== "eligible" → the route's
	// computerUpgradeAvailable is false.
	model["computerUpgradeAvailable"] = false
	model["computerBroadcastPolicy"] = broadcastPolicyProjection{
		Eligibility:    "no_broadcast",
		TargetVersion:  nil,
		TargetRole:     nil,
		MigrationClass: nil,
		PolicyRevision: nil,
		ReasonCode:     "source_missing",
	}
	return model
}

// decodeDirectoryRuntimes validates one machine's persisted runtimes JSON.
func decodeDirectoryRuntimes(row machineDirectoryRow) error {
	if row.Runtimes == nil {
		return nil
	}
	var ids []string
	return json.Unmarshal(row.Runtimes, &ids)
}

// deriveStatusSince ports deriveMachineStatusSince for the only live status
// M2 can report ("offline"): the last settled transition if it agrees, then
// heartbeat, then creation time for machines that never connected. M2 has no
// computerOutageOccurrences table, so the open-outage input is always null.
func deriveStatusSince(row machineDirectoryRow) any {
	if row.LastStatus.Valid && row.LastStatus.String == ComputerStateOffline && row.StatusChangedAt.Valid {
		return row.StatusChangedAt.Int64
	}
	if row.LastHeartbeat.Valid {
		return row.LastHeartbeat.Int64
	}
	if !row.LastStatus.Valid {
		return row.CreatedAt
	}
	return nil
}

// computerLinks maps machineID → active (non-revoked, machine-bound)
// computer rows (TS getComputerLinkedMachineAttachers, batched).
func (s *Store) computerLinks(ctx context.Context, workspaceID string) (map[string][]computerLink, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT machine_id, id, attached_by_user_id
		FROM computers
		WHERE workspace_id = ? AND revoked_at IS NULL AND machine_id IS NOT NULL`,
		workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read computer links: %w", err)
	}
	defer rows.Close()
	links := make(map[string][]computerLink)
	for rows.Next() {
		var machineID string
		var link computerLink
		if err := rows.Scan(&machineID, &link.ComputerID, &link.AttachedBy); err != nil {
			return nil, fmt.Errorf("scan computer link: %w", err)
		}
		links[machineID] = append(links[machineID], link)
	}
	return links, rows.Err()
}

// computerCreators resolves active-computer attachers to the same
// server-scoped public identity the agent creator links use (TS
// getComputerLinkedMachineCreators). A departed attacher resolves to no
// creator rather than leaking a raw audit id.
func (s *Store) computerCreators(ctx context.Context, workspaceID string) (map[string]computerCreatorSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.machine_id, u.id, u.name, u.display_name, u.avatar_url, u.email
		FROM computers c
		JOIN workspace_memberships m
		     ON m.workspace_id = c.workspace_id AND m.user_id = c.attached_by_user_id
		JOIN users u ON u.id = m.user_id
		WHERE c.workspace_id = ? AND c.revoked_at IS NULL
		  AND c.machine_id IS NOT NULL AND c.attached_by_user_id IS NOT NULL`,
		workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read computer creators: %w", err)
	}
	defer rows.Close()
	creators := make(map[string]computerCreatorSummary)
	for rows.Next() {
		var machineID string
		var summary computerCreatorSummary
		var displayName, avatarURL, email sql.NullString
		if err := rows.Scan(&machineID, &summary.ID, &summary.Name, &displayName, &avatarURL, &email); err != nil {
			return nil, fmt.Errorf("scan computer creator: %w", err)
		}
		summary.Type = "human"
		if displayName.Valid {
			v := displayName.String
			summary.DisplayName = &v
		}
		if avatarURL.Valid {
			v := avatarURL.String
			summary.AvatarURL = &v
		}
		// Same digest the member directory exposes, so the identity surface
		// stays consistent when email visibility hides the address itself.
		hash := sha256.Sum256([]byte(trimLower(email.String)))
		summary.GravatarHash = hex.EncodeToString(hash[:])
		creators[machineID] = summary
	}
	return creators, rows.Err()
}

// machineAgentCounts counts non-deleted agents bound to each machine (TS
// countActiveAgentsByMachine: every non-deleted assignment regardless of
// lifecycle status).
func (s *Store) machineAgentCounts(ctx context.Context, workspaceID string) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT machine_id, COUNT(*)
		FROM agents
		WHERE workspace_id = ? AND deleted_at IS NULL AND machine_id IS NOT NULL
		GROUP BY machine_id`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read machine agent counts: %w", err)
	}
	defer rows.Close()
	counts := make(map[string]int)
	for rows.Next() {
		var machineID string
		var n int
		if err := rows.Scan(&machineID, &n); err != nil {
			return nil, fmt.Errorf("scan machine agent count: %w", err)
		}
		counts[machineID] = n
	}
	return counts, rows.Err()
}

func nullStringAny(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}

func unixMilliTime(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

// trimLower mirrors the TS email digest input (email.trim().toLowerCase()).
func trimLower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
