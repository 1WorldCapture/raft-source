package acceptance

// Whole-app HTTP fault-window regressions for the stabilization closeout.
//
// These tests restore the coverage the legacyweb suites carried before the
// httpapi migration (review items R7/R10): when a LATE in-transaction step
// fails — the thread reply read advance after the message/follow facts are
// already written, or the DM create projection after the DM channel row is
// already inserted — the HTTP exit must answer the exact legacy 500 body and
// the durable database must keep the EXACT pre-request row set (full
// rollback, no partially applied side effects, no consumed idempotency key).
//
// Faults are real storage-level failures armed on the temp database itself
// (a verifying SQL trigger / a schema fault); no production hook, setter or
// seam is involved. Every fixture uses the whole-app testkit over a temp
// data dir and drives the assembled handler through an in-process recorder.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"raft.local/server-go/internal/auth"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/mail"
	"raft.local/server-go/tests/testkit"
)

// Fixture and fault-injection writes share the app's authority/write fence.
// The assembled app also runs the delivery pump; raw autocommit DDL can race
// its transactions and fail before the intended HTTP failure window is armed.
// This changes only test setup serialization, never the fault or assertions.
func stabExec(env *testkit.TestEnv, query string, args ...any) (sql.Result, error) {
	ctx := context.Background()
	var result sql.Result
	err := platformdb.WithWriteTx(ctx, env.App.DB, func(tx *sql.Tx) error {
		var err error
		result, err = tx.ExecContext(ctx, query, args...)
		return err
	})
	return result, err
}

// Schema fault swaps must be atomic and use one connection. Splitting a
// DROP VIEW / ALTER TABLE restore across pooled transactions exposes an
// intermediate schema to background readers and can leave the next DDL
// preparation consulting the old view name. This helper changes only test
// setup/teardown; the conditional late-failure view and rollback assertions
// remain unchanged.
func stabExecDDL(env *testkit.TestEnv, statements ...string) error {
	ctx := context.Background()
	return platformdb.WithWriteTx(ctx, env.App.DB, func(tx *sql.Tx) error {
		for _, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
		return nil
	})
}

type stabResponse struct {
	Status int
	Body   map[string]any
	Raw    []byte
}

// stabServe drives one request through the fully assembled app handler.
func stabServe(t *testing.T, env *testkit.TestEnv, method, path string, body any, token string) stabResponse {
	t.Helper()
	buf := mustJSON(t, body)
	req, err := http.NewRequest(method, path, bytes.NewReader(buf))
	if err != nil {
		t.Fatal(err)
	}
	req.RequestURI = path
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	env.App.Handler.ServeHTTP(rec, req)
	raw := rec.Body.Bytes()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return stabResponse{Status: rec.Code, Body: parsed, Raw: raw}
}

// stabScoped is a workspace-scoped request (auth + X-Server-Id).
func stabScoped(t *testing.T, env *testkit.TestEnv, method, path string, body any, token, serverID string) stabResponse {
	t.Helper()
	req, err := http.NewRequest(method, path, bytes.NewReader(mustJSON(t, body)))
	if err != nil {
		t.Fatal(err)
	}
	req.RequestURI = path
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Server-Id", serverID)
	rec := httptest.NewRecorder()
	env.App.Handler.ServeHTTP(rec, req)
	raw := rec.Body.Bytes()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(raw, &parsed)
	}
	return stabResponse{Status: rec.Code, Body: parsed, Raw: raw}
}

func mustJSON(t *testing.T, body any) []byte {
	t.Helper()
	if body == nil {
		return []byte{}
	}
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return buf
}

// stabAccount registers, verifies and completes the profile of one human.
func stabAccount(t *testing.T, env *testkit.TestEnv, email, name string) (string, string) {
	t.Helper()
	res := stabServe(t, env, "POST", "/api/auth/register", map[string]any{
		"email":          email,
		"password":       "password-123",
		"acceptTerms":    true,
		"termsVersion":   auth.TermsVersionCurrent,
		"privacyVersion": auth.PrivacyVersionCurrent,
	}, "")
	if res.Status != http.StatusOK {
		t.Fatalf("register %s: %d %s", email, res.Status, res.Raw)
	}
	token := res.Body["accessToken"].(string)
	userID := res.Body["user"].(map[string]any)["id"].(string)
	link := stabOutboxToken(t, env, "?verify=")
	if res := stabServe(t, env, "POST", "/api/auth/verify-email", map[string]any{"token": link}, ""); res.Status != http.StatusOK {
		t.Fatalf("verify-email: %d %s", res.Status, res.Raw)
	}
	if res := stabServe(t, env, "POST", "/api/auth/me/complete-profile", map[string]any{
		"name": name, "displayName": "Display " + name,
	}, token); res.Status != http.StatusOK {
		t.Fatalf("complete-profile: %d %s", res.Status, res.Raw)
	}
	return userID, token
}

func stabOutboxToken(t *testing.T, env *testkit.TestEnv, marker string) string {
	t.Helper()
	entries, err := mail.ReadOutbox(env.Outbox, 5)
	if err != nil || len(entries) == 0 {
		t.Fatalf("no outbox entries: %v", err)
	}
	for _, entry := range entries {
		for _, link := range entry.Links() {
			if idx := strings.Index(link, marker); idx >= 0 {
				return link[idx+len(marker):]
			}
		}
	}
	t.Fatal("no verification link found in outbox")
	return ""
}

// stabWorkspace creates one workspace over HTTP and adds a member directly
// (roles beyond owner cannot be granted over HTTP in this stage).
func stabWorkspace(t *testing.T, env *testkit.TestEnv, ownerToken, memberID string) string {
	t.Helper()
	res := stabServe(t, env, "POST", "/api/servers", map[string]any{"name": "Stab", "slug": "stab-" + memberID[:8]}, ownerToken)
	if res.Status != http.StatusOK {
		t.Fatalf("create server: %d %s", res.Status, res.Raw)
	}
	ws, _ := res.Body["id"].(string)
	if ws == "" {
		t.Fatalf("create server returned no id: %s", res.Raw)
	}
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?,?, 'member', 0, 1)`, []any{ws, memberID}},
		{`INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version) VALUES (?,?,'not_started',NULL,'onboarding-setup-v2')`, []any{ws, memberID}},
		{`INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?,?)`, []any{ws, memberID}},
	} {
		if _, err := stabExec(env, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("seed member row: %v", err)
		}
	}
	return ws
}

// stabChannel creates a public channel over HTTP.
func stabChannel(t *testing.T, env *testkit.TestEnv, token, ws, name string) string {
	t.Helper()
	res := stabScoped(t, env, "POST", "/api/channels", map[string]any{"name": name, "visibility": "public"}, token, ws)
	if res.Status != http.StatusOK && res.Status != http.StatusCreated {
		t.Fatalf("create channel: %d %s", res.Status, res.Raw)
	}
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("create channel returned no id: %s", res.Raw)
	}
	return id
}

// stabSendMessage posts one message over HTTP and returns its id.
func stabSendMessage(t *testing.T, env *testkit.TestEnv, token, ws, channelID, content string) string {
	t.Helper()
	res := stabScoped(t, env, "POST", "/api/messages", map[string]any{"channelId": channelID, "content": content}, token, ws)
	if res.Status != http.StatusOK {
		t.Fatalf("send message: %d %s", res.Status, res.Raw)
	}
	id, _ := res.Body["id"].(string)
	if id == "" {
		id = stabFirstMessageID(t, env, ws, channelID)
	}
	return id
}

func stabFirstMessageID(t *testing.T, env *testkit.TestEnv, ws, channelID string) string {
	t.Helper()
	var id string
	if err := env.App.DB.QueryRow(`SELECT id FROM messages WHERE workspace_id = ? AND channel_id = ? ORDER BY seq ASC LIMIT 1`, ws, channelID).Scan(&id); err != nil {
		t.Fatalf("parent message lookup: %v", err)
	}
	return id
}

// stabSnapshot captures the exact persisted row set of every application
// table. On realtime_publications the dispatcher-owned progress columns
// (published_at / attempts / next_attempt_at) are projected out: background
// marking of previously pending intents is legitimate async progress and
// must not mask whether the FAILED request added or removed durable rows.
func stabSnapshot(t *testing.T, env *testkit.TestEnv) map[string][]string {
	t.Helper()
	rows, err := env.App.DB.Query(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()

	facts := map[string][]string{}
	for _, name := range tables {
		var query string
		if name == "realtime_publications" {
			query = `SELECT id, workspace_id, object_type, object_id, event_type, revision, subject_user_id, scope_id, created_at FROM "realtime_publications"`
		} else {
			query = `SELECT * FROM "` + strings.ReplaceAll(name, `"`, `""`) + `"`
		}
		tableRows, err := env.App.DB.Query(query)
		if err != nil {
			t.Fatalf("snapshot %s: %v", name, err)
		}
		cols, err := tableRows.Columns()
		if err != nil {
			tableRows.Close()
			t.Fatal(err)
		}
		values := make([]any, len(cols))
		targets := make([]any, len(cols))
		for i := range values {
			targets[i] = &values[i]
		}
		encoded := []string{}
		for tableRows.Next() {
			if err := tableRows.Scan(targets...); err != nil {
				tableRows.Close()
				t.Fatal(err)
			}
			buf, err := json.Marshal(values)
			if err != nil {
				tableRows.Close()
				t.Fatal(err)
			}
			encoded = append(encoded, string(buf))
		}
		if err := tableRows.Err(); err != nil {
			tableRows.Close()
			t.Fatal(err)
		}
		tableRows.Close()
		sort.Strings(encoded)
		facts[name] = encoded
	}
	return facts
}

func stabAssertUnchanged(t *testing.T, before, after map[string][]string) {
	t.Helper()
	if len(before) != len(after) {
		t.Errorf("failed request changed the application table set (%d -> %d tables)", len(before), len(after))
	}
	for table, want := range before {
		got := after[table]
		if len(want) != len(got) {
			t.Errorf("failed request changed durable rows in %s (%d -> %d rows)", table, len(want), len(got))
			continue
		}
		for i := range want {
			if want[i] != got[i] {
				t.Errorf("failed request changed durable rows in %s:\n before %s\n after  %s", table, want[i], got[i])
			}
		}
	}
}

// stabArmReadFailure installs a REAL late storage failure: the trigger
// aborts the read-state insert of exactly one user, but only after it has
// VERIFIED inside the failed transaction that the earlier facts already
// exist (thread channel, active follow, and optionally the reply message).
// Firing before any write would not prove the rollback window.
func stabArmReadFailure(t *testing.T, env *testkit.TestEnv, userID string, requireReply bool, marker string) {
	t.Helper()
	messageCheck := ""
	if requireReply {
		messageCheck = `AND EXISTS (
			SELECT 1 FROM messages WHERE channel_id=NEW.channel_id AND content='` + strings.ReplaceAll(marker, "'", "''") + `'
		)`
	}
	// The preconditions belong in WHEN, not in separate RAISE branches.
	// HTTP deliberately hides storage errors behind one 500 body: raising
	// for a MISSING prerequisite would also produce 500 and let a reordered,
	// too-early fault pass vacuously. Missing earlier facts must skip this
	// trigger so the request succeeds and the expected-500 assertion FAILS.
	_, err := stabExec(env, fmt.Sprintf(`CREATE TRIGGER stab_fail_read_insert
		BEFORE INSERT ON user_channel_read_states
		WHEN NEW.user_id='%s'
			AND EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='thread')
			AND EXISTS (SELECT 1 FROM thread_follows WHERE thread_channel_id=NEW.channel_id
				AND user_id=NEW.user_id AND unfollowed_at IS NULL)
			%s
		BEGIN
			SELECT RAISE(ABORT, 'injected read-state storage failure after earlier facts');
		END`, strings.ReplaceAll(userID, "'", "''"), messageCheck))
	if err != nil {
		t.Fatalf("arm read failure: %v", err)
	}
}

func stabDisarmReadFailure(t *testing.T, env *testkit.TestEnv) {
	t.Helper()
	if _, err := stabExec(env, `DROP TRIGGER IF EXISTS stab_fail_read_insert`); err != nil {
		t.Fatalf("disarm read failure: %v", err)
	}
}

// stabFixture is the shared two-human workspace with one public channel and
// one root parent message from the owner.
type stabFixture struct {
	env         *testkit.TestEnv
	ws          string
	channelID   string
	parentMsgID string
	ownerID     string
	ownerToken  string
	memberID    string
	memberToken string
}

func newStabFixture(t *testing.T, name string) *stabFixture {
	t.Helper()
	env := testkit.NewTestEnv(t)
	ownerID, ownerToken := stabAccount(t, env, "stab-owner-"+name+"@a.test", "owner"+name)
	memberID, memberToken := stabAccount(t, env, "stab-member-"+name+"@a.test", "member"+name)
	ws := stabWorkspace(t, env, ownerToken, memberID)
	channelID := stabChannel(t, env, ownerToken, ws, "stab-"+name)
	// Explicit roster rows keep the fixture independent of implicit
	// membership semantics for posts and thread creation.
	for _, uid := range []string{ownerID, memberID} {
		if _, err := stabExec(env, `INSERT OR IGNORE INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?,?, 'member', 1)`, channelID, uid); err != nil {
			t.Fatalf("seed channel_humans: %v", err)
		}
	}
	parentID := stabSendMessage(t, env, ownerToken, ws, channelID, "root message "+name)
	return &stabFixture{
		env: env, ws: ws, channelID: channelID, parentMsgID: parentID,
		ownerID: ownerID, ownerToken: ownerToken, memberID: memberID, memberToken: memberToken,
	}
}

// stabThreadWithReply creates a thread (owner) with one first reply over
// HTTP and returns the thread channel id.
func (f *stabFixture) stabThreadWithReply(t *testing.T) string {
	t.Helper()
	res := stabScoped(t, f.env, "POST", "/api/channels/"+f.channelID+"/threads", map[string]any{
		"parentMessageId": f.parentMsgID, "content": "owner first reply",
	}, f.ownerToken, f.ws)
	if res.Status != http.StatusOK {
		t.Fatalf("create thread: %d %s", res.Status, res.Raw)
	}
	return stabThreadOfParent(t, f.env, f.parentMsgID)
}

func stabThreadOfParent(t *testing.T, env *testkit.TestEnv, parentID string) string {
	t.Helper()
	var id string
	err := env.App.DB.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parentID).Scan(&id)
	if err == sql.ErrNoRows || id == "" {
		t.Fatal("parent message carries no thread link")
	}
	if err != nil {
		t.Fatalf("thread link lookup: %v", err)
	}
	return id
}

// TestStabilizationThreadReplyReadFailureHTTP verifies the full-stack window
// the legacyweb suite covered before migration: a thread reply whose read
// advance fails AFTER the message, follow and publication intents exist
// inside the transaction must answer the exact legacy 500 body and leave the
// durable business facts and publication intents unchanged, and must not
// consume the client idempotency key.
func TestStabilizationThreadReplyReadFailureHTTP(t *testing.T) {
	f := newStabFixture(t, "reply")
	threadID := f.stabThreadWithReply(t)
	const marker = "stab-http-fault-reply"
	randomID := "stab-http-fault-reply-1"

	stabArmReadFailure(t, f.env, f.memberID, true, marker)
	before := stabSnapshot(t, f.env)

	res := stabScoped(t, f.env, "POST", "/api/messages", map[string]any{
		"channelId": threadID, "content": marker, "randomId": randomID,
	}, f.memberToken, f.ws)
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("thread reply with failing read advance: status %d, want 500 (%s)", res.Status, res.Raw)
	}
	if got, _ := res.Body["error"].(string); got != "Failed to send message" {
		t.Fatalf("thread reply 500 body: %q, want %q (%s)", got, "Failed to send message", res.Raw)
	}
	stabAssertUnchanged(t, before, stabSnapshot(t, f.env))

	// Positive recovery: the same request (same randomId) commits as a NEW
	// message once the fault is gone — a rolled-back attempt must never
	// consume the idempotency key — and carries its read effect.
	stabDisarmReadFailure(t, f.env)
	recovered := stabScoped(t, f.env, "POST", "/api/messages", map[string]any{
		"channelId": threadID, "content": marker, "randomId": randomID,
	}, f.memberToken, f.ws)
	if recovered.Status != http.StatusOK {
		t.Fatalf("recovery send: %d %s", recovered.Status, recovered.Raw)
	}
	var read int64
	if err := f.env.App.DB.QueryRow(`SELECT last_read_seq FROM user_channel_read_states
		WHERE workspace_id=? AND user_id=? AND channel_id=?`, f.ws, f.memberID, threadID).Scan(&read); err != nil {
		t.Fatalf("recovered reply omitted its read effect: %v", err)
	}
	if read <= 0 {
		t.Fatalf("recovered reply read frontier = %d, want the reply seq", read)
	}
}

// TestStabilizationThreadCreateReadFailureHTTP covers the create-thread-
// with-first-reply exit: EnsureThread (thread row, parent link, author
// follow, thread:updated intent) plus the reply's facts must all vanish when
// the reply's read advance fails.
func TestStabilizationThreadCreateReadFailureHTTP(t *testing.T) {
	f := newStabFixture(t, "create")
	const marker = "stab-http-fault-first-reply"

	stabArmReadFailure(t, f.env, f.memberID, true, marker)
	before := stabSnapshot(t, f.env)

	res := stabScoped(t, f.env, "POST", "/api/channels/"+f.channelID+"/threads", map[string]any{
		"parentMessageId": f.parentMsgID, "content": marker,
	}, f.memberToken, f.ws)
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("thread create with failing read advance: status %d, want 500 (%s)", res.Status, res.Raw)
	}
	if got, _ := res.Body["error"].(string); got != "Failed to create thread" {
		t.Fatalf("thread create 500 body: %q, want %q (%s)", got, "Failed to create thread", res.Raw)
	}
	stabAssertUnchanged(t, before, stabSnapshot(t, f.env))

	stabDisarmReadFailure(t, f.env)
	recovered := stabScoped(t, f.env, "POST", "/api/channels/"+f.channelID+"/threads", map[string]any{
		"parentMessageId": f.parentMsgID, "content": marker,
	}, f.memberToken, f.ws)
	if recovered.Status != http.StatusOK {
		t.Fatalf("recovery thread create: %d %s", recovered.Status, recovered.Raw)
	}
	threadID := stabThreadOfParent(t, f.env, f.parentMsgID)
	var follows, reads int
	if err := f.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows
		WHERE thread_channel_id=? AND user_id=? AND unfollowed_at IS NULL`, threadID, f.memberID).Scan(&follows); err != nil {
		t.Fatal(err)
	}
	if err := f.env.App.DB.QueryRow(`SELECT COUNT(*) FROM user_channel_read_states
		WHERE workspace_id=? AND user_id=? AND channel_id=?`, f.ws, f.memberID, threadID).Scan(&reads); err != nil {
		t.Fatal(err)
	}
	if follows != 1 || reads != 1 {
		t.Fatalf("recovered thread create: follows=%d reads=%d, want 1/1", follows, reads)
	}
}

// TestStabilizationFollowReadFailureHTTP covers the explicit follow exit:
// the ensure-created thread, the follow row and the read advance are one
// atomic unit through HTTP.
func TestStabilizationFollowReadFailureHTTP(t *testing.T) {
	f := newStabFixture(t, "follow")

	stabArmReadFailure(t, f.env, f.memberID, false, "")
	before := stabSnapshot(t, f.env)

	res := stabScoped(t, f.env, "POST", "/api/channels/threads/follow", map[string]any{
		"parentMessageId": f.parentMsgID,
	}, f.memberToken, f.ws)
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("follow with failing read advance: status %d, want 500 (%s)", res.Status, res.Raw)
	}
	if got, _ := res.Body["error"].(string); got != "Failed to follow thread" {
		t.Fatalf("follow 500 body: %q, want %q (%s)", got, "Failed to follow thread", res.Raw)
	}
	stabAssertUnchanged(t, before, stabSnapshot(t, f.env))

	stabDisarmReadFailure(t, f.env)
	recovered := stabScoped(t, f.env, "POST", "/api/channels/threads/follow", map[string]any{
		"parentMessageId": f.parentMsgID,
	}, f.memberToken, f.ws)
	if recovered.Status != http.StatusOK {
		t.Fatalf("recovery follow: %d %s", recovered.Status, recovered.Raw)
	}
	threadID, _ := recovered.Body["threadChannelId"].(string)
	if threadID == "" {
		t.Fatalf("recovery follow returned no threadChannelId: %s", recovered.Raw)
	}
	var reads int
	if err := f.env.App.DB.QueryRow(`SELECT COUNT(*) FROM user_channel_read_states
		WHERE workspace_id=? AND user_id=? AND channel_id=?`, f.ws, f.memberID, threadID).Scan(&reads); err != nil {
		t.Fatal(err)
	}
	if reads != 1 {
		t.Fatalf("recovered follow: read rows=%d, want 1", reads)
	}
}

// TestStabilizationDMProjectionFailureHTTP restores the DM fault window the
// legacy m4_dm_snapshot suite covered: the create-DM projection runs INSIDE
// the write transaction after the DM channel row, memberships and dm:new
// intent are already inserted. A real projection failure (the frontier
// reader encounters malformed JSON ONLY once those same-transaction facts
// exist) must answer the legacy 500 body and roll the whole creation back.
// Reading before the facts exist succeeds, so an early failure cannot pass
// as evidence of this late rollback window.
func TestStabilizationDMProjectionFailureHTTP(t *testing.T) {
	f := newStabFixture(t, "dm")

	// A test-local read view adds a poison row ONLY for the new DM, after
	// its pair/channel/participant facts exist. The real SQLite JSON function
	// errors when that row's frontier is projected. Unlike a missing column,
	// this fault cannot fire during a pre-write probe of the same view.
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	view := fmt.Sprintf(`CREATE VIEW user_channel_read_states AS
		SELECT workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at
		FROM stab_read_states_before_fault
		UNION ALL
		SELECT d.workspace_id, %s, d.channel_id, json_extract('stabilization-invalid-json', '$'), 1, 1
		FROM direct_messages d JOIN channels c ON c.id=d.channel_id AND c.workspace_id=d.workspace_id
		WHERE d.workspace_id=%s AND c.type='dm'
			AND ((d.user_low=%s AND d.user_high=%s) OR (d.user_low=%s AND d.user_high=%s))
			AND EXISTS (SELECT 1 FROM channel_humans WHERE channel_id=d.channel_id AND user_id=%s)
			AND EXISTS (SELECT 1 FROM channel_humans WHERE channel_id=d.channel_id AND user_id=%s)`,
		quote(f.ownerID), quote(f.ws), quote(f.ownerID), quote(f.memberID), quote(f.memberID), quote(f.ownerID), quote(f.ownerID), quote(f.memberID))
	if err := stabExecDDL(f.env,
		`ALTER TABLE user_channel_read_states RENAME TO stab_read_states_before_fault`, view); err != nil {
		t.Fatalf("install conditional projection view atomically: %v", err)
	}
	// The exact same reader is healthy before the new DM exists.
	rows, err := f.env.App.DB.Query(`SELECT last_read_seq, read_state_version FROM user_channel_read_states WHERE workspace_id=? AND user_id=?`, f.ws, f.ownerID)
	if err != nil {
		t.Fatalf("fault must not occur before DM creation: %v", err)
	}
	for rows.Next() {
		var seq, version int64
		if err := rows.Scan(&seq, &version); err != nil {
			rows.Close()
			t.Fatalf("pre-create frontier reader must remain healthy: %v", err)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("pre-create frontier reader must remain healthy: %v", err)
	}
	rows.Close()
	before := stabSnapshot(t, f.env)

	res := stabScoped(t, f.env, "POST", "/api/channels/dm", map[string]any{
		"userId": f.memberID,
	}, f.ownerToken, f.ws)
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("DM create with failing projection: status %d, want 500 (%s)", res.Status, res.Raw)
	}
	if got, _ := res.Body["error"].(string); got != "Failed to create DM" {
		t.Fatalf("DM create 500 body: %q, want %q (%s)", got, "Failed to create DM", res.Raw)
	}
	stabAssertUnchanged(t, before, stabSnapshot(t, f.env))
	var dmChannels int
	if err := f.env.App.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id=? AND type='dm'`, f.ws).Scan(&dmChannels); err != nil {
		t.Fatal(err)
	}
	if dmChannels != 0 {
		t.Fatalf("failed DM create left %d partial DM channel rows", dmChannels)
	}

	// Recovery: with the original table restored, the same request succeeds.
	if err := stabExecDDL(f.env,
		`DROP VIEW user_channel_read_states`,
		`ALTER TABLE stab_read_states_before_fault RENAME TO user_channel_read_states`); err != nil {
		t.Fatalf("restore original readstate table atomically: %v", err)
	}
	recovered := stabScoped(t, f.env, "POST", "/api/channels/dm", map[string]any{
		"userId": f.memberID,
	}, f.ownerToken, f.ws)
	if recovered.Status != http.StatusOK {
		t.Fatalf("recovery DM create: %d %s", recovered.Status, recovered.Raw)
	}
	if err := f.env.App.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id=? AND type='dm'`, f.ws).Scan(&dmChannels); err != nil {
		t.Fatal(err)
	}
	if dmChannels != 1 {
		t.Fatalf("recovered DM create: %d DM channels, want 1", dmChannels)
	}
}
