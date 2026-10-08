package agent

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
)

func fastArgon() computer.Argon2Config {
	return computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1}
}

func attachProvedComputer(t *testing.T, handle *sql.DB, fixed *clock.Fixed, userID, workspaceID string) computer.Principal {
	t.Helper()
	cs, err := computer.NewStore(handle, computer.Options{
		Clock: fixed, DeviceCodePepper: []byte(testPepper), Argon: fastArgon(),
	})
	if err != nil {
		t.Fatal(err)
	}
	attached, err := cs.AttachComputer(context.Background(), userID, workspaceID, "Computer")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := cs.Authenticate(context.Background(), attached.APIKey)
	if err != nil || principal.CredentialRevision == "" {
		t.Fatalf("authenticate: %v revision %q", err, principal.CredentialRevision)
	}
	return principal
}

func TestOldComputerProofFailsAfterKeyRotation(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	cs, err := computer.NewStore(handle, computer.Options{
		Clock: fixed, DeviceCodePepper: []byte(testPepper), Argon: fastArgon(),
	})
	if err != nil {
		t.Fatal(err)
	}
	attached, err := cs.AttachComputer(context.Background(), "owner", "ws", "Computer")
	if err != nil {
		t.Fatal(err)
	}
	old, err := cs.Authenticate(context.Background(), attached.APIKey)
	if err != nil || old.CredentialRevision == "" {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, old.MachineID, "owner")
	service := NewService(store, ServiceOptions{})
	ctx := context.Background()

	apiKey, hash, prefix, err := computer.GenerateComputerKeyMaterial(fastArgon())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE computers SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?`, hash, prefix, old.ComputerID); err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, old, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("rotated-away proof wrote status: %s", status)
	}
	empty := old
	empty.CredentialRevision = ""
	if err := service.OnMessage(ctx, empty, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	current, err := cs.Authenticate(ctx, apiKey)
	if err != nil || current.CredentialRevision == old.CredentialRevision {
		t.Fatalf("new proof: %v", err)
	}
	if err := service.OnMessage(ctx, current, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusInactive {
		t.Fatalf("current proof status: %s", status)
	}
}

func TestOldLegacyMachineProofFailsAfterRotation(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	cs, err := computer.NewStore(handle, computer.Options{
		Clock: fixed, DeviceCodePepper: []byte(testPepper), Argon: fastArgon(),
	})
	if err != nil {
		t.Fatal(err)
	}
	registered, err := cs.RegisterMachine(context.Background(), "ws", "owner", "Legacy")
	if err != nil {
		t.Fatal(err)
	}
	old, err := cs.Authenticate(context.Background(), registered.APIKey)
	if err != nil || old.CredentialRevision == "" {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, old.MachineID, "owner")
	service := NewService(store, ServiceOptions{})
	ctx := context.Background()
	if err := service.OnMessage(ctx, old, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET status = ? WHERE id = 'agent-1'`, StatusActive); err != nil {
		t.Fatal(err)
	}
	next, err := cs.RotateMachineKey(ctx, "ws", old.MachineID, "owner", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, old, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("old machine proof wrote status: %s", status)
	}
	current, err := cs.Authenticate(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, current, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusInactive {
		t.Fatalf("rotated machine proof status: %s", status)
	}
}

func TestLaunchFenceRejectsStaleStatusAndSession(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	if _, err := handle.Exec(`UPDATE machines SET daemon_version = '0.30.1' WHERE id = ?`, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, principal.MachineID, "owner")
	gateway := &recordingGateway{online: true}
	service := NewService(store, ServiceOptions{Gateway: gateway, ServerURL: "http://127.0.0.1:8080"})
	loaded, err := store.GetAgent(context.Background(), "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Start(context.Background(), loaded); err != nil {
		t.Fatal(err)
	}
	if err := service.Start(context.Background(), loaded); err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 2 || gateway.sent[0].LaunchID == "" || gateway.sent[1].LaunchID == "" ||
		gateway.sent[0].LaunchID == gateway.sent[1].LaunchID {
		t.Fatalf("launch ids: %+v", gateway.sent)
	}
	oldID := gateway.sent[0].LaunchID
	currentID := gateway.sent[1].LaunchID
	ctx := context.Background()
	staleStatus := []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive","launchId":"` + oldID + `"}`)
	if err := service.OnMessage(ctx, principal, staleStatus); err != nil {
		t.Fatal(err)
	}
	staleSession := []byte(`{"type":"agent:session","agentId":"agent-1","sessionId":"old-session","launchId":"` + oldID + `"}`)
	if err := service.OnMessage(ctx, principal, staleSession); err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, principal, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	var status string
	var session sql.NullString
	if err := handle.QueryRow(`SELECT status, session_id FROM agents WHERE id = 'agent-1'`).Scan(&status, &session); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive || session.Valid {
		t.Fatalf("stale launch overwrote status=%s session=%v", status, session)
	}
	currentSession := []byte(`{"type":"agent:session","agentId":"agent-1","sessionId":"live-session","launchId":"` + currentID + `"}`)
	if err := service.OnMessage(ctx, principal, currentSession); err != nil {
		t.Fatal(err)
	}
	currentStatus := []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive","launchId":"` + currentID + `"}`)
	if err := service.OnMessage(ctx, principal, currentStatus); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status, session_id FROM agents WHERE id = 'agent-1'`).Scan(&status, &session); err != nil {
		t.Fatal(err)
	}
	if status != StatusInactive || session.String != "live-session" {
		t.Fatalf("current launch status=%s session=%s", status, session.String)
	}

	if _, err := handle.Exec(`UPDATE machines SET daemon_version = '0.30.0' WHERE id = ?`, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET status = ? WHERE id = 'agent-1'`, StatusInactive); err != nil {
		t.Fatal(err)
	}
	loaded, err = store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	before := len(gateway.sent)
	if err := service.Start(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	if gateway.sent[before].LaunchID != "" {
		t.Fatalf("old daemon armed a launch id: %s", gateway.sent[before].LaunchID)
	}
	if err := service.OnMessage(ctx, principal, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("legacy daemon cleared the existing fence; status=%s", status)
	}
}

func TestLegacyDaemonAcceptsStatusWithoutLaunchID(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	if _, err := handle.Exec(`UPDATE machines SET daemon_version = '0.30.0' WHERE id = ?`, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, principal.MachineID, "owner")
	gateway := &recordingGateway{online: true}
	service := NewService(store, ServiceOptions{Gateway: gateway, ServerURL: "http://127.0.0.1:8080"})
	loaded, err := store.GetAgent(context.Background(), "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Start(context.Background(), loaded); err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 1 || gateway.sent[0].LaunchID != "" {
		t.Fatalf("unguarded start: %+v", gateway.sent)
	}
	if err := service.OnMessage(context.Background(), principal, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusInactive {
		t.Fatalf("legacy status: %s", status)
	}
}
