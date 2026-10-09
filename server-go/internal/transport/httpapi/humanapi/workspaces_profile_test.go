package humanapi_test

// T10: PATCH /api/servers/:id — capability gate before validation, the exact
// name rules (string, trimmed non-empty, <=100 UTF-16 units), boolean typing,
// at-least-one-field, and no privilege field can move through this route.

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
	"time"
)

func TestPatchWorkspaceProfileValidation(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("patch-owner@example.test", "patchowner")
	ws := e.CreateServer(t, access, "Patch Lab", "patch-lab")

	cases := []struct {
		name   string
		body   map[string]any
		errMsg string
	}{
		{"non-string name", map[string]any{"name": 42}, "Name must be a string"},
		{"null name", map[string]any{"name": nil}, "Name must be a string"},
		{"name only spaces", map[string]any{"name": "   "}, "Name is required"},
		{"name 101 ascii", map[string]any{"name": strings.Repeat("a", 101)}, "Name must be 100 characters or fewer"},
		{"name 51 emoji (102 utf16 units)", map[string]any{"name": strings.Repeat("😀", 51)}, "Name must be 100 characters or fewer"},
		{"hideHumans non-boolean", map[string]any{"hideHumansFromMembers": "yes"}, "hideHumansFromMembers must be a boolean"},
		{"hideHumans null", map[string]any{"hideHumansFromMembers": nil}, "hideHumansFromMembers must be a boolean"},
		{"empty body", map[string]any{}, "At least one field is required"},
		{"only unknown fields", map[string]any{"slug": "new-slug", "ownerId": "x"}, "At least one field is required"},
	}
	for _, tc := range cases {
		res := e.Serve("PATCH", "/api/servers/"+ws, tc.body, testkit.Scoped(access, ws))
		if res.Status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400 (%s)", tc.name, res.Status, res.Raw)
			continue
		}
		testkit.WantError(t, res.Body, tc.errMsg)
	}

	// 100 ascii and 50 emoji are exactly at the boundary and succeed.
	for _, name := range []string{strings.Repeat("a", 100), strings.Repeat("😀", 50)} {
		res := e.Serve("PATCH", "/api/servers/"+ws, map[string]any{"name": name}, testkit.Scoped(access, ws))
		if res.Status != http.StatusOK || res.Body["name"] != name {
			t.Errorf("boundary name rejected: %d %s", res.Status, res.Raw)
		}
	}
}

func TestPatchWorkspaceProfileCapabilities(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("cap-owner@example.test", "capowner")
	ws := e.CreateServer(t, access, "Cap Lab", "cap-lab")

	adminID, adminAccess, _ := e.FullAccount("cap-admin@example.test", "capadmin")
	memberID, memberAccess, _ := e.FullAccount("cap-member@example.test", "capmember")
	guestID, guestAccess, _ := e.FullAccount("cap-guest@example.test", "capguest")
	e.AddMember(t, ws, adminID, "admin")
	e.AddMember(t, ws, memberID, "member")
	e.AddMember(t, ws, guestID, "guest")

	// Role check precedes validation: an invalid body from a member still
	// yields the capability 403, never the 400.
	res := e.Serve("PATCH", "/api/servers/"+ws, map[string]any{"name": 42}, testkit.Scoped(memberAccess, ws))
	if res.Status != http.StatusForbidden || res.Body["error"] != "Only server owners and admins can edit the server profile" {
		t.Fatalf("member: %d %s", res.Status, res.Raw)
	}
	res = e.Serve("PATCH", "/api/servers/"+ws, map[string]any{"name": 42}, testkit.Scoped(guestAccess, ws))
	if res.Status != http.StatusForbidden {
		t.Fatalf("guest: %d %s", res.Status, res.Raw)
	}

	// Admin succeeds; name is stored trimmed.
	res = e.Serve("PATCH", "/api/servers/"+ws, map[string]any{"name": "  Trimmed Name  ", "hideHumansFromMembers": true}, testkit.Scoped(adminAccess, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("admin patch: %d %s", res.Status, res.Raw)
	}
	if res.Body["name"] != "Trimmed Name" || res.Body["hideHumansFromMembers"] != true {
		t.Fatalf("patch result wrong: %s", res.Raw)
	}
	if res.Body["slug"] != "cap-lab" || res.Body["ownerId"] != ownerID || res.Body["plan"] != "free" {
		t.Fatalf("identity fields changed: %s", res.Raw)
	}

	// createdAt is stable, updatedAt refreshes.
	time.Sleep(10 * time.Millisecond)
	res = e.Serve("PATCH", "/api/servers/"+ws, map[string]any{"name": "Again"}, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("owner patch: %d %s", res.Status, res.Raw)
	}
	if res.Body["createdAt"] == res.Body["updatedAt"] {
		t.Errorf("updatedAt must refresh: %s", res.Raw)
	}
	// Persisted: re-read through the detail endpoint.
	detail := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(access, ws))
	if detail.Body["name"] != "Again" || detail.Body["hideHumansFromMembers"] != true {
		t.Fatalf("detail after patch: %s", detail.Raw)
	}
}

func TestPatchWorkspaceRejectsPrivilegeFields(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("patch-inject@example.test", "injector")
	ws := e.CreateServer(t, access, "Inject Lab", "inject-lab")

	res := e.Serve("PATCH", "/api/servers/"+ws, map[string]any{
		"name": "Inject", "slug": "new-slug", "ownerId": "someone-else",
		"plan": "pro", "kind": "joint_storage", "onboardingAgentId": "agent-x",
	}, testkit.Scoped(access, ws))
	if res.Status != http.StatusOK {
		t.Fatalf("patch: %d %s", res.Status, res.Raw)
	}
	if res.Body["slug"] != "inject-lab" || res.Body["ownerId"] != ownerID ||
		res.Body["plan"] != "free" || res.Body["kind"] != "normal" || res.Body["onboardingAgentId"] != nil {
		t.Fatalf("privilege injection moved a column: %s", res.Raw)
	}
}
