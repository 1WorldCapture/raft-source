package legacyweb_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/app"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/mail"
)

// testEnv is a fully wired app over a temp data dir with fast Argon2 and an
// outbox mailer. No env mutation: config comes from an injected lookup.
type testEnv struct {
	t       *testing.T
	app     *app.App
	server  *httptest.Server
	outbox  string
	dataDir string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dataDir := t.TempDir()
	env := map[string]string{
		"RAFT_GO_DATA_DIR":               dataDir,
		"RAFT_GO_WEB_ORIGIN":             "http://127.0.0.1:5175",
		"RAFT_GO_ARGON2_MEMORY_KIB":      "19456",
		"RAFT_GO_ARGON2_ITERATIONS":      "2",
		"RAFT_GO_ARGON2_PARALLELISM":     "1",
		"RAFT_GO_ARGON2_MAX_CONCURRENCY": "4",
		"RAFT_GO_JWT_SECRET":             "test-secret-0123456789abcdef0123456789abcdef",
	}
	cfg, err := config.Load(func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}, dataDir, filepath.Join(dataDir, "keys", "jwt-secret"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := app.Build(app.Options{Config: cfg, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = built.Close() })
	server := httptest.NewServer(built.Handler)
	t.Cleanup(server.Close)
	outbox := cfg.OutboxDir
	if _, err := os.Stat(outbox); err != nil {
		t.Fatalf("outbox not created: %v", err)
	}
	return &testEnv{t: t, app: built, server: server, outbox: outbox, dataDir: dataDir}
}

// reopen simulates a process restart on the same data dir.
func (e *testEnv) reopen() *testEnv {
	e.t.Helper()
	cfg, err := config.Load(func(key string) (string, bool) {
		switch key {
		case "RAFT_GO_DATA_DIR":
			return e.dataDir, true
		case "RAFT_GO_WEB_ORIGIN":
			return "http://127.0.0.1:5175", true
		case "RAFT_GO_JWT_SECRET":
			return "test-secret-0123456789abcdef0123456789abcdef", true
		case "RAFT_GO_ARGON2_MEMORY_KIB":
			return "19456", true
		case "RAFT_GO_ARGON2_ITERATIONS":
			return "2", true
		case "RAFT_GO_ARGON2_PARALLELISM":
			return "1", true
		case "RAFT_GO_ARGON2_MAX_CONCURRENCY":
			return "4", true
		default:
			return "", false
		}
	}, e.dataDir, filepath.Join(e.dataDir, "keys", "jwt-secret"))
	if err != nil {
		e.t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := app.Build(app.Options{Config: cfg, Logger: logger})
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = built.Close() })
	server := httptest.NewServer(built.Handler)
	e.t.Cleanup(server.Close)
	return &testEnv{t: e.t, app: built, server: server, outbox: cfg.OutboxDir, dataDir: e.dataDir}
}

type response struct {
	status int
	body   map[string]any
	raw    []byte
	header http.Header
}

func (e *testEnv) do(method, path string, body any, bearer string) response {
	e.t.Helper()
	var reader io.Reader
	switch v := body.(type) {
	case nil:
		reader = nil
	case io.Reader:
		reader = v
	default:
		buf, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, e.server.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		if _, isReader := body.(io.Reader); !isReader {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	parsed := map[string]any{}
	if strings.Contains(resp.Header.Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return response{status: resp.StatusCode, body: parsed, raw: raw, header: resp.Header}
}

func (e *testEnv) latestOutboxLink(kind string) string {
	e.t.Helper()
	entries, err := mail.ReadOutbox(e.outbox, 5)
	if err != nil || len(entries) == 0 {
		e.t.Fatalf("no outbox entries: %v", err)
	}
	for _, entry := range entries {
		for _, link := range entry.Links() {
			marker := "?verify="
			if kind == "reset" {
				marker = "?reset="
			}
			if idx := strings.Index(link, marker); idx >= 0 {
				return link[idx+len(marker):]
			}
		}
	}
	e.t.Fatal("no link found in outbox")
	return ""
}

// registerOK registers a fresh verified-or-not account and returns its tokens.
func (e *testEnv) registerOK(email string) (userID, accessToken, refreshToken string) {
	e.t.Helper()
	res := e.do("POST", "/api/auth/register", map[string]any{
		"email":          email,
		"password":       "password-123",
		"acceptTerms":    true,
		"termsVersion":   auth.TermsVersionCurrent,
		"privacyVersion": auth.PrivacyVersionCurrent,
	}, "")
	if res.status != http.StatusOK {
		e.t.Fatalf("register failed: %d %s", res.status, res.raw)
	}
	user := res.body["user"].(map[string]any)
	return user["id"].(string), res.body["accessToken"].(string), res.body["refreshToken"].(string)
}

func (e *testEnv) verifyEmailOf(token string) {
	e.t.Helper()
	res := e.do("POST", "/api/auth/verify-email", map[string]any{"token": token}, "")
	if res.status != http.StatusOK || res.body["ok"] != true {
		e.t.Fatalf("verify-email failed: %d %s", res.status, res.raw)
	}
}

// fullAccount registers + verifies + completes profile.
func (e *testEnv) fullAccount(email, username string) (userID, accessToken, refreshToken string) {
	e.t.Helper()
	userID, accessToken, refreshToken = e.registerOK(email)
	e.verifyEmailOf(e.latestOutboxLink("verify"))
	res := e.do("POST", "/api/auth/me/complete-profile", map[string]any{
		"name": username, "displayName": "Display " + username,
	}, accessToken)
	if res.status != http.StatusOK {
		e.t.Fatalf("complete-profile failed: %d %s", res.status, res.raw)
	}
	return userID, accessToken, refreshToken
}

// doRaw issues a request with arbitrary extra headers.
func (e *testEnv) doRaw(method, path string, body any, headers map[string]string) response {
	e.t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		e.t.Fatal(err)
	}
	req, err := http.NewRequest(method, e.server.URL+path, bytes.NewReader(buf))
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	parsed := map[string]any{}
	_ = json.Unmarshal(raw, &parsed)
	return response{status: resp.StatusCode, body: parsed, raw: raw, header: resp.Header}
}

// insertWorkspace seeds a real workspace row for membership queries.
func (e *testEnv) insertWorkspace(id, name, slug, ownerID string) error {
	_, err := e.app.DB.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
		id, name, slug, ownerID, time.Now().UnixMilli())
	return err
}

// insertMembership seeds a membership row.
func (e *testEnv) insertMembership(m map[string]any) error {
	_, err := e.app.DB.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?,?,?,?,?)`,
		m["workspace_id"], m["user_id"], m["role"], m["server_push_muted"], m["joined_at"])
	return err
}
