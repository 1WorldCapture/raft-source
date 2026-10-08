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
	server := httptest.NewServer(mux)
	defer server.Close()

	health, _ := http.Get(server.URL + "/healthz")
	if health.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %d", health.StatusCode)
	}
	health.Body.Close()

	ready, _ := http.Get(server.URL + "/readyz")
	if ready.StatusCode != http.StatusOK {
		t.Fatalf("readyz: %d", ready.StatusCode)
	}
	ready.Body.Close()
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
