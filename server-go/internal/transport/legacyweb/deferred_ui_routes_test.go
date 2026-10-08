package legacyweb_test

import (
	"net/http"
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
			code, body, raw := e.do("GET", path, "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
			if code != http.StatusNotImplemented || body["code"] != "feature_not_implemented" {
				t.Fatalf("authorized unavailable: %d %s", code, raw)
			}
			code, _, _ = e.do("GET", path, "", "", map[string]string{"X-Server-Id": "ws"})
			if code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated: %d", code)
			}
			for _, actor := range []string{"member", "guest", "other"} {
				code, body, raw = e.do("GET", path, "", e.token(actor), map[string]string{"X-Server-Id": "ws"})
				if code != http.StatusForbidden || body["code"] == "feature_not_implemented" {
					t.Fatalf("unauthorized %s: %d %s", actor, code, raw)
				}
			}
			code, body, raw = e.do("GET", path, "", e.token("other"), map[string]string{"X-Server-Id": "other-ws"})
			if code != http.StatusNotFound || body["error"] != "Agent not found" {
				t.Fatalf("foreign resource must remain a real 404: %d %s", code, raw)
			}
		})
	}
	guestCode, _, guestRaw := e.do("GET", "/api/reminders?ownerType=agent&ownerId=missing", "", e.token("guest"), map[string]string{"X-Server-Id": "ws"})
	if guestCode != http.StatusForbidden {
		t.Fatalf("guest denial must precede owner lookup: %d %s", guestCode, guestRaw)
	}
	code, body, raw := e.do("GET", "/api/agents/missing/skills", "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusNotFound || body["error"] != "Agent not found" {
		t.Fatalf("missing agent: %d %s", code, raw)
	}
	code, body, raw = e.do("GET", "/api/reminders?ownerType=user&ownerId=member", "", e.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusForbidden || body["code"] == "feature_not_implemented" {
		t.Fatalf("another user's reminders: %d %s", code, raw)
	}
}

func TestDeferredOfficeOverviewHasExplicitScopedCapabilityResponse(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("office-owner@example.test", "officeowner")
	_, otherAccess, _ := e.fullAccount("office-other@example.test", "officeother")
	ws := e.createServer(t, access, "Office", "office-deferred")
	path := "/api/servers/" + ws + "/agent-overview"
	for _, tc := range []struct {
		name    string
		headers map[string]string
		status  int
	}{
		{"owner", scoped(access, ws), http.StatusNotImplemented},
		{"no auth", nil, http.StatusUnauthorized},
		{"no scope", bearer(access), http.StatusBadRequest},
		{"nonmember", scoped(otherAccess, ws), http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := e.serve("GET", path, nil, tc.headers)
			if res.status != tc.status {
				t.Fatalf("status: %d %s", res.status, res.raw)
			}
			if tc.status == http.StatusNotImplemented && res.body["code"] != "feature_not_implemented" {
				t.Fatalf("missing explicit capability code: %s", res.raw)
			}
		})
	}
	res := e.serve("GET", "/api/not-a-real-feature", nil, scoped(access, ws))
	if res.status != http.StatusNotFound || res.body["error"] != "Not found" || res.body["code"] == "feature_not_implemented" {
		t.Fatalf("unknown routes must remain real 404s: %d %s", res.status, res.raw)
	}
}
