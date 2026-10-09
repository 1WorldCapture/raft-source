package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func TestM4ReservedWorkspaceReadsDoNotBecomeWorkspaceIDs(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("reserved@example.test", "reservedtester")
	for _, name := range []string{"unread-summary", "join-community"} {
		for _, method := range []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "PUT"} {
			for _, header := range []string{"", "foreign-workspace"} {
				headers := testkit.Bearer(access)
				if header != "" {
					headers["X-Server-Id"] = header
				}
				res := e.Serve(method, "/api/servers/"+name, nil, headers)
				if name == "unread-summary" {
					// M4 replaces the old reserved/deferred surface with the
					// actual user-scoped read model. This account has no spaces,
					// so its real summary is an empty array, irrespective of a
					// bogus X-Server-Id. Mutating methods remain explicit 405.
					if method == http.MethodGet || method == http.MethodHead {
						if res.Status != http.StatusOK || len(decodeBareArray(t, res.Raw)) != 0 {
							t.Fatalf("%s user-scoped unread summary: %d %s", method, res.Status, res.Raw)
						}
					} else if res.Status != http.StatusMethodNotAllowed || res.Header.Get("Allow") != http.MethodGet {
						t.Fatalf("%s unread summary method policy: %d %s", method, res.Status, res.Raw)
					}
				} else if res.Status != http.StatusNotFound || res.Body["code"] != "feature_not_implemented" {
					t.Fatalf("%s reserved %s: %d %s", method, name, res.Status, res.Raw)
				}
			}
		}
	}
	// Existing user-scoped order retains its independent matching and 405.
	order := e.Serve("PUT", "/api/servers/order", nil, testkit.Bearer(access))
	if order.Status != http.StatusMethodNotAllowed || order.Header.Get("Allow") != "GET, PATCH" {
		t.Fatalf("order became workspace scope: %d %s", order.Status, order.Raw)
	}
	// Reserving route names never introduces a new slug prohibition.
	id := e.CreateServer(t, access, "Reserved slug is legal", "unread-summary")
	actual := e.Serve("GET", "/api/servers/"+id, nil, testkit.Scoped(access, id))
	if actual.Status != http.StatusOK || actual.Body["slug"] != "unread-summary" {
		t.Fatalf("valid UUID detail for reserved slug: %d %s", actual.Status, actual.Raw)
	}
}

func TestM3ReservedUserRoutesStillRequireIdentity(t *testing.T) {
	e := testkit.NewTestEnv(t)
	for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
		res := e.Serve(method, "/api/servers/unread-summary", nil, nil)
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s: %d %s", method, res.Status, res.Raw)
		}
	}
}
