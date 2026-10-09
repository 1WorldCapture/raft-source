package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"raft.local/server-go/internal/computer"
)

// Stop keeps agents.session_id so the next agent:start can resume. That
// pointer must not become the dispatch session of the new launch before
// agent:session reports it for that launch.
func TestStopStartDoesNotLeasePreviousSession(t *testing.T) {
	handle, store, launches, service, gateway, principal := newFencedLifecycle(t)
	ctx := context.Background()
	agent := mustAgent(t, store, "agent-1")

	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	first := currentLaunch(t, launches)
	ackRunning(t, service, principal, first)
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != first.ID || facts.SessionID != "" {
		t.Fatalf("running ack opened dispatch identity: %+v", facts)
	}

	reportSession(t, service, principal, "agent-1", first.ID, "session-1")
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != first.ID || facts.SessionID != "session-1" {
		t.Fatalf("matching callback did not open dispatch: %+v", facts)
	}
	if launchID, sessionID, err := service.CurrentControlIdentity(ctx, "ws", "agent-1"); err != nil || launchID != first.ID || sessionID != "session-1" {
		t.Fatalf("control identity = %s/%s err=%v", launchID, sessionID, err)
	}

	if err := service.Stop(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if got := resumeSession(t, handle); got != "session-1" {
		t.Fatalf("stop destroyed the resume pointer: %q", got)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != "" || facts.SessionID != "" {
		t.Fatalf("stopped agent still dispatchable: %+v", facts)
	}
	if currentLaunch(t, launches) != nil {
		t.Fatal("stop left a current launch")
	}

	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	second := currentLaunch(t, launches)
	if second == nil || second.ID == first.ID {
		t.Fatalf("restart did not reserve a new launch: %+v", second)
	}
	if second.ConfirmedSessionID.Valid {
		t.Fatalf("new launch inherited a session: %+v", second.ConfirmedSessionID)
	}
	starts := startCommands(gateway.sent)
	if len(starts) < 2 {
		t.Fatalf("starts recorded: %d", len(starts))
	}
	resumed := starts[len(starts)-1]
	if resumed.LaunchID != second.ID {
		t.Fatalf("last start launch = %s, want %s", resumed.LaunchID, second.ID)
	}
	if resumed.Config == nil || resumed.Config.SessionID == nil || *resumed.Config.SessionID != "session-1" {
		t.Fatalf("resume session missing from agent:start: %+v", resumed.Config)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != second.ID || facts.SessionID != "" {
		t.Fatalf("pre-callback dispatch pair: %+v", facts)
	}
	if launchID, sessionID, err := service.CurrentControlIdentity(ctx, "ws", "agent-1"); err != nil || launchID != second.ID || sessionID != "" {
		t.Fatalf("control identity before callback = %s/%s err=%v", launchID, sessionID, err)
	}

	reportSession(t, service, principal, "agent-1", first.ID, "session-stale")
	if resumeSession(t, handle) != "session-1" {
		t.Fatal("stale callback overwrote the resume pointer")
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != second.ID || facts.SessionID != "" {
		t.Fatalf("stale callback opened dispatch: %+v", facts)
	}

	reportSession(t, service, principal, "agent-1", second.ID, "session-1")
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != second.ID || facts.SessionID != "session-1" {
		t.Fatalf("matching callback did not make the new generation eligible: %+v", facts)
	}
	if resumeSession(t, handle) != "session-1" {
		t.Fatal("confirmed report dropped the resume pointer")
	}
}

func TestAssignMachineDropsStaleGeneration(t *testing.T) {
	handle, store, launches, service, _, principal := newFencedLifecycle(t)
	ctx := context.Background()
	seedMachine(t, handle, "ws", "owner", "machine-2", "")
	if _, err := handle.Exec(`
		INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES ('ws-other', 'Other', 'ws-other', 'owner', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-other', 'ws-other', 'owner', 'other', 1)`); err != nil {
		t.Fatal(err)
	}
	agent := mustAgent(t, store, "agent-1")
	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	first := currentLaunch(t, launches)
	reportSession(t, service, principal, "agent-1", first.ID, "session-1")
	user := "owner"
	minted, err := store.MintCredential(ctx, "agent-1", []string{"read"}, nil, &user)
	if err != nil {
		t.Fatal(err)
	}

	same := principal.MachineID
	if err := store.AssignMachine(ctx, "ws", "agent-1", &same); err != nil {
		t.Fatal(err)
	}
	if got := currentLaunch(t, launches); got == nil || got.ID != first.ID || !got.ConfirmedSessionID.Valid || got.ConfirmedSessionID.String != "session-1" {
		t.Fatalf("same-machine assign dropped the current generation: %+v", got)
	}

	other := "machine-other"
	if err := store.AssignMachine(ctx, "ws", "agent-1", &other); AsError(err) == nil || AsError(err).Status != 400 {
		t.Fatalf("cross-workspace machine admitted: %v", err)
	}
	if got := currentLaunch(t, launches); got == nil || got.ID != first.ID {
		t.Fatalf("rejected assign changed the launch: %+v", got)
	}

	// A raw binding write is not assignment. Facts must still refuse the
	// launch that no longer shares the agent's machine. The open row remains
	// until AssignMachine reconciles it.
	if _, err := handle.Exec(`UPDATE agents SET machine_id = 'machine-2' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != "" || facts.SessionID != "" || facts.MachineID != "machine-2" {
		t.Fatalf("mismatched launch admitted: %+v", facts)
	}
	var open int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM agent_launches WHERE agent_id = 'agent-1' AND state IN ('reserved','dispatched','acked')`).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 1 {
		t.Fatalf("open launches after raw move: %d", open)
	}

	next := "machine-2"
	if err := store.AssignMachine(ctx, "ws", "agent-1", &next); err != nil {
		t.Fatal(err)
	}
	if currentLaunch(t, launches) != nil {
		t.Fatal("assign left a current launch on the new machine")
	}
	var state, code string
	if err := handle.QueryRow(`SELECT state, terminal_code FROM agent_launches WHERE id = ?`, first.ID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != LaunchStateSuperseded || code != "machine_changed" {
		t.Fatalf("old launch: state=%s code=%s", state, code)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != "" || facts.SessionID != "" || facts.MachineID != "machine-2" {
		t.Fatalf("moved agent still has a generation: %+v", facts)
	}
	if resumeSession(t, handle) != "session-1" {
		t.Fatal("move destroyed the resume pointer")
	}
	var revoked sql.NullInt64
	if err := handle.QueryRow(`SELECT revoked_at FROM agent_credentials WHERE id = ?`, minted.CredentialID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid {
		t.Fatal("move revoked the agent credential")
	}

	reportSession(t, service, principal, "agent-1", first.ID, "session-stale")
	ackRunning(t, service, principal, first)
	if resumeSession(t, handle) != "session-1" {
		t.Fatal("old machine credential overwrote the resume pointer")
	}
	var confirmed sql.NullString
	if err := handle.QueryRow(`SELECT confirmed_session_id FROM agent_launches WHERE id = ?`, first.ID).Scan(&confirmed); err != nil {
		t.Fatal(err)
	}
	if !confirmed.Valid || confirmed.String != "session-1" {
		t.Fatalf("stale callback rewrote the old binding: %+v", confirmed)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != "" || facts.SessionID != "" {
		t.Fatalf("stale machine admitted: %+v", facts)
	}

	moved := mustAgent(t, store, "agent-1")
	if !moved.MachineID.Valid || moved.MachineID.String != "machine-2" {
		t.Fatalf("agent machine: %+v", moved.MachineID)
	}
	launch, err := service.EnsureStartLaunch(ctx, moved)
	if err != nil {
		t.Fatal(err)
	}
	if launch.ID == first.ID || launch.MachineID != "machine-2" || launch.ConfirmedSessionID.Valid {
		t.Fatalf("new machine did not get a fresh launch: %+v", launch)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != launch.ID || facts.SessionID != "" || facts.MachineID != "machine-2" {
		t.Fatalf("fresh launch leased the old session: %+v", facts)
	}

	if err := store.AssignMachine(ctx, "ws", "agent-1", nil); err != nil {
		t.Fatal(err)
	}
	if resumeSession(t, handle) != "session-1" {
		t.Fatal("unbind destroyed the resume pointer")
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.MachineID != "" || facts.LaunchID != "" || facts.SessionID != "" {
		t.Fatalf("unbound agent still identified: %+v", facts)
	}
	external := "machine-2"
	if _, err := handle.Exec(`UPDATE agents SET runtime = 'external', machine_id = NULL WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if err := store.AssignMachine(ctx, "ws", "agent-1", &external); AsError(err) == nil || AsError(err).Status != 400 {
		t.Fatalf("external assign: %v", err)
	}
}

func TestAssignMachineRacesSessionCallback(t *testing.T) {
	handle, store, _, service, _, principal := newFencedLifecycle(t)
	ctx := context.Background()
	seedMachine(t, handle, "ws", "owner", "machine-2", "")
	next := "machine-2"
	home := principal.MachineID
	for i := 0; i < 20; i++ {
		if err := store.AssignMachine(ctx, "ws", "agent-1", &home); err != nil {
			t.Fatal(err)
		}
		agent := mustAgent(t, store, "agent-1")
		if err := service.Start(ctx, agent); err != nil {
			t.Fatal(err)
		}
		launch := currentLaunch(t, service.launches)
		if launch == nil || launch.MachineID != home {
			t.Fatalf("iter %d: no home launch: %+v", i, launch)
		}
		frame := json.RawMessage(`{"type":"agent:session","agentId":"agent-1","sessionId":"session-race","launchId":"` + launch.ID + `"}`)
		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_ = service.OnMessage(ctx, principal, frame)
		}()
		go func() {
			defer wg.Done()
			<-start
			_ = store.AssignMachine(ctx, "ws", "agent-1", &next)
		}()
		close(start)
		wg.Wait()

		var machine string
		if err := handle.QueryRow(`SELECT machine_id FROM agents WHERE id = 'agent-1'`).Scan(&machine); err != nil {
			t.Fatal(err)
		}
		if machine != next {
			t.Fatalf("iter %d: machine = %s", i, machine)
		}
		var open int
		if err := handle.QueryRow(`SELECT COUNT(*) FROM agent_launches WHERE agent_id = 'agent-1' AND state IN ('reserved','dispatched','acked')`).Scan(&open); err != nil {
			t.Fatal(err)
		}
		if open != 0 {
			t.Fatalf("iter %d: open launches survived the move: %d", i, open)
		}
		facts := mustFacts(t, service, "ws", "agent-1")
		if facts.LaunchID != "" || facts.SessionID != "" || facts.MachineID != next {
			t.Fatalf("iter %d: stale generation admitted: %+v", i, facts)
		}
		var confirmedOnOpen int
		if err := handle.QueryRow(`
			SELECT COUNT(*) FROM agent_launches
			WHERE agent_id = 'agent-1' AND state IN ('reserved','dispatched','acked')
			  AND confirmed_session_id IS NOT NULL`).Scan(&confirmedOnOpen); err != nil {
			t.Fatal(err)
		}
		if confirmedOnOpen != 0 {
			t.Fatalf("iter %d: open confirmed binding", i)
		}
	}
}

func TestManualStartSendFailureStaysReserved(t *testing.T) {
	handle, store, launches, service, gateway, _ := newFencedLifecycle(t)
	ctx := context.Background()
	if _, err := handle.Exec(`UPDATE agents SET session_id = 'session-resume', status = 'inactive' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	gateway.sendErr = errors.New("daemon unavailable")
	agent := mustAgent(t, store, "agent-1")
	err := service.Start(ctx, agent)
	domain := AsError(err)
	if domain == nil || domain.Status != 504 || domain.Code != "daemon_timeout" {
		t.Fatalf("start error: %v", err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusInactive {
		t.Fatalf("failed start marked the agent %s", status)
	}
	if resumeSession(t, handle) != "session-resume" {
		t.Fatal("failed start destroyed the resume pointer")
	}
	reserved := currentLaunch(t, launches)
	if reserved == nil || reserved.State != LaunchStateReserved || reserved.ConfirmedSessionID.Valid {
		t.Fatalf("failed start reservation: %+v", reserved)
	}
	if facts := mustFacts(t, service, "ws", "agent-1"); facts.LaunchID != reserved.ID || facts.SessionID != "" {
		t.Fatalf("failed start opened dispatch: %+v", facts)
	}

	gateway.sendErr = nil
	if err := service.Start(ctx, agent); err != nil {
		t.Fatal(err)
	}
	retried := currentLaunch(t, launches)
	if retried == nil || retried.ID != reserved.ID || retried.State != LaunchStateDispatched {
		t.Fatalf("retry did not reuse the reserved dispatch: %+v", retried)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("retried start status: %s", status)
	}
	starts := startCommands(gateway.sent)
	if len(starts) != 1 || starts[0].LaunchID != reserved.ID || starts[0].StartDispatchID != reserved.StartDispatchID {
		t.Fatalf("retry dispatch identity: %+v", starts)
	}
	if starts[0].Config == nil || starts[0].Config.SessionID == nil || *starts[0].Config.SessionID != "session-resume" {
		t.Fatalf("retry dropped resume: %+v", starts[0].Config)
	}
}

func newFencedLifecycle(t *testing.T) (*sql.DB, *Store, *LaunchStore, *Service, *anyGateway, computer.Principal) {
	t.Helper()
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, principal.MachineID, "owner")
	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", Launches: launches,
	})
	return handle, store, launches, service, gateway, principal
}

func mustAgent(t *testing.T, store *Store, id string) *Agent {
	t.Helper()
	agent, err := store.GetAgent(context.Background(), id, false)
	if err != nil || agent == nil {
		t.Fatalf("agent %s: %v", id, err)
	}
	return agent
}

func mustFacts(t *testing.T, service *Service, workspaceID, agentID string) ManagedDispatchFacts {
	t.Helper()
	facts, err := service.ManagedDispatchFactsTx(context.Background(), service.store.db, workspaceID, agentID)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}

func currentLaunch(t *testing.T, launches *LaunchStore) *Launch {
	t.Helper()
	launch, err := launches.CurrentLaunch(context.Background(), "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	return launch
}

func resumeSession(t *testing.T, handle *sql.DB) string {
	t.Helper()
	var session sql.NullString
	if err := handle.QueryRow(`SELECT session_id FROM agents WHERE id = 'agent-1'`).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if !session.Valid {
		return ""
	}
	return session.String
}

func reportSession(t *testing.T, service *Service, principal computer.Principal, agentID, launchID, sessionID string) {
	t.Helper()
	frame := `{"type":"agent:session","agentId":"` + agentID + `","sessionId":"` + sessionID + `","launchId":"` + launchID + `"}`
	if err := service.OnMessage(context.Background(), principal, json.RawMessage(frame)); err != nil {
		t.Fatal(err)
	}
}

func ackRunning(t *testing.T, service *Service, principal computer.Principal, launch *Launch) {
	t.Helper()
	frame := `{"type":"agent:start:ack","agentId":"agent-1","startDispatchId":"` +
		launch.StartDispatchID + `","launchId":"` + launch.ID + `","queueState":"running"}`
	if err := service.OnMessage(context.Background(), principal, json.RawMessage(frame)); err != nil {
		t.Fatal(err)
	}
}

func startCommands(sent []any) []StartDispatchCommand {
	var out []StartDispatchCommand
	for _, payload := range sent {
		if command, ok := payload.(StartDispatchCommand); ok {
			out = append(out, command)
		}
	}
	return out
}
