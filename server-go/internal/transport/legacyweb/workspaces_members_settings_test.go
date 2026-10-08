package legacyweb_test

// T12/T13/T14: the member directory privacy rules, the aggregated settings
// shape and the onboarding-settings PATCH matrix (aliases, dismissals,
// manager gate, agent setter).

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestMembersDirectoryPrivacy(t *testing.T) {
	e := newTestEnv(t)
	_, ownerAccess, _ := e.fullAccount("mem-owner@example.test", "memowner")
	ws := e.createServer(t, ownerAccess, "Member Lab", "member-lab")

	memberID, memberAccess, _ := e.fullAccount("mem-member@example.test", "memmember")
	guestID, guestAccess, _ := e.fullAccount("mem-guest@example.test", "memguest")
	e.addMember(t, ws, memberID, "member")
	e.addMember(t, ws, guestID, "guest")

	fetch := func(token string) []map[string]any {
		t.Helper()
		res := e.serve("GET", "/api/servers/"+ws+"/members", nil, scoped(token, ws))
		if res.status != http.StatusOK {
			t.Fatalf("members: %d %s", res.status, res.raw)
		}
		var items []map[string]any
		if err := json.Unmarshal(res.raw, &items); err != nil {
			t.Fatalf("members not an array: %s", res.raw)
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
	if _, err := e.app.DB.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = ?`, ws); err != nil {
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
	res := e.serve("GET", "/api/servers/"+ws+"/members", nil, scoped(guestAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest members: %d %s", res.status, res.raw)
	}

	// Cross-workspace isolation: a second workspace's directory never mixes in.
	other := e.createServer(t, ownerAccess, "Other Lab", "other-lab")
	otherRes := e.serve("GET", "/api/servers/"+other+"/members", nil, scoped(ownerAccess, other))
	if otherRes.status != http.StatusOK {
		t.Fatalf("other workspace members: %d %s", otherRes.status, otherRes.raw)
	}
	var otherView []map[string]any
	if err := json.Unmarshal(otherRes.raw, &otherView); err != nil || len(otherView) != 1 {
		t.Fatalf("other workspace must list only its owner: %s", otherRes.raw)
	}
	if otherView[0]["userId"] == memberID || otherView[0]["userId"] == guestID {
		t.Errorf("cross-workspace member leaked: %v", otherView[0]["userId"])
	}
}

func TestSettingsShapes(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("settings-owner@example.test", "settingsowner")
	ws := e.createServer(t, access, "Settings Lab", "settings-lab")

	res := e.serve("GET", "/api/servers/"+ws+"/settings", nil, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("settings: %d %s", res.status, res.raw)
	}
	settings, _ := res.body["settings"].(map[string]any)
	if settings == nil {
		t.Fatalf("aggregated settings missing: %s", res.raw)
	}
	onboard, _ := settings["onboardSettings"].(map[string]any)
	if onboard == nil {
		t.Fatalf("onboardSettings missing: %s", res.raw)
	}
	for _, key := range []string{
		"onboardingAgentId", "agentAllChannelGreetingEnabled", "onboardingWizardEnabled",
		"setupModalReminderOptOut", "onboardingReminderOptOut",
		"dismissedAddComputerStepAt", "dismissedCreateAgentStepAt", "dismissedInviteStepAt",
		"dismissedCommunityStepAt", "dismissedNotificationStepAt",
		"onboardingWizardCurrentStep", "onboardingDmSentAt", "onboardingDmSentByAgentId",
	} {
		if _, present := onboard[key]; !present {
			t.Errorf("onboardSettings missing %q: %s", key, res.raw)
		}
	}
	if onboard["onboardingAgentId"] != nil || onboard["onboardingWizardEnabled"] != false ||
		onboard["setupModalReminderOptOut"] != false || onboard["onboardingReminderOptOut"] != false {
		t.Errorf("C0 defaults wrong: %s", res.raw)
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
		t.Errorf("feedbackSettings.enabled must be false at C0: %s", res.raw)
	}

	// The legacy GET /onboarding-settings returns exactly the inner object.
	inner := e.serve("GET", "/api/servers/"+ws+"/onboarding-settings", nil, scoped(access, ws))
	if inner.status != http.StatusOK {
		t.Fatalf("onboarding-settings: %d %s", inner.status, inner.raw)
	}
	for key, value := range onboard {
		if inner.body[key] != value {
			t.Errorf("inner projection drift at %q: %v vs %v", key, inner.body[key], value)
		}
	}

	// Guests are denied on both management surfaces.
	guestID, guestAccess, _ := e.fullAccount("settings-guest@example.test", "settingsguest")
	e.addMember(t, ws, guestID, "guest")
	for _, path := range []string{"/settings", "/onboarding-settings"} {
		res := e.serve("GET", "/api/servers/"+ws+path, nil, scoped(guestAccess, ws))
		if res.status != http.StatusForbidden || res.body["error"] != "Guests cannot access server management data" {
			t.Fatalf("guest %s: %d %s", path, res.status, res.raw)
		}
	}
}

func TestPatchOnboardingSettingsPreferences(t *testing.T) {
	e := newTestEnv(t)
	_, ownerAccess, _ := e.fullAccount("pref-owner@example.test", "prefowner")
	memberID, memberAccess, _ := e.fullAccount("pref-member@example.test", "prefmember")
	ws := e.createServer(t, ownerAccess, "Pref Lab", "pref-lab")
	e.addMember(t, ws, memberID, "member")

	patch := func(token string, body map[string]any) response {
		return e.serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", body, scoped(token, ws))
	}

	// An ordinary member updates their own preferences.
	res := patch(memberAccess, map[string]any{"dismissedAddComputerStep": true, "setupModalReminderOptOut": true})
	if res.status != http.StatusOK {
		t.Fatalf("member preference patch: %d %s", res.status, res.raw)
	}
	if res.body["setupModalReminderOptOut"] != true || res.body["onboardingReminderOptOut"] != true {
		t.Errorf("aliases must mirror one fact: %s", res.raw)
	}
	if res.body["dismissedAddComputerStepAt"] == nil {
		t.Errorf("dismissal=true must stamp a time: %s", res.raw)
	}

	// dismissal=false clears to null; wizard step round-trips; nothing about
	// this touches setup status.
	res = patch(memberAccess, map[string]any{"dismissedAddComputerStep": false, "onboardingWizardCurrentStep": "add-computer"})
	if res.status != http.StatusOK || res.body["dismissedAddComputerStepAt"] != nil {
		t.Fatalf("dismissal=false must clear: %d %s", res.status, res.raw)
	}
	if res.body["onboardingWizardCurrentStep"] != "add-computer" {
		t.Errorf("wizard step not stored: %s", res.raw)
	}
	status, reason := e.setupRow(t, ws, memberID)
	if status != "not_started" || reason.Valid {
		t.Errorf("preferences must never complete setup: %q %v", status, reason)
	}

	// Alias precedence: null setupModal falls through to onboardingReminder.
	res = patch(memberAccess, map[string]any{"setupModalReminderOptOut": nil, "onboardingReminderOptOut": false})
	if res.status != http.StatusOK || res.body["setupModalReminderOptOut"] != false {
		t.Fatalf("alias coalescing: %d %s", res.status, res.raw)
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
		if res.status != http.StatusBadRequest {
			t.Errorf("%s: %d %s", tc.name, res.status, res.raw)
			continue
		}
		wantError(t, res.body, tc.errMsg)
	}

	// Manager fields from a plain member: the capability 403.
	res = patch(memberAccess, map[string]any{"agentAllChannelGreetingEnabled": false})
	if res.status != http.StatusForbidden || res.body["error"] != "Only server owners and admins can update onboarding settings" {
		t.Fatalf("member manager field: %d %s", res.status, res.raw)
	}

	// setupStatus in the body is inert (T22).
	res = patch(ownerAccess, map[string]any{"setupStatus": "complete", "setupModalReminderOptOut": false})
	if res.status != http.StatusOK {
		t.Fatalf("setupStatus injection: %d %s", res.status, res.raw)
	}
	me := e.serve("GET", "/api/auth/me", nil, bearer(ownerAccess))
	status, _ = e.setupRow(t, ws, me.body["id"].(string))
	if status == "complete" {
		t.Fatal("body setupStatus completed setup")
	}
}

func TestPatchOnboardingSettingsAgentSetter(t *testing.T) {
	e := newTestEnv(t)
	ownerID, ownerAccess, _ := e.fullAccount("agent-owner@example.test", "agentowner")
	ws := e.createServer(t, ownerAccess, "Agent Lab", "agent-lab")

	patch := func(body map[string]any) response {
		return e.serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", body, scoped(ownerAccess, ws))
	}

	// Unknown / cross-workspace agent IDs are rejected with the legacy sentence.
	res := patch(map[string]any{"onboardingAgentId": "no-such-agent"})
	if res.status != http.StatusBadRequest || res.body["error"] != "Onboarding agent not found in this server" {
		t.Fatalf("invalid agent: %d %s", res.status, res.raw)
	}

	// A real active local agent (isolated fixture) is accepted; the setter
	// reconciles the incomplete owner to complete/grandfathered (D11).
	e.seedAgent(t, "agent-1", ws, "Helper")
	res = patch(map[string]any{"onboardingAgentId": "agent-1"})
	if res.status != http.StatusOK || res.body["onboardingAgentId"] != "agent-1" {
		t.Fatalf("valid agent setter: %d %s", res.status, res.raw)
	}
	status, reason := e.setupRow(t, ws, ownerID)
	if status != "complete" || reason.String != "grandfathered" {
		t.Fatalf("setter must reconcile owner to complete/grandfathered: %q %v", status, reason)
	}

	// Null clears the pointer; an already-complete owner keeps the reason.
	res = patch(map[string]any{"onboardingAgentId": nil})
	if res.status != http.StatusOK || res.body["onboardingAgentId"] != nil {
		t.Fatalf("clear agent: %d %s", res.status, res.raw)
	}
	status, reason = e.setupRow(t, ws, ownerID)
	if status != "complete" || reason.String != "grandfathered" {
		t.Fatalf("clearing must not regress completion: %q %v", status, reason)
	}
}

func TestPatchOnboardingSettingsIsAtomic(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("atomic-owner@example.test", "atomicowner")
	ws := e.createServer(t, access, "Atomic Lab", "atomic-lab")

	// A combined manager+preference PATCH whose preference write fails must
	// not leave the manager half applied (the approved single-transaction
	// improvement over the legacy two-write path).
	if _, err := e.app.DB.Exec(`CREATE TRIGGER reject_pref_update BEFORE UPDATE OF setup_modal_reminder_opt_out ON workspace_member_preferences
		BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END`); err != nil {
		t.Fatal(err)
	}
	res := e.serve("PATCH", "/api/servers/"+ws+"/onboarding-settings", map[string]any{
		"agentAllChannelGreetingEnabled": false, "setupModalReminderOptOut": true,
	}, scoped(access, ws))
	if res.status != http.StatusInternalServerError || res.body["error"] != "Failed to update onboarding settings" {
		t.Fatalf("combined patch failure: %d %s", res.status, res.raw)
	}
	var greeting int
	if err := e.app.DB.QueryRow(`SELECT agent_all_channel_greeting_enabled FROM workspaces WHERE id = ?`, ws).Scan(&greeting); err != nil {
		t.Fatal(err)
	}
	if greeting != 1 {
		t.Fatal("manager half of a failed combined patch must roll back")
	}
}
