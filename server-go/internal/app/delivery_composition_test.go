package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeliveryCompositionClosesWithTheApp(t *testing.T) {
	built, err := Build(Options{Config: testConfig(t, t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	if built.dispatcher == nil || built.agentHandlers == nil || built.control.deliveries == nil || built.control.launches == nil {
		t.Fatal("production assembly is missing the delivery pump, agent API, delivery store or launch store")
	}
	if built.chat == nil || built.chat.messaging == nil {
		t.Fatal("chat messaging was not constructed")
	}
	want := map[string]bool{
		"POST /internal/agent-api/send":            false,
		"POST /internal/agent-api/v2/send":         false,
		"POST /internal/agent-api/resolve-channel": false,
		"GET /internal/agent-api/events":           false,
		"GET /internal/agent-api/events/claim":     false,
		"POST /internal/agent-api/events/ack":      false,
		"GET /internal/agent-api/history":          false,
	}
	for _, row := range built.internalRouteRegistry() {
		key := row.Method + " " + row.Path
		if _, ok := want[key]; ok {
			if row.Principal != "sk_agent" {
				t.Fatalf("%s principal = %s", key, row.Principal)
			}
			want[key] = true
		}
	}
	for key, seen := range want {
		if !seen {
			t.Fatalf("preflight registry missing %s", key)
		}
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/internal/agent-api/send", nil)
	built.Handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusNotImplemented {
		t.Fatalf("wired agent send answered 501: %s", rec.Body.String())
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated agent send = %d %s", rec.Code, rec.Body.String())
	}

	if err := built.Close(); err != nil {
		t.Fatal(err)
	}
	if err := built.Close(); err != nil {
		t.Fatal(err)
	}
}
