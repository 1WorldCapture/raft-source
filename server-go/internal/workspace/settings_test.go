// Behavioral tests for the M2 settings worker slice: aggregated settings
// reads, onboarding preference writes with the exact legacy validation
// contract, and the configured-agent checkpoint path.
package workspace_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

// m2sMembership inserts a membership with an explicit role (roles other than
// owner have no creation path in M2; tests seed them directly).
func m2sMembership(t *testing.T, handle *sql.DB, workspaceID, userID, role string, joinedAt int64) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspaceID, userID, role, joinedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`,
		workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
		VALUES (?, ?, 'not_started', NULL, 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// m2sAgent inserts a real agent-directory row (M2 has no agent writer; valid
// rows exist only in fixtures).
func m2sAgent(t *testing.T, handle *sql.DB, id, workspaceID string, deleted bool) {
	t.Helper()
	var deletedAt any
	if deleted {
		deletedAt = time.Now().UnixMilli()
	}
	if _, err := handle.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, deleted_at, created_at, updated_at)
		VALUES (?, ?, ?, 'active', 'claude', ?, 1, 1)`, id, workspaceID, "agent-"+id, deletedAt); err != nil {
		t.Fatal(err)
	}
}

func mustGetSettings(t *testing.T, store *workspace.Store, workspaceID, userID string) map[string]any {
	t.Helper()
	out, err := store.GetSettings(context.Background(), workspaceID, userID)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	return out
}

func defaultOnboardSettings() map[string]any {
	return map[string]any{
		"onboardingAgentId":              nil,
		"agentAllChannelGreetingEnabled": true,
		"onboardingWizardEnabled":        false,
		"setupModalReminderOptOut":       false,
		"onboardingReminderOptOut":       false,
		"dismissedAddComputerStepAt":     nil,
		"dismissedCreateAgentStepAt":     nil,
		"dismissedInviteStepAt":          nil,
		"dismissedCommunityStepAt":       nil,
		"dismissedNotificationStepAt":    nil,
		"onboardingWizardCurrentStep":    nil,
		"onboardingDmSentAt":             nil,
		"onboardingDmSentByAgentId":      nil,
	}
}

func TestGetSettingsC0DefaultShape(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")

	want := map[string]any{
		"settings": map[string]any{
			"onboardSettings":  defaultOnboardSettings(),
			"feedbackSettings": map[string]any{"enabled": false},
		},
	}
	got := mustGetSettings(t, store, record.ID, "owner-a")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("aggregated settings mismatch:\n got %#v\nwant %#v", got, want)
	}

	inner, err := store.GetOnboardingSettings(context.Background(), record.ID, "owner-a")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inner, defaultOnboardSettings()) {
		t.Fatalf("onboarding-settings inner mismatch:\n got %#v\nwant %#v", inner, defaultOnboardSettings())
	}
}

func TestGetSettingsWizardAndFeedbackPolicy(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "owner-b")
	store, _ := newTestStore(handle, workspace.Policy{
		OnboardingOwnerWizardV0: true,
		FeedbackEnabled:         true,
	})
	normal := mustCreate(t, store, "owner-a", "alpha-team")
	community := mustCreate(t, store, "owner-b", "community")

	got := mustGetSettings(t, store, normal.ID, "owner-a")
	settings := got["settings"].(map[string]any)
	onboard := settings["onboardSettings"].(map[string]any)
	if onboard["onboardingWizardEnabled"] != true {
		t.Fatalf("wizard flag must follow the frozen policy vector, got %v", onboard["onboardingWizardEnabled"])
	}
	if settings["feedbackSettings"].(map[string]any)["enabled"] != true {
		t.Fatal("feedbackSettings.enabled must report the policy truthfully")
	}

	// The community slugs override the wizard flag off regardless of policy.
	communitySettings := mustGetSettings(t, store, community.ID, "owner-b")
	communityOnboard := communitySettings["settings"].(map[string]any)["onboardSettings"].(map[string]any)
	if communityOnboard["onboardingWizardEnabled"] != false {
		t.Fatalf("community slug must force the wizard off, got %v", communityOnboard["onboardingWizardEnabled"])
	}
}

func TestGetSettingsMissingFactsAreServerNotFound(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "outsider")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	ctx := context.Background()

	// Non-member caller.
	_, err := store.GetSettings(ctx, record.ID, "outsider")
	de := domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("non-member read: got %v/%q", de.Code, de.Message)
	}

	// Soft-deleted workspace.
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 1 WHERE id = ?`, record.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.GetSettings(ctx, record.ID, "owner-a")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("deleted workspace: got %v/%q", de.Code, de.Message)
	}

	// Missing preference row is integrity drift, not invented defaults.
	other := mustCreate(t, store, "owner-a", "second-team")
	if _, err := handle.Exec(`DELETE FROM workspace_member_preferences WHERE workspace_id = ?`, other.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.GetSettings(ctx, other.ID, "owner-a")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("missing prefs row: got %v/%q", de.Code, de.Message)
	}
}

func TestUpdateOnboardingSettingsGuestAndPermissionGates(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	seedUser(t, handle, "guest-g")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "member-m", "member", 20)
	m2sMembership(t, handle, record.ID, "guest-g", "guest", 30)
	ctx := context.Background()

	// Guest callers never reach preference writes on these surfaces.
	_, err := store.UpdateOnboardingSettings(ctx, record.ID, "guest-g", map[string]any{
		"setupModalReminderOptOut": true,
	})
	de := domainError(t, err)
	if de.Code != "FORBIDDEN" || de.Message != "Guests cannot access server management data" {
		t.Fatalf("guest patch: got %v/%q", de.Code, de.Message)
	}

	// Ordinary members may not touch manager fields, either of them.
	for _, body := range []map[string]any{
		{"onboardingAgentId": nil},
		{"agentAllChannelGreetingEnabled": true},
	} {
		_, err := store.UpdateOnboardingSettings(ctx, record.ID, "member-m", body)
		de := domainError(t, err)
		if de.Code != "FORBIDDEN" || de.Message != "Only server owners and admins can update onboarding settings" {
			t.Fatalf("member manager patch %#v: got %v/%q", body, de.Code, de.Message)
		}
	}

	// Non-member caller.
	_, err = store.UpdateOnboardingSettings(ctx, record.ID, "outsider", map[string]any{
		"setupModalReminderOptOut": true,
	})
	if err == nil {
		t.Fatal("expected error for non-member")
	}
}

func TestUpdateOnboardingSettingsValidationContract(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	ctx := context.Background()

	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{"agent wrong type", map[string]any{"onboardingAgentId": 12}, "onboardingAgentId must be a string or null"},
		{"reminder wrong type", map[string]any{"setupModalReminderOptOut": "yes"}, "setupModalReminderOptOut must be a boolean"},
		{"reminder alias wrong type", map[string]any{"onboardingReminderOptOut": 1}, "setupModalReminderOptOut must be a boolean"},
		{"greeting wrong type", map[string]any{"agentAllChannelGreetingEnabled": "true"}, "agentAllChannelGreetingEnabled must be a boolean"},
		{"add computer wrong type", map[string]any{"dismissedAddComputerStep": 1}, "dismissedAddComputerStep must be a boolean"},
		{"create agent wrong type", map[string]any{"dismissedCreateAgentStep": nil}, "dismissedCreateAgentStep must be a boolean"},
		{"invite wrong type", map[string]any{"dismissedInviteStep": "x"}, "dismissedInviteStep must be a boolean"},
		{"community wrong type", map[string]any{"dismissedCommunityStep": 0}, "dismissedCommunityStep must be a boolean"},
		{"notification wrong type", map[string]any{"dismissedNotificationStep": 1.5}, "dismissedNotificationStep must be a boolean"},
		{"wizard wrong type", map[string]any{"onboardingWizardCurrentStep": 3}, "onboardingWizardCurrentStep must be a valid onboarding wizard step or null"},
		{"wizard unknown step", map[string]any{"onboardingWizardCurrentStep": "bogus"}, "onboardingWizardCurrentStep must be a valid onboarding wizard step or null"},
		{"empty body", map[string]any{}, "At least one field is required"},
		{"null-only reminder alias resolves to absent", map[string]any{"setupModalReminderOptOut": nil}, "At least one field is required"},
		{"unknown key only", map[string]any{"somethingElse": true}, "At least one field is required"},
	}
	for _, tc := range cases {
		_, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", tc.body)
		de := domainError(t, err)
		if de.Code != "INVALID_INPUT" || de.Message != tc.want {
			t.Fatalf("%s: got %v/%q want INVALID_INPUT/%q", tc.name, de.Code, de.Message, tc.want)
		}
	}

	// Validation order matches the legacy route: agent type error wins over a
	// simultaneous reminder type error.
	_, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId": 5, "setupModalReminderOptOut": "x",
	})
	de := domainError(t, err)
	if de.Message != "onboardingAgentId must be a string or null" {
		t.Fatalf("validation order: got %q", de.Message)
	}

	// Invalid input must never persist anything.
	var reminder bool
	if err := handle.QueryRow(`SELECT setup_modal_reminder_opt_out FROM workspace_member_preferences
		WHERE workspace_id = ? AND user_id = 'owner-a'`, record.ID).Scan(&reminder); err != nil || reminder {
		t.Fatalf("invalid patch must not write: err=%v reminder=%v", err, reminder)
	}
}

func TestUpdateOnboardingSettingsOwnPreferences(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	store, fixed := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "member-m", "member", 20)
	ctx := context.Background()
	stamp := fixedBase.UTC().Format("2006-01-02T15:04:05.000Z")

	// Dismissal true stamps the injected now; false clears to null.
	out, err := store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{
		"dismissedAddComputerStep": true, "dismissedInviteStep": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["dismissedAddComputerStepAt"] != stamp || out["dismissedInviteStepAt"] != stamp {
		t.Fatalf("dismissal stamps: got %#v", out)
	}
	fixed.Advance(time.Hour)
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{
		"dismissedAddComputerStep": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["dismissedAddComputerStepAt"] != nil {
		t.Fatalf("false must clear the dismissal, got %v", out["dismissedAddComputerStepAt"])
	}
	// The invite dismissal keeps the stamp of its own earlier write; the
	// advanced clock only proves the new write did not re-stamp it.
	if out["dismissedInviteStepAt"] != stamp {
		t.Fatalf("untouched dismissal keeps its stamp, got %v want %v", out["dismissedInviteStepAt"], stamp)
	}

	// Both reminder aliases point at the same stored fact; the alias key
	// alone is accepted, and nullish precedence follows the legacy ?? rule.
	for _, body := range []map[string]any{
		{"setupModalReminderOptOut": true},
		{"onboardingReminderOptOut": true},
		{"setupModalReminderOptOut": nil, "onboardingReminderOptOut": true},
	} {
		out, err := store.UpdateOnboardingSettings(ctx, record.ID, "member-m", body)
		if err != nil {
			t.Fatalf("%#v: %v", body, err)
		}
		if out["setupModalReminderOptOut"] != true || out["onboardingReminderOptOut"] != true {
			t.Fatalf("alias must update the same fact, got %#v", out)
		}
	}
	// Primary key wins over the alias when both carry values.
	if _, err := store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{
		"setupModalReminderOptOut": false, "onboardingReminderOptOut": true,
	}); err != nil {
		t.Fatal(err)
	}
	got := mustGetSettings(t, store, record.ID, "member-m")
	onboard := got["settings"].(map[string]any)["onboardSettings"].(map[string]any)
	if onboard["setupModalReminderOptOut"] != false {
		t.Fatalf("primary reminder value must win, got %v", onboard["setupModalReminderOptOut"])
	}

	// Wizard step: closed set + null clear; it is a preference, never setup.
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{
		"onboardingWizardCurrentStep": "create-agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingWizardCurrentStep"] != "create-agent" {
		t.Fatalf("wizard step write: got %#v", out)
	}
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{
		"onboardingWizardCurrentStep": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingWizardCurrentStep"] != nil {
		t.Fatalf("wizard step null clear: got %#v", out)
	}

	// Preferences never complete setup.
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup
		WHERE workspace_id = ? AND user_id = 'member-m'`, record.ID).Scan(&status); err != nil || status != "not_started" {
		t.Fatalf("dismissal must not complete setup: err=%v status=%q", err, status)
	}
}

func TestUpdateOnboardingSettingsManagerFields(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "admin-d")
	seedUser(t, handle, "owner-c")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "admin-d", "admin", 20)
	ctx := context.Background()

	// Greeting toggle by admin (capability, not ownerId guessing).
	out, err := store.UpdateOnboardingSettings(ctx, record.ID, "admin-d", map[string]any{
		"agentAllChannelGreetingEnabled": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["agentAllChannelGreetingEnabled"] != false {
		t.Fatalf("greeting toggle: got %#v", out)
	}

	// Null clears the pointer.
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingAgentId"] != nil {
		t.Fatalf("null must clear the agent pointer: got %#v", out)
	}

	// Unknown and cross-workspace agents are rejected with the exact sentence.
	other := mustCreate(t, store, "owner-c", "other-team")
	m2sAgent(t, handle, "agent-other-ws", other.ID, false)
	m2sAgent(t, handle, "agent-deleted", record.ID, true)
	for _, badID := range []string{"agent-other-ws", "agent-deleted", "no-such-agent"} {
		_, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
			"onboardingAgentId": badID,
		})
		de := domainError(t, err)
		if de.Code != "INVALID_INPUT" || de.Message != "Onboarding agent not found in this server" {
			t.Fatalf("agent %q: got %v/%q", badID, de.Code, de.Message)
		}
	}
	var pointer sql.NullString
	if err := handle.QueryRow(`SELECT onboarding_agent_id FROM workspaces WHERE id = ?`, record.ID).Scan(&pointer); err != nil {
		t.Fatal(err)
	}
	if pointer.Valid {
		t.Fatalf("rejected setter must not persist a pointer, got %q", pointer.String)
	}

	// Authorized valid setter: pointer stored and incomplete owners reconciled
	// to complete/grandfathered (the config-setter checkpoint, which is NOT
	// the official-identity rule of explicit complete).
	m2sMembership(t, handle, record.ID, "owner-c", "owner", 30) // co-owner, incomplete
	m2sAgent(t, handle, "agent-real", record.ID, false)
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId": "agent-real",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingAgentId"] != "agent-real" {
		t.Fatalf("valid setter: got %#v", out)
	}
	reasons := map[string]string{}
	rows, err := handle.Query(`SELECT user_id, status, COALESCE(completion_reason,'') FROM workspace_member_setup WHERE workspace_id = ?`, record.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var userID, status, reason string
		if err := rows.Scan(&userID, &status, &reason); err != nil {
			t.Fatal(err)
		}
		reasons[userID] = status + "/" + reason
	}
	rows.Close()
	for _, owner := range []string{"owner-a", "owner-c"} {
		if got := reasons[owner]; got != "complete/grandfathered" {
			t.Fatalf("owner %q must be reconciled to complete/grandfathered, got %q", owner, got)
		}
	}
	if got := reasons["admin-d"]; got != "not_started/" {
		t.Fatalf("non-owner setup rows must stay untouched, got %q", got)
	}

	// An already-complete owner keeps its original reason.
	if _, err := handle.Exec(`UPDATE workspace_member_setup
		SET status='complete', completion_reason='normal' WHERE workspace_id = ? AND user_id = 'admin-d'`, record.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId": nil,
	}); err != nil {
		t.Fatal(err)
	}
	m2sAgent(t, handle, "agent-second", record.ID, false)
	if _, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId": "agent-second",
	}); err != nil {
		t.Fatal(err)
	}
	var reason sql.NullString
	if err := handle.QueryRow(`SELECT completion_reason FROM workspace_member_setup
		WHERE workspace_id = ? AND user_id = 'admin-d'`, record.ID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if !reason.Valid || reason.String != "normal" {
		t.Fatalf("already-complete rows keep their reason, got %#v", reason)
	}
}

func TestUpdateOnboardingSettingsEmptyStringAgentFailsLikeLegacyUUIDCast(t *testing.T) {
	// Release-reviewed contract: an empty (but present) onboardingAgentId
	// follows the legacy PostgreSQL uuid-column failure path. In TS the
	// string passes the route type checks, the falsy agent lookup is
	// skipped, and the write transaction fails the uuid cast — the route
	// catch answers the ordinary endpoint 500 and NOTHING persists. The
	// domain returns a plain error (transport maps non-domain errors to that
	// 500); a DomainError here would invent a 4xx shape legacy never sent.
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "member-m", "member", fixedBase.UnixMilli()+60000)
	ctx := context.Background()

	// The failure lands after the identity/permission gates, exactly like
	// legacy (isMember 404 and the 403 gate run before the failing write).
	_, err := store.UpdateOnboardingSettings(ctx, record.ID, "outsider", map[string]any{"onboardingAgentId": ""})
	de := domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("membership gate must precede the uuid failure: got %v/%q", de.Code, de.Message)
	}
	_, err = store.UpdateOnboardingSettings(ctx, record.ID, "member-m", map[string]any{"onboardingAgentId": ""})
	de = domainError(t, err)
	if de.Code != "FORBIDDEN" || de.Message != "Only server owners and admins can update onboarding settings" {
		t.Fatalf("permission gate must precede the uuid failure: got %v/%q", de.Code, de.Message)
	}

	// Owner, "" alone: ordinary error (endpoint 500 shape), not a DomainError.
	_, err = store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{"onboardingAgentId": ""})
	if err == nil {
		t.Fatal("empty-string agent id must fail")
	}
	if workspace.AsDomainError(err) != nil {
		t.Fatalf("must be an ordinary error for the endpoint 500 path, got domain error %v", workspace.AsDomainError(err))
	}

	// Combined with otherwise-valid manager and preference fields the whole
	// PATCH still fails atomically: no empty pointer, no greeting flip, no
	// preference write, no updated_at bump, no owner reconcile.
	_, err = store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{
		"onboardingAgentId":              "",
		"agentAllChannelGreetingEnabled": false,
		"setupModalReminderOptOut":       true,
		"dismissedInviteStep":            true,
	})
	if err == nil || workspace.AsDomainError(err) != nil {
		t.Fatalf("combined patch must fail through the ordinary path: %v", err)
	}
	var pointer sql.NullString
	var greeting int
	if err := handle.QueryRow(`SELECT onboarding_agent_id, agent_all_channel_greeting_enabled
		FROM workspaces WHERE id = ?`, record.ID).Scan(&pointer, &greeting); err != nil {
		t.Fatal(err)
	}
	if pointer.Valid {
		t.Fatalf("no pointer may persist from a failed setter, got %q", pointer.String)
	}
	if greeting != 1 {
		t.Fatalf("greeting must stay untouched, got %d", greeting)
	}
	var reminder bool
	var invite sql.NullInt64
	if err := handle.QueryRow(`SELECT setup_modal_reminder_opt_out, dismissed_invite_step_at
		FROM workspace_member_preferences WHERE workspace_id = ? AND user_id = 'owner-a'`,
		record.ID).Scan(&reminder, &invite); err != nil {
		t.Fatal(err)
	}
	if reminder || invite.Valid {
		t.Fatalf("preferences must stay untouched, got reminder=%v invite=%v", reminder, invite)
	}
	var status string
	if err := handle.QueryRow(`SELECT status FROM workspace_member_setup
		WHERE workspace_id = ? AND user_id = 'owner-a'`, record.ID).Scan(&status); err != nil || status != "not_started" {
		t.Fatalf("no owner reconcile may happen: err=%v status=%q", err, status)
	}

	// The neighbor paths stay unchanged: null still clears, a valid fixture
	// agent still stores (reconcile covered by the manager-fields test).
	m2sAgent(t, handle, "agent-real", record.ID, false)
	out, err := store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{"onboardingAgentId": nil})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingAgentId"] != nil {
		t.Fatalf("null must still clear the pointer: got %#v", out["onboardingAgentId"])
	}
	out, err = store.UpdateOnboardingSettings(ctx, record.ID, "owner-a", map[string]any{"onboardingAgentId": "agent-real"})
	if err != nil {
		t.Fatal(err)
	}
	if out["onboardingAgentId"] != "agent-real" {
		t.Fatalf("valid fixture agent must still store: got %#v", out["onboardingAgentId"])
	}
	var stored sql.NullString
	if err := handle.QueryRow(`SELECT onboarding_agent_id FROM workspaces WHERE id = ?`, record.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !stored.Valid || stored.String != "agent-real" {
		t.Fatalf("valid pointer must persist, got %#v", stored)
	}
}

func TestUpdateOnboardingSettingsSingleTransactionRollback(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")

	// Fail the member-preference write while the manager fields would also
	// apply: nothing may persist (approved M2 atomicity improvement).
	if _, err := handle.Exec(`CREATE TRIGGER fail_prefs BEFORE UPDATE ON workspace_member_preferences
		BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, err := store.UpdateOnboardingSettings(context.Background(), record.ID, "owner-a", map[string]any{
		"agentAllChannelGreetingEnabled": false,
		"setupModalReminderOptOut":       true,
	})
	if err == nil {
		t.Fatal("expected injected failure")
	}
	var greeting int
	var reminder bool
	if err := handle.QueryRow(`SELECT agent_all_channel_greeting_enabled FROM workspaces WHERE id = ?`, record.ID).Scan(&greeting); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT setup_modal_reminder_opt_out FROM workspace_member_preferences
		WHERE workspace_id = ? AND user_id = 'owner-a'`, record.ID).Scan(&reminder); err != nil {
		t.Fatal(err)
	}
	if greeting != 1 || reminder {
		t.Fatalf("combined patch must roll back completely: greeting=%d reminder=%v", greeting, reminder)
	}
}

// TestM1MembershipsGetPreferenceRowsOnUpgrade proves the 0005 backfill: a
// genuine M1 database (0001 only, memberships included) upgrades through the
// full chain and every legacy membership receives one default preferences
// row, while post-upgrade creation still inserts its own row without PK
// conflicts.
func TestM1MembershipsGetPreferenceRowsOnUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raft.db")
	raw := openRawSQLite(t, path)

	m1SQL, err := os.ReadFile(filepath.Join("..", "platform", "db", "migrations", "0001_init.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(string(m1SQL)); err != nil {
		t.Fatalf("apply 0001: %v", err)
	}
	if _, err := raw.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO schema_migrations(version, applied_at) VALUES ('0001_init.sql', 1)`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"legacy-owner", "legacy-member", "fresh-owner"} {
		if _, err := raw.Exec(`
			INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
			VALUES (?, ?, ?, 'hash', 11, 11)`, id, id+"@legacy.test", id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`
		INSERT INTO workspaces (id, name, slug, owner_id, hide_humans_from_members, plan, created_at)
		VALUES ('legacy-ws', 'Legacy', 'legacy-ws', 'legacy-owner', 0, 'free', 22)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		user, role string
		joined     int64
	}{
		{"legacy-owner", "owner", 33}, {"legacy-member", "member", 44},
	} {
		if _, err := raw.Exec(`
			INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
			VALUES ('legacy-ws', ?, ?, ?)`, row.user, row.role, row.joined); err != nil {
			t.Fatal(err)
		}
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	// Upgrade runs the whole chain, 0003 membership rebuild included; the
	// 0005 backfill must run against the rebuilt table and not conflict with
	// anything 0004 created.
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	if got := countRows(t, handle, `SELECT COUNT(*) FROM workspace_member_preferences`); got != 2 {
		t.Fatalf("both legacy memberships must get a preferences row, got %d", got)
	}
	var reminder, chSort, versions int
	if err := handle.QueryRow(`
		SELECT setup_modal_reminder_opt_out, sidebar_channel_sort_mode = 'manual',
		       (sidebar_sections_version = 0) + (pinned_version = 0)
		FROM workspace_member_preferences WHERE workspace_id = 'legacy-ws' AND user_id = 'legacy-member'`).
		Scan(&reminder, &chSort, &versions); err != nil {
		t.Fatal(err)
	}
	if reminder != 0 || chSort != 1 || versions != 2 {
		t.Fatalf("backfilled row must carry pure defaults: reminder=%d chSort=%d versions=%d", reminder, chSort, versions)
	}

	// A workspace created after the upgrade adds its own row on top.
	store, _ := newTestStore(handle, workspace.Policy{})
	fresh := mustCreate(t, store, "fresh-owner", "fresh-team")
	if got := countRows(t, handle, `SELECT COUNT(*) FROM workspace_member_preferences`); got != 3 {
		t.Fatalf("post-upgrade creation must add one row, got %d", got)
	}
	got := mustGetSettings(t, store, fresh.ID, "fresh-owner")
	if !reflect.DeepEqual(got["settings"].(map[string]any)["onboardSettings"], defaultOnboardSettings()) {
		t.Fatalf("fresh owner defaults: %#v", got)
	}
	// The legacy member reads real defaults too.
	legacy := mustGetSettings(t, store, "legacy-ws", "legacy-member")
	if !reflect.DeepEqual(legacy["settings"].(map[string]any)["onboardSettings"], defaultOnboardSettings()) {
		t.Fatalf("legacy member defaults: %#v", legacy)
	}
}
