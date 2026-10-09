// Package testkit is the whole-app HTTP integration testkit: it builds the
// fully assembled app over a temp data dir and drives it through in-process
// recorders (no TCP), so suites in tests/ and the leaf external test
// packages can exercise the real middleware chain. It is test-only
// infrastructure: production code never imports it.
package testkit

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

	"database/sql"
	"image"
	"image/png"
	"mime/multipart"
	"raft.local/server-go/internal/app"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/mail"
)

// TestEnv is a fully wired app over a temp data dir with fast Argon2 and an
// outbox mailer. No env mutation: config comes from an injected lookup.
//
// Requests are driven through the assembled handler with an in-process
// recorder: the full middleware chain runs for every request without a TCP
// listener, so the suite also executes in sandboxes that forbid local binds.
// End-to-end TCP coverage lives in tests/acceptance/*.mjs.
type TestEnv struct {
	T       *testing.T
	App     *app.App
	Outbox  string
	DataDir string
}

func NewTestEnv(t *testing.T) *TestEnv {
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
	outbox := cfg.OutboxDir
	if _, err := os.Stat(outbox); err != nil {
		t.Fatalf("outbox not created: %v", err)
	}
	return &TestEnv{T: t, App: built, Outbox: outbox, DataDir: dataDir}
}

// Reopen simulates a process restart on the same data dir.
func (e *TestEnv) Reopen() *TestEnv {
	e.T.Helper()
	cfg, err := config.Load(func(key string) (string, bool) {
		switch key {
		case "RAFT_GO_DATA_DIR":
			return e.DataDir, true
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
	}, e.DataDir, filepath.Join(e.DataDir, "keys", "jwt-secret"))
	if err != nil {
		e.T.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := app.Build(app.Options{Config: cfg, Logger: logger})
	if err != nil {
		e.T.Fatal(err)
	}
	e.T.Cleanup(func() { _ = built.Close() })
	return &TestEnv{T: e.T, App: built, Outbox: cfg.OutboxDir, DataDir: e.DataDir}
}

type Response struct {
	Status int
	Body   map[string]any
	Raw    []byte
	Header http.Header
}

// serveRequest drives one request through the app handler without TCP.
func (e *TestEnv) ServeRequest(method, path string, body any, headers map[string]string) Response {
	e.T.Helper()
	var reader io.Reader
	switch v := body.(type) {
	case nil:
		reader = nil
	case io.Reader:
		reader = v
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			e.T.Fatal(err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		e.T.Fatal(err)
	}
	if body != nil {
		if _, isReader := body.(io.Reader); !isReader {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.App.Handler.ServeHTTP(rec, req)
	return ParseResponse(rec)
}

func ParseResponse(rec *httptest.ResponseRecorder) Response {
	raw := rec.Body.Bytes()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return Response{Status: rec.Code, Body: parsed, Raw: raw, Header: rec.Header()}
}

func (e *TestEnv) Do(method, path string, body any, bearer string) Response {
	e.T.Helper()
	headers := map[string]string{}
	if bearer != "" {
		headers["Authorization"] = "Bearer " + bearer
	}
	return e.ServeRequest(method, path, body, headers)
}

func (e *TestEnv) LatestOutboxLink(kind string) string {
	e.T.Helper()
	entries, err := mail.ReadOutbox(e.Outbox, 5)
	if err != nil || len(entries) == 0 {
		e.T.Fatalf("no outbox entries: %v", err)
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
	e.T.Fatal("no link found in outbox")
	return ""
}

// registerOK registers a fresh verified-or-not account and returns its tokens.
func (e *TestEnv) RegisterOK(email string) (userID, accessToken, refreshToken string) {
	e.T.Helper()
	res := e.Do("POST", "/api/auth/register", map[string]any{
		"email":          email,
		"password":       "password-123",
		"acceptTerms":    true,
		"termsVersion":   auth.TermsVersionCurrent,
		"privacyVersion": auth.PrivacyVersionCurrent,
	}, "")
	if res.Status != http.StatusOK {
		e.T.Fatalf("register failed: %d %s", res.Status, res.Raw)
	}
	user := res.Body["user"].(map[string]any)
	return user["id"].(string), res.Body["accessToken"].(string), res.Body["refreshToken"].(string)
}

func (e *TestEnv) VerifyEmailOf(token string) {
	e.T.Helper()
	res := e.Do("POST", "/api/auth/verify-email", map[string]any{"token": token}, "")
	if res.Status != http.StatusOK || res.Body["ok"] != true {
		e.T.Fatalf("verify-email failed: %d %s", res.Status, res.Raw)
	}
}

// FullAccount registers + verifies + completes profile.
func (e *TestEnv) FullAccount(email, username string) (userID, accessToken, refreshToken string) {
	e.T.Helper()
	userID, accessToken, refreshToken = e.RegisterOK(email)
	e.VerifyEmailOf(e.LatestOutboxLink("verify"))
	res := e.Do("POST", "/api/auth/me/complete-profile", map[string]any{
		"name": username, "displayName": "Display " + username,
	}, accessToken)
	if res.Status != http.StatusOK {
		e.T.Fatalf("complete-profile failed: %d %s", res.Status, res.Raw)
	}
	return userID, accessToken, refreshToken
}

// doRaw issues a request with arbitrary extra headers.
func (e *TestEnv) DoRaw(method, path string, body any, headers map[string]string) Response {
	e.T.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		e.T.Fatal(err)
	}
	req, err := http.NewRequest(method, path, bytes.NewReader(buf))
	if err != nil {
		e.T.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.App.Handler.ServeHTTP(rec, req)
	return ParseResponse(rec)
}

// InsertWorkspace seeds a real workspace row for membership queries.
func (e *TestEnv) InsertWorkspace(id, name, slug, ownerID string) error {
	_, err := e.App.DB.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
		id, name, slug, ownerID, time.Now().UnixMilli())
	return err
}

// InsertMembership seeds a membership row.
func (e *TestEnv) InsertMembership(m map[string]any) error {
	_, err := e.App.DB.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?,?,?,?,?)`,
		m["workspace_id"], m["user_id"], m["role"], m["server_push_muted"], m["joined_at"])
	return err
}

// serve drives one request through the app handler without TCP.
func (e *TestEnv) Serve(method, path string, body any, headers map[string]string) Response {
	e.T.Helper()
	var reader io.Reader
	switch v := body.(type) {
	case nil:
		reader = nil
	case io.Reader:
		reader = v
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			e.T.Fatal(err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		e.T.Fatal(err)
	}
	req.RequestURI = path
	if body != nil {
		if _, isReader := body.(io.Reader); !isReader {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.App.Handler.ServeHTTP(rec, req)
	raw := rec.Body.Bytes()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return Response{Status: rec.Code, Body: parsed, Raw: raw, Header: rec.Header()}
}

// bearer returns the auth headers for a workspace-scoped request.
func Bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

// scoped returns auth + matching X-Server-Id headers.
func Scoped(token, serverID string) map[string]string {
	h := Bearer(token)
	h["X-Server-Id"] = serverID
	return h
}

// reopenRecorder rebuilds the app over the same data dir (a process restart)
// and serves follow-up requests through a fresh recorder, no TCP needed.
func (e *TestEnv) ReopenRecorder() *TestEnv {
	e.T.Helper()
	env := map[string]string{
		"RAFT_GO_DATA_DIR":               e.DataDir,
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
	}, e.DataDir, filepath.Join(e.DataDir, "keys", "jwt-secret"))
	if err != nil {
		e.T.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := app.Build(app.Options{Config: cfg, Logger: logger})
	if err != nil {
		e.T.Fatal(err)
	}
	e.T.Cleanup(func() { _ = built.Close() })
	return &TestEnv{T: e.T, App: built, DataDir: e.DataDir}
}

// createServer creates a workspace over HTTP and returns its id.
func (e *TestEnv) CreateServer(t *testing.T, token, name, slug string) string {
	t.Helper()
	res := e.Serve("POST", "/api/servers", map[string]any{"name": name, "slug": slug}, Bearer(token))
	if res.Status != http.StatusOK {
		t.Fatalf("create server %q: %d %s", slug, res.Status, res.Raw)
	}
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("create server %q returned no id: %s", slug, res.Raw)
	}
	return id
}

// addMember seeds a membership row directly (roles beyond owner cannot be
// granted over HTTP in M2; the seeder is test-only).
func (e *TestEnv) AddMember(t *testing.T, workspaceID, userID, role string) {
	t.Helper()
	if _, err := e.App.DB.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		 VALUES (?, ?, ?, 0, ?)`,
		workspaceID, userID, role, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	// Membership-dependent rows exist for HTTP-created members; keep parity.
	if _, err := e.App.DB.Exec(
		`INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
		 VALUES (?, ?, 'not_started', NULL, 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.App.DB.Exec(
		`INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// markJointStorage flips a workspace into the joint_storage kind.
func (e *TestEnv) MarkJointStorage(t *testing.T, workspaceID string) {
	t.Helper()
	if _, err := e.App.DB.Exec(`UPDATE workspaces SET kind = 'joint_storage' WHERE id = ?`, workspaceID); err != nil {
		t.Fatal(err)
	}
}

// softDeleteWorkspace tombstones a workspace.
func (e *TestEnv) SoftDeleteWorkspace(t *testing.T, workspaceID string) {
	t.Helper()
	if _, err := e.App.DB.Exec(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`, time.Now().UnixMilli(), workspaceID); err != nil {
		t.Fatal(err)
	}
}

// setupRow reads the durable setup state for assertions.
func (e *TestEnv) SetupRow(t *testing.T, workspaceID, userID string) (status string, reason sql.NullString) {
	t.Helper()
	err := e.App.DB.QueryRow(
		`SELECT status, completion_reason FROM workspace_member_setup WHERE workspace_id = ? AND user_id = ?`,
		workspaceID, userID).Scan(&status, &reason)
	if err != nil {
		t.Fatal(err)
	}
	return status, reason
}

// seedAgent inserts a real, active, local agent directory row (isolated
// fixture; M2 has no agent writer).
func (e *TestEnv) SeedAgent(t *testing.T, id, workspaceID, name string) {
	t.Helper()
	now := time.Now().UnixMilli()
	if _, err := e.App.DB.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, ?, 'active', 'claude', ?, ?)`, id, workspaceID, name, now, now); err != nil {
		t.Fatal(err)
	}
}

// seedComputer inserts a non-revoked computer row (a "connected computer").
func (e *TestEnv) SeedComputer(t *testing.T, id, workspaceID string) {
	t.Helper()
	if _, err := e.App.DB.Exec(`
		INSERT INTO computers (id, workspace_id, name, created_at)
		VALUES (?, ?, 'Test Computer', ?)`, id, workspaceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

// pngBody builds a multipart body with a real PNG avatar file.
func PngBody(t *testing.T, pixel byte) (io.Reader, string) {
	t.Helper()
	image := MinimalPNG(t, pixel)
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("avatar", "avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(image); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, writer.FormDataContentType()
}

// minimalPNG encodes a tiny valid PNG with a uniform color.
func MinimalPNG(t *testing.T, pixel byte) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for i := range img.Pix {
		img.Pix[i] = pixel
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// wantEqualString asserts a JSON string field.
func WantEqualString(t *testing.T, body map[string]any, key, want string) {
	t.Helper()
	if got, _ := body[key].(string); got != want {
		t.Errorf("%s = %q, want %q", key, got, want)
	}
}

// wantError asserts the legacy {error:...} body.
func WantError(t *testing.T, body map[string]any, want string) {
	t.Helper()
	if got, _ := body["error"].(string); got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
}
