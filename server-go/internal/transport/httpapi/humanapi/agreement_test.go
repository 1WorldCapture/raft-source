package humanapi_test

import (
	"net/http"
	"testing"

	"raft.local/server-go/tests/testkit"
)

func TestDeferredAgreementPreservesScopeRoleAndMethodPolicy(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, owner, _ := e.FullAccount("agreement-owner@example.test", "agreementowner")
	adminID, admin, _ := e.FullAccount("agreement-admin@example.test", "agreementadmin")
	memberID, member, _ := e.FullAccount("agreement-member@example.test", "agreementmember")
	guestID, guest, _ := e.FullAccount("agreement-guest@example.test", "agreementguest")
	_, outsider, _ := e.FullAccount("agreement-outsider@example.test", "agreementoutsider")
	ws := e.CreateServer(t, owner, "Agreement", "agreement-policy")
	e.AddMember(t, ws, adminID, "admin")
	e.AddMember(t, ws, memberID, "member")
	e.AddMember(t, ws, guestID, "guest")
	path := "/api/servers/" + ws + "/agreement"

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodPost, http.MethodDelete, http.MethodOptions} {
		for _, tc := range []struct {
			name    string
			headers map[string]string
			status  int
		}{
			{"owner", testkit.Scoped(owner, ws), http.StatusNotImplemented},
			{"admin", testkit.Scoped(admin, ws), http.StatusNotImplemented},
			{"member", testkit.Scoped(member, ws), http.StatusForbidden},
			{"guest", testkit.Scoped(guest, ws), http.StatusForbidden},
			{"outsider", testkit.Scoped(outsider, ws), http.StatusForbidden},
			{"unauthenticated", nil, http.StatusUnauthorized},
			{"wrong credential kind", testkit.Scoped("sk_agent_not-a-human-session", ws), http.StatusUnauthorized},
			{"missing scope", testkit.Bearer(owner), http.StatusBadRequest},
			{"mismatched scope", testkit.Scoped(owner, "another-workspace"), http.StatusBadRequest},
		} {
			t.Run(method+"/"+tc.name, func(t *testing.T) {
				expected := tc.status
				if expected == http.StatusNotImplemented && method != http.MethodGet && method != http.MethodPut {
					expected = http.StatusMethodNotAllowed
				}
				res := e.Serve(method, path, map[string]any{"enabled": true, "title": "Terms", "bodyMarkdown": "Do not silently accept this write."}, tc.headers)
				if res.Status != expected {
					t.Fatalf("status: got %d, want %d: %s", res.Status, expected, res.Raw)
				}
				if expected == http.StatusNotImplemented {
					if res.Body["code"] != "feature_not_implemented" || res.Body["error"] != "Pre-join agreements are not enabled in this server stage" {
						t.Fatalf("unchanged UI needs the explicit unavailable explanation: %s", res.Raw)
					}
				} else if res.Body["code"] == "feature_not_implemented" {
					t.Fatalf("capability response must not hide scope, role or method failures: %s", res.Raw)
				}
				if expected == http.StatusMethodNotAllowed && res.Header.Get("Allow") != "GET, PUT" {
					t.Fatalf("Allow: %q", res.Header.Get("Allow"))
				}
				if tc.name == "member" && res.Body["error"] != "Only server owners and admins can manage the pre-join agreement" {
					t.Fatalf("original member denial contract: %s", res.Raw)
				}
			})
		}
	}

	unknown := e.Serve(http.MethodGet, path+"/unknown", nil, testkit.Scoped(owner, ws))
	if unknown.Status != http.StatusNotFound || unknown.Body["code"] == "feature_not_implemented" {
		t.Fatalf("unknown agreement paths remain real 404s: %d %s", unknown.Status, unknown.Raw)
	}
}
