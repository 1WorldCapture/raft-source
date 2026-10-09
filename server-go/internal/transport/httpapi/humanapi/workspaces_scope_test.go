package humanapi_test

// T01/T07/T24: the common auth and workspace-scope gates, the /order-vs-{id}
// precedence, method/Allow behavior and the unchanged honest-404/501 policy.

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func TestWorkspaceScopeHeaderContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("scope-owner@example.test", "scopeowner")
	ws := e.CreateServer(t, access, "Scope Lab", "scope-lab")

	member := e.Serve("GET", "/api/servers/"+ws+"/members", nil, testkit.Bearer(access))
	if member.Status != http.StatusBadRequest || member.Body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("missing header: %d %s", member.Status, member.Raw)
	}

	mismatch := e.Serve("GET", "/api/servers/"+ws+"/members", nil,
		map[string]string{"Authorization": "Bearer " + access, "X-Server-Id": "other-id"})
	if mismatch.Status != http.StatusBadRequest || mismatch.Body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("mismatched header: %d %s", mismatch.Status, mismatch.Raw)
	}
}

func TestWorkspaceScopeMembershipContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	ownerID, access, _ := e.FullAccount("scope-a@example.test", "scopea")
	otherID, otherAccess, _ := e.FullAccount("scope-b@example.test", "scopeb")
	ws := e.CreateServer(t, access, "Scope Lab", "scope-lab-2")

	// A member of TWO servers still cannot cross scopes with the header.
	second := e.CreateServer(t, access, "Second Lab", "scope-lab-second")
	e.AddMember(t, second, otherID, "member")
	cross := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(otherAccess, second))
	if cross.Status != http.StatusBadRequest || cross.Body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("cross-scope header must 400: %d %s", cross.Status, cross.Raw)
	}

	// Plain non-member: 403 from the scope middleware, before any handler.
	notMember := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(otherAccess, ws))
	if notMember.Status != http.StatusForbidden || notMember.Body["error"] != "Not a member of this server" {
		t.Fatalf("non-member: %d %s", notMember.Status, notMember.Raw)
	}

	// Deleted workspace: membership exists but the scope check refuses.
	e.SoftDeleteWorkspace(t, ws)
	deleted := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(access, ws))
	if deleted.Status != http.StatusForbidden || deleted.Body["error"] != "Not a member of this server" {
		t.Fatalf("deleted workspace: %d %s", deleted.Status, deleted.Raw)
	}

	// joint_storage workspace: invisible to human members too.
	joint := e.CreateServer(t, access, "Joint", "scope-joint-lab")
	e.MarkJointStorage(t, joint)
	jointRes := e.Serve("GET", "/api/servers/"+joint, nil, testkit.Scoped(access, joint))
	if jointRes.Status != http.StatusForbidden || jointRes.Body["error"] != "Not a member of this server" {
		t.Fatalf("joint_storage: %d %s", jointRes.Status, jointRes.Raw)
	}
	_ = ownerID
}

func TestWorkspaceAuthGatesCoverNewRoutes(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, unverified, _ := e.RegisterOK("unverified-ws@example.test")
	ws := "any-server-id"

	// No token at all.
	if res := e.Serve("GET", "/api/servers/order", nil, nil); res.Status != http.StatusUnauthorized || res.Body["code"] != "auth_required" {
		t.Fatalf("no token: %d %s", res.Status, res.Raw)
	}
	// Verified email missing.
	if res := e.Serve("GET", "/api/servers/"+ws+"/settings", nil, testkit.Scoped(unverified, ws)); res.Status != http.StatusForbidden || res.Body["error"] != "Email verification required" {
		t.Fatalf("unverified: %d %s", res.Status, res.Raw)
	}
	// Profile incomplete.
	e.VerifyEmailOf(e.LatestOutboxLink("verify"))
	if res := e.Serve("GET", "/api/servers/"+ws+"/setup-projection", nil, testkit.Scoped(unverified, ws)); res.Status != http.StatusForbidden || res.Body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("profile incomplete: %d %s", res.Status, res.Raw)
	}
}

func TestOrderRouteNotCapturedAsServerID(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("order-route@example.test", "orderroute")
	e.CreateServer(t, access, "Order Lab", "order-route-lab")

	// "order" is the user-level route even when a foreign scope header rides
	// along: user-scoped routes never read X-Server-Id.
	res := e.Serve("GET", "/api/servers/order", nil,
		map[string]string{"Authorization": "Bearer " + access, "X-Server-Id": "someone-elses"})
	if res.Status != http.StatusOK {
		t.Fatalf("GET order with foreign scope header: %d %s", res.Status, res.Raw)
	}
	if res.Body["serverOrderVersion"] != float64(0) {
		t.Fatalf("order shape: %s", res.Raw)
	}
}

func TestWorkspaceMethodPolicy(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("methods@example.test", "methoduser")
	ws := e.CreateServer(t, access, "Method Lab", "method-lab")

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
		res := e.Serve(tc.method, tc.path, nil, testkit.Scoped(access, ws))
		if res.Status != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.path, res.Status, tc.want)
			continue
		}
		allow := res.Header.Get("Allow")
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
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("surfaces@example.test", "surfaceuser")
	ws := e.CreateServer(t, access, "Surface Lab", "surface-lab")

	// Unknown workspace subroutes stay honest 404s, never fake 200s.
	if res := e.Serve("GET", "/api/servers/"+ws+"/channels", nil, testkit.Scoped(access, ws)); res.Status != http.StatusNotFound {
		t.Fatalf("unknown subroute: %d %s", res.Status, res.Raw)
	}
	// Labs keeps its own legacy contract (not overridden by the wildcard).
	if res := e.Serve("GET", "/api/servers/"+ws+"/labs", nil, testkit.Scoped(access, ws)); res.Status != http.StatusNotFound {
		t.Fatalf("labs override: %d %s", res.Status, res.Raw)
	}
	// Agent routes now authenticate a distinct principal in M3. A human
	// session must not become an Agent credential, even in the M2 fixture.
	if res := e.Serve("GET", "/internal/agent-api/server", nil, testkit.Bearer(access)); res.Status != http.StatusUnauthorized {
		t.Fatalf("human token on Agent API = %d, want 401: %s", res.Status, res.Raw)
	}
	// M4 serves Socket.IO, but rejects missing/unsupported transports before
	// upgrade. Keep this distinct from genuinely unsupported daemon routes.
	for _, path := range []string{"/socket.io/?EIO=4", "/socket.io/?EIO=4&transport=polling"} {
		res := e.Serve("GET", path, nil, testkit.Bearer(access))
		if res.Status != http.StatusBadRequest || string(res.Raw) != "only the websocket transport is supported\n" {
			t.Fatalf("%s = %d, want explicit websocket-only rejection: %s", path, res.Status, res.Raw)
		}
	}
	if res := e.Serve("GET", "/daemon/ping", nil, testkit.Bearer(access)); res.Status != http.StatusNotImplemented {
		t.Fatalf("/daemon/ping = %d, want 501", res.Status)
	}
}
