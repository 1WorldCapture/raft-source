package legacyweb_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/legacyweb"
	"raft.local/server-go/internal/workspace"
)

func newScopedComputerEnv(t *testing.T) (*computerEnv, *[]string) {
	t.Helper()
	calls := []string{}
	env := newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) {
		h.Scope = (&legacyweb.ServersHandlers{Store: workspace.NewStore(h.Store.DB())}).RequireServerScope
		h.DisconnectMachine = func(machineID string) {
			calls = append(calls, machineID)
		}
	})
	return env, &calls
}

func (e *computerEnv) authed(userID, workspaceID string) map[string]string {
	e.t.Helper()
	headers := e.bearer(e.tokenFor(userID))
	headers["X-Server-Id"] = workspaceID
	return headers
}

func (e *computerEnv) exchange(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
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

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMachineManagementGatesAndPatchShapes(t *testing.T) {
	e, disconnected := newScopedComputerEnv(t)
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
	if rec := e.exchange("POST", path, `{"name":"box"}`, e.bearer(e.tokenFor("owner"))); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Missing X-Server-Id header") {
		t.Fatalf("missing scope = %d %s", rec.Code, rec.Body.String())
	}
	if code, body, _ := e.serve("POST", path, `{"name":"box"}`, e.authed("stranger", "w1")); code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("non-member = %d %v", code, body["error"])
	}
	if code, body, _ := e.serve("POST", path, `{"name":"box"}`, e.authed("unverified", "w1")); code != http.StatusForbidden || body["error"] != "Email verification required" {
		t.Fatalf("unverified = %d %v", code, body)
	}
	if code, body, _ := e.serve("POST", path, `{"name":"box"}`, e.authed("pendinguser", "w1")); code != http.StatusForbidden || body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("profile = %d %v", code, body)
	}
	if code, body, _ := e.serve("POST", path, `{"name":"box"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest register = %d %v", code, body["error"])
	}
	if code, body, _ := e.serve("POST", path, `{"name":"box"}`, e.authed("member", "w1")); code != http.StatusForbidden || body["error"] != "The `registerMachines` capability is required to register machines" {
		t.Fatalf("member register = %d %v", code, body["error"])
	}

	code, body, raw := e.serve("POST", path, `{"name":"Admin Box"}`, e.authed("admin", "w1"))
	if code != http.StatusOK {
		t.Fatalf("register = %d %s", code, raw)
	}
	if strings.Contains(raw, "apiKeyHash") || strings.Contains(raw, "argon2") {
		t.Fatalf("register response leaked a verifier: %s", raw)
	}
	machine, _ := body["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	apiKey, _ := body["apiKey"].(string)
	single := "/api/servers/w1/machines/" + machineID
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'creator' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}

	// Authorization is decided before body validation.
	if code, body, _ := e.serve("PATCH", single, `{"description":1}`, e.authed("member", "w1")); code != http.StatusForbidden || body["error"] != "The `editMachines` capability or machine creator authority is required to edit machines" {
		t.Fatalf("member patch = %d %v", code, body["error"])
	}
	if code, body, _ := e.serve("PATCH", single, `{"name":"stolen"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest creator patch = %d %v", code, body["error"])
	}
	if _, err := e.db.Exec(`UPDATE machines SET user_id = 'guest' WHERE id = ?`, machineID); err != nil {
		t.Fatal(err)
	}
	if code, body, _ := e.serve("PATCH", single, `{"name":"stolen"}`, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
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
		{mustJSON(t, map[string]any{"description": strings.Repeat("中", 501)}), "Description must be 500 characters or less"},
		{mustJSON(t, map[string]any{"description": strings.Repeat("😀", 251)}), "Description must be 500 characters or less"},
		{mustJSON(t, map[string]any{"description": strings.Repeat("😀", 500)}), "Description must be 500 characters or less"},
	}
	for _, tc := range cases {
		code, body, raw := e.serve("PATCH", single, tc.body, e.authed("creator", "w1"))
		if code != http.StatusBadRequest || body["error"] != tc.want {
			t.Fatalf("patch %s = %d %v raw %s", tc.body, code, body["error"], raw)
		}
	}

	code, body, raw = e.serve("PATCH", single, mustJSON(t, map[string]any{
		"name":        "  renamed box  ",
		"description": "  Runs the staging smoke tests  ",
	}), e.authed("creator", "w1"))
	if code != http.StatusOK || body["name"] != "renamed box" || body["description"] != "Runs the staging smoke tests" {
		t.Fatalf("trim patch = %d %v", code, body)
	}
	if _, ok := body["apiKeyHash"]; ok || strings.Contains(raw, "argon2") || strings.Contains(raw, "apiKeyFingerprint") {
		t.Fatalf("patch leaked verifier: %s", raw)
	}
	code, body, _ = e.serve("PATCH", single, mustJSON(t, map[string]any{"description": strings.Repeat("中", 500)}), e.authed("admin", "w1"))
	if code != http.StatusOK || body["description"] != strings.Repeat("中", 500) || body["name"] != "renamed box" {
		t.Fatalf("500 BMP description = %d %v", code, body["description"])
	}
	code, body, _ = e.serve("PATCH", single, mustJSON(t, map[string]any{"description": strings.Repeat("😀", 250)}), e.authed("creator", "w1"))
	if code != http.StatusOK || utf16Units(body["description"].(string)) != 500 {
		t.Fatalf("250 emoji description = %d %v", code, body["description"])
	}
	code, body, raw = e.serve("PATCH", single, `{"description":"   "}`, e.authed("creator", "w1"))
	if code != http.StatusOK || body["description"] != nil || !strings.Contains(raw, `"description":null`) {
		t.Fatalf("blank description = %d %s", code, raw)
	}
	code, body, raw = e.serve("PATCH", single, `{"description":null}`, e.authed("owner", "w1"))
	if code != http.StatusOK || body["description"] != nil || body["name"] != "renamed box" {
		t.Fatalf("null description = %d %s", code, raw)
	}
	if len(*disconnected) != 0 {
		t.Fatalf("patch disconnected %#v", *disconnected)
	}
	_ = apiKey
}

func TestMachineDeleteRotateDisconnectAndMethodFallback(t *testing.T) {
	e, disconnected := newScopedComputerEnv(t)
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
	code, body, raw := e.serve("POST", "/api/servers/w1/machines", `{"name":"box"}`, e.authed("owner", "w1"))
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

	code, body, _ = e.serve("DELETE", single, ``, e.authed("member", "w1"))
	if code != http.StatusForbidden || body["error"] != "The `removeMachines` capability or machine creator authority is required to remove machines" {
		t.Fatalf("member delete = %d %v", code, body["error"])
	}
	code, body, _ = e.serve("DELETE", single, ``, e.authed("creator", "w1"))
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

	code, body, raw = e.serve("POST", rotate, ``, e.authed("member", "w1"))
	if code != http.StatusForbidden || body["error"] != "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" {
		t.Fatalf("member rotate = %d %v", code, body["error"])
	}
	code, body, raw = e.serve("POST", rotate, ``, e.authed("creator", "w1"))
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
	if _, err := e.handlers.Store.Authenticate(t.Context(), originalKey); err == nil {
		t.Fatal("old key still authenticated")
	}
	if _, err := e.handlers.Store.Authenticate(t.Context(), rotated); err != nil {
		t.Fatalf("new key: %v", err)
	}
	code, body, _ = e.serve("POST", rotate, ``, e.authed("guest", "w1"))
	if code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest rotate = %d %v", code, body["error"])
	}

	code, body, raw = e.serve("DELETE", single, ``, e.authed("admin", "w1"))
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
	if code, body, _ := e.serve("PUT", single, ``, e.bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("put without scope = %d %v", code, body["error"])
	}
	if code, body, _ := e.serve("PUT", single, ``, e.authed("guest", "w1")); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
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
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	created := e.registerMachineOK("w1", "owner", "box")
	machine, _ := created["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	code, body, raw := e.serve("DELETE", "/api/servers/w1/machines/"+machineID, ``, e.bearer(e.tokenFor("owner")))
	if code != http.StatusOK || body["ok"] != true || strings.Contains(raw, "sk_") {
		t.Fatalf("nil callback delete = %d %s", code, raw)
	}
}

func TestDeviceApproveKeepsRequireGate(t *testing.T) {
	e := newComputerEnv(t)
	now := e.fixed.Now().UnixMilli()
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('unverified', 'unverified@example.test', 'unverified', 'x', 0, ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	code, body, _ := e.serve("POST", "/api/auth/device/approve", `{}`, e.bearer(e.tokenFor("unverified")))
	if code != http.StatusBadRequest || body["code"] != "user_code_required" {
		t.Fatalf("device approve = %d %v", code, body)
	}
	if body["error"] == "Email verification required" {
		t.Fatal("device approve was moved behind the verified-profile gate")
	}
}

func utf16Units(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}
