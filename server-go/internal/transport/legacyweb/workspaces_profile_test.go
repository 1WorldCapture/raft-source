package legacyweb_test

// T10: PATCH /api/servers/:id — capability gate before validation, the exact
// name rules (string, trimmed non-empty, <=100 UTF-16 units), boolean typing,
// at-least-one-field, and no privilege field can move through this route.

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPatchWorkspaceProfileValidation(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("patch-owner@example.test", "patchowner")
	ws := e.createServer(t, access, "Patch Lab", "patch-lab")

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
		res := e.serve("PATCH", "/api/servers/"+ws, tc.body, scoped(access, ws))
		if res.status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400 (%s)", tc.name, res.status, res.raw)
			continue
		}
		wantError(t, res.body, tc.errMsg)
	}

	// 100 ascii and 50 emoji are exactly at the boundary and succeed.
	for _, name := range []string{strings.Repeat("a", 100), strings.Repeat("😀", 50)} {
		res := e.serve("PATCH", "/api/servers/"+ws, map[string]any{"name": name}, scoped(access, ws))
		if res.status != http.StatusOK || res.body["name"] != name {
			t.Errorf("boundary name rejected: %d %s", res.status, res.raw)
		}
	}
}

func TestPatchWorkspaceProfileCapabilities(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("cap-owner@example.test", "capowner")
	ws := e.createServer(t, access, "Cap Lab", "cap-lab")

	adminID, adminAccess, _ := e.fullAccount("cap-admin@example.test", "capadmin")
	memberID, memberAccess, _ := e.fullAccount("cap-member@example.test", "capmember")
	guestID, guestAccess, _ := e.fullAccount("cap-guest@example.test", "capguest")
	e.addMember(t, ws, adminID, "admin")
	e.addMember(t, ws, memberID, "member")
	e.addMember(t, ws, guestID, "guest")

	// Role check precedes validation: an invalid body from a member still
	// yields the capability 403, never the 400.
	res := e.serve("PATCH", "/api/servers/"+ws, map[string]any{"name": 42}, scoped(memberAccess, ws))
	if res.status != http.StatusForbidden || res.body["error"] != "Only server owners and admins can edit the server profile" {
		t.Fatalf("member: %d %s", res.status, res.raw)
	}
	res = e.serve("PATCH", "/api/servers/"+ws, map[string]any{"name": 42}, scoped(guestAccess, ws))
	if res.status != http.StatusForbidden {
		t.Fatalf("guest: %d %s", res.status, res.raw)
	}

	// Admin succeeds; name is stored trimmed.
	res = e.serve("PATCH", "/api/servers/"+ws, map[string]any{"name": "  Trimmed Name  ", "hideHumansFromMembers": true}, scoped(adminAccess, ws))
	if res.status != http.StatusOK {
		t.Fatalf("admin patch: %d %s", res.status, res.raw)
	}
	if res.body["name"] != "Trimmed Name" || res.body["hideHumansFromMembers"] != true {
		t.Fatalf("patch result wrong: %s", res.raw)
	}
	if res.body["slug"] != "cap-lab" || res.body["ownerId"] != ownerID || res.body["plan"] != "free" {
		t.Fatalf("identity fields changed: %s", res.raw)
	}

	// createdAt is stable, updatedAt refreshes.
	time.Sleep(10 * time.Millisecond)
	res = e.serve("PATCH", "/api/servers/"+ws, map[string]any{"name": "Again"}, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("owner patch: %d %s", res.status, res.raw)
	}
	if res.body["createdAt"] == res.body["updatedAt"] {
		t.Errorf("updatedAt must refresh: %s", res.raw)
	}
	// Persisted: re-read through the detail endpoint.
	detail := e.serve("GET", "/api/servers/"+ws, nil, scoped(access, ws))
	if detail.body["name"] != "Again" || detail.body["hideHumansFromMembers"] != true {
		t.Fatalf("detail after patch: %s", detail.raw)
	}
}

func TestPatchWorkspaceRejectsPrivilegeFields(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("patch-inject@example.test", "injector")
	ws := e.createServer(t, access, "Inject Lab", "inject-lab")

	res := e.serve("PATCH", "/api/servers/"+ws, map[string]any{
		"name": "Inject", "slug": "new-slug", "ownerId": "someone-else",
		"plan": "pro", "kind": "joint_storage", "onboardingAgentId": "agent-x",
	}, scoped(access, ws))
	if res.status != http.StatusOK {
		t.Fatalf("patch: %d %s", res.status, res.raw)
	}
	if res.body["slug"] != "inject-lab" || res.body["ownerId"] != ownerID ||
		res.body["plan"] != "free" || res.body["kind"] != "normal" || res.body["onboardingAgentId"] != nil {
		t.Fatalf("privilege injection moved a column: %s", res.raw)
	}
}
