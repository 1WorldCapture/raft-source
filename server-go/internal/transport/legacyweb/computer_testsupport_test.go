// Shared fixtures for the M3 computer admission HTTP contract tests. The
// routes under test are mounted on a dedicated mux through the exported
// RegisterComputerRoutes (the parent wires the same call into legacyweb.New),
// driven with an in-process recorder — no TCP listener, real SQLite, real
// auth services.
package legacyweb_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/legacyweb"
)

const computerTestPepper = "computer-test-pepper-0123456789abcdef"

type computerEnv struct {
	t        *testing.T
	db       *sql.DB
	mux      *http.ServeMux
	handlers *legacyweb.ComputerHandlers
	fixed    *clock.Fixed
	signer   *auth.TokenSigner
}

func newComputerEnv(t *testing.T) *computerEnv {
	t.Helper()
	return newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) {})
}

func newComputerEnvWith(t *testing.T, tune func(*legacyweb.ComputerHandlers)) *computerEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	fixed := clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	store, err := computer.NewStore(handle, computer.Options{
		Clock:            &fixed,
		DeviceCodePepper: []byte(computerTestPepper),
		Argon:            computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1},
	})
	if err != nil {
		t.Fatalf("computer store: %v", err)
	}

	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner([]byte("test-secret-0123456789abcdef0123456789abcdef"), 15*time.Minute)
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &legacyweb.AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}

	base, _ := url.Parse("http://127.0.0.1:5175")
	handlers := &legacyweb.ComputerHandlers{
		Store:               store,
		Sessions:            legacyweb.SessionServices{Sessions: sessions, Signer: signer},
		VerificationBaseURL: base,
		DeviceLoginEnabled:  true,
		InternalRoutes:      []computer.InternalRouteEntry{{Method: "POST", Path: "/preflight", Principal: "sk_computer"}},
		ClaimedPrefixes:     []string{"/internal/computer/"},
	}
	tune(handlers)

	mux := http.NewServeMux()
	legacyweb.RegisterComputerRoutes(mux, handlers, gate)
	return &computerEnv{t: t, db: handle, mux: mux, handlers: handlers, fixed: &fixed, signer: signer}
}

func (e *computerEnv) seedUser(id string) {
	e.t.Helper()
	now := e.fixed.Now().UnixMilli()
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, ?, ?)`, id, id+"@example.test", id, now, now); err != nil {
		e.t.Fatal(err)
	}
}

func (e *computerEnv) seedWorkspace(id, slug, owner string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, "WS "+id, slug, owner, e.fixed.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *computerEnv) seedMembership(workspaceID, userID, role string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspaceID, userID, role, e.fixed.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *computerEnv) tokenFor(userID string) string {
	e.t.Helper()
	token, err := e.signer.SignAccessToken(userID, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return token
}

func (e *computerEnv) serve(method, path string, body string, headers map[string]string) (int, map[string]any, string) {
	e.t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	raw := rec.Body.String()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	return rec.Code, parsed, raw
}

func (e *computerEnv) bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

// attachAs performs the full owner attach and returns the response body map.
func (e *computerEnv) attachAs(userID, slug, name string) map[string]any {
	e.t.Helper()
	code, body, raw := e.serve("POST", "/api/computer/attach",
		`{"serverSlug":"`+slug+`","name":"`+name+`"}`, e.bearer(e.tokenFor(userID)))
	if code != http.StatusCreated {
		e.t.Fatalf("attach %s/%s: %d %s", userID, slug, code, raw)
	}
	return body
}
