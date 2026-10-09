package agent

import (
	"context"
	"encoding/json"
	"testing"
)

func TestManagedDispatchFactsTxComposesPersistedFactsOnly(t *testing.T) {
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, principal.MachineID, "owner")
	insertAgent(t, handle, "agent-stopped", "ws", "Bea", StatusStopped, principal.MachineID, "owner")
	if _, err := handle.Exec(`INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, machine_id, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-ext', 'ws', 'Ext', 'Ext', 'active', 'external', NULL, 'user', 'owner', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{Gateway: gateway, Launches: launches})
	ctx := context.Background()

	// A live agent with no launch/session yet: identity incomplete, machine
	// bound, wire supported, reachability from the machines row projection.
	facts, err := service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if !facts.SupportsManagedWire || facts.MachineID != principal.MachineID {
		t.Fatalf("live facts: %+v", facts)
	}
	if facts.LaunchID != "" || facts.SessionID != "" {
		t.Fatalf("identity formed from nothing: %+v", facts)
	}
	if facts.Reachable {
		t.Fatalf("machines.last_status fabricated online: %+v", facts)
	}

	// The settled online projection drives Reachable (never a hub probe).
	if _, err := handle.Exec(`UPDATE machines SET last_status = 'online' WHERE id = ?`, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	facts, err = service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if !facts.Reachable {
		t.Fatalf("settled online projection ignored: %+v", facts)
	}

	// A reserved launch plus the resume pointer is NOT a dispatch pair.
	// SessionID stays empty until agent:session confirms this launch.
	agent, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET session_id = 'session-stale' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	facts, err = service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if facts.LaunchID != launch.ID || facts.SessionID != "" {
		t.Fatalf("resume pointer leased with the new launch: %+v", facts)
	}
	frame := `{"type":"agent:session","agentId":"agent-1","sessionId":"session-1","launchId":"` + launch.ID + `"}`
	if err := service.OnMessage(ctx, principal, json.RawMessage(frame)); err != nil {
		t.Fatal(err)
	}
	facts, err = service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if facts.LaunchID != launch.ID || facts.SessionID != "session-1" {
		t.Fatalf("confirmed identity pair not composed: %+v", facts)
	}
	launchID, sessionID, err := service.CurrentControlIdentity(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if launchID != facts.LaunchID || sessionID != facts.SessionID {
		t.Fatalf("control identity = %s/%s, facts = %s/%s", launchID, sessionID, facts.LaunchID, facts.SessionID)
	}

	// Stopped and external agents carry their honest flags.
	stopped, err := service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-stopped")
	if err != nil {
		t.Fatal(err)
	}
	if !stopped.Stopped {
		t.Fatalf("stopped flag: %+v", stopped)
	}
	external, err := service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-ext")
	if err != nil {
		t.Fatal(err)
	}
	if external.SupportsManagedWire || external.MachineID != "" {
		t.Fatalf("external facts: %+v", external)
	}

	// Deleted agent: empty facts (the scheduler's authorize step cancels).
	if _, err := handle.Exec(`UPDATE agents SET deleted_at = 9 WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	facts, err = service.ManagedDispatchFactsTx(ctx, store.db, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if facts.MachineID != "" || facts.SessionID != "" || facts.LaunchID != "" {
		t.Fatalf("deleted agent facts: %+v", facts)
	}
}
