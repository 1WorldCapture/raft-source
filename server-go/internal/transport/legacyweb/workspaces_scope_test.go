package legacyweb_test

// T01/T07/T24: the common auth and workspace-scope gates, the /order-vs-{id}
// precedence, method/Allow behavior and the unchanged honest-404/501 policy.

import (
	"net/http"
	"testing"
)

func TestWorkspaceScopeHeaderContract(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("scope-owner@example.test", "scopeowner")
	ws := e.createServer(t, access, "Scope Lab", "scope-lab")

	member := e.serve("GET", "/api/servers/"+ws+"/members", nil, bearer(access))
	if member.status != http.StatusBadRequest || member.body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("missing header: %d %s", member.status, member.raw)
	}

	mismatch := e.serve("GET", "/api/servers/"+ws+"/members", nil,
		map[string]string{"Authorization": "Bearer " + access, "X-Server-Id": "other-id"})
	if mismatch.status != http.StatusBadRequest || mismatch.body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("mismatched header: %d %s", mismatch.status, mismatch.raw)
	}
}

func TestWorkspaceScopeMembershipContract(t *testing.T) {
	e := newTestEnv(t)
	ownerID, access, _ := e.fullAccount("scope-a@example.test", "scopea")
	otherID, otherAccess, _ := e.fullAccount("scope-b@example.test", "scopeb")
	ws := e.createServer(t, access, "Scope Lab", "scope-lab-2")

	// A member of TWO servers still cannot cross scopes with the header.
	second := e.createServer(t, access, "Second Lab", "scope-lab-second")
	e.addMember(t, second, otherID, "member")
	cross := e.serve("GET", "/api/servers/"+ws, nil, scoped(otherAccess, second))
	if cross.status != http.StatusBadRequest || cross.body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("cross-scope header must 400: %d %s", cross.status, cross.raw)
	}

	// Plain non-member: 403 from the scope middleware, before any handler.
	notMember := e.serve("GET", "/api/servers/"+ws, nil, scoped(otherAccess, ws))
	if notMember.status != http.StatusForbidden || notMember.body["error"] != "Not a member of this server" {
		t.Fatalf("non-member: %d %s", notMember.status, notMember.raw)
	}

	// Deleted workspace: membership exists but the scope check refuses.
	e.softDeleteWorkspace(t, ws)
	deleted := e.serve("GET", "/api/servers/"+ws, nil, scoped(access, ws))
	if deleted.status != http.StatusForbidden || deleted.body["error"] != "Not a member of this server" {
		t.Fatalf("deleted workspace: %d %s", deleted.status, deleted.raw)
	}

	// joint_storage workspace: invisible to human members too.
	joint := e.createServer(t, access, "Joint", "scope-joint-lab")
	e.markJointStorage(t, joint)
	jointRes := e.serve("GET", "/api/servers/"+joint, nil, scoped(access, joint))
	if jointRes.status != http.StatusForbidden || jointRes.body["error"] != "Not a member of this server" {
		t.Fatalf("joint_storage: %d %s", jointRes.status, jointRes.raw)
	}
	_ = ownerID
}

func TestWorkspaceAuthGatesCoverNewRoutes(t *testing.T) {
	e := newTestEnv(t)
	_, unverified, _ := e.registerOK("unverified-ws@example.test")
	ws := "any-server-id"

	// No token at all.
	if res := e.serve("GET", "/api/servers/order", nil, nil); res.status != http.StatusUnauthorized || res.body["code"] != "auth_required" {
		t.Fatalf("no token: %d %s", res.status, res.raw)
	}
	// Verified email missing.
	if res := e.serve("GET", "/api/servers/"+ws+"/settings", nil, scoped(unverified, ws)); res.status != http.StatusForbidden || res.body["error"] != "Email verification required" {
		t.Fatalf("unverified: %d %s", res.status, res.raw)
	}
	// Profile incomplete.
	e.verifyEmailOf(e.latestOutboxLink("verify"))
	if res := e.serve("GET", "/api/servers/"+ws+"/setup-projection", nil, scoped(unverified, ws)); res.status != http.StatusForbidden || res.body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("profile incomplete: %d %s", res.status, res.raw)
	}
}

func TestOrderRouteNotCapturedAsServerID(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("order-route@example.test", "orderroute")
	e.createServer(t, access, "Order Lab", "order-route-lab")

	// "order" is the user-level route even when a foreign scope header rides
	// along: user-scoped routes never read X-Server-Id.
	res := e.serve("GET", "/api/servers/order", nil,
		map[string]string{"Authorization": "Bearer " + access, "X-Server-Id": "someone-elses"})
	if res.status != http.StatusOK {
		t.Fatalf("GET order with foreign scope header: %d %s", res.status, res.raw)
	}
	if res.body["serverOrderVersion"] != float64(0) {
		t.Fatalf("order shape: %s", res.raw)
	}
}

func TestWorkspaceMethodPolicy(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("methods@example.test", "methoduser")
	ws := e.createServer(t, access, "Method Lab", "method-lab")

	cases := []struct {
		method, path string
		want         int
		allowHas     []string
	}{
		{"DELETE", "/api/servers/order", http.StatusMethodNotAllowed, []string{"GET", "PATCH"}},
		{"PUT", "/api/servers", http.StatusMethodNotAllowed, []string{"GET", "POST"}},
		{"PUT", "/api/servers/" + ws, http.StatusMethodNotAllowed, []string{"GET", "PATCH"}},
		{"DELETE", "/api/servers/" + ws + "/members", http.StatusMethodNotAllowed, []string{"GET"}},
		{"POST", "/api/servers/" + ws + "/settings", http.StatusMethodNotAllowed, []string{"GET"}},
		{"GET", "/api/servers/" + ws + "/setup-transition", http.StatusMethodNotAllowed, []string{"POST"}},
	}
	for _, tc := range cases {
		res := e.serve(tc.method, tc.path, nil, scoped(access, ws))
		if res.status != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.path, res.status, tc.want)
			continue
		}
		allow := res.header.Get("Allow")
		for _, m := range tc.allowHas {
			if !containsMethod(allow, m) {
				t.Errorf("%s %s Allow = %q, want %s", tc.method, tc.path, allow, m)
			}
		}
	}
}

func containsMethod(allow, method string) bool {
	for _, part := range splitComma(allow) {
		if part == method {
			return true
		}
	}
	return false
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			part := trimSpaces(s[start:i])
			if part != "" {
				out = append(out, part)
			}
			start = i + 1
		}
	}
	return out
}

func trimSpaces(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

func TestUnchangedHonestSurfaces(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("surfaces@example.test", "surfaceuser")
	ws := e.createServer(t, access, "Surface Lab", "surface-lab")

	// Unknown workspace subroutes stay honest 404s, never fake 200s.
	if res := e.serve("GET", "/api/servers/"+ws+"/channels", nil, scoped(access, ws)); res.status != http.StatusNotFound {
		t.Fatalf("unknown subroute: %d %s", res.status, res.raw)
	}
	// Labs keeps its own legacy contract (not overridden by the wildcard).
	if res := e.serve("GET", "/api/servers/"+ws+"/labs", nil, scoped(access, ws)); res.status != http.StatusNotFound {
		t.Fatalf("labs override: %d %s", res.status, res.raw)
	}
	// Agent routes now authenticate a distinct principal in M3. A human
	// session must not become an Agent credential, even in the M2 fixture.
	if res := e.serve("GET", "/internal/agent-api/server", nil, bearer(access)); res.status != http.StatusUnauthorized {
		t.Fatalf("human token on Agent API = %d, want 401: %s", res.status, res.raw)
	}
	// M4 serves Socket.IO, but rejects missing/unsupported transports before
	// upgrade. Keep this distinct from genuinely unsupported daemon routes.
	for _, path := range []string{"/socket.io/?EIO=4", "/socket.io/?EIO=4&transport=polling"} {
		res := e.serve("GET", path, nil, bearer(access))
		if res.status != http.StatusBadRequest || string(res.raw) != "only the websocket transport is supported\n" {
			t.Fatalf("%s = %d, want explicit websocket-only rejection: %s", path, res.status, res.raw)
		}
	}
	if res := e.serve("GET", "/daemon/ping", nil, bearer(access)); res.status != http.StatusNotImplemented {
		t.Fatalf("/daemon/ping = %d, want 501", res.status)
	}
}
