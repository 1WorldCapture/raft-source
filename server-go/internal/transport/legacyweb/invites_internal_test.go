package legacyweb

// Internal (same-package) tests for invitation security boundaries the
// external recorder suite cannot inject:
//   - a stale owner/admin claim stashed by the scope middleware must be
//     overruled by the transactional role revalidation (a demotion between
//     the middleware read and the store transaction cannot mint invitations);
//   - the invite-mail failure contract: a nil mailer is refused BEFORE
//     persisting, and a delivery failure logs a fixed diagnostic only —
//     never the transport error text, which may carry the mail body, the
//     recipient, SMTP credentials or the one-time token itself.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

type inviteInternalEnv struct {
	t           *testing.T
	db          *sql.DB
	store       *workspace.Store
	handler     *InviteHandlers
	logBuffer   *bytes.Buffer
	workspaceID string
	ownerID     string
	adminID     string
}

// newInviteInternalEnv opens a fully migrated isolated DB, seeds an owner
// and a DEMOTED admin (role member in the database) plus one workspace, and
// builds the handler with the given mail sender (nil allowed).
func newInviteInternalEnv(t *testing.T, mailer InviteMailSender) *inviteInternalEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	now := time.Now().UnixMilli()
	env := &inviteInternalEnv{t: t, db: handle, store: workspace.NewStore(handle)}
	logBuffer := &bytes.Buffer{}
	env.logBuffer = logBuffer
	env.handler = &InviteHandlers{
		Store:          env.store,
		SendInviteMail: mailer,
		Logger:         slog.New(slog.NewTextHandler(logBuffer, nil)),
	}
	seed := func(id, email, userName string) {
		t.Helper()
		if _, err := handle.Exec(`
			INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
			VALUES (?, ?, ?, 'x', ?, ?)`, id, email, userName, now, now); err != nil {
			t.Fatal(err)
		}
	}
	env.ownerID = "10000000-0000-4000-8000-000000000001"
	env.adminID = "10000000-0000-4000-8000-000000000002"
	seed(env.ownerID, "internal-owner@example.test", "internalowner")
	seed(env.adminID, "internal-admin@example.test", "internaladmin")
	record, err := env.store.CreateWorkspace(context.Background(), env.ownerID, "Internal", "internal-inv-ws")
	if err != nil {
		t.Fatal(err)
	}
	env.workspaceID = record.ID
	// The second user holds a REAL member role — the "admin" claim used in
	// the tests below is stale by construction.
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, 'member', 0, ?)`, env.workspaceID, env.adminID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, contract_version)
		VALUES (?, ?, 'not_started', 'onboarding-setup-v2')`, env.workspaceID, env.adminID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`,
		env.workspaceID, env.adminID); err != nil {
		t.Fatal(err)
	}
	return env
}

// inviteRequest builds a request whose context carries the authenticated
// user and a scope-membership claim of the given role — exactly what the
// middleware chain would stash. The claim may be STALE relative to the
// database; the store must revalidate.
func (e *inviteInternalEnv) inviteRequest(userID, claimedRole, body string) (*http.Request, *httptest.ResponseRecorder) {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/servers/"+e.workspaceID+"/invites", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// The real chain gets this from the ServeMux pattern match; direct
	// handler calls must seed it explicitly.
	req.SetPathValue("id", e.workspaceID)
	ctx := context.WithValue(req.Context(), ctxUserID, userID)
	membership := &workspace.Membership{ID: e.workspaceID, Role: claimedRole}
	ctx = context.WithValue(ctx, ctxScopeMembership, membership)
	return req.WithContext(ctx), httptest.NewRecorder()
}

func (e *inviteInternalEnv) inviteRowCount() int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM workspace_invites`).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *inviteInternalEnv) decodeBody(rec *httptest.ResponseRecorder) map[string]any {
	e.t.Helper()
	return decodeJSONMap(e.t, rec)
}

func decodeJSONMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return parsed
}

// TestInviteCreateOverrulesStaleScopeClaim: the transport precheck sees the
// stale admin claim and lets the request through, and the answer still comes
// from the transactional revalidation — 403 with the exact sentence, no row.
func TestInviteCreateOverrulesStaleScopeClaim(t *testing.T) {
	mailerCalls := 0
	env := newInviteInternalEnv(t, func(context.Context, string, string, string, string) error {
		mailerCalls++
		return nil
	})
	req, rec := env.inviteRequest(env.adminID, workspace.RoleAdmin, `{"email":"stale-target@example.com"}`)
	env.handler.CreateInvite(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("stale-admin create: %d %s", rec.Code, rec.Body.String())
	}
	if body := env.decodeBody(rec); body["error"] != "Only server owners and admins can send invites" {
		t.Fatalf("stale-admin sentence: %v", body["error"])
	}
	if n := env.inviteRowCount(); n != 0 {
		t.Fatalf("stale-admin create persisted %d rows", n)
	}
	if mailerCalls != 0 {
		t.Fatalf("mailer reached %d times for a refused create", mailerCalls)
	}
	// The real owner's request passes the very same double check and does
	// reach the mailer exactly once.
	req, rec = env.inviteRequest(env.ownerID, workspace.RoleOwner, `{"email":"stale-target@example.com"}`)
	env.handler.CreateInvite(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner create: %d %s", rec.Code, rec.Body.String())
	}
	if n := env.inviteRowCount(); n != 1 {
		t.Fatalf("owner create rows = %d", n)
	}
	if mailerCalls != 1 {
		t.Fatalf("owner create mailer calls = %d", mailerCalls)
	}
}

// TestInviteMailerNilRefusedBeforePersist: without a mailer the one-time
// token could never reach anyone, so the route refuses BEFORE the store
// writes anything — no pending row is created to strand.
func TestInviteMailerNilRefusedBeforePersist(t *testing.T) {
	env := newInviteInternalEnv(t, nil)
	req, rec := env.inviteRequest(env.ownerID, workspace.RoleOwner, `{"email":"nil-mailer@example.com"}`)
	env.handler.CreateInvite(rec, req)
	if rec.Code != http.StatusInternalServerError || env.decodeBody(rec)["error"] != "Failed to create invite" {
		t.Fatalf("nil mailer: %d %s", rec.Code, rec.Body.String())
	}
	if n := env.inviteRowCount(); n != 0 {
		t.Fatalf("nil mailer persisted %d rows; refusal must precede the write", n)
	}
}

// TestInviteMailerFailureLogsFixedDiagnosticOnly: a delivery failure keeps
// the TS semantics (row already committed, honest 500) but the log line is a
// fixed diagnostic — the transport error text, which here carries a sentinel
// secret, must never reach logs or the response.
func TestInviteMailerFailureLogsFixedDiagnosticOnly(t *testing.T) {
	const sentinel = "sk_invite_secret_DO_NOT_LOG_0123456789"
	env := newInviteInternalEnv(t, func(context.Context, string, string, string, string) error {
		return errors.New("smtp submit failed: AUTH " + sentinel)
	})
	req, rec := env.inviteRequest(env.ownerID, workspace.RoleOwner, `{"email":"fail-mailer@example.com"}`)
	env.handler.CreateInvite(rec, req)
	if rec.Code != http.StatusInternalServerError || env.decodeBody(rec)["error"] != "Failed to create invite" {
		t.Fatalf("failing mailer: %d %s", rec.Code, rec.Body.String())
	}
	if n := env.inviteRowCount(); n != 1 {
		t.Fatalf("failing mailer rows = %d (TS semantics: committed row stays)", n)
	}
	logs := env.logBuffer.String()
	if strings.Contains(logs, sentinel) {
		t.Fatalf("log leaked transport error/secret: %q", logs)
	}
	if !strings.Contains(logs, "invite email delivery failed") {
		t.Fatalf("fixed diagnostic missing from log: %q", logs)
	}
	if strings.Contains(rec.Body.String(), sentinel) {
		t.Fatalf("response leaked the failure detail: %s", rec.Body.String())
	}
}
