package agent

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

const testPepper = "agent-test-pepper-0123456789abcdef"

func newTestStore(t *testing.T) (*sql.DB, *Store, *clock.Fixed) {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	hasher, err := NewCredentialHasher([]byte(testPepper))
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(handle, StoreOptions{Clock: fixed, Hasher: hasher, SelfHostedRunnerEnabled: true})
	return handle, store, fixed
}

func seedIdentity(t *testing.T, handle *sql.DB, userID, workspaceID string) {
	t.Helper()
	now := int64(1_700_000_000_000)
	if _, err := handle.Exec(`
		INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, ?, ?)`,
		userID, userID+"@example.test", userID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		workspaceID, "Workspace", workspaceID, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, 'owner', 0, ?)`, workspaceID, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, contract_version)
		VALUES (?, ?, 'in_progress', 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

func seedMachine(t *testing.T, handle *sql.DB, workspaceID, userID, machineID, computerID string) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES (?, ?, ?, 'laptop', 1)`, machineID, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if computerID == "" {
		return
	}
	if _, err := handle.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at)
		VALUES (?, ?, 'laptop', ?, ?, 1)`, computerID, workspaceID, userID, machineID); err != nil {
		t.Fatal(err)
	}
}

func insertAgent(t *testing.T, handle *sql.DB, id, workspaceID, name, status, machineID, creator string) {
	t.Helper()
	var machine any
	if machineID != "" {
		machine = machineID
	}
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, machine_id,
			creator_type, creator_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'claude', ?, 'user', ?, 1, 1)`,
		id, workspaceID, name, name, status, machine, creator); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialRevocationRecheckedAfterArgon(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	user := "owner"
	minted, err := store.MintCredential(context.Background(), "agent-1", []string{"read"}, nil, &user)
	if err != nil {
		t.Fatal(err)
	}
	store.afterSlowSecret = func() {
		if _, err := handle.Exec(`UPDATE agent_credentials SET revoked_at = 99, revoked_reason = 'raced' WHERE id = ?`, minted.CredentialID); err != nil {
			t.Error(err)
		}
	}
	lookup, err := store.FindCredentialByAPIKey(context.Background(), minted.APIKey)
	if err != nil {
		t.Fatal(err)
	}
	if lookup != nil {
		t.Fatal("credential revoked during argon verified")
	}
}

func TestMintRechecksIssuerInsideWriteTransaction(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	user := "owner"
	store.afterSlowSecret = func() {
		if _, err := handle.Exec(`DELETE FROM workspace_member_setup WHERE user_id = ?`, user); err != nil {
			t.Error(err)
		}
		if _, err := handle.Exec(`DELETE FROM workspace_memberships WHERE user_id = ?`, user); err != nil {
			t.Error(err)
		}
	}
	if _, err := store.MintCredential(context.Background(), "agent-1", []string{"read"}, nil, &user); AsError(err) != ErrAgentMissing {
		t.Fatalf("mint after issuer lost membership: %v", err)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM agent_credentials`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("credential row committed without a live issuer: %d", count)
	}
}

func TestSlowSecretDoesNotHoldWriteLock(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	user := "owner"
	store.afterSlowSecret = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		tx, err := handle.BeginTx(ctx, nil)
		if err != nil {
			t.Errorf("write lock held across hashing: %v", err)
			return
		}
		_ = tx.Rollback()
	}
	if _, err := store.MintCredential(context.Background(), "agent-1", []string{"read"}, nil, &user); err != nil {
		t.Fatal(err)
	}
}

func TestRevokeKeepsFirstTimestamp(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	user := "owner"
	minted, err := store.MintCredential(context.Background(), "agent-1", []string{"read"}, nil, &user)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := store.RevokeCredential(context.Background(), minted.CredentialID, "agent-1", "ws", "first", &user)
	if err != nil || !ok {
		t.Fatalf("first revoke: %v %v", ok, err)
	}
	fixed.Advance(time.Hour)
	ok, err = store.RevokeCredential(context.Background(), minted.CredentialID, "agent-1", "ws", "second", &user)
	if err != nil || !ok {
		t.Fatalf("repeat revoke: %v %v", ok, err)
	}
	var revokedAt int64
	var reason string
	if err := handle.QueryRow(`SELECT revoked_at, revoked_reason FROM agent_credentials WHERE id = ?`, minted.CredentialID).Scan(&revokedAt, &reason); err != nil {
		t.Fatal(err)
	}
	if revokedAt != fixed.T.Add(-time.Hour).UnixMilli() || reason != "first" {
		t.Fatalf("first revoke overwritten: at=%d reason=%s", revokedAt, reason)
	}
}

func TestShortCredentialPrefixDoesNotPanic(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	if _, err := handle.Exec(`
		INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, created_at)
		VALUES ('cred-short', 'agent-1', 'x', 'ab', '[]', 1)`); err != nil {
		t.Fatal(err)
	}
	rows, err := store.ListCredentials(context.Background(), "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].MaskedToken != "ab***" {
		t.Fatalf("masked token: %+v", rows)
	}
}

func TestBootstrapConsumeRaceLeavesOneLiveCredential(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, "", "owner")
	issued, err := store.IssueBootstrapToken(context.Background(), "agent-1", "ws", "owner", []string{"read"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := store.ConsumeBootstrapToken(context.Background(), issued.RawToken, nil, nil)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	var successes, consumed int
	for err := range errs {
		if err == nil {
			successes++
			continue
		}
		if AsError(err) == ErrTokenConsumed {
			consumed++
			continue
		}
		t.Fatalf("consume: %v", err)
	}
	if successes != 1 || consumed != 1 {
		t.Fatalf("successes=%d consumed=%d", successes, consumed)
	}
	var active int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM agent_credentials WHERE revoked_at IS NULL`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 1 {
		t.Fatalf("live credentials: %d", active)
	}
}

func TestCindyCheckpointSerializesWithSetupReset(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	seedMachine(t, handle, "ws", "owner", "machine-1", "computer-1")
	workspaces := workspace.NewStoreWithOptions(handle, workspace.Options{Clock: fixed})
	ctx := context.Background()
	status := "in_progress"

	stale := status
	if _, err := store.CreateAgent(ctx, CreateAgentInput{
		WorkspaceID: "ws", Name: "Cindy", Runtime: "claude", CreatorType: "user", CreatorID: "owner",
		Onboarding: true, ExpectedOwnerSetupStatus: &stale,
	}); err != nil {
		t.Fatal(err)
	}
	var pointer sql.NullString
	var setup string
	if err := handle.QueryRow(`
		SELECT w.onboarding_agent_id, s.status
		FROM workspaces w JOIN workspace_member_setup s ON s.workspace_id = w.id AND s.user_id = w.owner_id
		WHERE w.id = 'ws'`).Scan(&pointer, &setup); err != nil {
		t.Fatal(err)
	}
	if !pointer.Valid || pointer.String == "" || setup != "complete" {
		t.Fatalf("checkpoint pointer=%v setup=%s", pointer, setup)
	}
	if _, err := workspaces.ResetSetup(ctx, "ws", "owner"); workspace.AsDomainError(err) == nil || workspace.AsDomainError(err).Code != workspace.CodeServerAlreadySetUp {
		t.Fatalf("reset after cindy: %v", err)
	}
	var revoked sql.NullInt64
	if err := handle.QueryRow(`SELECT revoked_at FROM computers WHERE id = 'computer-1'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid {
		t.Fatal("reset revoked computers after the cindy checkpoint committed")
	}

	handle2, store2, fixed2 := newTestStore(t)
	seedIdentity(t, handle2, "owner", "ws")
	seedMachine(t, handle2, "ws", "owner", "machine-1", "computer-1")
	workspaces2 := workspace.NewStoreWithOptions(handle2, workspace.Options{Clock: fixed2})
	if _, err := workspaces2.ResetSetup(ctx, "ws", "owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := store2.CreateAgent(ctx, CreateAgentInput{
		WorkspaceID: "ws", Name: "Cindy", Runtime: "claude", CreatorType: "user", CreatorID: "owner",
		Onboarding: true, ExpectedOwnerSetupStatus: &status,
	}); AsError(err) != ErrSetupChangedRetry {
		t.Fatalf("create after reset: %v", err)
	}
	var agents int
	var pointer2 sql.NullString
	if err := handle2.QueryRow(`SELECT COUNT(*) FROM agents`).Scan(&agents); err != nil {
		t.Fatal(err)
	}
	if err := handle2.QueryRow(`SELECT onboarding_agent_id FROM workspaces WHERE id = 'ws'`).Scan(&pointer2); err != nil {
		t.Fatal(err)
	}
	if agents != 0 || pointer2.Valid {
		t.Fatalf("stale create committed agents=%d pointer=%v", agents, pointer2)
	}
}

func TestCindyCreateAndResetCannotBothCommit(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	workspaces := workspace.NewStoreWithOptions(handle, workspace.Options{Clock: fixed})
	status := "in_progress"
	start := make(chan struct{})
	var createErr, resetErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, createErr = store.CreateAgent(context.Background(), CreateAgentInput{
			WorkspaceID: "ws", Name: "Cindy", Runtime: "claude", CreatorType: "user", CreatorID: "owner",
			Onboarding: true, ExpectedOwnerSetupStatus: &status,
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		_, resetErr = workspaces.ResetSetup(context.Background(), "ws", "owner")
	}()
	close(start)
	wg.Wait()
	if createErr == nil && resetErr == nil {
		t.Fatal("cindy create and setup reset both committed")
	}
	var pointer sql.NullString
	if err := handle.QueryRow(`SELECT onboarding_agent_id FROM workspaces WHERE id = 'ws'`).Scan(&pointer); err != nil {
		t.Fatal(err)
	}
	if createErr == nil && !pointer.Valid {
		t.Fatal("create committed without the onboarding pointer")
	}
	if resetErr == nil && pointer.Valid {
		t.Fatal("reset committed while the onboarding pointer is set")
	}
}

type recordingGateway struct {
	online bool
	sent   []MachineCommand
}

func (g *recordingGateway) IsOnline(string) bool { return g.online }
func (g *recordingGateway) Send(_ context.Context, _ string, payload any) error {
	g.sent = append(g.sent, payload.(MachineCommand))
	return nil
}

func TestMachineCallbacksRecheckBinding(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusInactive, principal.MachineID, "owner")
	insertAgent(t, handle, "agent-stopped", "ws", "Bea", StatusStopped, principal.MachineID, "owner")
	gateway := &recordingGateway{online: true}
	service := NewService(store, ServiceOptions{Gateway: gateway, ServerURL: "http://127.0.0.1:8080"})
	ctx := context.Background()
	if err := service.OnReady(ctx, principal, []byte(`{"type":"ready","runningAgents":["agent-1","agent-stopped","other-agent"]}`)); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("ready status: %s", status)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-stopped'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusStopped {
		t.Fatalf("stopped agent promoted: %s", status)
	}
	if len(gateway.sent) != 1 || gateway.sent[0].Type != MachineCommandStop || gateway.sent[0].AgentID != "agent-stopped" {
		t.Fatalf("force-stop commands: %+v", gateway.sent)
	}

	if _, err := handle.Exec(`UPDATE computers SET revoked_at = 50 WHERE id = ?`, principal.ComputerID); err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, principal, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("revoked principal mutated status: %s", status)
	}
	if err := service.OnDisconnect(ctx, principal); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("disconnect changed status: %s", status)
	}

	if _, err := handle.Exec(`UPDATE computers SET revoked_at = NULL WHERE id = ?`, principal.ComputerID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-2', 'ws', 'owner', 'other', 2)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET machine_id = 'machine-2' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(ctx, principal, []byte(`{"type":"agent:status","agentId":"agent-1","status":"inactive"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-1'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("unbound machine mutated status: %s", status)
	}
	if err := service.OnMessage(ctx, principal, []byte(`{"type":"agent:activity","agentId":"agent-stopped","activity":"online"}`)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM agents WHERE id = 'agent-stopped'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusStopped {
		t.Fatalf("activity frame mutated status: %s", status)
	}
}

func TestPurgeResultRequiresLiveBinding(t *testing.T) {
	handle, store, fixed := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	if _, err := handle.Exec(`
		INSERT INTO machine_pending_agent_purges (machine_id, agent_id, created_at)
		VALUES (?, 'gone', 1)`, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	service := NewService(store, ServiceOptions{})
	if _, err := handle.Exec(`UPDATE computers SET revoked_at = 9 WHERE id = ?`, principal.ComputerID); err != nil {
		t.Fatal(err)
	}
	if err := service.OnMessage(context.Background(), principal, []byte(`{"type":"agent:purge:result","agentId":"gone","outcome":"purged"}`)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM machine_pending_agent_purges`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("revoked principal cleared purge intent: %d", count)
	}
}
