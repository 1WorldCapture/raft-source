// Wire-level legacy machine management (R12: the human management surface
// lives in humanapi behind the verified-profile gate, the shared server
// scope middleware and the TS role/capability policy): register
// (registerMachines gate), rotate-key (capability OR machine-creator
// authority), patch shapes, delete conflict/rollback/disconnect ordering and
// the method fallbacks — plus scope behavior when the shared middleware is
// not wired.
package humanapi_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
	"raft.local/server-go/internal/workspace"
	"raft.local/server-go/tests/testkit"
)

const machinesTestPepper = "computer-test-pepper-0123456789abcdef"

type machinesEnv struct {
	t        *testing.T
	db       *sql.DB
	mux      *http.ServeMux
	handlers *humanapi.MachineHandlers
	store    *computer.Store
	fixed    *clock.Fixed
	signer   *auth.TokenSigner
}

func newMachinesEnv(t *testing.T, tune func(e *machinesEnv)) *machinesEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	store, err := computer.NewStore(handle, computer.Options{
		Clock:            &fixed,
		DeviceCodePepper: []byte(machinesTestPepper),
		Argon:            computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1},
	})
	if err != nil {
		t.Fatalf("computer store: %v", err)
	}
	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner([]byte("test-secret-0123456789abcdef0123456789abcdef"), 15*time.Minute)
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &authn.AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}

	handlers := &humanapi.MachineHandlers{Store: store}
	env := &machinesEnv{t: t, db: handle, handlers: handlers, store: store, fixed: &fixed, signer: signer}
	// tune runs BEFORE the routes are registered: the scope middleware is
	// bound at registration time exactly like the parent assembly.
	if tune != nil {
		tune(env)
	}
	mux := http.NewServeMux()
	humanapi.RegisterMachineRoutes(mux, handlers, gate)
	env.mux = mux
	return env
}

func (e *machinesEnv) seedUser(id string) {
	e.t.Helper()
	now := e.fixed.Now().UnixMilli()
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, ?, ?)`, id, id+"@example.test", id, now, now); err != nil {
		e.t.Fatal(err)
	}
}

func (e *machinesEnv) seedWorkspace(id, slug, owner string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, "WS "+id, slug, owner, e.fixed.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *machinesEnv) seedMembership(workspaceID, userID, role string) {
	e.t.Helper()
	if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspaceID, userID, role, e.fixed.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *machinesEnv) tokenFor(userID string) string {
	e.t.Helper()
	token, err := e.signer.SignAccessToken(userID, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return token
}

func (e *machinesEnv) authed(userID, workspaceID string) map[string]string {
	e.t.Helper()
	headers := testkit.Bearer(e.tokenFor(userID))
	headers["X-Server-Id"] = workspaceID
	return headers
}

func (e *machinesEnv) Serve(method, path string, body string, headers map[string]string) (int, map[string]any, string) {
	e.t.Helper()
	rec := e.exchange(method, path, body, headers)
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal([]byte(rec.Body.String()), &parsed)
	}
	return rec.Code, parsed, rec.Body.String()
}

func (e *machinesEnv) exchange(method, path string, body string, headers map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	req, err := http.NewRequest(method, path, strings.NewReader(body))
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
	return rec
}

func (e *machinesEnv) registerMachineOK(workspaceID, userID, name string) map[string]any {
	e.t.Helper()
	code, body, raw := e.Serve("POST", "/api/servers/"+workspaceID+"/machines",
		`{"name":"`+name+`"}`, testkit.Bearer(e.tokenFor(userID)))
	if code != http.StatusOK {
		e.t.Fatalf("register machine: %d %s", code, raw)
	}
	return body
}

func mustJSONMachine(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func utf16UnitsMachine(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

func TestRegisterMachineContract(t *testing.T) {
	e := newMachinesEnv(t, nil)
	e.seedUser("owner")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")

	// Non-member -> the TS "Server not found" (scope middleware absent, so
	// the handler's own role read decides).
	e.seedUser("stranger")
	if code, body, _ := e.Serve("POST", "/api/servers/w1/machines", `{"name":"m1"}`, testkit.Bearer(e.tokenFor("stranger"))); code != http.StatusNotFound || body["error"] != "Server not found" {
		t.Fatalf("stranger register = %d %v", code, body["error"])
	}
	// Member has a role but lacks the capability.
	if code, body, _ := e.Serve("POST", "/api/servers/w1/machines", `{"name":"m1"}`, testkit.Bearer(e.tokenFor("member"))); code != http.StatusForbidden || body["error"] != "The `registerMachines` capability is required to register machines" {
		t.Fatalf("member register = %d %v", code, body["error"])
	}
	// Name required.
	if code, body, _ := e.Serve("POST", "/api/servers/w1/machines", `{}`, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["error"] != "Name is required" {
		t.Fatalf("nameless register = %d %v", code, body["error"])
	}

	body := e.registerMachineOK("w1", "admin", "Admin Box")
	apiKey, _ := body["apiKey"].(string)
	if len(apiKey) <= len("sk_machine_") {
		t.Fatalf("apiKey = %q", apiKey)
	}
	machine, _ := body["machine"].(map[string]any)
	if machine == nil || machine["id"] == "" || machine["serverId"] != "w1" || machine["userId"] != "admin" {
		t.Fatalf("machine read model = %v", machine)
	}
	if machine["status"] != "offline" || machine["isComputer"] != false || machine["agentCount"] != float64(0) {
		t.Fatalf("read model derived fields = %v", machine)
	}
	if prefix, _ := machine["apiKeyPrefix"].(string); prefix != apiKey[:20] {
		t.Fatalf("apiKeyPrefix = %q, want first 20 of the raw key", prefix)
	}
}

func TestRotateMachineKeyContract(t *testing.T) {
	e := newMachinesEnv(t, nil)
	e.seedUser("creator")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedWorkspace("w1", "alpha", "creator")
	e.seedMembership("w1", "creator", "admin")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")

	created := e.registerMachineOK("w1", "creator", "box")
	machine, _ := created["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	path := "/api/servers/w1/machines/" + machineID + "/rotate-key"

	// Creator authority beats the missing role capability.
	code, body, raw := e.Serve("POST", path, ``, testkit.Bearer(e.tokenFor("creator")))
	if code != http.StatusOK {
		t.Fatalf("creator rotate = %d %s", code, raw)
	}
	rotated, _ := body["apiKey"].(string)
	if rotated == "" || rotated == created["apiKey"] {
		t.Fatalf("rotated key = %v", body)
	}

	// Non-creator member is denied with the capability message.
	code, body, _ = e.Serve("POST", path, ``, testkit.Bearer(e.tokenFor("member")))
	if code != http.StatusForbidden || body["error"] != "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" {
		t.Fatalf("member rotate = %d %v", code, body["error"])
	}
	// Admin rotates by capability.
	if code, _, raw2 := e.Serve("POST", path, ``, testkit.Bearer(e.tokenFor("admin"))); code != http.StatusOK {
		t.Fatalf("admin rotate = %d %s", code, raw2)
	}
	// Machine of another workspace is a uniform miss.
	e.seedWorkspace("w2", "beta", "admin")
	e.seedMembership("w2", "admin", "owner")
	if code, body, _ := e.Serve("POST", "/api/servers/w2/machines/"+machineID+"/rotate-key", ``, testkit.Bearer(e.tokenFor("admin"))); code != http.StatusNotFound || body["error"] != "Machine not found in this server" {
		t.Fatalf("cross-workspace rotate = %d %v", code, body["error"])
	}
	// Non-member caller gets the "Server not found" answer.
	e.seedUser("stranger")
	if code, body, _ := e.Serve("POST", path, ``, testkit.Bearer(e.tokenFor("stranger"))); code != http.StatusNotFound || body["error"] != "Server not found" {
		t.Fatalf("stranger rotate = %d %v", code, body["error"])
	}
}

func TestMachineManagementGatesAndPatchShapes(t *testing.T) {
	e, disconnected := newScopedMachinesEnv(t)
	e.seedUser("owner")
	e.seedUser("creator")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedUser("guest")
	e.seedUser("stranger")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "creator", "member")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")
	e.seedMembership("w1", "guest", "guest")
	now := e.fixed.Now().UnixMilli()
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('unverified', 'unverified@example.test', 'unverified', 'x', 0, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('pendinguser', 'pendinguser@example.test', 'pending_user', 'x', 1, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	e.seedMembership("w1", "unverified", "owner")
	e.seedMembership("w1", "pendinguser", "owner")

	path := "/api/servers/w1/machines"
	if rec := e.exchange("POST", path, `{"name":"box"}`, testkit.Bearer(e.tokenFor("owner"))); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Missing X-Server-Id header") {
		t.Fatalf("missing scope = %d %s", rec.Code, rec.Body.String())
	}
	if code, body, _ := e.Serve("POST", path, `{"name":"box"}`, e.authed("stranger", "w1")); code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("non-member = %d %v", code, body["error"])
	}
	if code, body, _ := e.Serve("POST", path, `{"name":"box"}`, e.authed("unverified", "w1")); code != http.StatusForbidden || body["error"] != "Email verification required" {
		t.Fatalf("unverified = %d %v", code, body)
	}
	if code, body, _ := e.Serve("POST", path, `{"name":"box"}`, e.authed("pendinguser", "w1")); code != http.StatusForbidden || body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("profile = %d %v", code, body)
	}
	if code, body, _ := e.Serve("POST", path, `{"name":"box"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest register = %d %v", code, body["error"])
	}
	if code, body, _ := e.Serve("POST", path, `{"name":"box"}`, e.authed("member", "w1")); code != http.StatusForbidden || body["error"] != "The `registerMachines` capability is required to register machines" {
		t.Fatalf("member register = %d %v", code, body["error"])
	}

	code, body, raw := e.Serve("POST", path, `{"name":"Admin Box"}`, e.authed("admin", "w1"))
	if code != http.StatusOK {
		t.Fatalf("register = %d %s", code, raw)
	}
	if strings.Contains(raw, "apiKeyHash") || strings.Contains(raw, "argon2") {
		t.Fatalf("register rec leaked a verifier: %s", raw)
	}
	machine, _ := body["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	apiKey, _ := body["apiKey"].(string)
	single := "/api/servers/w1/machines/" + machineID
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'creator' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}

	// Authorization is decided before body validation.
	if code, body, _ := e.Serve("PATCH", single, `{"description":1}`, e.authed("member", "w1")); code != http.StatusForbidden || body["error"] != "The `editMachines` capability or machine creator authority is required to edit machines" {
		t.Fatalf("member patch = %d %v", code, body["error"])
	}
	if code, body, _ := e.Serve("PATCH", single, `{"name":"stolen"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest creator patch = %d %v", code, body["error"])
	}
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'guest' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}
	if code, body, _ := e.Serve("PATCH", single, `{"name":"stolen"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest who owns the row = %d %v", code, body["error"])
	}
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'creator' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		body string
		want string
	}{
		{`{}`, "Name or description is required"},
		{`{"name":null}`, "Name is required"},
		{`{"name":1}`, "Name is required"},
		{`{"name":"   "}`, "Name is required"},
		{`{"name":1,"description":1}`, "Name is required"},
		{`{"description":1}`, "Description must be a string"},
		{`{"description":false}`, "Description must be a string"},
		{`{"description":{"text":"no"}}`, "Description must be a string"},
		{mustJSONMachine(t, map[string]any{"description": strings.Repeat("中", 501)}), "Description must be 500 characters or less"},
		{mustJSONMachine(t, map[string]any{"description": strings.Repeat("😀", 251)}), "Description must be 500 characters or less"},
		{mustJSONMachine(t, map[string]any{"description": strings.Repeat("😀", 500)}), "Description must be 500 characters or less"},
	}
	for _, tc := range cases {
		code, body, raw := e.Serve("PATCH", single, tc.body, e.authed("creator", "w1"))
		if code != http.StatusBadRequest || body["error"] != tc.want {
			t.Fatalf("patch %s = %d %v raw %s", tc.body, code, body["error"], raw)
		}
	}

	code, body, raw = e.Serve("PATCH", single, mustJSONMachine(t, map[string]any{
		"name":        "  renamed box  ",
		"description": "  Runs the staging smoke tests  ",
	}), e.authed("creator", "w1"))
	if code != http.StatusOK || body["name"] != "renamed box" || body["description"] != "Runs the staging smoke tests" {
		t.Fatalf("trim patch = %d %v", code, body)
	}
	if _, ok := body["apiKeyHash"]; ok || strings.Contains(raw, "argon2") || strings.Contains(raw, "apiKeyFingerprint") {
		t.Fatalf("patch leaked verifier: %s", raw)
	}
	code, body, _ = e.Serve("PATCH", single, mustJSONMachine(t, map[string]any{"description": strings.Repeat("中", 500)}), e.authed("admin", "w1"))
	if code != http.StatusOK || body["description"] != strings.Repeat("中", 500) || body["name"] != "renamed box" {
		t.Fatalf("500 BMP description = %d %v", code, body["description"])
	}
	code, body, _ = e.Serve("PATCH", single, mustJSONMachine(t, map[string]any{"description": strings.Repeat("😀", 250)}), e.authed("creator", "w1"))
	if code != http.StatusOK || utf16UnitsMachine(body["description"].(string)) != 500 {
		t.Fatalf("250 emoji description = %d %v", code, body["description"])
	}
	code, body, raw = e.Serve("PATCH", single, `{"description":"   "}`, e.authed("creator", "w1"))
	if code != http.StatusOK || body["description"] != nil || !strings.Contains(raw, `"description":null`) {
		t.Fatalf("blank description = %d %s", code, raw)
	}
	code, body, raw = e.Serve("PATCH", single, `{"description":null}`, e.authed("owner", "w1"))
	if code != http.StatusOK || body["description"] != nil || body["name"] != "renamed box" {
		t.Fatalf("null description = %d %s", code, raw)
	}
	if len(*disconnected) != 0 {
		t.Fatalf("patch disconnected %#v", *disconnected)
	}
	_ = apiKey
}

func TestMachineDeleteRotateDisconnectAndMethodFallback(t *testing.T) {
	e, disconnected := newScopedMachinesEnv(t)
	e.seedUser("owner")
	e.seedUser("creator")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedUser("guest")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "creator", "member")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")
	e.seedMembership("w1", "guest", "guest")
	code, body, raw := e.Serve("POST", "/api/servers/w1/machines", `{"name":"box"}`, e.authed("owner", "w1"))
	if code != http.StatusOK {
		t.Fatalf("register = %d %s", code, raw)
	}
	machine, _ := body["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	originalKey, _ := body["apiKey"].(string)
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'creator' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}
	now := e.fixed.Now().UnixMilli()
	if _, err := e.db.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at)
		VALUES ('c-live', 'w1', 'box', 'owner', ?, ?)`, machineID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, machine_id, created_at, updated_at)
		VALUES ('a-live', 'w1', 'cindy', 'active', 'claude', ?, ?, ?)`, machineID, now, now); err != nil {
		t.Fatal(err)
	}
	single := "/api/servers/w1/machines/" + machineID
	rotate := single + "/rotate-key"

	code, body, _ = e.Serve("DELETE", single, ``, e.authed("member", "w1"))
	if code != http.StatusForbidden || body["error"] != "The `removeMachines` capability or machine creator authority is required to remove machines" {
		t.Fatalf("member delete = %d %v", code, body["error"])
	}
	code, body, _ = e.Serve("DELETE", single, ``, e.authed("creator", "w1"))
	if code != http.StatusConflict || body["code"] != computer.MachineDeleteAssignedAgents || body["error"] != computer.MachineDeleteAssignedAgentsMessage || body["ok"] == true {
		t.Fatalf("assigned delete = %d %v", code, body)
	}
	if len(*disconnected) != 0 {
		t.Fatalf("conflict disconnected %#v", *disconnected)
	}
	var still int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM machines WHERE id = ?`, machineID).Scan(&still); err != nil || still != 1 {
		t.Fatalf("conflict removed the machine: %d %v", still, err)
	}

	if _, err := e.db.Exec(`UPDATE agents SET deleted_at = ? WHERE id = 'a-live'`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		CREATE TRIGGER machine_delete_abort BEFORE DELETE ON machines
		BEGIN
			SELECT RAISE(ABORT, 'forced delete failure');
		END`); err != nil {
		t.Fatal(err)
	}
	rec := e.exchange("DELETE", single, ``, e.authed("creator", "w1"))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"machine_delete_failed"`) || strings.Contains(rec.Body.String(), "forced") || strings.Contains(rec.Body.String(), "sk_") {
		t.Fatalf("rollback delete = %d %s", rec.Code, rec.Body.String())
	}
	if len(*disconnected) != 0 {
		t.Fatalf("failed delete disconnected %#v", *disconnected)
	}
	var revokedValid int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM computers WHERE id = 'c-live' AND revoked_at IS NULL AND machine_id = ?`, machineID).Scan(&revokedValid); err != nil || revokedValid != 1 {
		t.Fatalf("revoke survived a failed delete: %d %v", revokedValid, err)
	}
	if _, err := e.db.Exec(`DROP TRIGGER machine_delete_abort`); err != nil {
		t.Fatal(err)
	}

	code, body, raw = e.Serve("POST", rotate, ``, e.authed("member", "w1"))
	if code != http.StatusForbidden || body["error"] != "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" {
		t.Fatalf("member rotate = %d %v", code, body["error"])
	}
	code, body, raw = e.Serve("POST", rotate, ``, e.authed("creator", "w1"))
	if code != http.StatusOK {
		t.Fatalf("creator rotate = %d %s", code, raw)
	}
	rotated, _ := body["apiKey"].(string)
	if rotated == "" || rotated == originalKey || strings.Contains(raw, "apiKeyHash") {
		t.Fatalf("rotate body = %s", raw)
	}
	if len(*disconnected) != 1 || (*disconnected)[0] != machineID || strings.Contains((*disconnected)[0], "sk_") {
		t.Fatalf("rotate disconnect = %#v", *disconnected)
	}
	if _, err := e.store.Authenticate(t.Context(), originalKey); err == nil {
		t.Fatal("old key still authenticated")
	}
	if _, err := e.store.Authenticate(t.Context(), rotated); err != nil {
		t.Fatalf("new key: %v", err)
	}
	code, body, _ = e.Serve("POST", rotate, ``, e.authed("guest", "w1"))
	if code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest rotate = %d %v", code, body["error"])
	}

	code, body, raw = e.Serve("DELETE", single, ``, e.authed("admin", "w1"))
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("delete = %d %s", code, raw)
	}
	if len(*disconnected) != 2 || (*disconnected)[1] != machineID {
		t.Fatalf("delete disconnect = %#v", *disconnected)
	}
	var reason string
	if err := e.db.QueryRow(`SELECT revoked_reason FROM computers WHERE id = 'c-live'`).Scan(&reason); err != nil || reason != "machine_deleted" {
		t.Fatalf("revoked_reason = %q %v", reason, err)
	}
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM machines WHERE id = ?`, machineID).Scan(&still); err != nil || still != 0 {
		t.Fatalf("machine still present: %d %v", still, err)
	}

	// Identity and the guest wall run before the method fallback.
	if rec := e.exchange("PUT", single, ``, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous put = %d %s", rec.Code, rec.Body.String())
	}
	if code, body, _ := e.Serve("PUT", single, ``, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("put without scope = %d %v", code, body["error"])
	}
	if code, body, _ := e.Serve("PUT", single, ``, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest put = %d %v", code, body["error"])
	}
	rec = e.exchange("PUT", single, ``, e.authed("owner", "w1"))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "PATCH, DELETE" || !strings.Contains(rec.Body.String(), "Method not allowed") {
		t.Fatalf("single-machine fallback = %d allow %q body %s", rec.Code, rec.Header().Get("Allow"), rec.Body.String())
	}
	rec = e.exchange("GET", rotate, ``, e.authed("owner", "w1"))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "POST" {
		t.Fatalf("rotate fallback = %d allow %q", rec.Code, rec.Header().Get("Allow"))
	}
}

func TestNilDisconnectCallbackStillDeletes(t *testing.T) {
	e := newMachinesEnv(t, nil)
	e.seedUser("owner")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	created := e.registerMachineOK("w1", "owner", "solo")
	machine, _ := created["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	code, body, raw := e.Serve("DELETE", "/api/servers/w1/machines/"+machineID, ``, testkit.Bearer(e.tokenFor("owner")))
	if code != http.StatusOK || body["ok"] != true || strings.Contains(raw, "sk_") {
		t.Fatalf("nil callback delete = %d %s", code, raw)
	}
}

// newScopedMachinesEnv wires the REAL ServersHandlers scope middleware, the
// same one the parent assembly chains in front of the machine routes.
func newScopedMachinesEnv(t *testing.T) (*machinesEnv, *[]string) {
	t.Helper()
	calls := []string{}
	env := newMachinesEnv(t, func(e *machinesEnv) {
		e.handlers.Scope = (&humanapi.ServersHandlers{Store: workspace.NewStore(e.db)}).RequireServerScope
		e.handlers.DisconnectMachine = func(machineID string) { calls = append(calls, machineID) }
	})
	return env, &calls
}
