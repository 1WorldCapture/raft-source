package legacyweb_test

// Shared fixtures for the M2 workspace HTTP contract tests. Requests are
// driven through the fully wired handler with an in-process recorder: no TCP
// listener is needed, so the suite runs in sandboxes that forbid local binds
// while exercising the real middleware chain (auth gates, scope, routes).

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/app"
	"raft.local/server-go/internal/platform/config"
)

// serve drives one request through the app handler without TCP.
func (e *testEnv) serve(method, path string, body any, headers map[string]string) response {
	e.t.Helper()
	var reader io.Reader
	switch v := body.(type) {
	case nil:
		reader = nil
	case io.Reader:
		reader = v
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		e.t.Fatal(err)
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
	e.app.Handler.ServeHTTP(rec, req)
	raw := rec.Body.Bytes()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return response{status: rec.Code, body: parsed, raw: raw, header: rec.Header()}
}

// bearer returns the auth headers for a workspace-scoped request.
func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

// scoped returns auth + matching X-Server-Id headers.
func scoped(token, serverID string) map[string]string {
	h := bearer(token)
	h["X-Server-Id"] = serverID
	return h
}

// reopenRecorder rebuilds the app over the same data dir (a process restart)
// and serves follow-up requests through a fresh recorder, no TCP needed.
func (e *testEnv) reopenRecorder() *testEnv {
	e.t.Helper()
	env := map[string]string{
		"RAFT_GO_DATA_DIR":               e.dataDir,
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
	return &testEnv{t: e.t, app: built, dataDir: e.dataDir}
}

// createServer creates a workspace over HTTP and returns its id.
func (e *testEnv) createServer(t *testing.T, token, name, slug string) string {
	t.Helper()
	res := e.serve("POST", "/api/servers", map[string]any{"name": name, "slug": slug}, bearer(token))
	if res.status != http.StatusOK {
		t.Fatalf("create server %q: %d %s", slug, res.status, res.raw)
	}
	id, _ := res.body["id"].(string)
	if id == "" {
		t.Fatalf("create server %q returned no id: %s", slug, res.raw)
	}
	return id
}

// addMember seeds a membership row directly (roles beyond owner cannot be
// granted over HTTP in M2; the seeder is test-only).
func (e *testEnv) addMember(t *testing.T, workspaceID, userID, role string) {
	t.Helper()
	if _, err := e.app.DB.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		 VALUES (?, ?, ?, 0, ?)`,
		workspaceID, userID, role, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	// Membership-dependent rows exist for HTTP-created members; keep parity.
	if _, err := e.app.DB.Exec(
		`INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
		 VALUES (?, ?, 'not_started', NULL, 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.DB.Exec(
		`INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

// markJointStorage flips a workspace into the joint_storage kind.
func (e *testEnv) markJointStorage(t *testing.T, workspaceID string) {
	t.Helper()
	if _, err := e.app.DB.Exec(`UPDATE workspaces SET kind = 'joint_storage' WHERE id = ?`, workspaceID); err != nil {
		t.Fatal(err)
	}
}

// softDeleteWorkspace tombstones a workspace.
func (e *testEnv) softDeleteWorkspace(t *testing.T, workspaceID string) {
	t.Helper()
	if _, err := e.app.DB.Exec(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`, time.Now().UnixMilli(), workspaceID); err != nil {
		t.Fatal(err)
	}
}

// setupRow reads the durable setup state for assertions.
func (e *testEnv) setupRow(t *testing.T, workspaceID, userID string) (status string, reason sql.NullString) {
	t.Helper()
	err := e.app.DB.QueryRow(
		`SELECT status, completion_reason FROM workspace_member_setup WHERE workspace_id = ? AND user_id = ?`,
		workspaceID, userID).Scan(&status, &reason)
	if err != nil {
		t.Fatal(err)
	}
	return status, reason
}

// seedAgent inserts a real, active, local agent directory row (isolated
// fixture; M2 has no agent writer).
func (e *testEnv) seedAgent(t *testing.T, id, workspaceID, name string) {
	t.Helper()
	now := time.Now().UnixMilli()
	if _, err := e.app.DB.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, ?, 'active', 'claude', ?, ?)`, id, workspaceID, name, now, now); err != nil {
		t.Fatal(err)
	}
}

// seedComputer inserts a non-revoked computer row (a "connected computer").
func (e *testEnv) seedComputer(t *testing.T, id, workspaceID string) {
	t.Helper()
	if _, err := e.app.DB.Exec(`
		INSERT INTO computers (id, workspace_id, name, created_at)
		VALUES (?, ?, 'Test Computer', ?)`, id, workspaceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

// pngBody builds a multipart body with a real PNG avatar file.
func pngBody(t *testing.T, pixel byte) (io.Reader, string) {
	t.Helper()
	image := minimalPNG(t, pixel)
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
func minimalPNG(t *testing.T, pixel byte) []byte {
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
func wantEqualString(t *testing.T, body map[string]any, key, want string) {
	t.Helper()
	if got, _ := body[key].(string); got != want {
		t.Errorf("%s = %q, want %q", key, got, want)
	}
}

// wantError asserts the legacy {error:...} body.
func wantError(t *testing.T, body map[string]any, want string) {
	t.Helper()
	if got, _ := body["error"].(string); got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
}
