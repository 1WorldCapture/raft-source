// M5 lifecycle entry points: persistent start dispatch, offline recovery,
// the controlled delivery entry and the current-identity query. Lock order
// (proof in docs/m5-lifecycle-worker-contract.md §5): every method here
// finishes its database transaction BEFORE any gateway call — no path holds
// a write transaction or the authority fence while acquiring the machine
// slot guard inside hub.Send/IsOnline. The reverse direction (slot guard ->
// principal revalidation -> short DB tx) is the existing machinews callback
// order and stays the only other edge in the graph.
package agent

import (
	"context"
	"database/sql"
)

// EnsureStartLaunch reserves (or reuses) the agent's persistent start
// dispatch and, when the machine is currently online, sends agent:start for
// it. Dedup is the reservation itself: concurrent callers (a batch mention)
// reserve inside one short transaction and all receive the SAME launch /
// startDispatchId, so the daemon observes one start. When the machine is
// offline the reservation still commits — that IS the durable wake intent;
// RecoverPendingStarts (OnReady / periodic scan) re-sends it later. This
// method never waits for the daemon, never reads a model and never
// fabricates a wakeMessage.
func (s *Service) EnsureStartLaunch(ctx context.Context, a *Agent) (*Launch, error) {
	if s.launches == nil {
		return nil, ErrLaunchPersistenceUnavailable
	}
	if IsExternalAgentRuntime(a.Runtime) {
		return nil, errf(400, "", "External agents do not use Raft-managed runtime lifecycle")
	}
	if !a.MachineID.Valid || a.MachineID.String == "" {
		return nil, errf(409, "machine_unassigned",
			"No machine assigned. Please assign a machine to this agent first.")
	}
	machineID := a.MachineID.String

	// Phase 1 — durable reservation (short tx, no network inside). The
	// reservation re-reads the live agent/workspace/status/binding under its
	// transaction and returns the FRESH agent row, so the wire config below
	// is never the caller's stale copy.
	launch, fresh, err := s.reserveLaunch(ctx, a, machineID)
	if err != nil {
		return nil, err
	}

	// Phase 2 — best-effort dispatch AFTER commit, and only for a launch
	// that has never been sent (reserved). An already-dispatched or acked
	// launch is NOT resent here: repeated scans must not spam duplicate
	// starts; the resend path is RecoverPendingStarts (backoff-throttled).
	// A failed send leaves the reservation reserved; recovery owes it.
	if s.gateway != nil && s.gateway.IsOnline(machineID) && launch.State == LaunchStateReserved {
		// Best-effort. A failed send leaves the launch reserved. This method
		// still returns the launch: the reservation is the durable wake.
		// The dispatcher does not call EnsureStartLaunch again while any
		// open launch exists, so the resend owner is RecoverPendingStarts.
		_ = s.sendStartDispatch(ctx, fresh, machineID, launch)
	}
	return launch, nil
}

func (s *Service) reserveLaunch(ctx context.Context, a *Agent, machineID string) (*Launch, *Agent, error) {
	return s.reserveLaunchTx(ctx, a, machineID, false)
}

// reserveLaunchForRestart is the manual-Start form (stopped agents may be
// restarted by an explicit human action).
func (s *Service) reserveLaunchForRestart(ctx context.Context, a *Agent, machineID string) (*Launch, *Agent, error) {
	return s.reserveLaunchTx(ctx, a, machineID, true)
}

func (s *Service) reserveLaunchTx(ctx context.Context, a *Agent, machineID string, allowStopped bool) (*Launch, *Agent, error) {
	reserve := s.launches.ReserveStartLaunchTx
	if allowStopped {
		reserve = s.launches.ReserveStartLaunchRestartTx
	}
	var launch *Launch
	var fresh *Agent
	err := s.store.withTx(ctx, func(tx *sql.Tx) error {
		reserved, reloaded, err := reserve(ctx, tx, a.WorkspaceID, a.ID, machineID)
		if err != nil {
			return err
		}
		launch = reserved
		fresh = reloaded
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return launch, fresh, nil
}

// sendStartDispatch sends agent:start for a reserved launch and records the
// dispatch. An already-acked or superseded launch keeps its state (the CAS
// in MarkStartDispatched refuses), which is exactly the fence we want.
func (s *Service) sendStartDispatch(ctx context.Context, a *Agent, machineID string, launch *Launch) error {
	if a == nil || launch == nil {
		return errf(409, "machine_changed", "Agent is no longer bound to this machine")
	}
	machine, err := s.store.GetMachine(ctx, a.WorkspaceID, machineID)
	if err != nil || machine == nil {
		if err == nil {
			err = errf(409, "machine_changed", "Machine no longer exists")
		}
		s.logger.Warn("start dispatch could not load machine", "agent_id", a.ID,
			"machine_id", machineID, "error", err.Error())
		return err
	}
	name, description, hostname, osName, daemonVersion := machineFields(machine)
	command := NewStartDispatchCommand(a, s.serverURL, name, description, hostname, osName,
		daemonVersion, launch.ID, launch.StartDispatchID)
	if err := s.gateway.Send(ctx, machineID, command); err != nil {
		s.logger.Warn("start dispatch send failed; intent stays reserved", "agent_id", a.ID,
			"machine_id", machineID, "start_dispatch_id", launch.StartDispatchID,
			"launch_id", launch.ID, "error", err.Error())
		return err
	}
	if err := s.launches.RecordStartDispatch(ctx, launch.ID); err != nil {
		// The daemon already has this dispatch id. Leaving the row reserved
		// makes the next Start or RecoverPendingStarts resend the same id.
		// Do not fail the caller: the frame was queued.
		if domain := AsError(err); domain == nil {
			s.logger.Warn("start dispatch state update failed", "agent_id", a.ID,
				"launch_id", launch.ID, "error", err.Error())
		}
	}
	return nil
}

// RecoverPendingStarts re-sends the machine's unconfirmed start dispatches —
// the offline wake/recovery path. Called from OnReady (machine reconnected)
// and the parent's startup scan (server restarted). Every resend carries the
// ORIGINAL launchId and startDispatchId, so the daemon's start coordinator
// deduplicates instead of launching twice. Agents that were stopped, deleted
// or moved off this machine are skipped: a stale reservation is abandoned,
// never resurrected.
func (s *Service) RecoverPendingStarts(ctx context.Context, machineID string) error {
	if s.launches == nil || s.gateway == nil || machineID == "" {
		return nil
	}
	pending, err := s.launches.ListUnconfirmedStartDispatches(ctx, machineID)
	if err != nil {
		return err
	}
	for _, launch := range pending {
		if launch.State != LaunchStateReserved && launch.State != LaunchStateDispatched {
			continue
		}
		// Backoff throttle: a dispatched-but-unacked launch is resent at most
		// once per StartResendBackoff window, so periodic scans never spin
		// duplicate starts at the daemon (which dedups by dispatch id, but
		// the server must not rely on that as a flood excuse).
		if launch.State == LaunchStateDispatched && launch.LastDispatchAt.Valid &&
			s.launches.now()-launch.LastDispatchAt.Int64 < StartResendBackoffMS {
			continue
		}
		agent, err := s.store.GetAgent(ctx, launch.AgentID, false)
		if err != nil {
			return err
		}
		if agent == nil || agent.WorkspaceID != launch.WorkspaceID ||
			!agent.MachineID.Valid || agent.MachineID.String != machineID ||
			agent.Status == StatusStopped {
			// Only retire the sampled launch. This batch may predate a
			// machine move and a new reservation: cancelling every launch
			// of the Agent here would let the old machine kill the new
			// generation. The per-ID CAS also preserves a launch already
			// superseded by the move itself.
			if err := s.launches.withTx(ctx, func(tx *sql.Tx) error {
				return s.launches.terminateTx(ctx, tx, launch, LaunchStateCancelled, "binding_lost")
			}); err != nil {
				return err
			}
			continue
		}
		if !s.gateway.IsOnline(machineID) {
			return nil
		}
		_ = s.sendStartDispatch(ctx, agent, machineID, launch)
	}
	return nil
}

// StartResendBackoffMS is the minimum spacing between resend attempts of the
// same unconfirmed start dispatch (design §6.3's base backoff, applied to
// the start channel; the delivery channel's budget lives in worker A).
const StartResendBackoffMS = int64(5000)

// DispatchDelivery is the controlled delivery entry: it queues one typed
// agent:deliver to the machine through the machine gateway. The gateway (the
// MACHINEWS hub) owns current-connection admission — machine slot guard,
// principal revalidation and the connection-generation fence all run inside
// hub.Send before the frame is queued, so a replaced or revoked connection
// can never receive it. Callers MUST NOT hold a database transaction or the
// authority fence when calling (lock order: slot -> fence/DB only).
func (s *Service) DispatchDelivery(ctx context.Context, machineID string, command DeliveryCommand) error {
	if s.gateway == nil {
		return errf(503, "machine_gateway_unavailable", "Machine transport is not available in this build")
	}
	return s.gateway.Send(ctx, machineID, command)
}

// CurrentLaunchIdentity answers "which launch, and which session identity,
// does this agent hold right now" — the delivery scheduler's identity gate.
// A launch with a start-ack but no session is NOT deliverable: queueState
// queued/starting/running is the daemon's queue projection, not a session
// (design §7.1). Nil means no active launch; SessionIdentity() nil means
// waiting_identity.
func (s *Service) CurrentLaunchIdentity(ctx context.Context, workspaceID, agentID string) (*Launch, error) {
	if s.launches == nil {
		return nil, ErrLaunchPersistenceUnavailable
	}
	return s.launches.CurrentLaunch(ctx, workspaceID, agentID)
}
