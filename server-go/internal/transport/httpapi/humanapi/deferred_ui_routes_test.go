package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func TestDeferredAgentUIPreservesAuthenticationAndResourceErrors(t *testing.T) {
	e := newAgentHTTPEnv(t, true, true)
	e.seedUser("owner", "owner", "ws")
	e.seedUser("member", "member", "ws")
	e.seedUser("guest", "guest", "ws")
	e.seedUser("other", "owner", "other-ws")
	if _, err := e.db.Exec(`INSERT INTO agents
		(id, workspace_id, name, display_name, status, runtime, creator_type, creator_id, created_at, updated_at)
		VALUES ('bot', 'ws', 'Bot', 'Bot', 'inactive', 'claude', 'user', 'owner', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/agents/bot/skills",
		"/api/reminders?ownerType=agent&ownerId=bot",
	} {
		t.Run(path, func(t *testing.T) {
			code, body, raw := e.Do("GET", path, "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
			if code != http.StatusNotImplemented || body["code"] != "feature_not_implemented" {
				t.Fatalf("authorized unavailable: %d %s", code, raw)
			}
			code, _, _ = e.Do("GET", path, "", "", map[string]string{"X-Server-Id": "ws"})
			if code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated: %d", code)
			}
			for _, actor := range []string{"member", "guest", "other"} {
				code, body, raw = e.Do("GET", path, "", e.token(actor), map[string]string{"X-Server-Id": "ws"})
				if code != http.StatusForbidden || body["code"] == "feature_not_implemented" {
					t.Fatalf("unauthorized %s: %d %s", actor, code, raw)
				}
			}
			code, body, raw = e.Do("GET", path, "", e.token("other"), map[string]string{"X-Server-Id": "other-ws"})
			if code != http.StatusNotFound || body["error"] != "Agent not found" {
				t.Fatalf("foreign resource must remain a real 404: %d %s", code, raw)
			}
		})
	}
	guestCode, _, guestRaw := e.Do("GET", "/api/reminders?ownerType=agent&ownerId=missing", "", e.token("guest"), map[string]string{"X-Server-Id": "ws"})
	if guestCode != http.StatusForbidden {
		t.Fatalf("guest denial must precede owner lookup: %d %s", guestCode, guestRaw)
	}
	code, body, raw := e.Do("GET", "/api/agents/missing/skills", "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusNotFound || body["error"] != "Agent not found" {
		t.Fatalf("missing agent: %d %s", code, raw)
	}
	code, body, raw = e.Do("GET", "/api/reminders?ownerType=user&ownerId=member", "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusForbidden || body["code"] == "feature_not_implemented" {
		t.Fatalf("another user's reminders: %d %s", code, raw)
	}
}

func TestDeferredOfficeOverviewHasExplicitScopedCapabilityResponse(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("office-owner@example.test", "officeowner")
	_, otherAccess, _ := e.FullAccount("office-other@example.test", "officeother")
	ws := e.CreateServer(t, access, "Office", "office-deferred")
	path := "/api/servers/" + ws + "/agent-overview"
	for _, tc := range []struct {
		name    string
		headers map[string]string
		status  int
	}{
		{"owner", testkit.Scoped(access, ws), http.StatusNotImplemented},
		{"no auth", nil, http.StatusUnauthorized},
		{"no scope", testkit.Bearer(access), http.StatusBadRequest},
		{"nonmember", testkit.Scoped(otherAccess, ws), http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := e.Serve("GET", path, nil, tc.headers)
			if res.Status != tc.status {
				t.Fatalf("status: %d %s", res.Status, res.Raw)
			}
			if tc.status == http.StatusNotImplemented && res.Body["code"] != "feature_not_implemented" {
				t.Fatalf("missing explicit capability code: %s", res.Raw)
			}
		})
	}
	res := e.Serve("GET", "/api/not-a-real-feature", nil, testkit.Scoped(access, ws))
	if res.Status != http.StatusNotFound || res.Body["error"] != "Not found" || res.Body["code"] == "feature_not_implemented" {
		t.Fatalf("unknown routes must remain real 404s: %d %s", res.Status, res.Raw)
	}
}
