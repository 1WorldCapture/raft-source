package legacyweb_test

// T15/T16/T17/T18/T19/T21/T23: the setup gate over HTTP — the honest initial
// projection for a fresh owner, the transition command contract, reset,
// handoff persistence, the machine directory and the sidebar projection.

import (
	"net/http"
	"testing"
	"time"
)

func TestSetupProjectionFreshOwnerGate(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("gate-owner@example.test", "gateowner")
	ws := e.createServer(t, access, "Gate Lab", "gate-lab")

	res := e.serve("GET", "/api/servers/"+ws+"/setup-projection", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("projection: %d %s", res.status, res.raw)
	}
	// Design §10.2: with a real-but-empty catalog the gate is honest.
	want := map[string]any{
		"surface": "computer_runtime", "phase": "not_started",
		"currentStep": "computer_runtime", "blocksChat": true,
	}
	for key, value := range want {
		if res.body[key] != value {
			t.Errorf("%s = %v, want %v", key, res.body[key], value)
		}
	}
	if exits, _ := res.body["allowedExits"].([]any); len(exits) != 2 || exits[0] != "reset" || exits[1] != "return_to_server" {
		t.Errorf("allowedExits: %v", res.body["allowedExits"])
	}
	if res.body["gateReason"] != "computer_offline" || res.body["computerStatus"] != "offline" {
		t.Errorf("gate facts: %s", res.raw)
	}
	// No computer => runtime is unknown (not not_ready), options empty.
	if res.body["runtimeStatus"] != "unknown" {
		t.Errorf("runtimeStatus = %v, want unknown", res.body["runtimeStatus"])
	}
	if opts, _ := res.body["runtimeOptions"].([]any); len(opts) != 0 {
		t.Errorf("runtimeOptions: %v", res.body["runtimeOptions"])
	}
	if res.body["hasConnectedComputer"] != false {
		t.Errorf("hasConnectedComputer: %v", res.body["hasConnectedComputer"])
	}
	if offline, _ := res.body["offlineComputers"].([]any); len(offline) != 0 {
		t.Errorf("offlineComputers: %v", res.body["offlineComputers"])
	}
	post, _ := res.body["postSetup"].(map[string]any)
	if post == nil || post["surveyPending"] != false || post["handoffPending"] != false {
		t.Errorf("postSetup hidden before completion: %v", res.body["postSetup"])
	}

	// A restart does not lose the gate (T15 persistence).
	reopened := e.reopen()
	res = reopened.serve("GET", "/api/servers/"+ws+"/setup-projection", nil, scoped(access, ws))
	if res.status != http.StatusOK || res.body["blocksChat"] != true || res.body["surface"] != "computer_runtime" {
		t.Fatalf("projection after restart: %d %s", res.status, res.raw)
	}
	_ = ownerID
}

func TestSetupProjectionNonOwnerAndGuest(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("proj-owner@example.test", "projowner")
	memberID, memberAccess, _ := e.fullAccount("proj-member@example.test", "projmember")
	guestID, guestAccess, _ := e.fullAccount("proj-guest@example.test", "projguest")
	ws := e.createServer(t, access, "Proj Lab", "proj-lab")
	e.addMember(t, ws, memberID, "member")
	e.addMember(t, ws, guestID, "guest")

	// Non-owner member passing the scope check: the reference no-setup
	// projection (surface none, phase null, no gate).
	res := e.serve("GET", "/api/servers/"+ws+"/setup-projection", nil, scoped(memberAccess, ws))
	if res.status != http.StatusOK {
		t.Fatalf("member projection: %d %s", res.status, res.raw)
	}
	if res.body["surface"] != "none" || res.body["phase"] != nil || res.body["blocksChat"] != false {
		t.Fatalf("non-owner projection: %s", res.raw)
	}
	if res.body["gateReason"] != "insufficient_permission" {
		t.Errorf("gateReason: %v", res.body["gateReason"])
	}

	// Guests are denied at the management middleware, before any projection.
	res = e.serve("GET", "/api/servers/"+ws+"/setup-projection", nil, scoped(guestAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest projection: %d %s", res.status, res.raw)
	}
}

func TestSetupTransitionContract(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("trans-owner@example.test", "transowner")
	memberID, memberAccess, _ := e.fullAccount("trans-member@example.test", "transmember")
	ws := e.createServer(t, access, "Trans Lab", "trans-lab")
	e.addMember(t, ws, memberID, "member")

	post := func(token string, body map[string]any) response {
		return e.serve("POST", "/api/servers/"+ws+"/setup-transition", body, scoped(token, ws))
	}

	// Unknown/retired/non-string actions: the exact 400.
	for _, action := range []any{"defer", "bogus", nil, 42} {
		res := post(access, map[string]any{"action": action})
		if res.status != http.StatusBadRequest || res.body["error"] != "INVALID_SETUP_ACTION" {
			t.Fatalf("action %v: %d %s", action, res.status, res.raw)
		}
	}

	// Only the owner may drive their own setup row.
	res := post(memberAccess, map[string]any{"action": "start"})
	if res.status != http.StatusForbidden || res.body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("member start: %d %s", res.status, res.raw)
	}

	// start moves not_started -> in_progress and is idempotent.
	res = post(access, map[string]any{"action": "start"})
	if res.status != http.StatusOK || res.body["phase"] != "in_progress" {
		t.Fatalf("start: %d %s", res.status, res.raw)
	}
	res = post(access, map[string]any{"action": "start"})
	if res.status != http.StatusOK || res.body["phase"] != "in_progress" {
		t.Fatalf("second start must be a no-op success: %d %s", res.status, res.raw)
	}

	// complete without a usable official agent is the 409 (never a fake
	// completion, never mixed up with a 424).
	res = post(access, map[string]any{"action": "complete"})
	if res.status != http.StatusConflict || res.body["error"] != "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE" {
		t.Fatalf("complete without agent: %d %s", res.status, res.raw)
	}
	status, _ := e.setupRow(t, ws, ownerID)
	if status != "in_progress" {
		t.Fatalf("failed complete changed status: %q", status)
	}

	// Body-level forgery never reaches the state machine (T22).
	res = post(access, map[string]any{"action": "start", "setupStatus": "complete", "role": "owner", "wizardCurrentStep": "complete"})
	if res.status != http.StatusOK {
		t.Fatalf("forged body: %d %s", res.status, res.raw)
	}
	status, _ = e.setupRow(t, ws, ownerID)
	if status == "complete" {
		t.Fatal("body setupStatus completed setup")
	}
}

func TestSetupResetContract(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("reset-owner@example.test", "resetowner")
	adminID, adminAccess, _ := e.fullAccount("reset-admin@example.test", "resetadmin")
	ws := e.createServer(t, access, "Reset Lab", "reset-lab")
	e.addMember(t, ws, adminID, "admin")

	// Admin may help set up but may not throw the owner's workspace away.
	res := e.serve("POST", "/api/servers/"+ws+"/setup-reset", nil, scoped(adminAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("admin reset: %d %s", res.status, res.raw)
	}

	// Owner reset: connected computers are revoked, setup returns to
	// not_started, and the response merges the projection with the real count.
	e.seedComputer(t, "computer-1", ws)
	res = e.serve("POST", "/api/servers/"+ws+"/setup-reset", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("reset: %d %s", res.status, res.raw)
	}
	if res.body["revokedComputers"] != float64(1) {
		t.Errorf("revokedComputers: %v", res.body["revokedComputers"])
	}
	if res.body["surface"] != "computer_runtime" || res.body["phase"] != "not_started" {
		t.Errorf("post-reset projection: %s", res.raw)
	}
	var revokedAt any
	if err := e.app.DB.QueryRow(`SELECT revoked_at FROM computers WHERE id = 'computer-1'`).Scan(&revokedAt); err != nil || revokedAt == nil {
		t.Fatalf("computer must be revoked: %v %v", revokedAt, err)
	}
	status, reason := e.setupRow(t, ws, ownerID)
	if status != "not_started" || reason.Valid {
		t.Fatalf("owner state after reset: %q %v", status, reason)
	}
	// The workspace, its members and its channels survive.
	var members, channels int
	_ = e.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, ws).Scan(&members)
	_ = e.app.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id = ?`, ws).Scan(&channels)
	if members != 2 || channels != 2 {
		t.Errorf("reset must preserve members/channels: %d %d", members, channels)
	}

	// Repeat reset is safe (idempotent zero-revoke).
	res = e.serve("POST", "/api/servers/"+ws+"/setup-reset", nil, scoped(access, ws))
	if res.status != http.StatusOK || res.body["revokedComputers"] != float64(0) {
		t.Fatalf("repeat reset: %d %s", res.status, res.raw)
	}

	// A completed setup is terminal for reset.
	if _, err := e.app.DB.Exec(`UPDATE workspace_member_setup SET status='complete', completion_reason='normal' WHERE workspace_id = ? AND user_id = ?`, ws, ownerID); err != nil {
		t.Fatal(err)
	}
	res = e.serve("POST", "/api/servers/"+ws+"/setup-reset", nil, scoped(access, ws))
	if res.status != http.StatusConflict || res.body["error"] != "SERVER_ALREADY_SET_UP" {
		t.Fatalf("complete reset: %d %s", res.status, res.raw)
	}
}

func TestSetupHandoffContract(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("handoff-owner@example.test", "handoffowner")
	memberID, memberAccess, _ := e.fullAccount("handoff-member@example.test", "handoffmember")
	ws := e.createServer(t, access, "Handoff Lab", "handoff-lab")
	e.addMember(t, ws, memberID, "member")

	// The handoff belongs to the ownerId, not to any manager role.
	res := e.serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, scoped(memberAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "INSUFFICIENT_PERMISSION" {
		t.Fatalf("member handoff: %d %s", res.status, res.raw)
	}

	// Owner ack: 200 with the re-read projection. Faithful to the reference,
	// there is no complete prerequisite — and setup.status never moves.
	res = e.serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("handoff: %d %s", res.status, res.raw)
	}
	status, _ := e.setupRow(t, ws, ownerID)
	if status != "not_started" {
		t.Fatalf("early handoff advanced setup: %q (D06)", status)
	}

	// The account-level first-onboarding fact persists and first-write-wins.
	var firstAt any
	if err := e.app.DB.QueryRow(`SELECT first_onboarding_completed_at FROM users WHERE id = ?`, ownerID).Scan(&firstAt); err != nil || firstAt == nil {
		t.Fatalf("handoff must stamp the account fact: %v %v", firstAt, err)
	}
	time.Sleep(10 * time.Millisecond)
	res = e.serve("POST", "/api/servers/"+ws+"/setup-handoff", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("repeat handoff: %d %s", res.status, res.raw)
	}
	var secondAt any
	_ = e.app.DB.QueryRow(`SELECT first_onboarding_completed_at FROM users WHERE id = ?`, ownerID).Scan(&secondAt)
	if secondAt != firstAt {
		t.Fatalf("first acknowledgment must be immutable: %v vs %v", firstAt, secondAt)
	}
}

func TestMachinesDirectoryContract(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("machines-owner@example.test", "machowner")
	guestID, guestAccess, _ := e.fullAccount("machines-guest@example.test", "machguest")
	ws := e.createServer(t, access, "Machines Lab", "machines-lab")
	e.addMember(t, ws, guestID, "guest")

	// Real catalog query: [] is a true answer, never null.
	res := e.serve("GET", "/api/servers/"+ws+"/machines", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("machines: %d %s", res.status, res.raw)
	}
	machines, _ := res.body["machines"].([]any)
	if machines == nil || len(machines) != 0 {
		t.Fatalf("empty catalog must be []: %s", res.raw)
	}
	if _, present := res.body["latestDaemonVersion"]; !present {
		t.Errorf("legacy envelope missing latestDaemonVersion: %s", res.raw)
	}

	// Seeded machines appear with their read-model identity.
	if _, err := e.app.DB.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('mach-1', ?, ?, 'Laptop', ?)`, ws, guestID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	res = e.serve("GET", "/api/servers/"+ws+"/machines", nil, scoped(access, ws))
	machines, _ = res.body["machines"].([]any)
	if len(machines) != 1 {
		t.Fatalf("seeded machine missing: %s", res.raw)
	}
	mach, _ := machines[0].(map[string]any)
	if mach["id"] != "mach-1" || mach["name"] != "Laptop" {
		t.Errorf("machine projection: %v", mach)
	}

	// Guests are denied.
	res = e.serve("GET", "/api/servers/"+ws+"/machines", nil, scoped(guestAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest machines: %d %s", res.status, res.raw)
	}
}

func TestSidebarOrderContract(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("sidebar-owner@example.test", "sidebarowner")
	ws := e.createServer(t, access, "Sidebar Lab", "sidebar-lab")

	res := e.serve("GET", "/api/servers/"+ws+"/sidebar-order", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("sidebar-order: %d %s", res.status, res.raw)
	}
	for _, key := range []string{
		"channelOrder", "agentOrder", "dmOrder", "channelSortMode", "jointChannelSortMode",
		"dmSortMode", "pinnedSortMode", "pinned", "pinnedChannelIds", "pinnedAgentIds",
		"pinnedOrder", "hiddenDmIds", "channelPanelTabOrder", "agentPanelTabOrder",
		"customSections", "sectionOrder", "sectionPlacements", "sectionsVersion", "pinnedVersion",
	} {
		if _, present := res.body[key]; !present {
			t.Errorf("sidebar field %q missing: %s", key, res.raw)
		}
	}
	for _, key := range []string{"channelOrder", "agentOrder", "dmOrder", "pinned", "pinnedChannelIds",
		"pinnedAgentIds", "pinnedOrder", "hiddenDmIds", "channelPanelTabOrder", "agentPanelTabOrder",
		"customSections", "sectionOrder", "sectionPlacements"} {
		if arr, ok := res.body[key].([]any); !ok {
			t.Errorf("%s must be an array (empty ok, null not): %v", key, res.body[key])
		} else if arr == nil {
			t.Errorf("%s must not be null", key)
		}
	}
	for _, key := range []string{"channelSortMode", "jointChannelSortMode", "dmSortMode", "pinnedSortMode"} {
		if res.body[key] != "manual" {
			t.Errorf("%s = %v, want manual", key, res.body[key])
		}
	}
	if res.body["sectionsVersion"] != float64(0) || res.body["pinnedVersion"] != float64(0) {
		t.Errorf("versions must start at 0: %s", res.raw)
	}
}
