package humanapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/runtimecatalog"
)

func TestAgentAPIServerAndChannelReads(t *testing.T) {
	env := newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	env.seedUser("pat", "member", "ws")
	env.seedUser("outsider", "owner", "other")
	if _, err := env.db.Exec(`UPDATE users SET description = 'Pat the human' WHERE id = 'pat'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, description, status, runtime, model, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'Ada', 'Ada', 'navigator', 'inactive', 'claude', 'opus', 'user', 'owner', 1, 1),
		       ('agent-2', 'ws', 'Bea', 'Bea', NULL, 'inactive', 'claude', 'opus', 'user', 'owner', 2, 2),
		       ('agent-other', 'other', 'Ada', 'Ada', NULL, 'inactive', 'claude', 'opus', 'user', 'outsider', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', 1, 1),
		       ('ws', 'agent-2', 'admin', 1, 1),
		       ('other', 'agent-other', 'member', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channels (id, workspace_id, name, description, type, system_kind, guest_visible, guest_joinable, created_at)
		VALUES ('ch-all', 'ws', 'all', 'everyone', 'channel', 'all', 0, 0, 1),
		       ('ch-secret', 'ws', 'secret', 'hidden', 'private', NULL, 0, 0, 2),
		       ('ch-other', 'other', 'secret', 'elsewhere', 'channel', NULL, 0, 0, 1),
		       ('ch-dm', 'ws', 'dm-pat', NULL, 'dm', NULL, 0, 0, 3)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channel_agents (channel_id, agent_id, role, added_at)
		VALUES ('ch-dm', 'agent-1', 'member', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
		VALUES ('ch-dm', 'pat', 'member', 1)`); err != nil {
		t.Fatal(err)
	}
	owner := env.token("owner")
	_, minted, raw := env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{"scopes":["server","channels"]}`, owner, nil)
	if minted["apiKey"] == nil {
		t.Fatalf("mint: %s", raw)
	}
	key := bodyString(minted, "apiKey")
	_, narrow, raw := env.Do(http.MethodPost, "/api/agents/agent-1/credentials", `{"scopes":["read"]}`, owner, nil)
	readKey := bodyString(narrow, "apiKey")

	code, body, raw := env.Do(http.MethodGet, "/internal/agent-api/server", "", key, nil)
	if code != http.StatusOK {
		t.Fatalf("server info: %d %s", code, raw)
	}
	agents, _ := body["agents"].([]any)
	if len(agents) != 2 {
		t.Fatalf("agents leaked or missing: %s", raw)
	}
	for _, item := range agents {
		row := item.(map[string]any)
		if _, ok := row["id"]; ok {
			t.Fatalf("agent directory exposed a uuid: %s", raw)
		}
		if row["name"] == "Ada" && row["role"] != "member" {
			t.Fatalf("ada role: %s", raw)
		}
	}
	channels, _ := body["channels"].([]any)
	if len(channels) != 1 || channels[0].(map[string]any)["name"] != "all" || channels[0].(map[string]any)["joined"] != true {
		t.Fatalf("channels: %s", raw)
	}
	humans, _ := body["humans"].([]any)
	if len(humans) != 2 {
		t.Fatalf("humans: %s", raw)
	}
	runtime, _ := body["runtimeContext"].(map[string]any)
	if runtime["agentId"] != "agent-1" || runtime["serverId"] != "ws" {
		t.Fatalf("runtime context: %s", raw)
	}

	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/server", "", readKey, nil)
	if code != http.StatusForbidden || body["code"] != "capability_not_authorized" || body["requiredCapability"] != "server" {
		t.Fatalf("scope: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/server", "", key, map[string]string{
		"X-Slock-Agent-Active-Capabilities": "channels",
	})
	if code != http.StatusNotImplemented || body["code"] != "unsupported_capability" {
		t.Fatalf("active capability: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodGet, "/internal/agent-api/server", "", env.token("owner"), nil)
	if code < 400 {
		t.Fatalf("user jwt succeeded: %d %s", code, raw)
	}

	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/channel-members?channel=%23secret", "", key, nil)
	if code != http.StatusNotFound || !strings.Contains(raw, "Channel not found: #secret") {
		t.Fatalf("private channel: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodGet, "/internal/agent-api/channel-members?channel=%23secret:abcd1234", "", key, nil)
	if code != http.StatusNotFound {
		t.Fatalf("thread handle: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/channel-members?channel=%23all", "", key, nil)
	if code != http.StatusOK {
		t.Fatalf("all members: %d %s", code, raw)
	}
	if body["channel"].(map[string]any)["type"] != "channel" {
		t.Fatalf("channel type: %s", raw)
	}
	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/channel-members?channel=DM:@pat", "", key, nil)
	if code != http.StatusOK || body["channel"].(map[string]any)["type"] != "dm" {
		t.Fatalf("dm handle: %d %s", code, raw)
	}
	humans, _ = body["humans"].([]any)
	if len(humans) != 1 || humans[0].(map[string]any)["name"] != "pat" {
		t.Fatalf("dm humans: %s", raw)
	}

	if _, err := env.db.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/server", "", key, nil)
	if code != http.StatusOK {
		t.Fatalf("hidden directory: %d %s", code, raw)
	}
	humans, _ = body["humans"].([]any)
	if len(humans) != 0 {
		t.Fatalf("member saw hidden humans: %s", raw)
	}

	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/history", "", key, nil)
	if code != http.StatusNotImplemented || body["code"] != "not_implemented" {
		t.Fatalf("history: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodGet, "/internal/agent-api/not-a-real-route", "", key, nil)
	if code != http.StatusUnauthorized || body["code"] != "auth_policy_unregistered_path" {
		t.Fatalf("unknown path: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPost, "/internal/agent-api", "", key, nil)
	if code != http.StatusUnauthorized || body["code"] != "auth_policy_unregistered_path" {
		t.Fatalf("post whoami: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPatch, "/internal/agent-api/server", `{}`, key, nil)
	if code != http.StatusNotImplemented || body["code"] != "not_implemented" {
		t.Fatalf("patch server: %d %s", code, raw)
	}
}

func TestAgentFormDefinitionAdmission(t *testing.T) {
	env := newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	headers := map[string]string{"X-Server-Id": "ws"}
	token := env.token("owner")
	builtinRef := map[string]any{
		"protocolVersion": 1,
		"runtimeId":       "builtin",
		"schemaVersion":   runtimecatalog.BuiltinPiFormSchemaVersion,
	}
	kimiRef := map[string]any{
		"protocolVersion": 1,
		"runtimeId":       "kimi-sdk",
		"schemaVersion":   runtimecatalog.KimiSDKFormSchemaVersion,
	}
	post := func(body map[string]any) (int, map[string]any, string) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return env.Do(http.MethodPost, "/api/agents", string(raw), token, headers)
	}

	code, body, raw := post(map[string]any{
		"name": "Ada", "runtime": "builtin",
		"runtimeConfig":     map[string]any{"runtime": "builtin", "model": map[string]any{"kind": "preset", "id": "gpt"}},
		"formDefinitionRef": builtinRef,
	})
	if code != http.StatusOK || body["runtime"] != "builtin" {
		t.Fatalf("valid builtin ref: %d %s", code, raw)
	}

	stale := map[string]any{"protocolVersion": 1, "runtimeId": "builtin", "schemaVersion": "builtin-pi.create.v1"}
	code, body, raw = post(map[string]any{
		"name": "Bea", "runtime": "builtin", "runtimeConfig": map[string]any{"runtime": "builtin"},
		"formDefinitionRef": stale,
	})
	if code != http.StatusConflict || !strings.Contains(raw, "stale_form_schema") {
		t.Fatalf("stale schema: %d %s", code, raw)
	}
	code, _, raw = post(map[string]any{
		"name": "Cara", "runtime": "claude", "formDefinitionRef": builtinRef,
	})
	if code != http.StatusBadRequest || !strings.Contains(raw, "form_runtime_mismatch") {
		t.Fatalf("mismatch: %d %s", code, raw)
	}
	code, _, raw = post(map[string]any{
		"name": "Dee", "external": true, "formDefinitionRef": builtinRef,
	})
	if code != http.StatusBadRequest || !strings.Contains(raw, "external_form_definition_forbidden") {
		t.Fatalf("external ref: %d %s", code, raw)
	}
	code, _, raw = post(map[string]any{
		"name": "Eve", "runtime": "builtin", "runtimeConfig": map[string]any{"runtime": "builtin"},
	})
	if code != http.StatusConflict || !strings.Contains(raw, "form_definition_ref_required") {
		t.Fatalf("missing ref: %d %s", code, raw)
	}
	code, _, raw = post(map[string]any{
		"name": "Fay", "runtime": "kimi-sdk", "reasoningEffort": "high",
		"runtimeConfig": map[string]any{"runtime": "kimi-sdk"},
	})
	if code != http.StatusConflict || !strings.Contains(raw, "kimi_reasoning_effort_upgrade_required") {
		t.Fatalf("kimi effort without ref: %d %s", code, raw)
	}
	code, body, raw = post(map[string]any{
		"name": "Gia", "runtime": "kimi-sdk", "formDefinitionRef": kimiRef,
		"runtimeConfig": map[string]any{"runtime": "kimi-sdk", "model": "kimi-code/kimi-for-coding"},
	})
	if code != http.StatusOK || body["runtime"] != "kimi-sdk" {
		t.Fatalf("kimi without effort: %d %s", code, raw)
	}

	if _, err := env.db.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('11111111-1111-1111-1111-111111111111', 'ws', 'owner', 'laptop', 1)`); err != nil {
		t.Fatal(err)
	}
	offline := &offlineCatalogGateway{}
	env.handlers.RuntimeCatalog = runtimecatalog.NewBroker(runtimecatalog.BrokerConfig{
		Gateway:    offline,
		Generation: func(string) (uint64, bool) { return 1, true },
	})
	code, body, raw = post(map[string]any{
		"name": "Hal", "runtime": "builtin", "machineId": "11111111-1111-1111-1111-111111111111",
		"runtimeConfig":     map[string]any{"runtime": "builtin"},
		"formDefinitionRef": builtinRef,
	})
	if code != http.StatusConflict || body["code"] != "builtin_catalog_unavailable" || body["recovery"] != "retry" {
		t.Fatalf("offline builtin: %d %s", code, raw)
	}

	reply := &replyCatalogGateway{workspace: "ws"}
	broker := runtimecatalog.NewBroker(runtimecatalog.BrokerConfig{
		Gateway:    reply,
		Generation: func(string) (uint64, bool) { return 1, true },
	})
	reply.broker = broker
	env.handlers.RuntimeCatalog = broker
	code, _, raw = post(map[string]any{
		"name": "Ian", "runtime": "kimi-sdk", "machineId": "11111111-1111-1111-1111-111111111111",
		"runtimeConfig":     map[string]any{"runtime": "kimi-sdk", "model": "missing-model"},
		"formDefinitionRef": kimiRef,
	})
	if code != http.StatusBadRequest || !strings.Contains(raw, "invalid_option") {
		t.Fatalf("unknown model: %d %s", code, raw)
	}
	code, body, raw = post(map[string]any{
		"name": "Jen", "runtime": "builtin", "machineId": "11111111-1111-1111-1111-111111111111",
		"runtimeConfig": map[string]any{
			"runtime": "builtin",
			"model":   map[string]any{"kind": "preset", "id": "not-in-the-string-list"},
		},
		"formDefinitionRef": builtinRef,
	})
	if code != http.StatusOK || body["name"] != "Jen" {
		t.Fatalf("object builtin model: %d %s", code, raw)
	}
}

func TestAgentAvatarAndOnboardingAdoption(t *testing.T) {
	env := newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	env.seedUser("member", "member", "ws")
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'Ada', 'Ada', 'inactive', 'claude', 'user', 'owner', 1, 1),
		       ('agent-2', 'ws', 'Bea', 'Bea', 'inactive', 'claude', 'user', 'owner', 2, 2)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', 1, 1), ('ws', 'agent-2', 'member', 2, 2)`); err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"X-Server-Id": "ws"}
	code, _, raw := env.Do(http.MethodPost, "/api/agents/agent-1/avatar", "not-an-image", env.token("member"), headers)
	if code != http.StatusForbidden {
		t.Fatalf("member garbage avatar: %d %s", code, raw)
	}
	status, avatarBody := uploadPNG(t, env, "/api/agents/agent-1/avatar", env.token("owner"), headers)
	if status != http.StatusOK || !strings.Contains(bodyString(avatarBody, "avatarUrl"), "/api/avatars/servers/") {
		t.Fatalf("owner avatar: %d %v", status, avatarBody)
	}

	if _, err := env.db.Exec(`UPDATE workspaces SET onboarding_agent_id = 'agent-1' WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	code, body, raw := env.Do(http.MethodGet, "/api/agents/agent-2/onboarding-identity-adoption", "", env.token("owner"), headers)
	if code != http.StatusBadRequest || !strings.Contains(raw, "not this server's onboarding agent") {
		t.Fatalf("wrong agent: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodPost, "/api/agents/agent-1/onboarding-identity-adoption", "", env.token("owner"), headers)
	if code != http.StatusOK || body["canAdopt"] != false {
		t.Fatalf("adopt: %d %s", code, raw)
	}
	agentBody, _ := body["agent"].(map[string]any)
	if agentBody["name"] != "Cindy" || agentBody["serverRole"] != "admin" {
		t.Fatalf("adopted identity: %s", raw)
	}
	var role string
	if err := env.db.QueryRow(`SELECT role FROM agent_members WHERE agent_id = 'agent-1'`).Scan(&role); err != nil || role != "admin" {
		t.Fatalf("role: %s %v", role, err)
	}

	if _, err := env.db.Exec(`UPDATE agents SET name = 'Old' WHERE id = 'agent-2'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`UPDATE workspaces SET onboarding_agent_id = 'agent-2' WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	code, _, raw = env.Do(http.MethodPost, "/api/agents/agent-2/onboarding-identity-adoption", "", env.token("owner"), headers)
	if code != http.StatusConflict || !strings.Contains(raw, "already taken") {
		t.Fatalf("name conflict: %d %s", code, raw)
	}
	if err := env.db.QueryRow(`SELECT role FROM agent_members WHERE agent_id = 'agent-2'`).Scan(&role); err != nil || role != "member" {
		t.Fatalf("conflict changed role: %s %v", role, err)
	}
}

func TestGetAgentIncludesDeletedProfile(t *testing.T) {
	env := newAgentHTTPEnv(t, true, true)
	env.seedUser("owner", "owner", "ws")
	env.seedUser("guest", "guest", "ws")
	env.seedUser("outsider", "owner", "other")
	if _, err := env.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, creator_type, creator_id, deleted_at, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'Ada', 'Ada', 'inactive', 'claude', 'user', 'owner', 50, 1, 1),
		       ('agent-other', 'other', 'Bea', 'Bea', 'inactive', 'claude', 'user', 'outsider', NULL, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channels (id, workspace_id, name, type, guest_visible, guest_joinable, created_at)
		VALUES ('ch-1', 'ws', 'general', 'channel', 0, 0, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channel_agents (channel_id, agent_id, role, added_at) VALUES ('ch-1', 'agent-1', 'member', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES ('ch-1', 'guest', 'member', 1)`); err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"X-Server-Id": "ws"}
	code, _, raw := env.Do(http.MethodGet, "/api/agents/agent-1", "", "", headers)
	if code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d %s", code, raw)
	}
	code, body, raw := env.Do(http.MethodGet, "/api/agents/agent-1", "", env.token("owner"), headers)
	if code != http.StatusOK || body["deletedAt"] == nil {
		t.Fatalf("member deleted profile: %d %s", code, raw)
	}
	code, body, raw = env.Do(http.MethodGet, "/api/agents/agent-1", "", env.token("guest"), headers)
	if code != http.StatusOK || body["deletedAt"] == nil || body["name"] != "Ada" {
		t.Fatalf("guest deleted profile: %d %s", code, raw)
	}
	code, _, raw = env.Do(http.MethodGet, "/api/agents/agent-other", "", env.token("owner"), headers)
	if code != http.StatusNotFound {
		t.Fatalf("foreign row: %d %s", code, raw)
	}
	code, list, raw := env.Do(http.MethodGet, "/api/agents", "", env.token("owner"), headers)
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, raw)
	}
	if rows, ok := list["unused"].([]any); ok && len(rows) > 0 {
		t.Fatal("unexpected")
	}
	if strings.Contains(raw, "agent-1") {
		t.Fatalf("list included deleted agent: %s", raw)
	}
}

type offlineCatalogGateway struct{}

func (offlineCatalogGateway) IsOnline(string) bool { return false }
func (offlineCatalogGateway) Send(context.Context, string, any) error {
	return nil
}

type replyCatalogGateway struct {
	broker    *runtimecatalog.Broker
	workspace string
}

func (g *replyCatalogGateway) IsOnline(string) bool { return true }
func (g *replyCatalogGateway) Send(ctx context.Context, machineID string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var probe struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return err
	}
	frame := []byte(`{"type":"machine:runtime_models:result","requestId":"` + probe.RequestID + `","outcome":{"kind":"live","value":{"models":[{"id":"listed-model","label":"Listed"}]}}}`)
	_, err = g.broker.OnMachineMessage(ctx, computer.Principal{MachineID: machineID, WorkspaceID: g.workspace}, frame)
	return err
}

func uploadPNG(t *testing.T, env *agentHTTPEnv, path, token string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("avatar", "avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(part, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	env.mux.ServeHTTP(rec, req)
	parsed := map[string]any{}
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return rec.Code, parsed
}
