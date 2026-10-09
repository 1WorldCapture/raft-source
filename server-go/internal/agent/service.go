// Domain service: lifecycle orchestration and the identity/bootstrap use
// cases the HTTP surfaces call. Machine commands flow only through the
// injected Gateway (the MACHINEWS hub); no SQLite transaction is ever held
// across a network write (the store commits first, dispatch follows).
package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
)

// Service wires the store to the machine gateway.
type Service struct {
	store             *Store
	gateway           Gateway
	serverURL         string
	deviceAuthEnabled bool
	logger            *slog.Logger

	// launches is the M5 persistent launch/start-dispatch store. Nil (the
	// pre-0014 build) keeps the exact M3 behavior: the in-memory fence in
	// launch_fence.go and no durable start facts. It is bound at
	// construction and never replaced.
	launches *LaunchStore

	launchMu sync.Mutex
	launchID map[string]string
}

// ServiceOptions injects the machine gateway (the MACHINEWS hub or a test
// double), the server URL embedded in agent:start configs, the frozen
// device-login gate, a logger and — for the M5 lifecycle paths — the
// persistent launch store. The gateway and launch store are fixed at
// assembly time.
type ServiceOptions struct {
	Gateway           Gateway
	ServerURL         string
	DeviceAuthEnabled bool
	Logger            *slog.Logger
	// Launches enables the M5 persistent startDispatch/launch paths. Nil
	// leaves M3 semantics untouched and makes the M5 entry points fail with
	// ErrLaunchPersistenceUnavailable instead of silently degrading.
	Launches *LaunchStore
}

// NewService builds the lifecycle service.
func NewService(store *Store, opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store:             store,
		gateway:           opts.Gateway,
		serverURL:         opts.ServerURL,
		deviceAuthEnabled: opts.DeviceAuthEnabled,
		logger:            logger,
		launches:          opts.Launches,
		launchID:          map[string]string{},
	}
}

// DeviceAuthEnabled reports the frozen sk_agent mint gate.
func (s *Service) DeviceAuthEnabled() bool { return s.deviceAuthEnabled }

// ResetMode values (TS AgentResetMode).
const (
	ResetModeRestart = "restart"
	ResetModeSession = "session"
	ResetModeFull    = "full"
)

// Start ports agentOrchestrator.startAgent for the manual route: validate,
// dispatch agent:start to the live machine, then persist active. The status
// write happens only after a successful dispatch, mirroring the TS order.
//
// M5 convergence: when the persistent launch store is wired, the manual
// start and the delivery-driven start share ONE path — the durable
// reservation in EnsureStartLaunch. There is no separate in-memory M5
// expectation competing with the M3 fence: the reserved launch IS the
// fence, the daemon-visible dispatch id is deduplicated by the reservation,
// and late lifecycle frames are fenced by the persisted launch. The M3
// in-memory fence remains only for pre-0014 builds (Launches == nil).
func (s *Service) Start(ctx context.Context, a *Agent) error {
	if IsExternalAgentRuntime(a.Runtime) {
		return errf(400, "", "External agents do not use Raft-managed runtime lifecycle")
	}
	if !a.MachineID.Valid || a.MachineID.String == "" {
		return errf(409, "machine_unassigned", "No machine assigned. Please assign a machine to this agent first.")
	}
	machineID := a.MachineID.String
	if s.gateway == nil {
		return errf(503, "machine_gateway_unavailable", "Machine transport is not available in this build")
	}
	if !s.gateway.IsOnline(machineID) {
		return errf(409, "machine_offline", "Machine offline. Please start your local daemon.")
	}
	if s.launches != nil {
		// One path with the delivery-driven start: reserve (live re-read
		// inside the transaction refuses stopped/moved/deleted agents),
		// dispatch first-time launches, then the same M3 status projection.
		launch, fresh, err := s.reserveLaunchForRestart(ctx, a, machineID)
		if err != nil {
			return err
		}
		if launch.State == LaunchStateReserved {
			// Same client-visible failure as the M3 path: a send that does
			// not land is daemon_timeout, and the agent is not marked active.
			// The reservation stays so a retry resends the same dispatch id.
			// RecoverPendingStarts still owes a resend for a non-stopped agent.
			if err := s.sendStartDispatch(ctx, fresh, machineID, launch); err != nil {
				return errf(504, "daemon_timeout", "Machine request timed out")
			}
		}
		return s.store.UpdateAgentStatus(ctx, a.ID, StatusActive, nil)
	}
	machine, err := s.store.GetMachine(ctx, a.WorkspaceID, machineID)
	if err != nil {
		return err
	}
	name, description, hostname, osName, daemonVersion := machineFields(machine)
	command := NewStartCommand(a, s.serverURL, name, description, hostname, osName, daemonVersion)
	// Arm the fence before Send so a delayed event from the previous launch
	// on this same connection cannot commit between the two starts.
	launchID := s.armLaunch(a.ID, stringOrEmpty(daemonVersion))
	command.LaunchID = launchID
	if err := s.gateway.Send(ctx, machineID, command); err != nil {
		s.rollbackLaunch(a.ID, launchID)
		return errf(504, "daemon_timeout", "Machine request timed out")
	}
	// The server-side start projection (TS reduceStartLifecycle): dispatched
	// means active. Runtime-reported state lands through later events.
	if err := s.store.UpdateAgentStatus(ctx, a.ID, StatusActive, nil); err != nil {
		return err
	}
	return nil
}

// Stop ports stopAgent(reason="manual"): the persisted projection applies
// even when the machine is unreachable (TS "applying lifecycle projection
// anyway"); the machine stop message is best-effort here.
func (s *Service) Stop(ctx context.Context, a *Agent) error {
	if IsExternalAgentRuntime(a.Runtime) {
		return errf(400, "", "External agents do not use Raft-managed runtime lifecycle")
	}
	if s.gateway != nil && a.MachineID.Valid && a.MachineID.String != "" {
		if err := s.gateway.Send(ctx, a.MachineID.String, NewStopCommand(a.ID)); err != nil {
			// Manual stop persists regardless; log the dispatch failure.
			s.logger.Warn("agent stop dispatch failed", "agent_id", a.ID,
				"machine_id", a.MachineID.String, "error", err.Error())
		}
	}
	// M5: a manual stop terminates the persistent launch identity too, so a
	// late daemon frame cannot extend a stopped agent's launch.
	if s.launches != nil {
		if _, err := s.launches.TerminateAgentLaunches(ctx, a.WorkspaceID, a.ID, "",
			LaunchStateCancelled, "stopped"); err != nil {
			return err
		}
	}
	return s.store.UpdateAgentStatus(ctx, a.ID, StatusStopped, nil)
}

// StopInternal is the internal-reason stop (reset/delete pre-step): the
// persisted projection is inactive, and the stopped guard keeps a manual
// stop intact. With the M5 launch store present, every active launch of the
// agent is superseded in the same step so a late daemon frame cannot extend
// a stopped agent's launch identity.
func (s *Service) StopInternal(ctx context.Context, a *Agent) error {
	if s.gateway != nil && a.MachineID.Valid && a.MachineID.String != "" {
		if err := s.gateway.Send(ctx, a.MachineID.String, NewStopCommand(a.ID)); err != nil {
			s.logger.Warn("agent internal stop dispatch failed", "agent_id", a.ID,
				"machine_id", a.MachineID.String, "error", err.Error())
		}
	}
	if s.launches != nil {
		if _, err := s.launches.TerminateAgentLaunches(ctx, a.WorkspaceID, a.ID, "",
			LaunchStateCancelled, "stopped"); err != nil {
			return err
		}
	}
	return s.store.UpdateAgentStatus(ctx, a.ID, StatusInactive, nil)
}

// Reset ports resetAgent/planResetActions. POST /reset restarts even a
// manually stopped agent (TS restartIfStopped defaults true).
func (s *Service) Reset(ctx context.Context, a *Agent, mode string) error {
	return s.reset(ctx, a, mode, true)
}

// ResetForSettings is the PATCH restartMode path: a manually stopped agent
// stays stopped (TS restartIfStopped: false). Active and inactive agents
// still receive the real restart commands.
func (s *Service) ResetForSettings(ctx context.Context, a *Agent, mode string) error {
	return s.reset(ctx, a, mode, false)
}

func (s *Service) reset(ctx context.Context, a *Agent, mode string, restartIfStopped bool) error {
	if IsExternalAgentRuntime(a.Runtime) {
		return errf(400, "", "External agents do not use Raft-managed runtime lifecycle")
	}
	if mode != ResetModeRestart && mode != ResetModeSession && mode != ResetModeFull {
		return errf(400, "", "Invalid reset mode: "+mode)
	}
	previous := a.Status
	if err := s.StopInternal(ctx, a); err != nil {
		return err
	}
	if mode == ResetModeSession || mode == ResetModeFull {
		s.clearLaunch(a.ID)
		if err := s.store.ResetAgentSession(ctx, a.ID); err != nil {
			return err
		}
	}
	if mode == ResetModeFull && a.MachineID.Valid && a.MachineID.String != "" && s.gateway != nil {
		if err := s.gateway.Send(ctx, a.MachineID.String, NewResetWorkspaceCommand(a.ID)); err != nil {
			s.logger.Warn("agent workspace reset dispatch failed", "agent_id", a.ID,
				"machine_id", a.MachineID.String, "error", err.Error())
		}
	}
	shouldRestart := previous != StatusStopped || restartIfStopped
	if !shouldRestart {
		return nil
	}
	if err := s.Start(ctx, a); err != nil {
		domain := AsError(err)
		if domain != nil && (domain == ErrAgentMissing || domain.Status == 404) {
			return err
		}
		// machine_unassigned / offline / timeout: the reset stands, the agent
		// stays offline — exactly the TS tolerance.
		s.logger.Warn("agent restart after reset did not dispatch", "agent_id", a.ID,
			"mode", mode, "error", err.Error())
	}
	return nil
}

// Delete ports the route's delete sequence: bounded internal stop, the
// transactional soft delete (with credential revocation and the durable
// purge intent), then the immediate best-effort purge dispatch.
func (s *Service) Delete(ctx context.Context, workspaceID string, a *Agent) error {
	if !IsExternalAgentRuntime(a.Runtime) {
		if err := s.StopInternal(ctx, a); err != nil {
			domain := AsError(err)
			if domain == nil || domain != ErrAgentMissing {
				return err
			}
		}
	}
	if err := s.store.DeleteAgent(ctx, workspaceID, a.ID); err != nil {
		return err
	}
	if a.MachineID.Valid && a.MachineID.String != "" && s.gateway != nil {
		if err := s.gateway.Send(ctx, a.MachineID.String, NewPurgeCommand(a.ID)); err != nil {
			s.logger.Warn("agent purge dispatch failed; intent stays queued", "agent_id", a.ID,
				"machine_id", a.MachineID.String, "error", err.Error())
		}
	}
	return nil
}

// DispatchPendingPurges sends queued purge intents for a machine. The
// MACHINEWS ready-callback (parent wiring) calls this on reconnect.
func (s *Service) DispatchPendingPurges(ctx context.Context, machineID string) error {
	if s.gateway == nil {
		return nil
	}
	pending, err := s.store.ListPendingPurges(ctx, machineID)
	if err != nil {
		return err
	}
	for _, purge := range pending {
		outcome := "dispatched"
		if err := s.gateway.Send(ctx, machineID, NewPurgeCommand(purge.AgentID)); err != nil {
			outcome = "dispatch_failed"
		}
		if err := s.store.RecordPurgeAttempt(ctx, machineID, purge.AgentID, outcome); err != nil {
			return err
		}
	}
	return nil
}

// ApplyPurgeResult records a daemon's terminal purge outcome. refused_running
// keeps the intent (retried on the next reconnect); terminal outcomes clear it.
func (s *Service) ApplyPurgeResult(ctx context.Context, machineID, agentID, outcome string) error {
	switch outcome {
	case "purged", "nothing_to_purge":
		return s.store.ClearPendingPurge(ctx, machineID, agentID)
	case "refused_running":
		return s.store.RecordPurgeAttempt(ctx, machineID, agentID, outcome)
	default:
		return fmt.Errorf("unknown purge outcome: %s", outcome)
	}
}

// machineFields projects the machine row into the runtime-context values
// (nil machine yields all-null pointers, like a missing machine in TS).
func machineFields(m *Machine) (name, description, hostname, osName, daemonVersion *string) {
	if m == nil {
		return nil, nil, nil, nil, nil
	}
	name = &m.Name
	description = nullString(m.Description)
	hostname = nullString(m.Hostname)
	osName = nullString(m.OS)
	daemonVersion = nullString(m.DaemonVer)
	return
}
