package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"raft.local/server-go/internal/platform/config"
)

func testConfig(t *testing.T, dataDir string) *config.Config {
	t.Helper()
	env := map[string]string{
		"RAFT_GO_DATA_DIR":               dataDir,
		"RAFT_GO_JWT_SECRET":             "test-secret-0123456789abcdef0123456789abcdef",
		"RAFT_GO_ARGON2_MEMORY_KIB":      "19456",
		"RAFT_GO_ARGON2_ITERATIONS":      "2",
		"RAFT_GO_ARGON2_PARALLELISM":     "1",
		"RAFT_GO_ARGON2_MAX_CONCURRENCY": "2",
	}
	cfg, err := config.Load(func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}, dataDir, filepath.Join(dataDir, "keys", "jwt-secret"))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestHealthAndReadiness(t *testing.T) {
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := Build(Options{Config: testConfig(t, dataDir), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	defer built.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", built.LivenessHandler())
	mux.HandleFunc("GET /readyz", built.ReadinessHandler())

	// Drive the handlers with a recorder: no TCP listener is needed, so the
	// readiness assertions also run in sandboxes that forbid local binds.
	health := httptest.NewRecorder()
	mux.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("healthz: %d", health.Code)
	}

	ready := httptest.NewRecorder()
	mux.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("readyz: %d", ready.Code)
	}
}

func TestReadinessFailsWhenDatabaseClosed(t *testing.T) {
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := Build(Options{Config: testConfig(t, dataDir), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if err := built.Close(); err != nil {
		t.Fatal(err)
	}

	if err := built.Ready(context.Background()); err == nil {
		t.Fatal("readiness must fail after the database closes")
	}
}
