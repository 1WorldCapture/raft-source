// Live dispatch facts for A's scheduler callbacks (delivery.DispatchDeps.
// Facts, docs/m5-delivery-worker-contract.md §2.3 and change request §5.4).
// This query runs INSIDE the scheduler's write transaction, so it touches
// ONLY persisted facts — never the machine hub, never Hub.Snapshot/IsOnline
// (those take the machine slot guard and would invert the slot -> DB/fence
// lock order). Reachable is therefore the machines row's settled connection
// projection; the final real-time admission happens AFTER the scheduler's
// transaction commits, inside the hub's current-connection guard.
package agent

import (
	"context"
	"database/sql"

	platformdb "raft.local/server-go/internal/platform/db"
)

// ManagedDispatchFacts mirrors delivery.DispatchFacts field-for-field so the
// parent's composition is a plain struct copy with no translation layer that
// could drift.
type ManagedDispatchFacts struct {
	// SupportsManagedWire is false for external-runtime agents (claim-only).
	SupportsManagedWire bool
	// Reachable is the persisted machines.last_status projection ("online"),
	// NOT a live hub probe.
	Reachable bool
	// MachineID is the agent's current machine binding ("" when unbound).
	MachineID string
	// LaunchID is the current same-machine launch ("" when none). A launch
	// whose machine is not the agent's machine is not current.
	LaunchID string
	// SessionID is that launch's confirmed_session_id. agents.session_id is
	// the resume pointer and is NOT a dispatch credential. Empty until the
	// authenticated agent:session for this launch commits.
	SessionID string
	// Stopped is the user's explicit stop: wait, do not burn budget, do not
	// force a wake.
	Stopped bool
}

// ManagedDispatchFactsTx reads the dispatch facts for one agent on the
// caller's executor (the scheduler's own write transaction, or a read
// snapshot). It performs no writes and no network I/O.
func (s *Service) ManagedDispatchFactsTx(ctx context.Context, ex Executor, workspaceID, agentID string) (ManagedDispatchFacts, error) {
	facts := ManagedDispatchFacts{}
	var machineID sql.NullString
	var status string
	var runtime string
	err := ex.QueryRowContext(ctx, `
		SELECT machine_id, status, runtime
		FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		agentID, workspaceID).
		Scan(&machineID, &status, &runtime)
	if err == sql.ErrNoRows {
		// A deleted agent reports as stopped-with-no-machine: the scheduler's
		// authorize callback decides cancellation; facts stay empty.
		return facts, nil
	}
	if err != nil {
		return facts, err
	}
	facts.Stopped = status == StatusStopped
	facts.SupportsManagedWire = !IsExternalAgentRuntime(runtime)
	if machineID.Valid && machineID.String != "" {
		facts.MachineID = machineID.String
		var lastStatus sql.NullString
		err := ex.QueryRowContext(ctx,
			`SELECT last_status FROM machines WHERE id = ? AND workspace_id = ?`,
			machineID.String, workspaceID).Scan(&lastStatus)
		if err != nil && err != sql.ErrNoRows {
			return facts, err
		}
		// The settled projection only: last_status is written by the machine
		// transport after its grace window, so "online" means the machines row
		// observed a published connection. Real admission still happens at
		// send time in the hub.
		facts.Reachable = lastStatus.Valid && lastStatus.String == "online"
	}
	if s.launches != nil {
		current, err := currentLaunchOn(ctx, ex, workspaceID, agentID)
		if err != nil {
			return facts, err
		}
		if current != nil {
			facts.LaunchID = current.ID
			// Fail closed: only the session reported for this launch. The
			// resume pointer on agents.session_id can still name the previous
			// generation and must not lease a delivery.
			if current.ConfirmedSessionID.Valid && current.ConfirmedSessionID.String != "" {
				facts.SessionID = current.ConfirmedSessionID.String
			}
		}
	}
	return facts, nil
}

// CurrentControlIdentity reads the persisted current launch and its confirmed
// session. Both empty means identity is not formed. The resume pointer on
// agents.session_id is not a control-ack credential. It is a short read of
// persisted facts only — it does not touch the machine hub — so a receipt
// path that already holds the machine slot may call it (slot → DB). Callers
// pass the pair into delivery.AcknowledgeControl; that store rejects a
// receipt whose attempt snapshot does not match. A control ack has no
// launch or session on the wire, so this read is the only current-identity
// source.
func (s *Service) CurrentControlIdentity(ctx context.Context, workspaceID, agentID string) (launchID, sessionID string, err error) {
	if s == nil || s.store == nil || s.store.db == nil {
		return "", "", ErrLaunchPersistenceUnavailable
	}
	err = platformdb.WithReadSnapshot(ctx, s.store.db, func(ex platformdb.Executor) error {
		facts, ferr := s.ManagedDispatchFactsTx(ctx, ex, workspaceID, agentID)
		if ferr != nil {
			return ferr
		}
		launchID = facts.LaunchID
		sessionID = facts.SessionID
		return nil
	})
	if err != nil {
		return "", "", err
	}
	return launchID, sessionID, nil
}
