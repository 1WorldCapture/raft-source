package humanapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"raft.local/server-go/internal/transport/httpapi/agentapi"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/computerapi"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
)

type agentHTTPEnv struct {
	t        *testing.T
	db       *sql.DB
	mux      *http.ServeMux
	store    *agent.Store
	gateway  *recordingGateway
	signer   *auth.TokenSigner
	handlers *humanapi.AgentHandlers
}

type recordingGateway struct {
	online bool
	sent   []agent.MachineCommand
}

func (g *recordingGateway) IsOnline(string) bool { return g.online }
func (g *recordingGateway) Send(_ context.Context, _ string, payload any) error {
	g.sent = append(g.sent, payload.(agent.MachineCommand))
	return nil
}

func newAgentHTTPEnv(t *testing.T, selfHosted, deviceAuth bool) *agentHTTPEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	hasher, err := agent.NewCredentialHasher([]byte("agent-http-pepper-0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	store := agent.NewStore(handle, agent.StoreOptions{
		Clock: fixed, Hasher: hasher, SelfHostedRunnerEnabled: selfHosted,
	})
	gateway := &recordingGateway{online: true}
	service := agent.NewService(store, agent.ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", DeviceAuthEnabled: deviceAuth,
	})
	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner([]byte("test-secret-0123456789abcdef0123456789abcdef"), 15*time.Minute)
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &authn.AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}
	handlers := &humanapi.AgentHandlers{Store: store, Service: service, AvatarDir: t.TempDir()}
	mux := http.NewServeMux()
	humanapi.RegisterAgentRoutes(mux, handlers, gate)
	agentapi.RegisterRoutes(mux, &agentapi.Handlers{Store: handlers.Store})
	computers := &computerapi.ComputerHandlers{
		AgentBootstrapEnabled: selfHosted,
		AgentBootstrap:        agent.NewBootstrapExchanger(store),
	}
	mux.Handle("POST /api/agent/login", http.HandlerFunc(computers.AgentLogin))
	return &agentHTTPEnv{t: t, db: handle, mux: mux, store: store, gateway: gateway, signer: signer, handlers: handlers}
}

func (e *agentHTTPEnv) seedUser(id, role, workspace string) {
	e.t.Helper()
	now := int64(1_700_000_000_000)
	if _, err := e.db.Exec(`
		INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, ?, ?)`, id, id+"@example.test", id, now, now); err != nil {
		e.t.Fatal(err)
	}
	if workspace == "" {
		return
	}
	if role == "owner" {
		if _, err := e.db.Exec(`
			INSERT INTO workspaces (id, name, slug, owner_id, created_at)
			VALUES (?, 'Workspace', ?, ?, ?)`, workspace, workspace, id, now); err != nil {
			e.t.Fatal(err)
		}
	}
	if _, err := e.db.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspace, id, role, now); err != nil {
		e.t.Fatal(err)
	}
}

func (e *agentHTTPEnv) token(userID string) string {
	e.t.Helper()
	token, err := e.signer.SignAccessToken(userID, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return token
}

func (e *agentHTTPEnv) Do(method, path, body, token string, headers map[string]string) (int, map[string]any, string) {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") && rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return rec.Code, parsed, rec.Body.String()
}

func TestCredentialHTTPScopesAndIdentity(t *testing.T) {
	env := newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	env.seedUser("member", "member", "ws")
	env.seedUser("outsider", "owner", "other")
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'Ada', 'Ada Lovelace', 'inactive', 'claude', 'user', 'member', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', 1, 1)`); err != nil {
		t.Fatal(err)
	}

	code, body, raw := env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{"scopes":["nope"]}`, env.token("member"), nil)
	if code != http.StatusBadRequest || body["code"] != "scopes_invalid" {
		t.Fatalf("bad scopes: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{"scopes":[]}`, env.token("member"), nil)
	if code != http.StatusBadRequest || body["code"] != "scopes_empty" {
		t.Fatalf("empty scopes: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{}`, env.token("outsider"), nil)
	if code != http.StatusNotFound || !strings.Contains(raw, "agent_missing") {
		t.Fatalf("cross-space: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{}`, env.token("owner"), nil)
	if code != http.StatusCreated || !strings.HasPrefix(bodyString(body, "apiKey"), "sk_agent_") {
		t.Fatalf("owner mint: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{"scopes":["read","send","read"]}`, env.token("member"), nil)
	if code != http.StatusCreated {
		t.Fatalf("creator mint: %d %s", code, raw)
	}
	scopes, _ := body["scopes"].([]any)
	if len(scopes) != 2 || scopes[0] != "read" || scopes[1] != "send" {
		t.Fatalf("normalized scopes: %s", raw)
	}
	apiKey := bodyString(body, "apiKey")
	code, who, raw := env.Do(http.MethodGet, "/internal/agent-api/", "", apiKey, nil)
	if code != http.StatusOK || who["agentId"] != "agent-1" || who["serverId"] != "ws" || who["credentialId"] == "" {
		t.Fatalf("whoami: %d %s", code, raw)
	}
	if who["serverRole"] != "member" {
		t.Fatalf("serverRole: %s", raw)
	}
	code, _, raw = env.Do(http.MethodGet, "/internal/agent-api/", "", "sk_computer_not-an-agent", nil)
	if code != http.StatusUnauthorized || !strings.Contains(raw, "invalid_principal") {
		t.Fatalf("wrong principal: %d %s", code, raw)
	}

	credentialID := bodyString(body, "credentialId")
	code, _, raw = env.Do(http.MethodDelete, "/api/agents/agent-1/credentials/"+credentialID, "", env.token("member"), nil)
	if code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodDelete, "/api/agents/agent-1/credentials/"+credentialID, "", env.token("member"), nil)
	if code != http.StatusNoContent {
		t.Fatalf("repeat revoke: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodGet, "/internal/agent-api/", "", apiKey, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("revoked whoami: %d %s", code, raw)
	}
	code, listed, raw := env.Do(http.MethodGet, "/api/agents/agent-1/credentials", "", env.token("member"), nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, raw)
	}
	if !strings.Contains(raw, "revokedAt") || !strings.Contains(raw, "***") {
		t.Fatalf("list shape: %s", raw)
	}
	_ = listed

	code, _, raw = env.Do(http.MethodGet, "/api/agents", "", env.token("owner"), nil)
	if code != http.StatusBadRequest {
		t.Fatalf("list without server header: %d %s", code, raw)
	}
}

func TestBootstrapLoginAndLifecycleWire(t *testing.T) {
	env := newAgentHTTPEnv(t, false, true)
	env.seedUser("owner", "owner", "ws")
	machineID := "11111111-1111-4111-8111-111111111111"
	if _, err := env.db.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES (?, 'ws', 'owner', 'laptop', 1)`, machineID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, creator_type, creator_id, created_at, updated_at)
		VALUES ('ext-1', 'ws', 'Ext', 'inactive', 'external', 'user', 'owner', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	code, _, raw := env.Do(http.MethodPost, "/api/agents/ext-1/bootstrap-tokens", `{}`, env.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusNotFound || !strings.Contains(raw, "self_hosted_runner_bootstrap_disabled") {
		t.Fatalf("bootstrap disabled: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodPost, "/api/agents/ext-1/start", "", env.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusBadRequest || !strings.Contains(raw, "External agents do not use Raft-managed runtime lifecycle") {
		t.Fatalf("external start: %d %s", code, raw)
	}

	env = newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	if _, err := env.db.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES (?, 'ws', 'owner', 'laptop', 1)`, machineID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, model, machine_id, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'Ada', 'Ada', 'inactive', 'claude', 'opus', ?, 'user', 'owner', 1, 1)`, machineID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	code, issued, raw := env.Do(http.MethodPost, "/api/agents/agent-1/bootstrap-tokens", `{"scopes":["read"]}`, env.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusCreated || !strings.HasPrefix(bodyString(issued, "bootstrapToken"), "abtk_") {
		t.Fatalf("issue: %d %s", code, raw)
	}
	loginBody := `{"bootstrapToken":"` + bodyString(issued, "bootstrapToken") + `"}`
	code, login, raw := env.Do(http.MethodPost, "/api/agent/login", loginBody, "", nil)
	if code != http.StatusOK || !strings.HasPrefix(bodyString(login, "apiKey"), "sk_agent_") || login["serverId"] != "ws" || login["serverSlug"] != "ws" {
		t.Fatalf("login: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodPost, "/api/agent/login", loginBody, "", nil)
	if code != http.StatusGone || !strings.Contains(raw, "token_consumed") {
		t.Fatalf("replay: %d %s", code, raw)
	}

	code, _, raw = env.Do(http.MethodPost, "/api/agents/agent-1/start", "", env.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusOK {
		t.Fatalf("start: %d %s", code, raw)
	}
	if len(env.gateway.sent) != 1 || env.gateway.sent[0].Type != "agent:start" || env.gateway.sent[0].Config == nil || env.gateway.sent[0].AgentID != "agent-1" {
		t.Fatalf("start wire: %+v", env.gateway.sent)
	}
	env.gateway.online = false
	env.gateway.sent = nil
	if _, err := env.db.Exec(`UPDATE agents SET status = 'inactive', machine_id = NULL WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	code, body, raw := env.Do(http.MethodPost, "/api/agents/agent-1/start", "", env.token("owner"), map[string]string{"X-Server-Id": "ws"})
	if code != http.StatusConflict || body["code"] != "machine_unassigned" {
		t.Fatalf("unassigned: %d %s", code, raw)
	}
	if len(env.gateway.sent) != 0 {
		t.Fatal("unassigned start sent a command")
	}
}

func bodyString(body map[string]any, key string) string {
	value, _ := body[key].(string)
	return value
}
