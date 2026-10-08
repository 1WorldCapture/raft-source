package legacyweb_test

import (
	"net/http"
	"testing"
)

func TestM3ReservedWorkspaceReadsDoNotBecomeWorkspaceIDs(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("reserved@example.test", "reservedtester")
	for _, name := range []string{"unread-summary", "join-community"} {
		for _, method := range []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "PUT"} {
			for _, header := range []string{"", "foreign-workspace"} {
				headers := bearer(access)
				if header != "" {
					headers["X-Server-Id"] = header
				}
				res := e.serve(method, "/api/servers/"+name, nil, headers)
				if res.status != http.StatusNotFound || res.body["code"] != "feature_not_implemented" {
					t.Fatalf("%s reserved %s: %d %s", method, name, res.status, res.raw)
				}
			}
		}
	}
	// Existing user-scoped order retains its independent matching and 405.
	order := e.serve("PUT", "/api/servers/order", nil, bearer(access))
	if order.status != http.StatusMethodNotAllowed || order.header.Get("Allow") != "GET, PATCH" {
		t.Fatalf("order became workspace scope: %d %s", order.status, order.raw)
	}
	// Reserving route names never introduces a new slug prohibition.
	id := e.createServer(t, access, "Reserved slug is legal", "unread-summary")
	actual := e.serve("GET", "/api/servers/"+id, nil, scoped(access, id))
	if actual.status != http.StatusOK || actual.body["slug"] != "unread-summary" {
		t.Fatalf("valid UUID detail for reserved slug: %d %s", actual.status, actual.raw)
	}
}

func TestM3ReservedUserRoutesStillRequireIdentity(t *testing.T) {
	e := newTestEnv(t)
	for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
		res := e.serve(method, "/api/servers/unread-summary", nil, nil)
		if res.status != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s: %d %s", method, res.status, res.raw)
		}
	}
}
