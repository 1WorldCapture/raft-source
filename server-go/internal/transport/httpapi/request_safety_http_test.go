package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/transport/httpapi/httpx"
)

func TestRequestBodyMustContainExactlyOneJSONDocument(t *testing.T) {
	e := testkit.NewTestEnv(t)
	for _, tail := range []string{` {"email":"second@example.test"}`, ` garbage`, ` []`} {
		res := e.Do("POST", "/api/auth/forgot-password", strings.NewReader(`{"email":"nobody@example.test"}`+tail), "")
		if res.Status != http.StatusBadRequest {
			t.Errorf("trailing JSON/content accepted: status %d", res.Status)
		}
	}
	large := e.Do("POST", "/api/auth/forgot-password", strings.NewReader(`{"email":"nobody@example.test"}`+strings.Repeat(" ", 256*1024)), "")
	if large.Status != http.StatusRequestEntityTooLarge {
		t.Errorf("trailing whitespace bypassed body limit: status %d", large.Status)
	}
}

func TestDatabaseFailureIsNotReportedAsInvalidSession(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.RegisterOK("db-outage@example.test")
	if err := e.App.DB.Close(); err != nil {
		t.Fatal(err)
	}
	res := e.Do("GET", "/api/auth/me", nil, access)
	if res.Status != http.StatusServiceUnavailable {
		t.Fatalf("database outage must not make clients discard a valid session: status=%d", res.Status)
	}
	if res.Body["code"] != "auth_temporarily_unavailable" {
		t.Errorf("unexpected temporary failure envelope: %v", res.Body["code"])
	}
}

func TestAccountLookupHonorsRequestCancellation(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.RegisterOK("cancel@example.test")
	e.App.DB.SetMaxOpenConns(1)
	conn, err := e.App.DB.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/auth/me", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+access)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); e.App.Handler.ServeHTTP(rec, req) }()
	select {
	case <-done:
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("cancelled lookup: HTTP %d", rec.Code)
		}
	case <-time.After(time.Second):
		// Always release the pinned connection and join the handler on failure.
		conn.Close()
		<-done
		t.Fatal("account lookup ignored the cancelled request while waiting for a database connection")
	}
}

func TestRequestLogsUseRouteTemplatesWithoutResourceIDsOrCredentials(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/items/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	handler := httpx.RequestID(logger)(mux)
	secret := "private-credential-never-log-this"
	req := httptest.NewRequest("GET", "/api/items/"+secret+"?reset="+secret, nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if strings.Contains(logs.String(), secret) {
		t.Fatal("request logs included a raw resource path or credential")
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("request ID must be returned for diagnostics")
	}
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["route"] != "GET /api/items/{id}" {
		t.Fatalf("expected bounded route template, got %v", entry["route"])
	}
}
