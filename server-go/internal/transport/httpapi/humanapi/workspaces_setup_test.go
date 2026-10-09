package humanapi_test

// T15/T16/T17/T18/T19/T21/T23: the setup gate over HTTP — the honest initial
// projection for a fresh owner, the transition command contract, reset,
// handoff persistence, the machine directory and the sidebar projection.

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
	"time"
)

func TestSetupProjectionFreshOwnerGate(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("gate-owner@example.test", "gateowner")
	ws := e.CreateServer(t, access, "Gate Lab", "gate-lab")

	res := e.Serve("GET", "/api/servers/"+ws+"/setup-projection", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("projection: %d %s", res.Status, res.Raw)
	}
	// Design §10.2: with a real-but-empty catalog the gate is honest.
	want := map[string]any{
		"surface": "computer_runtime", "phase": "not_started",
		"currentStep": "computer_runtime", "blocksChat": true,
	}
	for key, value := range want {
		if res.Body[key] != value {
			t.Errorf("%s = %v, want %v", key, res.Body[key], value)
		}
	}
	if exits, _ := res.Body["allowedExits"].([]any); len(exits) != 2 || exits[0] != "reset" || exits[1] != "return_to_server" {
		t.Errorf("allowedExits: %v", res.Body["allowedExits"])
	}
	if res.Body["gateReason"] != "computer_offline" || res.Body["computerStatus"] != "offline" {
		t.Errorf("gate facts: %s", res.Raw)
	}
	// No computer => runtime is unknown (not not_ready), options empty.
	if res.Body["runtimeStatus"] != "unknown" {
		t.Errorf("runtimeStatus = %v, want unknown", res.Body["runtimeStatus"])
	}
	if opts, _ := res.Body["runtimeOptions"].([]any); len(opts) != 0 {
		t.Errorf("runtimeOptions: %v", res.Body["runtimeOptions"])
	}
	if res.Body["hasConnectedComputer"] != false {
		t.Errorf("hasConnectedComputer: %v", res.Body["hasConnectedComputer"])
	}
	if offline, _ := res.Body["offlineComputers"].([]any); len(offline) != 0 {
		t.Errorf("offlineComputers: %v", res.Body["offlineComputers"])
	}
	post, _ := res.Body["postSetup"].(map[string]any)
	if post == nil || post["surveyPending"] != false || post["handoffPending"] != false {
		t.Errorf("postSetup hidden before completion: %v", res.Body["postSetup"])
	}

	// A restart does not lose the gate (T15 persistence).
	reopened := e.Reopen()
	res = reopened.Serve("GET", "/api/servers/"+ws+"/setup-projection", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK || res.Body["blocksChat"] != true || res.Body["surface"] != "computer_runtime" {
		t.Fatalf("projection after restart: %d %s", res.Status, res.Raw)
	}
	_ = ownerID
}

func TestSetupProjectionNonOwnerAndGuest(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("proj-owner@example.test", "projowner")
	memberID, memberAccess, _ := e.FullAccount("proj-member@example.test", "projmember")
	guestID, guestAccess, _ := e.FullAccount("proj-guest@example.test", "projguest")
	ws := e.CreateServer(t, access, "Proj Lab", "proj-lab")
	e.AddMember(t, ws, memberID, "member")
	e.AddMember(t, ws, guestID, "guest")

	// Non-owner member passing the scope check: the reference no-setup
	// projection (surface none, phase null, no gate).
	res := e.Serve("GET", "/api/servers/"+ws+"/setup-projection", nil, testkit.Scoped(memberAccess, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("member projection: %d %s", res.Status, res.Raw)
	}
	if res.Body["surface"] != "none" || res.Body["phase"] != nil || res.Body["blocksChat"] != false {
		t.Fatalf("non-owner projection: %s", res.Raw)
	}
	if res.Body["gateReason"] != "insufficient_permission" {
		t.Errorf("gateReason: %v", res.Body["gateReason"])
	}

	// Guests are denied at the management middleware, before any projection.
	res = e.Serve("GET", "/api/servers/"+ws+"/setup-projection", nil, testkit.Scoped(guestAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest projection: %d %s", res.Status, res.Raw)
	}
}

func TestSetupTransitionContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("trans-owner@example.test", "transowner")
	memberID, memberAccess, _ := e.FullAccount("trans-member@example.test", "transmember")
	ws := e.CreateServer(t, access, "Trans Lab", "trans-lab")
	e.AddMember(t, ws, memberID, "member")

	post := func(token string, body map[string]any) testkit.Response {
		return e.Serve("POST", "/api/servers/"+ws+"/setup-transition", body, testkit.Scoped(token, ws))
	}

	// Unknown/retired/non-string actions: the exact 400.
	for _, action := range []any{"defer", "bogus", nil, 42} {
		res := post(access, map[string]any{"action": action})
		if res.Status != http.StatusBadRequest || res.Body["error"] != "INVALID_SETUP_ACTION" {
			t.Fatalf("action %v: %d %s", action, res.Status, res.Raw)
		}
	}

	// Only the owner may drive their own setup row.
	res := post(memberAccess, map[string]any{"action": "start"})
	if res.Status != http.StatusForbidden || res.Body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("member start: %d %s", res.Status, res.Raw)
	}

	// start moves not_started -> in_progress and is idempotent.
	res = post(access, map[string]any{"action": "start"})
	if res.Status != http.StatusOK || res.Body["phase"] != "in_progress" {
		t.Fatalf("start: %d %s", res.Status, res.Raw)
	}
	res = post(access, map[string]any{"action": "start"})
	if res.Status != http.StatusOK || res.Body["phase"] != "in_progress" {
		t.Fatalf("second start must be a no-op success: %d %s", res.Status, res.Raw)
	}

	// complete without a usable official agent is the 409 (never a fake
	// completion, never mixed up with a 424).
	res = post(access, map[string]any{"action": "complete"})
	if res.Status != http.StatusConflict || res.Body["error"] != "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE" {
		t.Fatalf("complete without agent: %d %s", res.Status, res.Raw)
	}
	status, _ := e.SetupRow(t, ws, ownerID)
	if status != "in_progress" {
		t.Fatalf("failed complete changed status: %q", status)
	}

	// Body-level forgery never reaches the state machine (T22).
	res = post(access, map[string]any{"action": "start", "setupStatus": "complete", "role": "owner", "wizardCurrentStep": "complete"})
	if res.Status != http.StatusOK {
		t.Fatalf("forged body: %d %s", res.Status, res.Raw)
	}
	status, _ = e.SetupRow(t, ws, ownerID)
	if status == "complete" {
		t.Fatal("body setupStatus completed setup")
	}
}

func TestSetupResetContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("reset-owner@example.test", "resetowner")
	adminID, adminAccess, _ := e.FullAccount("reset-admin@example.test", "resetadmin")
	ws := e.CreateServer(t, access, "Reset Lab", "reset-lab")
	e.AddMember(t, ws, adminID, "admin")

	// Admin may help set up but may not throw the owner's workspace away.
	res := e.Serve("POST", "/api/servers/"+ws+"/setup-reset", nil, testkit.Scoped(adminAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("admin reset: %d %s", res.Status, res.Raw)
	}

	// Owner reset: connected computers are revoked, setup returns to
	// not_started, and the rec merges the projection with the real count.
	e.SeedComputer(t, "computer-1", ws)
	res = e.Serve("POST", "/api/servers/"+ws+"/setup-reset", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("reset: %d %s", res.Status, res.Raw)
	}
	if res.Body["revokedComputers"] != float64(1) {
		t.Errorf("revokedComputers: %v", res.Body["revokedComputers"])
	}
	if res.Body["surface"] != "computer_runtime" || res.Body["phase"] != "not_started" {
		t.Errorf("post-reset projection: %s", res.Raw)
	}
	var revokedAt any
	if err := e.App.DB.QueryRow(`SELECT revoked_at FROM computers WHERE id = 'computer-1'`).Scan(&revokedAt); err != nil || revokedAt == nil {
		t.Fatalf("computer must be revoked: %v %v", revokedAt, err)
	}
	status, reason := e.SetupRow(t, ws, ownerID)
	if status != "not_started" || reason.Valid {
		t.Fatalf("owner state after reset: %q %v", status, reason)
	}
	// The workspace, its members and its channels survive.
	var members, channels int
	_ = e.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, ws).Scan(&members)
	_ = e.App.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id = ?`, ws).Scan(&channels)
	if members != 2 || channels != 2 {
		t.Errorf("reset must preserve members/channels: %d %d", members, channels)
	}

	// Repeat reset is safe (idempotent zero-revoke).
	res = e.Serve("POST", "/api/servers/"+ws+"/setup-reset", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK || res.Body["revokedComputers"] != float64(0) {
		t.Fatalf("repeat reset: %d %s", res.Status, res.Raw)
	}

	// A completed setup is terminal for reset.
	if _, err := e.App.DB.Exec(`UPDATE workspace_member_setup SET status='complete', completion_reason='normal' WHERE workspace_id = ? AND user_id = ?`, ws, ownerID); err != nil {
		t.Fatal(err)
	}
	res = e.Serve("POST", "/api/servers/"+ws+"/setup-reset", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusConflict || res.Body["error"] != "SERVER_ALREADY_SET_UP" {
		t.Fatalf("complete reset: %d %s", res.Status, res.Raw)
	}
}

func TestSetupHandoffContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("handoff-owner@example.test", "handoffowner")
	memberID, memberAccess, _ := e.FullAccount("handoff-member@example.test", "handoffmember")
	ws := e.CreateServer(t, access, "Handoff Lab", "handoff-lab")
	e.AddMember(t, ws, memberID, "member")

	// The handoff belongs to the ownerId, not to any manager role.
	res := e.Serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, testkit.Scoped(memberAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("member handoff: %d %s", res.Status, res.Raw)
	}

	// Owner ack: 200 with the re-read projection. Faithful to the reference,
	// there is no complete prerequisite — and setup.Status never moves.
	res = e.Serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("handoff: %d %s", res.Status, res.Raw)
	}
	status, _ := e.SetupRow(t, ws, ownerID)
	if status != "not_started" {
		t.Fatalf("early handoff advanced setup: %q (D06)", status)
	}

	// The account-level first-onboarding fact persists and first-write-wins.
	var firstAt any
	if err := e.App.DB.QueryRow(`SELECT first_onboarding_completed_at FROM users WHERE id = ?`, ownerID).Scan(&firstAt); err != nil || firstAt == nil {
		t.Fatalf("handoff must stamp the account fact: %v %v", firstAt, err)
	}
	time.Sleep(10 * time.Millisecond)
	res = e.Serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("repeat handoff: %d %s", res.Status, res.Raw)
	}
	var secondAt any
	_ = e.App.DB.QueryRow(`SELECT first_onboarding_completed_at FROM users WHERE id = ?`, ownerID).Scan(&secondAt)
	if secondAt != firstAt {
		t.Fatalf("first acknowledgment must be immutable: %v vs %v", firstAt, secondAt)
	}
}

func TestMachinesDirectoryContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("machines-owner@example.test", "machowner")
	guestID, guestAccess, _ := e.FullAccount("machines-guest@example.test", "machguest")
	ws := e.CreateServer(t, access, "Machines Lab", "machines-lab")
	e.AddMember(t, ws, guestID, "guest")

	// Real catalog query: [] is a true answer, never null.
	res := e.Serve("GET", "/api/servers/"+ws+"/machines", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("machines: %d %s", res.Status, res.Raw)
	}
	machines, _ := res.Body["machines"].([]any)
	if machines == nil || len(machines) != 0 {
		t.Fatalf("empty catalog must be []: %s", res.Raw)
	}
	if _, present := res.Body["latestDaemonVersion"]; !present {
		t.Errorf("legacy envelope missing latestDaemonVersion: %s", res.Raw)
	}

	// Seeded machines appear with their read-model identity.
	if _, err := e.App.DB.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('mach-1', ?, ?, 'Laptop', ?)`, ws, guestID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	res = e.Serve("GET", "/api/servers/"+ws+"/machines", nil, testkit.Scoped(access, ws))
	machines, _ = res.Body["machines"].([]any)
	if len(machines) != 1 {
		t.Fatalf("seeded machine missing: %s", res.Raw)
	}
	mach, _ := machines[0].(map[string]any)
	if mach["id"] != "mach-1" || mach["name"] != "Laptop" {
		t.Errorf("machine projection: %v", mach)
	}

	// Guests are denied.
	res = e.Serve("GET", "/api/servers/"+ws+"/machines", nil, testkit.Scoped(guestAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest machines: %d %s", res.Status, res.Raw)
	}
}

func TestSidebarOrderContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("sidebar-owner@example.test", "sidebarowner")
	ws := e.CreateServer(t, access, "Sidebar Lab", "sidebar-lab")

	res := e.Serve("GET", "/api/servers/"+ws+"/sidebar-order", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("sidebar-order: %d %s", res.Status, res.Raw)
	}
	for _, key := range []string{
		"channelOrder", "agentOrder", "dmOrder", "channelSortMode", "jointChannelSortMode",
		"dmSortMode", "pinnedSortMode", "pinned", "pinnedChannelIds", "pinnedAgentIds",
		"pinnedOrder", "hiddenDmIds", "channelPanelTabOrder", "agentPanelTabOrder",
		"customSections", "sectionOrder", "sectionPlacements", "sectionsVersion", "pinnedVersion",
	} {
		if _, present := res.Body[key]; !present {
			t.Errorf("sidebar field %q missing: %s", key, res.Raw)
		}
	}
	for _, key := range []string{"channelOrder", "agentOrder", "dmOrder", "pinned", "pinnedChannelIds",
		"pinnedAgentIds", "pinnedOrder", "hiddenDmIds", "channelPanelTabOrder", "agentPanelTabOrder",
		"customSections", "sectionOrder", "sectionPlacements"} {
		if arr, ok := res.Body[key].([]any); !ok {
			t.Errorf("%s must be an array (empty ok, null not): %v", key, res.Body[key])
		} else if arr == nil {
			t.Errorf("%s must not be null", key)
		}
	}
	for _, key := range []string{"channelSortMode", "jointChannelSortMode", "dmSortMode", "pinnedSortMode"} {
		if res.Body[key] != "manual" {
			t.Errorf("%s = %v, want manual", key, res.Body[key])
		}
	}
	if res.Body["sectionsVersion"] != float64(0) || res.Body["pinnedVersion"] != float64(0) {
		t.Errorf("versions must start at 0: %s", res.Raw)
	}
}
