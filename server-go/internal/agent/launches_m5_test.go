package agent

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/platform/clock"
)

// newLaunchTestStore builds a store pair against a database migrated through
// 0014 (worker A's migration now ships in the embedded chain, so
// agent_launches exists — with its composite FKs to agents and machines).
func newLaunchTestStore(t *testing.T) (*sql.DB, *Store, *LaunchStore, *clock.Fixed) {
	t.Helper()
	handle, store, fixed := newTestStore(t)
	launches, err := NewLaunchStore(handle, fixed)
	if err != nil {
		t.Fatal(err)
	}
	return handle, store, launches, fixed
}

// seedLaunchTarget seeds one workspace, machine and bound agent so the
// agent_launches composite FKs (agents(id,workspace_id) and
// machines(id,workspace_id)) are satisfiable.
func seedLaunchTarget(t *testing.T, handle *sql.DB, agentID, machineID string) {
	t.Helper()
	seedIdentity(t, handle, "owner", "ws")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES (?, 'ws', 'owner', 'laptop', 1)`, machineID); err != nil {
		t.Fatal(err)
	}
	insertAgent(t, handle, agentID, "ws", "Ada", StatusActive, machineID, "owner")
}

// inLaunchTx runs fn in one short write transaction on the launch store and
// commits — mirroring how the service uses the Tx methods.
func inLaunchTx(t *testing.T, launches *LaunchStore, fn func(tx *sql.Tx) error) {
	t.Helper()
	err := launches.withTx(context.Background(), fn)
	if err != nil {
		t.Fatal(err)
	}
}

func TestReserveStartLaunchDedupesPerAgent(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	ctx := context.Background()
	var first, second *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		first = reserved
		_ = fresh
		return err
	})
	// A second caller in a NEW transaction (the batch-mention race) must get
	// the SAME launch and dispatch id: one daemon start, not N.
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh2, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		second = reserved
		_ = fresh2
		return err
	})
	if first.ID != second.ID || first.StartDispatchID != second.StartDispatchID {
		t.Fatalf("dedupe broke: %s/%s vs %s/%s", first.ID, first.StartDispatchID, second.ID, second.StartDispatchID)
	}
	var rows int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM agent_launches`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("duplicate launch rows: %d", rows)
	}
}

func TestReserveStartLaunchSupersedesOnMachineChange(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-2', 'ws', 'owner', 'desk', 2)`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var first *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		first = reserved
		_ = fresh
		return err
	})
	if _, err := handle.Exec(`UPDATE agents SET session_id = 'session-1' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}

	// The agent moves machines: the binding changes on the agent row, THEN a
	// reserve for the new machine supersedes the old launch. A reserve whose
	// machine argument disagrees with the live binding is refused outright
	// (the reservation never mints identity for moved facts).
	if _, err := handle.Exec(`UPDATE agents SET machine_id = 'machine-2' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		_, _, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		if AsError(err) == nil {
			t.Fatal("reserve for a machine the agent left was accepted")
		}
		return nil
	})
	var second *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh2, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-2")
		second = reserved
		_ = fresh2
		return err
	})
	if second.ID == first.ID || second.MachineID != "machine-2" {
		t.Fatalf("machine change did not mint a new launch: %+v", second)
	}
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		accepted, err := launches.AcceptSessionFrameTx(ctx, tx, "ws", "agent-1", "machine-1", first.ID)
		if err != nil {
			return err
		}
		if accepted {
			t.Fatal("late frame from a superseded launch accepted")
		}
		return nil
	})
	var state, code string
	if err := handle.QueryRow(`SELECT state, terminal_code FROM agent_launches WHERE id = ?`, first.ID).
		Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != LaunchStateSuperseded || code != "machine_changed" {
		t.Fatalf("old launch: state=%s code=%s", state, code)
	}
}

func TestStartAckIsReportedQueueStateNotSession(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	ctx := context.Background()
	var launch *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		launch = reserved
		_ = fresh
		return err
	})
	if err := launches.RecordStartDispatch(ctx, launch.ID); err != nil {
		t.Fatal(err)
	}

	// queued -> starting -> running: every state is a REPORTED queue fact.
	// NONE of them establishes a session — the daemon's start queue is not a
	// runtime session, and even a drained report is only a daemon-reported
	// receipt (agentProcessManager.ts:4361–4388 buffers during start and
	// ACKs before any model consumption).
	for _, queueState := range []string{"queued", "starting", "running"} {
		inLaunchTx(t, launches, func(tx *sql.Tx) error {
			applied, err := launches.ApplyStartAckTx(ctx, tx, "ws", "agent-1", "machine-1",
				launch.StartDispatchID, launch.ID, queueState)
			if err != nil {
				return err
			}
			if !applied {
				t.Fatalf("ack %s not applied", queueState)
			}
			return nil
		})
		current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
		if err != nil {
			t.Fatal(err)
		}
		if !current.QueueState.Valid || current.QueueState.String != queueState {
			t.Fatalf("reported queue state not stored: %+v", current.QueueState)
		}
		// The resume pointer and the per-launch binding both stay empty.
		// running is not a session.
		var session, confirmed sql.NullString
		if err := handle.QueryRow(`SELECT session_id FROM agents WHERE id = 'agent-1'`).Scan(&session); err != nil {
			t.Fatal(err)
		}
		if session.Valid {
			t.Fatalf("queueState %s fabricated a session", queueState)
		}
		if err := handle.QueryRow(`SELECT confirmed_session_id FROM agent_launches WHERE id = ?`, launch.ID).Scan(&confirmed); err != nil {
			t.Fatal(err)
		}
		if confirmed.Valid {
			t.Fatalf("queueState %s fabricated a launch binding", queueState)
		}
	}

	// A real session report still lands after the acks (agents.session_id).
	if _, err := handle.Exec(`UPDATE agents SET session_id = 'session-9' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if current.State != LaunchStateAcked {
		t.Fatalf("ack state lost: %s", current.State)
	}
}

func TestStartAckFencesWrongDispatchMachineAndLaunch(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	ctx := context.Background()
	var launch *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		launch = reserved
		_ = fresh
		return err
	})
	if err := launches.RecordStartDispatch(ctx, launch.ID); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, dispatch, launchID, machine string
	}{
		{"wrong dispatch id", "not-the-dispatch", launch.ID, "machine-1"},
		{"wrong launch id", launch.StartDispatchID, "other-launch", "machine-1"},
		{"wrong machine", launch.StartDispatchID, launch.ID, "machine-9"},
		{"unknown queue state", launch.StartDispatchID, launch.ID, "machine-1"},
	}
	// The last case's queueState is invalid, so use running for the rest.
	for i, tc := range cases {
		queueState := "running"
		if tc.name == "unknown queue state" {
			queueState = "drained-consumed"
		}
		applied := false
		inLaunchTx(t, launches, func(tx *sql.Tx) error {
			ok, err := launches.ApplyStartAckTx(ctx, tx, "ws", "agent-1", tc.machine, tc.dispatch, tc.launchID, queueState)
			applied = ok
			return err
		})
		if applied {
			t.Fatalf("case %d (%s): ack applied", i, tc.name)
		}
	}

	// A late ack for a terminated launch is refused by the CAS too.
	if _, err := launches.TerminateAgentLaunches(ctx, "ws", "agent-1", "",
		LaunchStateCancelled, "stopped"); err != nil {
		t.Fatal(err)
	}
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		applied, err := launches.ApplyStartAckTx(ctx, tx, "ws", "agent-1", "machine-1",
			launch.StartDispatchID, launch.ID, "rebound")
		if err != nil {
			return err
		}
		if applied {
			t.Fatal("ack applied to a terminated launch")
		}
		return nil
	})
}

func TestListUnconfirmedStartDispatchesRecoveryWindow(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-a", "machine-1")
	insertAgent(t, handle, "agent-b", "ws", "Bea", StatusActive, "machine-1", "owner")
	insertAgent(t, handle, "agent-c", "ws", "Cara", StatusActive, "machine-1", "owner")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-2', 'ws', 'owner', 'desk', 2)`); err != nil {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-d", "ws", "Dan", StatusActive, "machine-2", "owner")
	ctx := context.Background()
	reserve := func(agentID, machineID string) *Launch {
		var launch *Launch
		inLaunchTx(t, launches, func(tx *sql.Tx) error {
			reserved, freshRow, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", agentID, machineID)
			launch = reserved
			_ = freshRow
			return err
		})
		return launch
	}
	reserve("agent-a", "machine-1")               // stays reserved
	dispatched := reserve("agent-b", "machine-1") // sent, no ack
	acked := reserve("agent-c", "machine-1")      // acked -> confirmed
	reserve("agent-d", "machine-2")               // other machine
	if err := launches.RecordStartDispatch(ctx, dispatched.ID); err != nil {
		t.Fatal(err)
	}
	if err := launches.RecordStartDispatch(ctx, acked.ID); err != nil {
		t.Fatal(err)
	}
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		_, err := launches.ApplyStartAckTx(ctx, tx, "ws", "agent-c", "machine-1",
			acked.StartDispatchID, acked.ID, "running")
		return err
	})

	unconfirmed, err := launches.ListUnconfirmedStartDispatches(ctx, "machine-1")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, launch := range unconfirmed {
		seen[launch.AgentID] = true
	}
	if !seen["agent-a"] || !seen["agent-b"] {
		t.Fatalf("recovery window missed reserved/dispatched: %v", seen)
	}
	if seen["agent-c"] || seen["agent-d"] {
		t.Fatalf("recovery window too wide (acked or other machine): %v", seen)
	}
	if len(unconfirmed) != 2 {
		t.Fatalf("window size: %d", len(unconfirmed))
	}
}

func TestRecordStartDispatchCountsResendsAndRefusesTerminal(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	ctx := context.Background()
	var launch *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		launch = reserved
		_ = fresh
		return err
	})
	if err := launches.RecordStartDispatch(ctx, launch.ID); err != nil {
		t.Fatal(err)
	}
	// An offline-recovery resend of the SAME dispatch bumps the count — the
	// daemon dedups by dispatch id; the count makes that visible.
	if err := launches.RecordStartDispatch(ctx, launch.ID); err != nil {
		t.Fatal(err)
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if current.DispatchCount != 2 || current.State != LaunchStateDispatched {
		t.Fatalf("resend accounting: %+v", current)
	}
	if _, err := launches.TerminateAgentLaunches(ctx, "ws", "agent-1", "",
		LaunchStateSuperseded, "machine_changed"); err != nil {
		t.Fatal(err)
	}
	if err := launches.RecordStartDispatch(ctx, launch.ID); err == nil {
		t.Fatal("terminal launch resurrected by a resend")
	}
}

func TestStopTerminatesPersistentLaunches(t *testing.T) {
	handle, store, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	gateway := &recordingGateway{online: false}
	service := NewService(store, ServiceOptions{Gateway: gateway, Launches: launches})
	ctx := context.Background()
	var launch *Launch
	inLaunchTx(t, launches, func(tx *sql.Tx) error {
		reserved, fresh, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", "machine-1")
		launch = reserved
		_ = fresh
		return err
	})
	agent, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.StopInternal(ctx, agent); err != nil {
		t.Fatal(err)
	}
	var state, code string
	if err := handle.QueryRow(`SELECT state, terminal_code FROM agent_launches WHERE id = ?`, launch.ID).
		Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != LaunchStateCancelled || code != "stopped" {
		t.Fatalf("stop left the launch open: state=%s code=%s", state, code)
	}
}

func TestReserveStartLaunchRefusesStaleFacts(t *testing.T) {
	handle, _, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	ctx := context.Background()
	reserveErr := func(machineID string) error {
		var reserveErr error
		if err := launches.withTx(ctx, func(tx *sql.Tx) error {
			_, _, reserveErr = launches.ReserveStartLaunchTx(ctx, tx, "ws", "agent-1", machineID)
			return nil // a refused reservation wrote nothing; commit is a no-op
		}); err != nil {
			t.Fatalf("reserve probe infrastructure error: %v", err)
		}
		return reserveErr
	}

	// Machine argument disagrees with the live binding (moved).
	if err := reserveErr("machine-other"); AsError(err) == nil || AsError(err).Code != "machine_changed" {
		t.Fatalf("moved agent accepted: %v", err)
	}
	// Stopped agent.
	if _, err := handle.Exec(`UPDATE agents SET status = 'stopped' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if err := reserveErr("machine-1"); AsError(err) == nil || AsError(err).Code != "agent_stopped" {
		t.Fatalf("stopped agent accepted: %v", err)
	}
	// Deleted agent.
	if _, err := handle.Exec(`UPDATE agents SET status = 'active', deleted_at = 5 WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if err := reserveErr("machine-1"); AsError(err) != ErrAgentMissing {
		t.Fatalf("deleted agent accepted: %v", err)
	}
	// Deleted workspace.
	if _, err := handle.Exec(`UPDATE agents SET deleted_at = NULL WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 5 WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	if err := reserveErr("machine-1"); AsError(err) == nil || AsError(err).Code != "server_gone" {
		t.Fatalf("deleted workspace accepted: %v", err)
	}
}

func TestManualStartConvergesWithPersistentLaunches(t *testing.T) {
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, principal.MachineID, "owner")
	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", Launches: launches,
	})
	ctx := context.Background()
	agent, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	// The manual start went through the persistent path: one launch row in
	// dispatched state, one wire start carrying its identity, and the M3
	// status projection (dispatched => active).
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if current == nil || current.State != LaunchStateDispatched {
		t.Fatalf("manual start left no dispatched launch: %+v", current)
	}
	starts := 0
	for _, payload := range gateway.sent {
		if _, ok := payload.(StartDispatchCommand); ok {
			starts++
		}
	}
	if starts != 1 {
		t.Fatalf("manual start sent %d start frames", starts)
	}
	var command StartDispatchCommand
	for _, payload := range gateway.sent {
		if c, ok := payload.(StartDispatchCommand); ok {
			command = c
		}
	}
	if command.LaunchID != current.ID || command.StartDispatchID != current.StartDispatchID {
		t.Fatalf("manual start bypassed the launch fence identity: %+v", command)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("manual start status projection: %s", status)
	}

	// A stopped agent cannot be manually started back up through the stale
	// row: Stop terminated the launch, and Start on a stopped agent still
	// resets it per the M3 semantics (restartIfStopped) — verify the second
	// start reuses ONE converged path (new reservation, new dispatch id).
	if err := service.Stop(ctx, agent); err != nil {
		t.Fatal(err)
	}
	afterStop, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if afterStop != nil {
		t.Fatalf("stop left a live launch: %+v", afterStop)
	}
	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	relaunched, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if relaunched == nil || relaunched.ID == current.ID {
		t.Fatalf("restart did not converge on a fresh persistent launch: %+v", relaunched)
	}
	starts = 0
	for _, payload := range gateway.sent {
		if _, ok := payload.(StartDispatchCommand); ok {
			starts++
		}
	}
	if starts != 2 {
		t.Fatalf("restart sent %d start frames", starts)
	}
}
