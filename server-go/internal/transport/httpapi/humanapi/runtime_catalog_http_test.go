package humanapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"strings"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/runtimecatalog"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
)

type catalogGateway struct {
	mu     sync.Mutex
	online bool
	gen    uint64
	sent   chan any
}

func (g *catalogGateway) IsOnline(string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.online
}

func (g *catalogGateway) Send(_ context.Context, _ string, payload any) error {
	g.sent <- payload
	return nil
}

type catalogEnv struct {
	t      *testing.T
	db     *sql.DB
	mux    *http.ServeMux
	gw     *catalogGateway
	broker *runtimecatalog.Broker
	signer *auth.TokenSigner
	now    int64
}

func newCatalogEnv(t *testing.T) *catalogEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	gw := &catalogGateway{sent: make(chan any, 4), gen: 1}
	broker := runtimecatalog.NewBroker(runtimecatalog.BrokerConfig{
		Gateway: gw,
		Generation: func(string) (uint64, bool) {
			gw.mu.Lock()
			defer gw.mu.Unlock()
			if !gw.online {
				return 0, false
			}
			return gw.gen, true
		},
	})
	signer := auth.NewTokenSigner([]byte("runtime-catalog-test-secret-0123456789"), 15*time.Minute)
	authStore := auth.NewStore(handle)
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &authn.AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}
	mux := http.NewServeMux()
	humanapi.RegisterRuntimeCatalogRoutes(mux, &humanapi.RuntimeCatalogHandlers{
		Store:  runtimecatalog.NewStore(handle),
		Broker: broker,
	}, gate)
	return &catalogEnv{t: t, db: handle, mux: mux, gw: gw, broker: broker, signer: signer, now: time.Date(2026, 10, 8, 8, 0, 0, 0, time.UTC).UnixMilli()}
}

func (e *catalogEnv) user(id string) {
	e.t.Helper()
	_, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, ?, ?)`, id, id+"@example.test", id, e.now, e.now)
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *catalogEnv) workspace(id, owner string) {
	e.t.Helper()
	_, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, id, id, owner, e.now)
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *catalogEnv) member(workspace, user, role string) {
	e.t.Helper()
	_, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspace, user, role, e.now)
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *catalogEnv) machine(id, workspace, user, runtimes string) {
	e.t.Helper()
	var encoded any
	if runtimes == "NULL" {
		encoded = nil
	} else {
		encoded = runtimes
	}
	_, err := e.db.Exec(`INSERT INTO machines (id, workspace_id, user_id, name, runtimes, daemon_version, computer_version, created_at)
		VALUES (?, ?, ?, ?, ?, '1.4.0', '2.0.0', ?)`, id, workspace, user, id, encoded, e.now)
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *catalogEnv) agent(id, workspace, runtime, machineID string, deleted bool) {
	e.t.Helper()
	var deletedAt any
	if deleted {
		deletedAt = e.now
	}
	var machine any
	if machineID != "" {
		machine = machineID
	}
	_, err := e.db.Exec(`INSERT INTO agents (id, workspace_id, name, runtime, machine_id, deleted_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, workspace, id, runtime, machine, deletedAt, e.now, e.now)
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *catalogEnv) token(user string) string {
	e.t.Helper()
	token, err := e.signer.SignAccessToken(user, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return token
}

func (e *catalogEnv) Serve(method, path, user, server string) (int, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if user != "" {
		req.Header.Set("Authorization", "Bearer "+e.token(user))
	}
	if server != "" {
		req.Header.Set("X-Server-Id", server)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	body := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func (e *catalogEnv) serveAsync(method, path, user, server string) (<-chan int, <-chan map[string]any) {
	codes := make(chan int, 1)
	bodies := make(chan map[string]any, 1)
	go func() {
		code, body := e.Serve(method, path, user, server)
		codes <- code
		bodies <- body
	}()
	return codes, bodies
}

func (e *catalogEnv) nextPayload() map[string]any {
	e.t.Helper()
	select {
	case payload := <-e.gw.sent:
		raw, err := json.Marshal(payload)
		if err != nil {
			e.t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			e.t.Fatal(err)
		}
		return decoded
	case <-time.After(2 * time.Second):
		e.t.Fatal("timed out waiting for a machine payload")
		return nil
	}
}

func TestRuntimeOptionsFailClosedWithoutAuthAndHideMissingFlags(t *testing.T) {
	e := newCatalogEnv(t)
	e.user("ada")
	e.user("mia")
	e.user("ned")
	e.user("gus")
	e.user("out")
	e.workspace("ws", "ada")
	e.member("ws", "ada", "owner")
	e.member("ws", "mia", "member")
	e.member("ws", "ned", "member")
	e.member("ws", "gus", "guest")
	e.machine("mac-mia", "ws", "mia", `["codex","grok","builtin"]`)
	e.machine("mac-ada", "ws", "ada", "NULL")
	e.machine("mac-bad", "ws", "ada", `{"not":"an array"}`)
	e.workspace("ws2", "ada")
	e.member("ws2", "ada", "owner")
	e.machine("mac-ws2", "ws2", "ada", `["claude"]`)
	e.agent("agent-grok", "ws", "grok", "mac-mia", false)
	e.agent("agent-gone", "ws", "claude", "mac-mia", true)
	e.agent("agent-foreign", "ws2", "claude", "", false)
	e.agent("agent-cross", "ws", "claude", "mac-ws2", false)

	path := "/api/servers/ws/machines/mac-mia/runtime-options"
	if code, body := e.Serve(http.MethodGet, path, "", "ws"); code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "ada", ""); code != http.StatusBadRequest || body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("missing header = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "ada", "other"); code != http.StatusBadRequest || body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("mismatch = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "out", "ws"); code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("outsider = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "gus", "ws"); code != http.StatusForbidden || body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest owner-bypass must not apply, got %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "ned", "ws"); code != http.StatusForbidden || !strings.Contains(body["error"].(string), "editMachines") {
		t.Fatalf("non-creator member = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, path, "ada", "ws"); code != http.StatusOK || body["context"] != "new_agent" {
		t.Fatalf("owner = %d %#v", code, body)
	}
	code, body := e.Serve(http.MethodGet, path, "mia", "ws")
	if code != http.StatusOK || body["context"] != "new_agent" || body["machineId"] != "mac-mia" {
		t.Fatalf("creator member = %d %#v", code, body)
	}
	options := body["options"].([]any)
	if runtimeListed(options, "grok") || runtimeListed(options, "omp") || runtimeListed(options, "kimi") {
		t.Fatalf("C0 new-agent leaked runtimes: %#v", options)
	}
	codex := runtimeOption(t, options, "codex")
	if codex["capabilityStatus"] != "available" || codex["canSelectInThisContext"] != true || codex["admissionReason"] != nil {
		t.Fatalf("codex = %#v", codex)
	}
	if _, ok := codex["formDefinitionRef"]; ok {
		t.Fatal("codex must omit formDefinitionRef")
	}
	builtin := runtimeOption(t, options, "builtin")
	ref := builtin["formDefinitionRef"].(map[string]any)
	if ref["schemaVersion"] != runtimecatalog.BuiltinPiFormSchemaVersion || builtin["capabilityStatus"] != "available" {
		t.Fatalf("builtin = %#v", builtin)
	}

	code, body = e.Serve(http.MethodGet, "/api/servers/ws/machines/mac-ada/runtime-options", "ada", "ws")
	if code != http.StatusOK {
		t.Fatalf("null runtimes = %d %#v", code, body)
	}
	unreported := body["options"].([]any)
	if runtimeOption(t, unreported, "claude")["capabilityStatus"] != "not_installed" || runtimeOption(t, unreported, "builtin")["capabilityStatus"] != "update_required" {
		t.Fatal("NULL runtimes were treated as installed or ready")
	}
	code, body = e.Serve(http.MethodGet, "/api/servers/ws/machines/mac-bad/runtime-options", "ada", "ws")
	if code != http.StatusInternalServerError {
		t.Fatalf("bad runtimes = %d %#v", code, body)
	}
	if _, ok := body["options"]; ok {
		t.Fatal("unparseable runtimes produced a catalog")
	}

	agentPath := "/api/agents/agent-grok/runtime-options"
	code, body = e.Serve(http.MethodGet, agentPath, "mia", "ws")
	if code != http.StatusOK || body["context"] != "existing_agent" || body["machineId"] != "mac-mia" {
		t.Fatalf("existing = %d %#v", code, body)
	}
	grok := runtimeOption(t, body["options"].([]any), "grok")
	if grok["admissionStatus"] != "grandfathered_current" || grok["admissionReason"] != "feature_flag_off" || grok["canSelectInThisContext"] != true || grok["availableForNew"] != false {
		t.Fatalf("grandfathered grok = %#v", grok)
	}
	if runtimeListed(body["options"].([]any), "omp") {
		t.Fatal("existing picker offered flag-off omp")
	}
	if code, _ := e.Serve(http.MethodGet, "/api/agents/agent-gone/runtime-options", "mia", "ws"); code != http.StatusNotFound {
		t.Fatalf("deleted agent = %d", code)
	}
	if code, body := e.Serve(http.MethodGet, "/api/agents/agent-foreign/runtime-options", "ada", "ws"); code != http.StatusNotFound || body["error"] != "Agent not found" {
		t.Fatalf("foreign agent = %d %#v", code, body)
	}
	code, body = e.Serve(http.MethodGet, "/api/agents/agent-cross/runtime-options", "ada", "ws")
	if code != http.StatusOK || body["machineId"] != nil || runtimeOption(t, body["options"].([]any), "claude")["capabilityStatus"] != "not_installed" {
		t.Fatalf("cross-workspace machine = %d %#v", code, body)
	}
	if code, body := e.Serve(http.MethodGet, agentPath, "gus", "ws"); code != http.StatusForbidden || body["error"] != "Guests cannot access the server Agent directory" {
		t.Fatalf("guest agent = %d %#v", code, body)
	}
}

func TestRuntimeModelsAndFormsUseMachineReplyOnly(t *testing.T) {
	e := newCatalogEnv(t)
	e.user("ada")
	e.workspace("ws", "ada")
	e.member("ws", "ada", "owner")
	e.machine("mac", "ws", "ada", `["claude","builtin","kimi-sdk"]`)

	modelsPath := "/api/servers/ws/machines/mac/runtime-models/claude"
	code, body := e.Serve(http.MethodGet, modelsPath, "ada", "ws")
	if code != http.StatusOK || body["kind"] != "error" || body["retryable"] != true {
		t.Fatalf("offline models = %d %#v", code, body)
	}
	if _, ok := body["models"]; ok {
		t.Fatal("offline claude detect invented the static catalog")
	}
	if code, body := e.Serve(http.MethodPost, "/api/servers/ws/machines/mac/runtimes/rescan", "ada", "ws"); code != http.StatusConflict || body["error"] != "Computer is offline" {
		t.Fatalf("offline rescan = %d %#v", code, body)
	}
	formPath := "/api/servers/ws/machines/mac/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=" + runtimecatalog.BuiltinPiFormSchemaVersion
	code, body = e.Serve(http.MethodGet, formPath, "ada", "ws")
	if code != http.StatusConflict || body["code"] != "builtin_catalog_unavailable" {
		t.Fatalf("offline builtin source = %d %#v", code, body)
	}
	if _, ok := body["options"]; ok {
		t.Fatal("offline form source included options")
	}

	defPath := "/api/servers/ws/machines/mac/runtime-form-definitions/builtin?schemaVersion=" + runtimecatalog.BuiltinPiFormSchemaVersion
	code, body = e.Serve(http.MethodGet, defPath, "ada", "ws")
	if code != http.StatusOK || body["schemaVersion"] != runtimecatalog.BuiltinPiFormSchemaVersion {
		t.Fatalf("definition = %d %#v", code, body)
	}
	sources := body["optionSources"].(map[string]any)
	if _, ok := sources["provider"].(map[string]any)["options"]; ok {
		t.Fatal("definition inlined option values")
	}
	if code, body := e.Serve(http.MethodGet, "/api/servers/ws/machines/mac/runtime-form-definitions/builtin?schemaVersion=stale", "ada", "ws"); code != http.StatusConflict {
		t.Fatalf("stale schema = %d %#v", code, body)
	}

	e.gw.mu.Lock()
	e.gw.online = true
	e.gw.mu.Unlock()
	codes, bodies := e.serveAsync(http.MethodGet, modelsPath, "ada", "ws")
	sent := e.nextPayload()
	if sent["type"] != "machine:runtime_models:detect" || sent["runtime"] != "claude" {
		t.Fatalf("detect = %#v", sent)
	}
	requestID := sent["requestId"].(string)
	forged := []byte(`{"type":"machine:runtime_models:result","requestId":"` + requestID + `","outcome":{"kind":"live","value":{"models":[{"id":"forged","label":"Forged"}]}}}`)
	if _, err := e.broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "other", WorkspaceID: "ws"}, forged); err == nil {
		t.Fatal("forged reply was accepted")
	}
	real := []byte(`{"type":"machine:runtime_models:result","requestId":"` + requestID + `","outcome":{"kind":"live","value":{"models":[{"id":"machine-model","label":"From computer"}],"default":"machine-model"}}}`)
	if _, err := e.broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "mac", WorkspaceID: "ws"}, real); err != nil {
		t.Fatal(err)
	}
	code, body = <-codes, <-bodies
	if code != http.StatusOK || body["kind"] != "live" {
		t.Fatalf("live models = %d %#v", code, body)
	}
	models := body["models"].([]any)
	if len(models) != 1 || models[0].(map[string]any)["id"] != "machine-model" {
		t.Fatalf("models = %#v", models)
	}

	codes, bodies = e.serveAsync(http.MethodGet, formPath, "ada", "ws")
	sent = e.nextPayload()
	catalogReply := []byte(`{"type":"machine:runtime_models:result","requestId":"` + sent["requestId"].(string) + `","outcome":{"kind":"live","value":{"models":[{"id":"deepseek/deepseek-v4-pro","label":"DeepSeek V4 Pro"},{"id":"not-in-registry","label":"Nope"}],"catalog":{"protocolVersion":1,"runtime":"builtin","runtimeVersion":"0.85.1"}}}}`)
	if _, err := e.broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "mac", WorkspaceID: "ws"}, catalogReply); err != nil {
		t.Fatal(err)
	}
	code, body = <-codes, <-bodies
	if code != http.StatusOK {
		t.Fatalf("filtered source = %d %#v", code, body)
	}
	values := map[string]bool{}
	for _, option := range body["options"].([]any) {
		values[option.(map[string]any)["value"].(string)] = true
	}
	if !values["deepseek"] || !values["openai-compatible"] || values["not-in-registry"] || values["openai"] {
		t.Fatalf("filtered providers = %#v", values)
	}

	kimiPath := "/api/servers/ws/machines/mac/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=" + runtimecatalog.KimiSDKFormSchemaVersion
	codes, bodies = e.serveAsync(http.MethodGet, kimiPath, "ada", "ws")
	sent = e.nextPayload()
	kimiReply := []byte(`{"type":"machine:runtime_models:result","requestId":"` + sent["requestId"].(string) + `","outcome":{"kind":"live","value":{"models":[{"id":"kimi-code/kimi-for-coding","label":"Kimi for Coding"}],"default":"kimi-code/kimi-for-coding"}}}`)
	if _, err := e.broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "mac", WorkspaceID: "ws"}, kimiReply); err != nil {
		t.Fatal(err)
	}
	code, body = <-codes, <-bodies
	if code != http.StatusOK {
		t.Fatalf("kimi source = %d %#v", code, body)
	}
	kimiOptions := body["options"].([]any)
	if len(kimiOptions) != 1 || kimiOptions[0].(map[string]any)["value"] != "kimi-code/kimi-for-coding" {
		t.Fatalf("kimi options = %#v", kimiOptions)
	}

	codes, bodies = e.serveAsync(http.MethodPost, "/api/servers/ws/machines/mac/runtimes/rescan", "ada", "ws")
	sent = e.nextPayload()
	if sent["type"] != "machine:runtimes:rescan" || sent["requestId"] != nil {
		t.Fatalf("rescan = %#v", sent)
	}
	code, body = <-codes, <-bodies
	if code != http.StatusOK || body["requested"] != true {
		t.Fatalf("rescan rec = %d %#v", code, body)
	}
}

func runtimeListed(options []any, id string) bool {
	for _, option := range options {
		if option.(map[string]any)["runtimeId"] == id {
			return true
		}
	}
	return false
}

func runtimeOption(t *testing.T, options []any, id string) map[string]any {
	t.Helper()
	for _, option := range options {
		item := option.(map[string]any)
		if item["runtimeId"] == id {
			return item
		}
	}
	t.Fatalf("missing runtime %s", id)
	return nil
}
