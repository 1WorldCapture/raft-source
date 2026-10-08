package agent

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

const (
	runnerSecretSession = "session-RESUME-SECRET-do-not-leak-zzz"
	runnerSecretEnv     = "ENVVAR-SECRET-do-not-leak-qqq"
)

type runnerFixture struct {
	access   *RunnerAccess
	store    *Store
	db       *sql.DB
	clock    *clock.Fixed
	binding  RunnerBinding
	agentID  string
	otherID  string
	foreign  string
	machine  string
	otherMac string
}

func openRunnerFixture(t *testing.T) *runnerFixture {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 8, 0, 0, 0, time.UTC)}
	hasher, err := NewCredentialHasher([]byte("runner-access-pepper-0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	access, err := NewRunnerAccess(handle, RunnerAccessOptions{Clock: fixed, Hasher: hasher})
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(handle, StoreOptions{Clock: fixed, Hasher: hasher})
	f := &runnerFixture{access: access, store: store, db: handle, clock: fixed}
	f.seed(t)
	return f
}

func (f *runnerFixture) seed(t *testing.T) {
	t.Helper()
	now := f.clock.Now().UnixMilli()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.db.Exec(query, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, query)
		}
	}
	exec(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES ('owner', 'owner@example.test', 'owner', 'x', ?, ?)`, now, now)
	exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES
		('ws', 'WS', 'ws', 'owner', ?),
		('ws-b', 'WS B', 'ws-b', 'owner', ?)`, now, now)
	exec(`INSERT INTO machines (id, workspace_id, user_id, name, created_at) VALUES
		('mach', 'ws', 'owner', 'mach', ?),
		('mach-b', 'ws', 'owner', 'mach-b', ?),
		('mach-c', 'ws-b', 'owner', 'mach-c', ?)`, now, now, now)
	exec(`INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at)
		VALUES ('comp', 'ws', 'comp', 'owner', 'mach', ?),
		       ('comp-b', 'ws', 'comp-b', 'owner', 'mach-b', ?)`, now, now)
	env := `{"OPENAI_API_KEY":"` + runnerSecretEnv + `"}`
	exec(`INSERT INTO agents (
			id, workspace_id, name, status, runtime, model, machine_id, session_id, env_vars, created_at, updated_at
		) VALUES
		('agent', 'ws', 'RunnerBot', 'active', 'claude', 'opus', 'mach', ?, ?, ?, ?),
		('agent-b', 'ws', 'OtherMachineBot', 'active', 'claude', 'sonnet', 'mach-b', 'other-session', '{}', ?, ?),
		('agent-c', 'ws-b', 'ForeignBot', 'active', 'claude', 'sonnet', 'mach-c', ?, ?, ?, ?),
		('agent-dead', 'ws', 'DeadBot', 'inactive', 'claude', 'sonnet', 'mach', ?, ?, ?, ?)`,
		runnerSecretSession, env, now, now,
		now, now,
		runnerSecretSession, env, now, now,
		runnerSecretSession, env, now, now)
	exec(`UPDATE agents SET deleted_at = ? WHERE id = 'agent-dead'`, now)
	f.binding = f.authenticatedBinding(t, "comp", "mach")
	f.agentID = "agent"
	f.otherID = "agent-b"
	f.foreign = "agent-c"
	f.machine = "mach"
	f.otherMac = "mach-b"
}

// Prove every fixture principal through the real authenticator. Tests do
// not synthesize a revision or bypass the production write-time guard.
func (f *runnerFixture) authenticatedBinding(t *testing.T, computerID, machineID string) RunnerBinding {
	t.Helper()
	cfg := computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1}
	var key, hash, prefix string
	var err error
	legacy := computerID == ""
	if legacy {
		key, hash, prefix, _, err = computer.GenerateMachineKeyMaterial(cfg)
	} else {
		key, hash, prefix, err = computer.GenerateComputerKeyMaterial(cfg)
	}
	if err != nil {
		t.Fatal(err)
	}
	if legacy {
		_, err = f.db.Exec(`UPDATE machines SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?`, hash, prefix, machineID)
	} else {
		_, err = f.db.Exec(`UPDATE computers SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?`, hash, prefix, computerID)
	}
	if err != nil {
		t.Fatal(err)
	}
	store, err := computer.NewStore(f.db, computer.Options{
		Clock: f.clock, Argon: cfg, DeviceCodePepper: []byte("runner-computer-pepper-0123456789abcdef"),
	})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := store.Authenticate(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	return RunnerBinding{
		Principal: principal, ComputerID: computerID, MachineID: machineID,
		WorkspaceID: principal.WorkspaceID, LegacyMachine: legacy,
	}
}

func (f *runnerFixture) credentialCount(t *testing.T, agentID string) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_credentials WHERE agent_id = ?`, agentID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRunnerMintPersistsHashAndVerifies(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	minted, err := f.access.Mint(ctx, f.binding, f.agentID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if minted.AgentName != "RunnerBot" || minted.WorkspaceID != "ws" || minted.AgentID != f.agentID {
		t.Fatalf("mint identity: %+v", minted)
	}
	body := strings.TrimPrefix(minted.APIKey, "sk_agent_")
	if !IsAgentAPIKey(minted.APIKey) || len(body) != 64 {
		t.Fatalf("key format: %q", minted.APIKey)
	}
	if _, err := hex.DecodeString(body); err != nil {
		t.Fatal(err)
	}
	wantScopes, err := NormalizeRunnerScopes(nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(minted.Scopes, ",") != strings.Join(wantScopes, ",") {
		t.Fatalf("scopes = %v", minted.Scopes)
	}

	var hash, prefix, scopes string
	var name sql.NullString
	var createdBy sql.NullString
	var revoked sql.NullInt64
	var createdAt int64
	err = f.db.QueryRow(`
		SELECT api_key_hash, api_key_prefix, name, scopes, created_by_user_id, revoked_at, created_at
		FROM agent_credentials WHERE id = ?`, minted.CredentialID).
		Scan(&hash, &prefix, &name, &scopes, &createdBy, &revoked, &createdAt)
	if err != nil {
		t.Fatal(err)
	}
	if !f.access.hasher.Verify(minted.APIKey, hash) {
		t.Fatal("stored hash does not verify")
	}
	if prefix != APIKeyPrefix(minted.APIKey) || len(prefix) != 16 {
		t.Fatalf("prefix = %q", prefix)
	}
	if name.Valid || createdBy.Valid || revoked.Valid {
		t.Fatalf("name=%v createdBy=%v revoked=%v", name, createdBy, revoked)
	}
	if createdAt != f.clock.Now().UnixMilli() {
		t.Fatalf("created_at = %d", createdAt)
	}
	if strings.Contains(hash, minted.APIKey) || strings.Contains(scopes, minted.APIKey) {
		t.Fatal("raw key persisted")
	}
	var decoded []string
	if err := json.Unmarshal([]byte(scopes), &decoded); err != nil {
		t.Fatal(err)
	}
	if strings.Join(decoded, ",") != strings.Join(wantScopes, ",") {
		t.Fatalf("stored scopes = %s", scopes)
	}

	found, err := f.store.FindCredentialByAPIKey(ctx, minted.APIKey)
	if err != nil || found == nil || found.CredentialID != minted.CredentialID || found.WorkspaceID != "ws" {
		t.Fatalf("lookup = %+v %v", found, err)
	}

	// A second mint does not revoke the first.
	nameLabel := "runner:claude:agent"
	second, err := f.access.Mint(ctx, f.binding, f.agentID, []string{"read", "send", "read"}, &nameLabel)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(second.Scopes, ",") != "read,send" {
		t.Fatalf("normalized scopes = %v", second.Scopes)
	}
	if f.credentialCount(t, f.agentID) != 2 {
		t.Fatalf("count = %d", f.credentialCount(t, f.agentID))
	}
	still, err := f.store.FindCredentialByAPIKey(ctx, minted.APIKey)
	if err != nil || still == nil {
		t.Fatalf("first key revoked by second mint: %+v %v", still, err)
	}
	var storedName string
	if err := f.db.QueryRow(`SELECT name FROM agent_credentials WHERE id = ?`, second.CredentialID).Scan(&storedName); err != nil {
		t.Fatal(err)
	}
	if storedName != nameLabel {
		t.Fatalf("name = %q", storedName)
	}
}

func TestRunnerMintRejectsCrossMachineAndCrossSpace(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	for _, id := range []string{f.otherID, f.foreign, "missing", "agent-dead"} {
		_, err := f.access.Mint(ctx, f.binding, id, nil, nil)
		if AsError(err) != ErrRunnerAgentMissing {
			t.Fatalf("mint %s: %v", id, err)
		}
		if f.credentialCount(t, id) != 0 {
			t.Fatalf("credential row written for %s", id)
		}
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("cross-target mint wrote a credential")
	}
}

func TestRunnerMintRollsBackWhenBindingChanges(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()

	f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE agents SET machine_id = ? WHERE id = ?`, f.otherMac, f.agentID)
		return err
	}
	if _, err := f.access.Mint(ctx, f.binding, f.agentID, nil, nil); AsError(err) != ErrRunnerAgentMissing {
		t.Fatalf("reassignment: %v", err)
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("reassignment committed a credential")
	}

	f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE computers SET revoked_at = ? WHERE id = 'comp'`, f.clock.Now().UnixMilli())
		return err
	}
	if _, err := f.access.Mint(ctx, f.binding, f.agentID, nil, nil); AsError(err) != ErrRunnerComputerDenied {
		t.Fatalf("revocation: %v", err)
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("revoked computer committed a credential")
	}

	// Put the agent back; the revoke above only set computers.revoked_at
	// inside a rolled-back transaction, so the computer row is still live.
	if _, err := f.db.Exec(`UPDATE agents SET machine_id = ? WHERE id = ?`, f.machine, f.agentID); err != nil {
		t.Fatal(err)
	}
	f.access.beforeGuard = nil
	f.access.beforeCommit = func(context.Context, *sql.Tx) error {
		return errors.New("boom")
	}
	if _, err := f.access.Mint(ctx, f.binding, f.agentID, nil, nil); err == nil || err.Error() != "boom" {
		t.Fatalf("commit hook: %v", err)
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("failed commit left a credential row")
	}
}

func TestRunnerRevokeIsScopedAndRollsBack(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	minted, err := f.access.Mint(ctx, f.binding, f.agentID, []string{"read"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.access.Mint(ctx, f.authenticatedBinding(t, "comp-b", "mach-b"), f.otherID, []string{"read"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := f.access.Revoke(ctx, f.binding, f.otherID, other.CredentialID); AsError(err) != ErrRunnerAgentMissing {
		t.Fatalf("cross-machine revoke: %v", err)
	}
	if err := f.access.Revoke(ctx, f.binding, f.agentID, other.CredentialID); AsError(err) != ErrRunnerCredentialMissing {
		t.Fatalf("wrong credential: %v", err)
	}
	still, err := f.store.FindCredentialByAPIKey(ctx, other.APIKey)
	if err != nil || still == nil {
		t.Fatal("cross-machine revoke changed the other credential")
	}

	f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE agents SET machine_id = ? WHERE id = ?`, f.otherMac, f.agentID)
		return err
	}
	if err := f.access.Revoke(ctx, f.binding, f.agentID, minted.CredentialID); AsError(err) != ErrRunnerAgentMissing {
		t.Fatalf("reassignment revoke: %v", err)
	}
	f.access.beforeGuard = nil
	if _, err := f.db.Exec(`UPDATE agents SET machine_id = ? WHERE id = ?`, f.machine, f.agentID); err != nil {
		t.Fatal(err)
	}
	live, err := f.store.FindCredentialByAPIKey(ctx, minted.APIKey)
	if err != nil || live == nil {
		t.Fatal("reassignment revoke committed")
	}

	f.access.beforeCommit = func(context.Context, *sql.Tx) error { return errors.New("boom") }
	if err := f.access.Revoke(ctx, f.binding, f.agentID, minted.CredentialID); err == nil || err.Error() != "boom" {
		t.Fatalf("revoke commit hook: %v", err)
	}
	f.access.beforeCommit = nil
	var revoked sql.NullInt64
	if err := f.db.QueryRow(`SELECT revoked_at FROM agent_credentials WHERE id = ?`, minted.CredentialID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid {
		t.Fatal("rolled-back revoke persisted revoked_at")
	}

	f.clock.Advance(time.Second)
	if err := f.access.Revoke(ctx, f.binding, f.agentID, minted.CredentialID); err != nil {
		t.Fatal(err)
	}
	var reason string
	var revokedAt int64
	if err := f.db.QueryRow(`SELECT revoked_at, revoked_reason FROM agent_credentials WHERE id = ?`, minted.CredentialID).
		Scan(&revokedAt, &reason); err != nil {
		t.Fatal(err)
	}
	if reason != RunnerRevokeReason || revokedAt != f.clock.Now().UnixMilli() {
		t.Fatalf("revoke row at=%d reason=%q", revokedAt, reason)
	}
	if err := f.access.Revoke(ctx, f.binding, f.agentID, minted.CredentialID); err != nil {
		t.Fatal(err)
	}
	var reasonAgain string
	if err := f.db.QueryRow(`SELECT revoked_reason FROM agent_credentials WHERE id = ?`, minted.CredentialID).Scan(&reasonAgain); err != nil {
		t.Fatal(err)
	}
	if reasonAgain != RunnerRevokeReason {
		t.Fatalf("second revoke rewrote reason %q", reasonAgain)
	}
	gone, err := f.store.FindCredentialByAPIKey(ctx, minted.APIKey)
	if err != nil || gone != nil {
		t.Fatalf("revoked key still authenticates: %+v %v", gone, err)
	}
	// The other machine's credential is untouched.
	kept, err := f.store.FindCredentialByAPIKey(ctx, other.APIKey)
	if err != nil || kept == nil {
		t.Fatal("other credential was revoked")
	}
}

func TestRunnerListProjectsWhitelistOnly(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	rows, err := f.access.List(ctx, f.binding, "")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, runnerSecretSession) || strings.Contains(text, runnerSecretEnv) || strings.Contains(text, "sessionId") || strings.Contains(text, "envVars") {
		t.Fatalf("list leaked secrets: %s", text)
	}
	if len(rows) != 1 || rows[0].AgentID != f.agentID || rows[0].Name != "RunnerBot" || rows[0].Model != "opus" || rows[0].Runtime != "claude" || rows[0].Status != "active" {
		t.Fatalf("machine list = %+v", rows)
	}
	wide, err := f.access.List(ctx, f.binding, "server")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, row := range wide {
		ids[row.AgentID] = true
	}
	if !ids[f.agentID] || !ids[f.otherID] || ids[f.foreign] || ids["agent-dead"] {
		t.Fatalf("server list ids = %v", ids)
	}
	if _, err := f.access.List(ctx, f.binding, "all"); AsError(err) != ErrRunnerInvalidScope {
		t.Fatalf("scope: %v", err)
	}

	f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE computers SET revoked_at = 1 WHERE id = 'comp'`)
		return err
	}
	if _, err := f.access.List(ctx, f.binding, "server"); AsError(err) != ErrRunnerComputerDenied {
		t.Fatalf("revoked list: %v", err)
	}
}

func TestRunnerScopeAndNameCodes(t *testing.T) {
	if _, err := NormalizeRunnerScopes([]string{}); AsError(err) != ErrRunnerScopesEmpty {
		t.Fatal(err)
	}
	if _, err := NormalizeRunnerScopes([]string{"read", "bogus"}); AsError(err) != ErrRunnerScopesValue {
		t.Fatal(err)
	}
	if AsError(errRunnerName("")) != ErrRunnerNameInvalid {
		t.Fatal("empty name")
	}
	long := strings.Repeat("a", 201)
	if AsError(ValidateRunnerName(&long)) != ErrRunnerNameInvalid {
		t.Fatal("long name")
	}
	ok := strings.Repeat("a", 200)
	if err := ValidateRunnerName(&ok); err != nil {
		t.Fatal(err)
	}
}

func errRunnerName(s string) error { return ValidateRunnerName(&s) }

func TestRunnerLegacyAliasReassignmentGuard(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	legacy := f.authenticatedBinding(t, "", "mach")
	f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE machines SET legacy_key_migrated_at = 1 WHERE id = 'mach'`)
		return err
	}
	if _, err := f.access.Mint(ctx, legacy, f.agentID, []string{"read"}, nil); AsError(err) != ErrRunnerLegacyMigrated {
		t.Fatalf("migrated alias: %v", err)
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("migrated alias committed a credential")
	}
}
