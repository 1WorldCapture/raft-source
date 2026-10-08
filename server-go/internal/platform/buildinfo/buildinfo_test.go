package buildinfo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVersionOnlyExposesEmbeddedBuildMetadata(t *testing.T) {
	r := httptest.NewRecorder()
	Handler(r, httptest.NewRequest("GET", "/version", nil))
	var body map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 6 || body["stage"] != Stage {
		t.Fatalf("unexpected metadata shape: %v", body)
	}
	for _, key := range []string{"revision", "commitTime", "buildTime", "goVersion"} {
		if value, ok := body[key].(string); !ok || value == "" {
			t.Fatalf("missing %s", key)
		}
	}
	if _, ok := body["modified"].(bool); !ok {
		t.Fatal("modified must be a boolean")
	}
	if r.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("version must never be cached as the current process identity")
	}
}

func TestBuildHeadersDoNotChangeUnderlyingResponse(t *testing.T) {
	r := httptest.NewRecorder()
	Headers(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("unavailable"))
	})).ServeHTTP(r, httptest.NewRequest("GET", "/readyz", nil))
	if r.Code != http.StatusServiceUnavailable || r.Body.String() != "unavailable" {
		t.Fatal("diagnostics changed response semantics")
	}
	if r.Header().Get("X-Raft-Go-Stage") != Stage || r.Header().Get("X-Raft-Go-Revision") == "" {
		t.Fatal("running build identity missing")
	}
}

func TestVersionWritePropagatesWriterFailure(t *testing.T) {
	if err := Write(errorWriter{}); err == nil || !strings.Contains(err.Error(), "writer failed") {
		t.Fatalf("expected writer error, got %v", err)
	}
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) { return 0, &testWriteError{} }

type testWriteError struct{}

func (*testWriteError) Error() string { return "writer failed" }
