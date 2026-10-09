// M5 persistent launch fencing for daemon lifecycle frames. The M3
// in-memory fence (launch_fence.go) is untouched; when the launch store is
// wired, agent:session / agent:session:invalidate are additionally fenced by
// the DURABLE current launch: a frame survives only when its launchId is the
// agent's current active launch on this machine. Late frames from a
// superseded launch (restart, machine move, stop/reset) change nothing. When
// the agent has NO persisted launch the M3 in-memory path runs unchanged —
// pre-0014 builds and legacy flows keep their exact semantics.
package agent

import (
	"context"
	"database/sql"
	"strings"

	"raft.local/server-go/internal/computer"
)

// applyFencedSession handles agent:session under the persistent fence.
// handled=false means "no persisted launch — use the M3 in-memory path".
// handled=true means the frame was decided here (applied or fenced out).
func (s *Service) applyFencedSession(ctx context.Context, p computer.Principal, agentID string, launchID *string, sessionID string) (bool, error) {
	sessionID = strings.TrimSpace(sessionID)
	current, err := s.launches.CurrentLaunch(ctx, p.WorkspaceID, agentID)
	if err != nil {
		return false, err
	}
	// A named launch, or any frame while a current launch exists, is decided
	// here. Falling through would let the M3 path write agents.session_id
	// with no same-generation binding. Only a launch-less frame for an agent
	// that has no durable launch keeps the pre-0014 path.
	if !sessionFrameMatchesCurrent(current, p.MachineID, launchID, sessionID) {
		if current != nil || (launchID != nil && *launchID != "") {
			return true, nil
		}
		return false, nil
	}
	_, err = s.store.WithBoundAgent(ctx, p, agentID, func(tx *sql.Tx, a *Agent) error {
		if a.Status == StatusStopped {
			return nil
		}
		// The durable fence re-answers INSIDE the write transaction (a
		// supersede that raced the outside read cannot slip through). The
		// confirmed binding and the resume pointer commit together. The
		// binding is not copied from a previous launch's session.
		accepted, err := s.launches.AcceptSessionFrameTx(ctx, tx,
			p.WorkspaceID, agentID, p.MachineID, current.ID)
		if err != nil || !accepted {
			return err
		}
		confirmed, err := s.launches.ConfirmSessionTx(ctx, tx,
			p.WorkspaceID, agentID, p.MachineID, current.ID, sessionID)
		if err != nil || !confirmed {
			return err
		}
		now := s.store.now()
		query := `
			UPDATE agents SET session_id = ?, updated_at = ?
			WHERE id = ? AND workspace_id = ? AND machine_id = ?
			  AND deleted_at IS NULL AND status != ?`
		args := []any{sessionID, now, agentID, p.WorkspaceID, p.MachineID, StatusStopped}
		if a.Status != StatusActive {
			query = `
				UPDATE agents SET session_id = ?, status = ?, status_changed_at = ?, updated_at = ?
				WHERE id = ? AND workspace_id = ? AND machine_id = ?
				  AND deleted_at IS NULL AND status != ?`
			args = []any{sessionID, StatusActive, now, now, agentID, p.WorkspaceID, p.MachineID, StatusStopped}
		}
		_, err = tx.ExecContext(ctx, query, args...)
		return err
	})
	return true, err
}

// invalidateFencedSession handles agent:session:invalidate under the
// persistent fence. Same tri-state contract as applyFencedSession.
func (s *Service) invalidateFencedSession(ctx context.Context, p computer.Principal, agentID string, launchID *string, sessionID string) (bool, error) {
	sessionID = strings.TrimSpace(sessionID)
	current, err := s.launches.CurrentLaunch(ctx, p.WorkspaceID, agentID)
	if err != nil {
		return false, err
	}
	// Same tri-state as applyFencedSession. A stale launch id must not clear
	// the resume pointer through the M3 path.
	if !sessionFrameMatchesCurrent(current, p.MachineID, launchID, sessionID) {
		if current != nil || (launchID != nil && *launchID != "") {
			return true, nil
		}
		return false, nil
	}
	_, err = s.store.WithBoundAgent(ctx, p, agentID, func(tx *sql.Tx, a *Agent) error {
		if a.Status == StatusStopped || !a.SessionID.Valid || a.SessionID.String != sessionID {
			return nil
		}
		accepted, err := s.launches.AcceptSessionFrameTx(ctx, tx,
			p.WorkspaceID, agentID, p.MachineID, current.ID)
		if err != nil || !accepted {
			return err
		}
		if _, err := s.launches.ClearConfirmedSessionTx(ctx, tx,
			p.WorkspaceID, agentID, p.MachineID, current.ID, sessionID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE agents SET session_id = NULL, updated_at = ?
			WHERE id = ? AND workspace_id = ? AND machine_id = ?
			  AND session_id = ? AND deleted_at IS NULL AND status != ?`,
			s.store.now(), agentID, p.WorkspaceID, p.MachineID, sessionID, StatusStopped)
		return err
	})
	return true, err
}

// sessionFrameMatchesCurrent reports whether this frame is the authenticated
// report for the agent's current same-machine launch. A blank session never
// matches: it must not confirm a generation or clear the resume pointer.
func sessionFrameMatchesCurrent(current *Launch, machineID string, launchID *string, sessionID string) bool {
	if current == nil || sessionID == "" || launchID == nil || *launchID == "" {
		return false
	}
	return *launchID == current.ID && current.MachineID == machineID
}

// applyStartAck records one agent:start:ack. The authenticated principal
// must still be bound to the agent (WithBoundAgent rechecks workspace,
// machine and liveness in one short transaction), the startDispatchId must
// name the CURRENT launch's dispatch, and an echoed launchId must match. The
// queueState is stored as a REPORTED fact; it never writes a session and
// never flips dispatchability on its own.
func (s *Service) applyStartAck(ctx context.Context, p computer.Principal, frame *StartAckFrame) error {
	if frame == nil || frame.AgentID == "" || frame.StartDispatchID == "" {
		return nil
	}
	_, err := s.store.WithBoundAgent(ctx, p, frame.AgentID, func(tx *sql.Tx, a *Agent) error {
		applied, err := s.launches.ApplyStartAckTx(ctx, tx, p.WorkspaceID, frame.AgentID,
			p.MachineID, frame.StartDispatchID, stringOrEmpty(frame.LaunchID), frame.QueueState)
		if err != nil {
			return err
		}
		if !applied {
			s.logger.Info("start ack fenced out", "agent_id", frame.AgentID,
				"machine_id", p.MachineID, "start_dispatch_id", frame.StartDispatchID,
				"queue_state", frame.QueueState)
		}
		return nil
	})
	return err
}
