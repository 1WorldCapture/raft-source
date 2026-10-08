// Machine-plane callbacks. Parent wires these to the MACHINEWS hub before
// serving. Each callback rechecks the computer principal inside a short
// database transaction and never holds that transaction across Send.
// Unhandled frames (messages, briefing, activity) are ignored: this slice
// does not invent a successful job for them.
package agent

import (
	"context"
	"database/sql"
	"encoding/json"

	"raft.local/server-go/internal/computer"
)

// OnReady reconciles agents bound to this machine with the daemon's
// runningAgents list, then drains durable purge intents. A stopped agent
// that the daemon still reports running receives a real agent:stop. An
// agent missing from the list keeps its persisted status (TS
// mark-wakeable-not-running does not demote active). A stale or revoked
// principal mutates nothing and sends nothing.
func (s *Service) OnReady(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
	var frame struct {
		RunningAgents []string `json:"runningAgents"`
	}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &frame); err != nil {
			return nil
		}
	}
	stops, err := s.reconcileReady(ctx, p, frame.RunningAgents)
	if err != nil {
		return err
	}
	s.sendStops(ctx, p, stops)
	return s.sendPendingPurges(ctx, p)
}

// OnMessage accepts the M3 lifecycle frames that belong to this machine.
// agent:status, agent:session, agent:session:invalidate and
// agent:purge:result update identity state only when the agent is currently
// bound here. Every other type returns without a write.
func (s *Service) OnMessage(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
	var frame struct {
		Type      string  `json:"type"`
		AgentID   string  `json:"agentId"`
		Status    string  `json:"status"`
		SessionID string  `json:"sessionId"`
		Outcome   string  `json:"outcome"`
		LaunchID  *string `json:"launchId"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil || frame.Type == "" {
		return nil
	}
	switch frame.Type {
	case "agent:status":
		if !s.acceptLaunch(frame.AgentID, frame.LaunchID) {
			return nil
		}
		return s.applyDaemonStatus(ctx, p, frame.AgentID, frame.Status)
	case "agent:session":
		if !s.acceptLaunch(frame.AgentID, frame.LaunchID) {
			return nil
		}
		return s.applyDaemonSession(ctx, p, frame.AgentID, frame.SessionID)
	case "agent:session:invalidate":
		if !s.acceptLaunch(frame.AgentID, frame.LaunchID) {
			return nil
		}
		return s.invalidateDaemonSession(ctx, p, frame.AgentID, frame.SessionID)
	case "agent:purge:result":
		return s.applyDaemonPurge(ctx, p, frame.AgentID, frame.Outcome)
	default:
		return nil
	}
}

// OnDisconnect rechecks the principal and then preserves agent status.
// TS reduceMachineDisconnectLifecycle skips the status write (reachability
// is a machine fact, not an agent-status fact). Live-activity "offline"
// events are not emitted here.
func (s *Service) OnDisconnect(ctx context.Context, p computer.Principal) error {
	_, err := s.store.WithLivePrincipal(ctx, p, func(*sql.Tx) error { return nil })
	return err
}

func (s *Service) reconcileReady(ctx context.Context, p computer.Principal, runningIDs []string) ([]string, error) {
	running := make(map[string]bool, len(runningIDs))
	for _, id := range runningIDs {
		if id != "" {
			running[id] = true
		}
	}
	var stops []string
	_, err := s.store.WithLivePrincipal(ctx, p, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id, status FROM agents
			WHERE workspace_id = ? AND machine_id = ? AND deleted_at IS NULL`,
			p.WorkspaceID, p.MachineID)
		if err != nil {
			return err
		}
		defer rows.Close()
		type bound struct{ id, status string }
		var agents []bound
		for rows.Next() {
			var row bound
			if err := rows.Scan(&row.id, &row.status); err != nil {
				return err
			}
			agents = append(agents, row)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		now := s.store.now()
		for _, row := range agents {
			if !running[row.id] {
				continue
			}
			if row.status == StatusStopped {
				stops = append(stops, row.id)
				continue
			}
			if row.status == StatusActive {
				continue
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE agents SET status = ?, status_changed_at = ?, updated_at = ?
				WHERE id = ? AND workspace_id = ? AND machine_id = ?
				  AND deleted_at IS NULL AND status NOT IN (?, ?)`,
				StatusActive, now, now, row.id, p.WorkspaceID, p.MachineID,
				StatusStopped, StatusActive); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return stops, nil
}

func (s *Service) sendStops(ctx context.Context, p computer.Principal, agentIDs []string) {
	if s.gateway == nil || len(agentIDs) == 0 {
		return
	}
	for _, agentID := range agentIDs {
		live, err := s.store.PrincipalBindingLive(ctx, p)
		if err != nil || !live {
			return
		}
		if err := s.gateway.Send(ctx, p.MachineID, NewStopCommand(agentID)); err != nil {
			s.logger.Warn("ready force-stop dispatch failed", "agent_id", agentID,
				"machine_id", p.MachineID, "error", err.Error())
		}
	}
}

func (s *Service) sendPendingPurges(ctx context.Context, p computer.Principal) error {
	if s.gateway == nil {
		return nil
	}
	live, err := s.store.PrincipalBindingLive(ctx, p)
	if err != nil || !live {
		return err
	}
	pending, err := s.store.ListPendingPurges(ctx, p.MachineID)
	if err != nil {
		return err
	}
	for _, purge := range pending {
		live, err = s.store.PrincipalBindingLive(ctx, p)
		if err != nil || !live {
			return err
		}
		outcome := "dispatched"
		if err := s.gateway.Send(ctx, p.MachineID, NewPurgeCommand(purge.AgentID)); err != nil {
			outcome = "dispatch_failed"
		}
		if err := s.store.RecordPurgeAttempt(ctx, p.MachineID, purge.AgentID, outcome); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) applyDaemonStatus(ctx context.Context, p computer.Principal, agentID, reported string) error {
	normalized := normalizeDaemonStatus(reported)
	if normalized == "" {
		return nil
	}
	_, err := s.store.WithBoundAgent(ctx, p, agentID, func(tx *sql.Tx, a *Agent) error {
		next := normalized
		switch {
		case next == StatusActive && a.Status == StatusStopped:
			return nil
		case a.Status == StatusStopped:
			return nil
		}
		if next == a.Status {
			return nil
		}
		now := s.store.now()
		_, err := tx.ExecContext(ctx, `
			UPDATE agents SET status = ?, status_changed_at = ?, updated_at = ?
			WHERE id = ? AND workspace_id = ? AND machine_id = ?
			  AND deleted_at IS NULL AND status != ?`,
			next, now, now, a.ID, p.WorkspaceID, p.MachineID, StatusStopped)
		return err
	})
	return err
}

func (s *Service) applyDaemonSession(ctx context.Context, p computer.Principal, agentID, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	_, err := s.store.WithBoundAgent(ctx, p, agentID, func(tx *sql.Tx, a *Agent) error {
		if a.Status == StatusStopped {
			return nil
		}
		now := s.store.now()
		query := `
			UPDATE agents SET session_id = ?, updated_at = ?
			WHERE id = ? AND workspace_id = ? AND machine_id = ?
			  AND deleted_at IS NULL AND status != ?`
		args := []any{sessionID, now, a.ID, p.WorkspaceID, p.MachineID, StatusStopped}
		if a.Status != StatusActive {
			query = `
				UPDATE agents SET session_id = ?, status = ?, status_changed_at = ?, updated_at = ?
				WHERE id = ? AND workspace_id = ? AND machine_id = ?
				  AND deleted_at IS NULL AND status != ?`
			args = []any{sessionID, StatusActive, now, now, a.ID, p.WorkspaceID, p.MachineID, StatusStopped}
		}
		_, err := tx.ExecContext(ctx, query, args...)
		return err
	})
	return err
}

func (s *Service) invalidateDaemonSession(ctx context.Context, p computer.Principal, agentID, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	_, err := s.store.WithBoundAgent(ctx, p, agentID, func(tx *sql.Tx, a *Agent) error {
		if a.Status == StatusStopped || !a.SessionID.Valid || a.SessionID.String != sessionID {
			return nil
		}
		_, err := tx.ExecContext(ctx, `
			UPDATE agents SET session_id = NULL, updated_at = ?
			WHERE id = ? AND workspace_id = ? AND machine_id = ?
			  AND session_id = ? AND deleted_at IS NULL AND status != ?`,
			s.store.now(), a.ID, p.WorkspaceID, p.MachineID, sessionID, StatusStopped)
		return err
	})
	return err
}

func (s *Service) applyDaemonPurge(ctx context.Context, p computer.Principal, agentID, outcome string) error {
	switch outcome {
	case "purged", "nothing_to_purge", "refused_running":
	default:
		return nil
	}
	live, err := s.store.PrincipalBindingLive(ctx, p)
	if err != nil || !live {
		return err
	}
	return s.ApplyPurgeResult(ctx, p.MachineID, agentID, outcome)
}

func normalizeDaemonStatus(status string) string {
	switch status {
	case "sleeping", StatusActive:
		return StatusActive
	case StatusInactive:
		return StatusInactive
	default:
		return ""
	}
}
