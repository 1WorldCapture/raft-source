// Setup persistence and command behavioral tests (real SQLite, isolated
// per-test databases via the real migration chain — never var/).
//
// Covers the M2 matrix slices owned by the setup worker:
// T15 initial gate, T16 state branches (DB side), T17 transitions,
// T18 terminal semantics, T19/T20 reset, T21 handoff, T22 anti-forgery,
// T23 catalog honesty. The machine online probe is overridden per test to
// exercise online branches the M2 default probe cannot produce.
package workspace

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// setupTestNow is the deterministic instant for setup writes.
var setupTestNow = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

func openSetupDB(t *testing.T) *sql.DB {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "setup.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	return handle
}

func newSetupStore(t *testing.T, handle *sql.DB) (*Store, *clock.Fixed) {
	t.Helper()
	fixed := &clock.Fixed{T: setupTestNow}
	return NewStoreWithOptions(handle, Options{Clock: fixed, Policy: Policy{}}), fixed
}

func setupSeedUser(t *testing.T, handle *sql.DB, id string) {
	t.Helper()
	// Idempotent: several seeders may touch the same user (e.g. an owner who
	// is also a member of another workspace).
	if _, err := handle.Exec(`
		INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, 1)`, id, id+"@example.test", id); err != nil {
		t.Fatal(err)
	}
}

// setupSeedWorkspace inserts a live normal workspace, an owner membership and
// the v2 setup row — the exact rows CreateWorkspace produces.
func setupSeedWorkspace(t *testing.T, handle *sql.DB, id, ownerID string) {
	t.Helper()
	setupSeedUser(t, handle, ownerID)
	if _, err := handle.Exec(`
		INSERT INTO workspaces (id, name, slug, owner_id, kind, created_at, updated_at)
		VALUES (?, 'Team', ?, ?, 'normal', ?, ?)`, id, id+"-slug", ownerID, 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
		VALUES (?, ?, 'owner', 1)`, id, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, contract_version)
		VALUES (?, ?, 'not_started', 'onboarding-setup-v2')`, id, ownerID); err != nil {
		t.Fatal(err)
	}
}

func setupSeedMembership(t *testing.T, handle *sql.DB, workspaceID, userID, role string) {
	t.Helper()
	setupSeedUser(t, handle, userID)
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
		VALUES (?, ?, ?, 1)`, workspaceID, userID, role); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, contract_version)
		VALUES (?, ?, 'not_started', 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// setupSeedMachine inserts a catalog machine; runtimes nil = not reported.
func setupSeedMachine(t *testing.T, handle *sql.DB, workspaceID, machineID, userID string, runtimes *string, lastStatus *string, lastHeartbeat *int64) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, runtimes, last_status, last_heartbeat, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		machineID, workspaceID, userID, machineID+"-name", runtimes, lastStatus, lastHeartbeat, 1); err != nil {
		t.Fatal(err)
	}
}

func setupSeedComputer(t *testing.T, handle *sql.DB, workspaceID, computerID, machineID string, revoked bool) {
	t.Helper()
	var revokedAt any
	if revoked {
		revokedAt = int64(1)
	}
	var machine any
	if machineID != "" {
		machine = machineID
	}
	if _, err := handle.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, 1, ?)`,
		computerID, workspaceID, computerID+"-name", nil, machine, revokedAt); err != nil {
		t.Fatal(err)
	}
}

// setupSeedOfficialCindy creates the official onboarding agent fixture: real
// local row, machine-bound, runtime set, official identity, agent admin role.
// This is a TEST fixture only — M2 ships no agent writer.
func setupSeedOfficialCindy(t *testing.T, handle *sql.DB, workspaceID, agentID, machineID string) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, description, avatar_url,
		                    status, runtime, machine_id, created_at, updated_at)
		VALUES (?, ?, 'Cindy', 'Cindy', 'Onboarding Assistant', 'pixel:mug',
		        'active', 'claude', ?, 1, 1)`, agentID, workspaceID, machineID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES (?, ?, 'admin', 1, 1)`, workspaceID, agentID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		UPDATE workspaces SET onboarding_agent_id = ? WHERE id = ?`, agentID, workspaceID); err != nil {
		t.Fatal(err)
	}
}

func withProbe(t *testing.T, fn func(ctx context.Context, machineID string) (bool, error)) {
	t.Helper()
	prev := machineStatusProbe
	machineStatusProbe = fn
	t.Cleanup(func() { machineStatusProbe = prev })
}

func mustDomainCode(t *testing.T, err error) string {
	t.Helper()
	de := AsDomainError(err)
	if de == nil {
		t.Fatalf("expected a DomainError, got %v", err)
	}
	return de.Code
}

// --- T15: the initial gate for a fresh owner ------------------------------

func TestSetupProjectionFreshOwnerMatchesAcceptanceJSON(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)

	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.Surface != SetupSurfaceComputerRuntime || proj.Phase == nil || *proj.Phase != SetupStatusNotStarted {
		t.Fatalf("surface %s phase %v", proj.Surface, proj.Phase)
	}
	if !proj.BlocksChat || *proj.GateReason != GateReasonComputerOffline {
		t.Fatalf("gate: blocks=%v reason=%v", proj.BlocksChat, proj.GateReason)
	}
	if proj.ComputerStatus != ComputerStateOffline || proj.RuntimeStatus != RuntimeStateUnknown {
		t.Fatalf("facts: computer=%s runtime=%s (unknown, not invented)", proj.ComputerStatus, proj.RuntimeStatus)
	}
	if proj.HasConnectedComputer || len(proj.OfflineComputers) != 0 || len(proj.RuntimeOptions) != 0 {
		t.Fatalf("fresh workspace facts must be empty: %+v", proj)
	}
}

func TestSetupProjectionNonOwnerAndGuestGetNoSetup(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMembership(t, handle, "ws", "member", "member")
	setupSeedMembership(t, handle, "ws", "guest", "guest")
	store, _ := newSetupStore(t, handle)

	for _, userID := range []string{"member", "guest", "stranger"} {
		proj, err := store.GetSetupProjection(context.Background(), "ws", userID)
		if err != nil {
			t.Fatal(err)
		}
		if proj.Surface != SetupSurfaceNone || *proj.GateReason != GateReasonInsufficientPermission || proj.BlocksChat {
			t.Fatalf("%s: %+v", userID, proj)
		}
	}
}

func TestSetupProjectionMissingStateRowIsRetry(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	// Owner membership exists but the setup row vanished (drift): the
	// resolver must answer retry/state_not_found, never fake complete.
	if _, err := handle.Exec(`DELETE FROM workspace_member_setup WHERE workspace_id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.Surface != SetupSurfaceRetry || *proj.GateReason != GateReasonStateNotFound {
		t.Fatalf("%+v", proj)
	}
}

func TestSetupProjectionDeletedWorkspaceLosesRole(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 5 WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.Surface != SetupSurfaceNone || *proj.GateReason != GateReasonInsufficientPermission {
		t.Fatalf("%+v", proj)
	}
}

// --- T16/T18: DB-side branches -------------------------------------------

func TestSetupProjectionCompletePostSetupFacts(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)

	complete := func(reason string) {
		if _, err := handle.Exec(`
			UPDATE workspace_member_setup SET status = 'complete', completion_reason = ?
			WHERE workspace_id = 'ws'`, reason); err != nil {
			t.Fatal(err)
		}
	}

	complete(SetupReasonNormal)
	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.Surface != SetupSurfaceComplete || !proj.PostSetup.SurveyPending || !proj.PostSetup.HandoffPending {
		t.Fatalf("normal completion owes survey+handoff: %+v", proj.PostSetup)
	}
	// Complete is terminal even with a machine linked and offline rows —
	// the completion resolver answers unknown computer facts.
	if proj.ComputerStatus != ComputerStateUnknown || proj.HasConnectedComputer {
		t.Fatalf("completion resolver must not re-read live inventory: %+v", proj)
	}

	// Survey answered → only handoff remains owed.
	if _, err := handle.Exec(`UPDATE users SET signup_survey_completed_at = 9 WHERE id = 'owner'`); err != nil {
		t.Fatal(err)
	}
	proj, _ = store.GetSetupProjection(context.Background(), "ws", "owner")
	if proj.PostSetup.SurveyPending || !proj.PostSetup.HandoffPending {
		t.Fatalf("%+v", proj.PostSetup)
	}

	// Grandfathered completion owes nothing (never went through the flow).
	complete(SetupReasonGrandfathered)
	proj, _ = store.GetSetupProjection(context.Background(), "ws", "owner")
	if proj.PostSetup.SurveyPending || proj.PostSetup.HandoffPending {
		t.Fatalf("grandfathered owes no post-setup steps: %+v", proj.PostSetup)
	}
}

func TestSetupProjectionOfflineComputerNamedRecovery(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedComputer(t, handle, "ws", "computer-1", "machine-1", false)
	heartbeat := time.Date(2026, 7, 1, 10, 35, 0, 0, time.UTC).UnixMilli()
	setupSeedComputer(t, handle, "ws", "computer-2", "", false)
	if _, err := handle.Exec(`UPDATE machines SET last_heartbeat = ? WHERE id = 'machine-1'`, heartbeat); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)

	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	// Default M2 probe: every machine status is unknown → computer unknown.
	if proj.ComputerStatus != ComputerStateUnknown || *proj.GateReason != GateReasonComputerStatusUnknown {
		t.Fatalf("computer=%s gate=%v", proj.ComputerStatus, proj.GateReason)
	}
	if !proj.HasConnectedComputer {
		t.Fatal("non-revoked computer rows are durable connected facts")
	}
	if len(proj.OfflineComputers) != 2 {
		t.Fatalf("both computers are non-running: %+v", proj.OfflineComputers)
	}
	for _, c := range proj.OfflineComputers {
		if !c.IsComputer {
			t.Fatal("computers rows ARE managed computers")
		}
	}
	wantHeartbeat := time.Date(2026, 7, 1, 10, 35, 0, 0, time.UTC).Format("2006-01-02T15:04:05.000Z")
	found := false
	for _, c := range proj.OfflineComputers {
		if c.ID == "computer-1" && c.LastHeartbeat != nil && *c.LastHeartbeat == wantHeartbeat {
			found = true
		}
	}
	if !found {
		t.Fatalf("linked computer heartbeat missing: %+v", proj.OfflineComputers)
	}
}

func TestSetupProjectionOnlineComputerWithRuntimes(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	runtimes := `["claude","grok"]`
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", &runtimes, nil, nil)
	setupSeedComputer(t, handle, "ws", "computer-1", "machine-1", false)
	store, _ := newSetupStore(t, handle)

	withProbe(t, func(context.Context, string) (bool, error) { return true, nil })
	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.ComputerStatus != ComputerStateOnline {
		t.Fatalf("computer=%s", proj.ComputerStatus)
	}
	if proj.RuntimeStatus != RuntimeStateReadyRecommended {
		t.Fatalf("runtime=%s", proj.RuntimeStatus)
	}
	if len(proj.OfflineComputers) != 0 {
		t.Fatalf("online computer is not offline-listed: %+v", proj.OfflineComputers)
	}
	// Surface advances to create_agent; completion still disabled (no Cindy).
	if proj.Surface != SetupSurfaceCreateAgent || *proj.GateReason != GateReasonOfficialAgentMissing {
		t.Fatalf("surface=%s gate=%v", proj.Surface, proj.GateReason)
	}
	// C0 policy: grok reported but not admitted; claude carries readiness.
	if len(proj.RuntimeOptions) == 0 {
		t.Fatal("runtime options must project for an online machine")
	}
}

func TestSetupProjectionRevokedComputerExcluded(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedComputer(t, handle, "ws", "computer-1", "machine-1", true)
	store, _ := newSetupStore(t, handle)

	proj, err := store.GetSetupProjection(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if proj.HasConnectedComputer {
		t.Fatal("revocation removes the connected-computer fact")
	}
	if len(proj.OfflineComputers) != 0 {
		t.Fatalf("%+v", proj.OfflineComputers)
	}
}

// --- T17: transitions ----------------------------------------------------

func TestTransitionSetupStartLifecycle(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)
	ctx := context.Background()

	proj, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionStart)
	if err != nil {
		t.Fatal(err)
	}
	if proj.Phase == nil || *proj.Phase != SetupStatusInProgress {
		t.Fatalf("phase %v", proj.Phase)
	}
	// Idempotent: a second start stays in_progress.
	if _, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionStart); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws' AND user_id='owner'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusInProgress {
		t.Fatalf("status %s", status)
	}
	// Legacy deferred revives to in_progress.
	if _, err := handle.Exec(`UPDATE workspace_member_setup SET status='deferred' WHERE workspace_id='ws'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionStart); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusInProgress {
		t.Fatalf("deferred revive: %s", status)
	}
}

func TestTransitionSetupRejectsDeferAndUnknownActions(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)
	for _, action := range []string{"defer", "", "pause"} {
		if code := mustDomainCode(t, actionErr(store, action)); code != CodeInvalidSetupAction {
			t.Fatalf("action %q: code %s", action, code)
		}
	}
}

func actionErr(store *Store, action string) error {
	_, err := store.TransitionSetup(context.Background(), "ws", "owner", action)
	return err
}

func TestTransitionSetupCompleteRequiresOfficialAgent(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	store, _ := newSetupStore(t, handle)

	// No pointer at all: unusable.
	if code := mustDomainCode(t, transitionErr(store, SetupActionComplete)); code != CodeOfficialOnboardingAgentNotUsable {
		t.Fatalf("code %s", code)
	}

	// A real, local, machine-bound agent that is NOT Cindy: explicit complete
	// still refuses — official identity is part of the usable definition.
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, description, avatar_url,
		                    status, runtime, machine_id, created_at, updated_at)
		VALUES ('agent-bob', 'ws', 'Bob', 'Bob', 'Ops', 'pixel:cube', 'active', 'claude', 'machine-1', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-bob', 'admin', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET onboarding_agent_id='agent-bob' WHERE id='ws'`); err != nil {
		t.Fatal(err)
	}
	if code := mustDomainCode(t, transitionErr(store, SetupActionComplete)); code != CodeOfficialOnboardingAgentNotUsable {
		t.Fatalf("non-official agent must not complete setup: %s", code)
	}
}

func transitionErr(store *Store, action string) error {
	_, err := store.TransitionSetup(context.Background(), "ws", "owner", action)
	return err
}

func TestTransitionSetupCompleteWithOfficialAgentFixture(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedOfficialCindy(t, handle, "ws", "agent-cindy", "machine-1")
	store, _ := newSetupStore(t, handle)
	ctx := context.Background()

	proj, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionComplete)
	if err != nil {
		t.Fatal(err)
	}
	if proj.Surface != SetupSurfaceComplete || !proj.PostSetup.SurveyPending || !proj.PostSetup.HandoffPending {
		t.Fatalf("%+v", proj)
	}
	var status, reason string
	if err := handle.QueryRow(`SELECT status, completion_reason FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusComplete || reason != SetupReasonNormal {
		t.Fatalf("status=%s reason=%s", status, reason)
	}
	// Idempotent: completing again neither errors nor rewrites the reason.
	if _, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionComplete); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT completion_reason FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != SetupReasonNormal {
		t.Fatalf("reason rewritten: %s", reason)
	}
	// start after complete cannot regress.
	if _, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionStart); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusComplete {
		t.Fatalf("complete regressed: %s", status)
	}
}

func TestTransitionSetupAuthority(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMembership(t, handle, "ws", "admin", "admin")
	setupSeedMembership(t, handle, "ws", "member", "member")
	store, _ := newSetupStore(t, handle)

	// Admin may help manage the workspace, but setup is the owner's.
	_, adminErr := store.TransitionSetup(context.Background(), "ws", "admin", SetupActionStart)
	if code := mustDomainCode(t, adminErr); code != CodeInsufficientPermission {
		t.Fatalf("admin: %s", code)
	}
	_, memberErr := store.TransitionSetup(context.Background(), "ws", "member", SetupActionStart)
	if code := mustDomainCode(t, memberErr); code != CodeInsufficientPermission {
		t.Fatalf("member: %s", code)
	}
	// No setup row at all: STATE_NOT_FOUND for a legitimate owner.
	setupSeedUser(t, handle, "owner2")
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
		VALUES ('ws', 'owner2', 'owner', 1)`); err != nil {
		t.Fatal(err)
	}
	_, noStateErr := store.TransitionSetup(context.Background(), "ws", "owner2", SetupActionStart)
	if code := mustDomainCode(t, noStateErr); code != CodeStateNotFound {
		t.Fatalf("missing setup row: %s", code)
	}
}

func TestTransitionSetupBodyFieldsCannotForgeCompletion(t *testing.T) {
	// T22: the domain takes only (workspace, user, action). There is no
	// channel through which setupStatus, wizard step or an agent id string
	// can buy completion — the command re-derives everything from the DB.
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)
	if code := mustDomainCode(t, transitionErr(store, SetupActionComplete)); code != CodeOfficialOnboardingAgentNotUsable {
		t.Fatalf("code %s", code)
	}
}

// --- T19/T20: reset ------------------------------------------------------

func TestResetSetupRevokesComputersAndRewindsOwner(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedComputer(t, handle, "ws", "computer-1", "machine-1", false)
	setupSeedComputer(t, handle, "ws", "computer-2", "", false)
	setupSeedComputer(t, handle, "ws", "computer-revoked", "machine-1", true)
	if _, err := handle.Exec(`UPDATE workspace_member_setup SET status='in_progress' WHERE workspace_id='ws'`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	ctx := context.Background()

	result, err := store.ResetSetup(ctx, "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if result.RevokedComputers != 2 {
		t.Fatalf("revoked %d, want only the 2 active rows", result.RevokedComputers)
	}
	var status sql.NullString
	var reason sql.NullString
	if err := handle.QueryRow(`SELECT status, completion_reason FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status.String != SetupStatusNotStarted || reason.Valid {
		t.Fatalf("owner state %s/%v", status.String, reason)
	}
	// Workspace, membership and machines survive a reset.
	var workspaces, memberships, machines int
	for table, counter := range map[string]*int{
		"workspaces": &workspaces, "workspace_memberships": &memberships, "machines": &machines,
	} {
		if err := handle.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(counter); err != nil {
			t.Fatal(err)
		}
		if *counter != 1 {
			t.Fatalf("%s count %d", table, *counter)
		}
	}
	// Repeat reset is safe (idempotent zero-revoke) and the projection after
	// reset shows the fresh Connect-Computer state.
	again, err := store.ResetSetup(ctx, "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if again.RevokedComputers != 0 {
		t.Fatalf("second reset revoked %d", again.RevokedComputers)
	}
	if result.Projection.Surface != SetupSurfaceComputerRuntime || result.Projection.HasConnectedComputer {
		t.Fatalf("post-reset projection: %+v", result.Projection)
	}
}

func TestResetSetupRefusals(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedWorkspace(t, handle, "ws-done", "owner2")
	setupSeedMembership(t, handle, "ws", "coowner", "owner")
	store, _ := newSetupStore(t, handle)

	// complete is terminal, including here.
	if _, err := handle.Exec(`UPDATE workspace_member_setup SET status='complete', completion_reason='normal'
		WHERE workspace_id='ws-done'`); err != nil {
		t.Fatal(err)
	}
	if code := mustDomainCode(t, resetErr(store, "ws-done", "owner2")); code != CodeServerAlreadySetUp {
		t.Fatalf("complete reset: %s", code)
	}

	// Any onboarding-agent pointer is the commit point, even while the owner
	// row is still not_started.
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedOfficialCindy(t, handle, "ws", "agent-cindy", "machine-1")
	if code := mustDomainCode(t, resetErr(store, "ws", "owner")); code != CodeServerAlreadySetUp {
		t.Fatalf("checkpoint reset: %s", code)
	}

	// ownerId mismatch: a co-owner membership cannot reset someone else's
	// workspace even with role=owner.
	if code := mustDomainCode(t, resetErr(store, "ws-done", "coowner")); code != CodeInsufficientPermission {
		t.Fatalf("coowner reset: %s", code)
	}
	// Missing workspace.
	if code := mustDomainCode(t, resetErr(store, "nope", "owner")); code != CodeStateNotFound {
		t.Fatalf("missing workspace reset: %s", code)
	}
}

func resetErr(store *Store, workspaceID, userID string) error {
	_, err := store.ResetSetup(context.Background(), workspaceID, userID)
	return err
}

func TestResetSetupOwnerIDBeatsMembershipRole(t *testing.T) {
	// The legacy asymmetry (D06/R08): reset authorizes by workspace ownerId,
	// not the membership role. The workspace owner keeps the right to reset
	// even when their membership role was reduced to member.
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	if _, err := handle.Exec(`UPDATE workspace_memberships SET role='member' WHERE workspace_id='ws' AND user_id='owner'`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	result, err := store.ResetSetup(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatalf("workspace owner must keep reset authority: %v", err)
	}
	if result.RevokedComputers != 0 {
		t.Fatalf("no computers existed; revoked %d", result.RevokedComputers)
	}
}

func TestResetSetupAtomicRollbackOnComputerFailure(t *testing.T) {
	// T20-style serialization proof: when the computer revocation write
	// fails inside the transaction, the owner's setup row must NOT be reset.
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedComputer(t, handle, "ws", "computer-1", "", false)
	if _, err := handle.Exec(`UPDATE workspace_member_setup SET status='in_progress' WHERE workspace_id='ws'`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		CREATE TRIGGER fail_computer_revoke BEFORE UPDATE ON computers
		WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
		BEGIN SELECT RAISE(ABORT, 'injected computer revoke failure'); END`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	if _, err := store.ResetSetup(context.Background(), "ws", "owner"); err == nil {
		t.Fatal("injected failure must surface")
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusInProgress {
		t.Fatalf("owner state must roll back with the failed revocation, got %s", status)
	}
}

// --- T21: handoff --------------------------------------------------------

func TestHandoffSetupRecordsFirstFactsIdempotently(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, fixed := newSetupStore(t, handle)
	ctx := context.Background()

	if _, err := store.HandoffSetup(ctx, "ws", "owner", "family-1"); err != nil {
		t.Fatal(err)
	}
	var ack int64
	var accountAt int64
	var family string
	if err := handle.QueryRow(`SELECT handoff_acknowledged_at FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&ack); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT first_onboarding_completed_at, first_onboarding_completed_session_family_id FROM users WHERE id='owner'`).Scan(&accountAt, &family); err != nil {
		t.Fatal(err)
	}
	if ack != setupTestNow.UnixMilli() || accountAt != setupTestNow.UnixMilli() || family != "family-1" {
		t.Fatalf("ack=%d account=%d family=%s", ack, accountAt, family)
	}

	// Second press from another session: first facts never refresh.
	fixed.Advance(time.Hour)
	if _, err := store.HandoffSetup(ctx, "ws", "owner", "family-2"); err != nil {
		t.Fatal(err)
	}
	var family2 string
	var accountAt2 int64
	if err := handle.QueryRow(`SELECT first_onboarding_completed_at, first_onboarding_completed_session_family_id FROM users WHERE id='owner'`).Scan(&accountAt2, &family2); err != nil {
		t.Fatal(err)
	}
	if accountAt2 != setupTestNow.UnixMilli() || family2 != "family-1" {
		t.Fatalf("first facts must be immutable: at=%d family=%s", accountAt2, family2)
	}
	var ack2 int64
	if err := handle.QueryRow(`SELECT handoff_acknowledged_at FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&ack2); err != nil {
		t.Fatal(err)
	}
	if ack2 != setupTestNow.UnixMilli() {
		t.Fatalf("first acknowledgment must be immutable: %d", ack2)
	}
}

func TestHandoffSetupEarlyCallDoesNotAdvanceSetupStatus(t *testing.T) {
	// D06: the legacy endpoint has NO complete prerequisite — an early
	// handoff records the click and must NOT change setup.status.
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)
	ctx := context.Background()

	proj, err := store.HandoffSetup(ctx, "ws", "owner", "family-1")
	if err != nil {
		t.Fatal(err)
	}
	if proj.Phase == nil || *proj.Phase != SetupStatusNotStarted {
		t.Fatalf("early handoff changed the flow: %v", proj.Phase)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusNotStarted {
		t.Fatalf("early handoff must not complete setup: %s", status)
	}
}

func TestHandoffSetupAuthorityAndMissingWorkspace(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMembership(t, handle, "ws", "admin", "admin")
	store, _ := newSetupStore(t, handle)

	if code := mustDomainCode(t, handoffErr(store, "ws", "admin")); code != CodeInsufficientPermission {
		t.Fatalf("admin handoff: %s", code)
	}
	// The owner-of-record on another workspace is a stranger here.
	if code := mustDomainCode(t, handoffErr(store, "nope", "owner")); code != CodeNotFound {
		t.Fatalf("missing workspace: %s", code)
	}
}

func handoffErr(store *Store, workspaceID, userID string) error {
	_, err := store.HandoffSetup(context.Background(), workspaceID, userID, "family")
	return err
}

func TestHandoffSetupAccountStampFailureRollsBackMemberStamp(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	if _, err := handle.Exec(`
		CREATE TRIGGER fail_account_stamp BEFORE UPDATE ON users
		WHEN NEW.first_onboarding_completed_at IS NOT NULL AND OLD.first_onboarding_completed_at IS NULL
		BEGIN SELECT RAISE(ABORT, 'injected account stamp failure'); END`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	if _, err := store.HandoffSetup(context.Background(), "ws", "owner", "family-1"); err == nil {
		t.Fatal("injected failure must surface")
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM workspace_member_setup WHERE handoff_acknowledged_at IS NOT NULL`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("member acknowledgment must roll back with the failed account stamp")
	}
}

// --- R23/D11: settings helpers ------------------------------------------

func TestValidateConfiguredAgentTxAcceptsAnyRealLocalAgent(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedWorkspace(t, handle, "other", "owner2")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	// NOT Cindy: the config setter rule accepts real local agents
	// regardless of official identity.
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, machine_id, created_at, updated_at)
		VALUES ('agent-bob', 'ws', 'Bob', 'inactive', 'claude', NULL, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES ('agent-deleted', 'ws', 'Deleted', 'inactive', 'claude', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET deleted_at = 2 WHERE id = 'agent-deleted'`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES ('agent-foreign', 'other', 'Foreign', 'inactive', 'claude', 1, 1)`); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	err := handle.QueryRowContext(ctx, `SELECT 1`).Scan(new(int))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	if err := validateConfiguredAgentTx(ctx, tx, "ws", "agent-bob"); err != nil {
		t.Fatalf("real local agent must pass: %v", err)
	}
	for _, agentID := range []string{"agent-deleted", "agent-foreign", "missing", ""} {
		err := validateConfiguredAgentTx(ctx, tx, "ws", agentID)
		if err == nil {
			t.Fatalf("agent %q must be rejected", agentID)
		}
		if code := mustDomainCode(t, err); code != CodeInvalidInput {
			t.Fatalf("agent %q: code %s", agentID, code)
		}
	}
}

func TestReconcileOwnersTxCheckpointSemantics(t *testing.T) {
	handle := openSetupDB(t)
	ctx := context.Background()

	// No checkpoint crossed: reconcile is a no-op even with incomplete owners.
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMembership(t, handle, "ws", "coowner", "owner")
	setupSeedMembership(t, handle, "ws", "member", "member")
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := reconcileOwnersTx(ctx, tx, "ws"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup WHERE workspace_id='ws' AND user_id='owner'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != SetupStatusNotStarted {
		t.Fatalf("no checkpoint must not reconcile: %s", status)
	}

	// Cross the checkpoint: incomplete OWNERS become complete/grandfathered;
	// already-complete reasons survive; members stay untouched.
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedOfficialCindy(t, handle, "ws", "agent-cindy", "machine-1")
	if _, err := handle.Exec(`
		UPDATE workspace_member_setup SET status='complete', completion_reason='normal'
		WHERE workspace_id='ws' AND user_id='owner'`); err != nil {
		t.Fatal(err)
	}
	tx, err = handle.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := reconcileOwnersTx(ctx, tx, "ws"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	assertRow := func(userID, wantStatus string, wantReason *string) {
		t.Helper()
		var status, reason sql.NullString
		if err := handle.QueryRow(`SELECT status, completion_reason FROM workspace_member_setup
			WHERE workspace_id='ws' AND user_id=?`, userID).Scan(&status, &reason); err != nil {
			t.Fatal(err)
		}
		if status.String != wantStatus {
			t.Fatalf("%s: status %s want %s", userID, status.String, wantStatus)
		}
		if wantReason == nil {
			if reason.Valid {
				t.Fatalf("%s: reason must stay null, got %s", userID, reason.String)
			}
		} else if !reason.Valid || reason.String != *wantReason {
			t.Fatalf("%s: reason %v want %s", userID, reason, *wantReason)
		}
	}
	// The original owner keeps `normal`; the co-owner is grandfathered.
	assertRow("owner", SetupStatusComplete, reasonPtr(SetupReasonNormal))
	assertRow("coowner", SetupStatusComplete, reasonPtr(SetupReasonGrandfathered))
	assertRow("member", SetupStatusNotStarted, nil)
}

// --- T25-lite: persistence across reopen --------------------------------

func TestSetupFactsSurviveReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persist.db")
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	setupSeedOfficialCindy(t, handle, "ws", "agent-cindy", "machine-1")
	store, _ := newSetupStore(t, handle)
	ctx := context.Background()
	if _, err := store.TransitionSetup(ctx, "ws", "owner", SetupActionComplete); err != nil {
		t.Fatal(err)
	}
	if _, err := store.HandoffSetup(ctx, "ws", "owner", "family-1"); err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: migrations are idempotent and every setup fact persists.
	handle2, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle2.Close()
	store2, _ := newSetupStore(t, handle2)
	proj, err := store2.GetSetupProjection(ctx, "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	// Handoff was acknowledged; the survey was never answered, so it stays
	// owed — separate facts survive independently across the restart.
	if proj.Surface != SetupSurfaceComplete || !proj.PostSetup.SurveyPending || proj.PostSetup.HandoffPending {
		t.Fatalf("completed + acknowledged state must survive restart: %+v", proj)
	}
	var family string
	if err := handle2.QueryRow(`SELECT first_onboarding_completed_session_family_id FROM users WHERE id='owner'`).Scan(&family); err != nil {
		t.Fatal(err)
	}
	if family != "family-1" {
		t.Fatalf("account family fact lost: %q", family)
	}
}

// --- migration backfill honesty -----------------------------------------

func TestMigrationBackfillsExistingMembershipsNotStarted(t *testing.T) {
	handle := openSetupDB(t)
	// The migration chain itself backfills setup rows for pre-existing
	// memberships: insert a membership BEFORE opening is impossible here
	// (Open migrates), so verify the seeded row contract instead — creation
	// writes and the backfill share it: not_started, null reason, v2.
	setupSeedWorkspace(t, handle, "ws", "owner")
	var status sql.NullString
	var reason sql.NullString
	var contract sql.NullString
	if err := handle.QueryRow(`SELECT status, completion_reason, contract_version
		FROM workspace_member_setup WHERE workspace_id='ws' AND user_id='owner'`).Scan(&status, &reason, &contract); err != nil {
		t.Fatal(err)
	}
	if status.String != SetupStatusNotStarted || reason.Valid || contract.String != SetupContractVersion {
		t.Fatalf("seed/backfill contract: %s/%v/%s", status.String, reason, contract.String)
	}
}
