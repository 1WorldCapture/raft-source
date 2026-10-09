package humanapi_test

// T12/T13/T14: the member directory privacy rules, the aggregated settings
// shape and the onboarding-settings PATCH matrix (aliases, dismissals,
// manager gate, agent setter).

import (
	"encoding/json"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func TestMembersDirectoryPrivacy(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, ownerAccess, _ := e.FullAccount("mem-owner@example.test", "memowner")
	ws := e.CreateServer(t, ownerAccess, "Member Lab", "member-lab")

	memberID, memberAccess, _ := e.FullAccount("mem-member@example.test", "memmember")
	guestID, guestAccess, _ := e.FullAccount("mem-guest@example.test", "memguest")
	e.AddMember(t, ws, memberID, "member")
	e.AddMember(t, ws, guestID, "guest")

	fetch := func(token string) []map[string]any {
		t.Helper()
		res := e.Serve("GET", "/api/servers/"+ws+"/members", nil, testkit.Scoped(token, ws))
		if res.Status != http.StatusOK {
			t.Fatalf("members: %d %s", res.Status, res.Raw)
		}
		var items []map[string]any
		if err := json.Unmarshal(res.Raw, &items); err != nil {
			t.Fatalf("members not an array: %s", res.Raw)
		}
		return items
	}

	// Owner sees every member's email; ordinary members see only their own.
	ownerView := fetch(ownerAccess)
	if len(ownerView) != 3 {
		t.Fatalf("owner must see all members: %d", len(ownerView))
	}
	for _, m := range ownerView {
		if m["email"] == nil {
			t.Errorf("owner must see email of %v", m["userId"])
		}
		if m["gravatarHash"] == nil || m["gravatarHash"] == "" {
			t.Errorf("gravatarHash must survive: %v", m)
		}
		for _, key := range []string{"userId", "email", "name", "displayName", "description", "avatarUrl", "role", "joinedAt", "gravatarHash"} {
			if _, present := m[key]; !present {
				t.Errorf("member field %q missing", key)
			}
		}
	}

	memberView := fetch(memberAccess)
	if len(memberView) != 3 {
		t.Fatalf("member must see the directory: %d", len(memberView))
	}
	for _, m := range memberView {
		if m["userId"] == memberID && m["email"] == nil {
			t.Error("member must see own email")
		}
		if m["userId"] != memberID && m["email"] != nil {
			t.Errorf("peer email leaked: %v", m["email"])
		}
		// gravatarHash stays derived from the real email even when hidden.
		if m["gravatarHash"] == "" {
			t.Error("gravatarHash dropped for hidden email")
		}
	}

	// hideHumansFromMembers=true: an ordinary member's directory is only
	// themselves; owner/admin keep the full management directory.
	if _, err := e.App.DB.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = ?`, ws); err != nil {
		t.Fatal(err)
	}
	memberView = fetch(memberAccess)
	if len(memberView) != 1 || memberView[0]["userId"] != memberID {
		t.Fatalf("hidden directory must reduce member to self: %d entries", len(memberView))
	}
	if len(fetch(ownerAccess)) != 3 {
		t.Fatal("owner must keep the full directory")
	}

	// Guests are rejected by this endpoint itself.
	res := e.Serve("GET", "/api/servers/"+ws+"/members", nil, testkit.Scoped(guestAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest members: %d %s", res.Status, res.Raw)
	}

	// Cross-workspace isolation: a second workspace's directory never mixes in.
	other := e.CreateServer(t, ownerAccess, "Other Lab", "other-lab")
	otherRes := e.Serve("GET", "/api/servers/"+other+"/members", nil, testkit.Scoped(ownerAccess, other))
	if otherRes.Status != http.StatusOK {
		t.Fatalf("other workspace members: %d %s", otherRes.Status, otherRes.Raw)
	}
	var otherView []map[string]any
	if err := json.Unmarshal(otherRes.Raw, &otherView); err != nil || len(otherView) != 1 {
		t.Fatalf("other workspace must list only its owner: %s", otherRes.Raw)
	}
	if otherView[0]["userId"] == memberID || otherView[0]["userId"] == guestID {
		t.Errorf("cross-workspace member leaked: %v", otherView[0]["userId"])
	}
}

func TestSettingsShapes(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("settings-owner@example.test", "settingsowner")
	ws := e.CreateServer(t, access, "Settings Lab", "settings-lab")

	res := e.Serve("GET", "/api/servers/"+ws+"/settings", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("settings: %d %s", res.Status, res.Raw)
	}
	settings, _ := res.Body["settings"].(map[string]any)
	if settings == nil {
		t.Fatalf("aggregated settings missing: %s", res.Raw)
	}
	onboard, _ := settings["onboardSettings"].(map[string]any)
	if onboard == nil {
		t.Fatalf("onboardSettings missing: %s", res.Raw)
	}
	for _, key := range []string{
		"onboardingAgentId", "agentAllChannelGreetingEnabled", "onboardingWizardEnabled",
		"setupModalReminderOptOut", "onboardingReminderOptOut",
		"dismissedAddComputerStepAt", "dismissedCreateAgentStepAt", "dismissedInviteStepAt",
		"dismissedCommunityStepAt", "dismissedNotificationStepAt",
		"onboardingWizardCurrentStep", "onboardingDmSentAt", "onboardingDmSentByAgentId",
	} {
		if _, present := onboard[key]; !present {
			t.Errorf("onboardSettings missing %q: %s", key, res.Raw)
		}
	}
	if onboard["onboardingAgentId"] != nil || onboard["onboardingWizardEnabled"] != false ||
		onboard["setupModalReminderOptOut"] != false || onboard["onboardingReminderOptOut"] != false {
		t.Errorf("C0 defaults wrong: %s", res.Raw)
	}
	for _, nullField := range []string{"dismissedAddComputerStepAt", "dismissedCreateAgentStepAt",
		"dismissedInviteStepAt", "dismissedCommunityStepAt", "dismissedNotificationStepAt",
		"onboardingWizardCurrentStep", "onboardingDmSentAt", "onboardingDmSentByAgentId"} {
		if v, present := onboard[nullField]; !present || v != nil {
			t.Errorf("%s must be present null: %v", nullField, v)
		}
	}
	feedback, _ := settings["feedbackSettings"].(map[string]any)
	if feedback == nil || feedback["enabled"] != false {
		t.Errorf("feedbackSettings.enabled must be false at C0: %s", res.Raw)
	}

	// The legacy GET /onboarding-settings returns exactly the inner object.
	inner := e.Serve("GET", "/api/servers/"+ws+"/onboarding-settings", nil, testkit.Scoped(access, ws))
	if inner.Status != http.StatusOK {
		t.Fatalf("onboarding-settings: %d %s", inner.Status, inner.Raw)
	}
	for key, value := range onboard {
		if inner.Body[key] != value {
			t.Errorf("inner projection drift at %q: %v vs %v", key, inner.Body[key], value)
		}
	}

	// Guests are denied on both management surfaces.
	guestID, guestAccess, _ := e.FullAccount("settings-guest@example.test", "settingsguest")
	e.AddMember(t, ws, guestID, "guest")
	for _, path := range []string{"/settings", "/onboarding-settings"} {
		res := e.Serve("GET", "/api/servers/"+ws+path, nil, testkit.Scoped(guestAccess, ws))
		if res.Status != http.StatusForbidden || res.Body["error"] != "Guests cannot access server management data" {
			t.Fatalf("guest %s: %d %s", path, res.Status, res.Raw)
		}
	}
}

func TestPatchOnboardingSettingsPreferences(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, ownerAccess, _ := e.FullAccount("pref-owner@example.test", "prefowner")
	memberID, memberAccess, _ := e.FullAccount("pref-member@example.test", "prefmember")
	ws := e.CreateServer(t, ownerAccess, "Pref Lab", "pref-lab")
	e.AddMember(t, ws, memberID, "member")

	patch := func(token string, body map[string]any) testkit.Response {
		return e.Serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", body, testkit.Scoped(token, ws))
	}

	// An ordinary member updates their own preferences.
	res := patch(memberAccess, map[string]any{"dismissedAddComputerStep": true, "setupModalReminderOptOut": true})
	if res.Status != http.StatusOK {
		t.Fatalf("member preference patch: %d %s", res.Status, res.Raw)
	}
	if res.Body["setupModalReminderOptOut"] != true || res.Body["onboardingReminderOptOut"] != true {
		t.Errorf("aliases must mirror one fact: %s", res.Raw)
	}
	if res.Body["dismissedAddComputerStepAt"] == nil {
		t.Errorf("dismissal=true must stamp a time: %s", res.Raw)
	}

	// dismissal=false clears to null; wizard step round-trips; nothing about
	// this touches setup status.
	res = patch(memberAccess, map[string]any{"dismissedAddComputerStep": false, "onboardingWizardCurrentStep": "add-computer"})
	if res.Status != http.StatusOK || res.Body["dismissedAddComputerStepAt"] != nil {
		t.Fatalf("dismissal=false must clear: %d %s", res.Status, res.Raw)
	}
	if res.Body["onboardingWizardCurrentStep"] != "add-computer" {
		t.Errorf("wizard step not stored: %s", res.Raw)
	}
	status, reason := e.SetupRow(t, ws, memberID)
	if status != "not_started" || reason.Valid {
		t.Errorf("preferences must never complete setup: %q %v", status, reason)
	}

	// Alias precedence: null setupModal falls through to onboardingReminder.
	res = patch(memberAccess, map[string]any{"setupModalReminderOptOut": nil, "onboardingReminderOptOut": false})
	if res.Status != http.StatusOK || res.Body["setupModalReminderOptOut"] != false {
		t.Fatalf("alias coalescing: %d %s", res.Status, res.Raw)
	}

	// Validation sentences and order.
	cases := []struct {
		name   string
		body   map[string]any
		errMsg string
	}{
		{"agent id type", map[string]any{"onboardingAgentId": 42}, "onboardingAgentId must be a string or null"},
		{"reminder type", map[string]any{"setupModalReminderOptOut": "yes"}, "setupModalReminderOptOut must be a boolean"},
		{"greeting type", map[string]any{"agentAllChannelGreetingEnabled": 1}, "agentAllChannelGreetingEnabled must be a boolean"},
		{"dismissal type", map[string]any{"dismissedInviteStep": 1}, "dismissedInviteStep must be a boolean"},
		{"wizard step invalid", map[string]any{"onboardingWizardCurrentStep": "bogus"}, "onboardingWizardCurrentStep must be a valid onboarding wizard step or null"},
		{"empty body", map[string]any{}, "At least one field is required"},
		{"only unknown fields", map[string]any{"translationEnabled": true}, "At least one field is required"},
	}
	for _, tc := range cases {
		res = patch(ownerAccess, tc.body)
		if res.Status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", tc.name, res.Status, res.Raw)
			continue
		}
		testkit.WantError(t, res.Body, tc.errMsg)
	}

	// Manager fields from a plain member: the capability 403.
	res = patch(memberAccess, map[string]any{"agentAllChannelGreetingEnabled": false})
	if res.Status != http.StatusForbidden || res.Body["error"] != "Only server owners and admins can update onboarding settings" {
		t.Fatalf("member manager field: %d %s", res.Status, res.Raw)
	}

	// setupStatus in the body is inert (T22).
	res = patch(ownerAccess, map[string]any{"setupStatus": "complete", "setupModalReminderOptOut": false})
	if res.Status != http.StatusOK {
		t.Fatalf("setupStatus injection: %d %s", res.Status, res.Raw)
	}
	me := e.Serve("GET", "/api/auth/me", nil, testkit.Bearer(ownerAccess))
	status, _ = e.SetupRow(t, ws, me.Body["id"].(string))
	if status == "complete" {
		t.Fatal("body setupStatus completed setup")
	}
}

func TestPatchOnboardingSettingsAgentSetter(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, ownerAccess, _ := e.FullAccount("agent-owner@example.test", "agentowner")
	ws := e.CreateServer(t, ownerAccess, "Agent Lab", "agent-lab")

	patch := func(body map[string]any) testkit.Response {
		return e.Serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", body, testkit.Scoped(ownerAccess, ws))
	}

	// Unknown / cross-workspace agent IDs are rejected with the legacy sentence.
	res := patch(map[string]any{"onboardingAgentId": "no-such-agent"})
	if res.Status != http.StatusBadRequest || res.Body["error"] != "Onboarding agent not found in this server" {
		t.Fatalf("invalid agent: %d %s", res.Status, res.Raw)
	}

	// A real active local agent (isolated fixture) is accepted; the setter
	// reconciles the incomplete owner to complete/grandfathered (D11).
	e.SeedAgent(t, "agent-1", ws, "Helper")
	res = patch(map[string]any{"onboardingAgentId": "agent-1"})
	if res.Status != http.StatusOK || res.Body["onboardingAgentId"] != "agent-1" {
		t.Fatalf("valid agent setter: %d %s", res.Status, res.Raw)
	}
	status, reason := e.SetupRow(t, ws, ownerID)
	if status != "complete" || reason.String != "grandfathered" {
		t.Fatalf("setter must reconcile owner to complete/grandfathered: %q %v", status, reason)
	}

	// Null clears the pointer; an already-complete owner keeps the reason.
	res = patch(map[string]any{"onboardingAgentId": nil})
	if res.Status != http.StatusOK || res.Body["onboardingAgentId"] != nil {
		t.Fatalf("clear agent: %d %s", res.Status, res.Raw)
	}
	status, reason = e.SetupRow(t, ws, ownerID)
	if status != "complete" || reason.String != "grandfathered" {
		t.Fatalf("clearing must not regress completion: %q %v", status, reason)
	}
}

func TestPatchOnboardingSettingsIsAtomic(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("atomic-owner@example.test", "atomicowner")
	ws := e.CreateServer(t, access, "Atomic Lab", "atomic-lab")

	// A combined manager+preference PATCH whose preference write fails must
	// not leave the manager half applied (the approved single-transaction
	// improvement over the legacy two-write path).
	if _, err := e.App.DB.Exec(`CREATE TRIGGER reject_pref_update BEFORE UPDATE OF setup_modal_reminder_opt_out ON workspace_member_preferences
		BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END`); err != nil {
		t.Fatal(err)
	}
	res := e.Serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", map[string]any{
		"agentAllChannelGreetingEnabled": false, "setupModalReminderOptOut": true,
	}, testkit.Scoped(access, ws))
	if res.Status != http.StatusInternalServerError || res.Body["error"] != "Failed to update onboarding settings" {
		t.Fatalf("combined patch failure: %d %s", res.Status, res.Raw)
	}
	var greeting int
	if err := e.App.DB.QueryRow(`SELECT agent_all_channel_greeting_enabled FROM workspaces WHERE id = ?`, ws).Scan(&greeting); err != nil {
		t.Fatal(err)
	}
	if greeting != 1 {
		t.Fatal("manager half of a failed combined patch must roll back")
	}
}
