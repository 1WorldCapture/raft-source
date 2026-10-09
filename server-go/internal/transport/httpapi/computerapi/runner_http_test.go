package computerapi_test

import (
	"context"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/httpapi/computerapi"
)

const (
	runnerSecretSession  = "session-RESUME-SECRET-do-not-leak-zzz"
	runnerSecretEnv      = "ENVVAR-SECRET-do-not-leak-qqq"
	runnerProviderSecret = "provider-materialization-secret"
)

type captureGateway struct {
	calls   int
	payload any
}

func (g *captureGateway) IsOnline(string) bool { return true }

func (g *captureGateway) Send(_ context.Context, _ string, payload any) error {
	g.calls++
	g.payload = payload
	return nil
}

type runnerHTTP struct {
	env         *computerEnv
	store       *agent.Store
	handlers    *computerapi.RunnerHandlers
	gateway     *captureGateway
	computerKey string
	legacyKey   string
	agentID     string
	otherID     string
	foreignID   string
	externalID  string
}

func newRunnerHTTP(t *testing.T) *runnerHTTP {
	t.Helper()
	env := newComputerEnvWith(t, func(h *computerapi.ComputerHandlers) {
		h.InternalRoutes = append(h.InternalRoutes, computerapi.RunnerRouteManifest()...)
	})
	hasher, err := agent.NewCredentialHasher([]byte("runner-http-pepper-0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	access, err := agent.NewRunnerAccess(env.db, agent.RunnerAccessOptions{Clock: env.fixed, Hasher: hasher})
	if err != nil {
		t.Fatal(err)
	}
	store := agent.NewStore(env.db, agent.StoreOptions{Clock: env.fixed, Hasher: hasher})
	gateway := &captureGateway{}
	service := agent.NewService(store, agent.ServiceOptions{Gateway: gateway})
	handlers := &computerapi.RunnerHandlers{Access: access, Computers: env.handlers.Store, Lifecycle: service}
	computerapi.RegisterRunnerRoutes(env.mux, handlers)
	h := &runnerHTTP{
		env: env, store: store, handlers: handlers, gateway: gateway,
		agentID: "agent", otherID: "agent-b", foreignID: "agent-c", externalID: "agent-ext",
	}
	h.seed(t)
	return h
}

func (h *runnerHTTP) seed(t *testing.T) {
	t.Helper()
	now := h.env.fixed.Now().UnixMilli()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := h.env.db.Exec(query, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, query)
		}
	}
	exec(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES ('owner', 'owner@example.test', 'owner', 'x', ?, ?)`, now, now)
	exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES
		('ws', 'WS', 'ws', 'owner', ?), ('ws-b', 'WS B', 'ws-b', 'owner', ?)`, now, now)
	cheap := computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1}
	machineKey, machineHash, machinePrefix, machineFP, err := computer.GenerateMachineKeyMaterial(cheap)
	if err != nil {
		t.Fatal(err)
	}
	h.legacyKey = machineKey
	exec(`INSERT INTO machines (
			id, workspace_id, user_id, name, api_key_hash, api_key_prefix, api_key_fingerprint, created_at
		) VALUES
		('mach', 'ws', 'owner', 'mach', ?, ?, ?, ?),
		('mach-b', 'ws', 'owner', 'mach-b', NULL, NULL, NULL, ?),
		('mach-c', 'ws-b', 'owner', 'mach-c', NULL, NULL, NULL, ?)`,
		machineHash, machinePrefix, machineFP, now, now, now)
	computerKey, computerHash, computerPrefix, err := computer.GenerateComputerKeyMaterial(cheap)
	if err != nil {
		t.Fatal(err)
	}
	h.computerKey = computerKey
	exec(`INSERT INTO computers (
			id, workspace_id, name, attached_by_user_id, machine_id, api_key_hash, api_key_prefix, created_at
		) VALUES ('comp', 'ws', 'comp', 'owner', 'mach', ?, ?, ?)`, computerHash, computerPrefix, now)
	envVars := `{"OPENAI_API_KEY":"` + runnerSecretEnv + `"}`
	exec(`INSERT INTO agents (
			id, workspace_id, name, status, runtime, model, machine_id, session_id, env_vars, created_at, updated_at
		) VALUES
		('agent', 'ws', 'RunnerBot', 'active', 'claude', 'opus', 'mach', ?, ?, ?, ?),
		('agent-b', 'ws', 'OtherMachineBot', 'active', 'claude', 'sonnet', 'mach-b', 'other-session', '{}', ?, ?),
		('agent-c', 'ws-b', 'ForeignBot', 'active', 'claude', 'sonnet', 'mach-c', ?, ?, ?, ?),
		('agent-ext', 'ws', 'ExternalBot', 'active', 'external', 'external', 'mach', NULL, NULL, ?, ?),
		('agent-dead', 'ws', 'DeadBot', 'inactive', 'claude', 'sonnet', 'mach', ?, ?, ?, ?)`,
		runnerSecretSession, envVars, now, now,
		now, now,
		runnerSecretSession, envVars, now, now,
		now, now,
		runnerSecretSession, envVars, now, now)
	exec(`UPDATE agents SET deleted_at = ? WHERE id = 'agent-dead'`, now)
}

func (h *runnerHTTP) countCreds(t *testing.T, agentID string) int {
	t.Helper()
	var n int
	if err := h.env.db.QueryRow(`SELECT COUNT(*) FROM agent_credentials WHERE agent_id = ?`, agentID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRunnerHTTPMintListRevokeAndAuth(t *testing.T) {
	h := newRunnerHTTP(t)
	bearer := testkit.Bearer(h.computerKey)

	code, body, raw := h.env.Serve("GET", "/internal/computer/runners", "", bearer)
	if code != http.StatusOK {
		t.Fatalf("list = %d %s", code, raw)
	}
	if strings.Contains(raw, runnerSecretSession) || strings.Contains(raw, runnerSecretEnv) {
		t.Fatalf("list leaked secrets: %s", raw)
	}
	whitelist, _ := body["whitelist"].([]any)
	if strings.Join(stringList(whitelist), ",") != "agentId,name,status,model,runtime" {
		t.Fatalf("whitelist = %#v", body["whitelist"])
	}
	runners, _ := body["runners"].([]any)
	if len(runners) != 2 { // RunnerBot + ExternalBot; not the other machine, foreign, or deleted
		t.Fatalf("runners = %#v", body["runners"])
	}
	for _, item := range runners {
		row, _ := item.(map[string]any)
		if len(row) != 5 {
			t.Fatalf("runner keys = %#v", row)
		}
		if row["agentId"] == h.otherID || row["agentId"] == h.foreignID || row["agentId"] == "agent-dead" {
			t.Fatalf("runner leaked %v", row["agentId"])
		}
	}

	code, body, raw = h.env.Serve("GET", "/internal/computer/runners?scope=server", "", bearer)
	if code != http.StatusOK {
		t.Fatalf("server list = %d %s", code, raw)
	}
	if !strings.Contains(raw, h.otherID) || strings.Contains(raw, h.foreignID) || strings.Contains(raw, "agent-dead") {
		t.Fatalf("server scope = %s", raw)
	}
	code, body, _ = h.env.Serve("GET", "/internal/computer/runners?scope=all", "", bearer)
	if code != http.StatusBadRequest || body["code"] != "invalid_scope" {
		t.Fatalf("scope = %d %#v", code, body)
	}

	code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/provider-connection",
		`{"connectionId":"c1","apiKey":"`+runnerProviderSecret+`"}`, bearer)
	if code != http.StatusNotFound || body["code"] != "provider_connections_disabled" {
		t.Fatalf("provider = %d %#v", code, body)
	}
	if strings.Contains(raw, runnerProviderSecret) || strings.Contains(raw, "envVars") {
		t.Fatalf("provider refusal echoed a secret: %s", raw)
	}

	if code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{}`, nil); code != http.StatusUnauthorized || body["error"] != "Missing computer credential" {
		t.Fatalf("missing auth = %d %#v", code, body)
	}
	if code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{}`, testkit.Bearer("sk_agent_"+strings.Repeat("ab", 32))); code != http.StatusUnauthorized || body["code"] != "invalid_principal" {
		t.Fatalf("agent principal = %d %#v", code, body)
	}
	if code, body, _ = h.env.Serve("GET", "/internal/computer/runners", "", testkit.Bearer(h.env.tokenFor("owner"))); code != http.StatusUnauthorized || body["code"] != "invalid_principal" {
		t.Fatalf("jwt = %d %#v", code, body)
	}
	if code, body, _ = h.env.Serve("POST", "/internal/computer/agent-o11y/events", `{}`, bearer); code != http.StatusUnauthorized || body["code"] != "auth_policy_unregistered_path" {
		t.Fatalf("unregistered sibling = %d %#v", code, body)
	}

	for _, id := range []string{h.otherID, h.foreignID, "missing", "agent-dead"} {
		code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+id+"/credentials", `{}`, bearer)
		if code != http.StatusNotFound || body["code"] != "agent_missing" {
			t.Fatalf("mint %s = %d %s", id, code, raw)
		}
		if h.countCreds(t, id) != 0 {
			t.Fatalf("credential stored for %s", id)
		}
	}

	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{"scopes":"read"}`, bearer)
	if code != http.StatusBadRequest || body["code"] != "scopes_invalid" || body["error"] != "scopes must be an array of capability literals" {
		t.Fatalf("scopes type = %d %#v", code, body)
	}
	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{"scopes":[]}`, bearer)
	if code != http.StatusBadRequest || body["code"] != "scopes_empty" {
		t.Fatalf("scopes empty = %d %#v", code, body)
	}
	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{"scopes":["read","bogus"]}`, bearer)
	if code != http.StatusBadRequest || body["code"] != "scopes_invalid" || !strings.Contains(body["error"].(string), "send, read, mentions") {
		t.Fatalf("scopes value = %d %#v", code, body)
	}
	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{"name":""}`, bearer)
	if code != http.StatusBadRequest || body["code"] != "name_invalid" {
		t.Fatalf("name = %d %#v", code, body)
	}
	if h.countCreds(t, h.agentID) != 0 {
		t.Fatal("rejected mint wrote a row")
	}

	mintBody := `{"scopes":["send","read","mentions","tasks","reactions","server","channels","knowledge","mcp"],"name":"runner:claude:agent"}`
	code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", mintBody, bearer)
	if code != http.StatusCreated {
		t.Fatalf("mint = %d %s", code, raw)
	}
	apiKey, _ := body["apiKey"].(string)
	credentialID, _ := body["credentialId"].(string)
	if !strings.HasPrefix(apiKey, "sk_agent_") || len(apiKey) != len("sk_agent_")+64 || credentialID == "" {
		t.Fatalf("mint payload = %#v", body)
	}
	if body["agentId"] != h.agentID || body["agentName"] != "RunnerBot" || body["serverId"] != "ws" {
		t.Fatalf("mint identity = %#v", body)
	}
	scopes, _ := body["scopes"].([]any)
	if strings.Join(stringList(scopes), ",") != "channels,knowledge,mcp,mentions,reactions,read,send,server,tasks" {
		t.Fatalf("scopes = %#v", body["scopes"])
	}
	found, err := h.store.FindCredentialByAPIKey(context.Background(), apiKey)
	if err != nil || found == nil || found.CredentialID != credentialID || found.AgentID != h.agentID {
		t.Fatalf("lookup = %+v %v", found, err)
	}
	var stored string
	if err := h.env.db.QueryRow(`
		SELECT api_key_hash || ' ' || api_key_prefix || ' ' || IFNULL(name,'') || ' ' || scopes
		FROM agent_credentials WHERE id = ?`, credentialID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, apiKey) {
		t.Fatal("raw key persisted")
	}

	code, body, raw = h.env.Serve("DELETE", "/internal/computer/runners/"+h.otherID+"/credentials/"+credentialID, "", bearer)
	if code != http.StatusNotFound || body["code"] != "agent_missing" {
		t.Fatalf("cross revoke = %d %s", code, raw)
	}
	code, body, _ = h.env.Serve("DELETE", "/internal/computer/runners/"+h.agentID+"/credentials/missing", "", bearer)
	if code != http.StatusNotFound || body["code"] != "credential_missing" {
		t.Fatalf("missing credential = %d %#v", code, body)
	}
	if found, err = h.store.FindCredentialByAPIKey(context.Background(), apiKey); err != nil || found == nil {
		t.Fatal("credential revoked by a rejected delete")
	}

	code, _, raw = h.env.Serve("DELETE", "/internal/computer/runners/"+h.agentID+"/credentials/"+credentialID, "", bearer)
	if code != http.StatusNoContent || strings.TrimSpace(raw) != "" {
		t.Fatalf("revoke = %d %q", code, raw)
	}
	code, _, raw = h.env.Serve("DELETE", "/internal/computer/runners/"+h.agentID+"/credentials/"+credentialID, "", bearer)
	if code != http.StatusNoContent {
		t.Fatalf("second revoke = %d %s", code, raw)
	}
	if found, err = h.store.FindCredentialByAPIKey(context.Background(), apiKey); err != nil || found != nil {
		t.Fatalf("revoked key still works: %+v %v", found, err)
	}
	var reason string
	if err := h.env.db.QueryRow(`SELECT revoked_reason FROM agent_credentials WHERE id = ?`, credentialID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != agent.RunnerRevokeReason {
		t.Fatalf("reason = %q", reason)
	}

	// Legacy machine alias mints for the same current machine.
	code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{"scopes":["read"],"name":"alias"}`, testkit.Bearer(h.legacyKey))
	if code != http.StatusCreated || body["serverId"] != "ws" {
		t.Fatalf("legacy mint = %d %s", code, raw)
	}
	legacyKey, _ := body["apiKey"].(string)
	if found, err = h.store.FindCredentialByAPIKey(context.Background(), legacyKey); err != nil || found == nil {
		t.Fatalf("legacy lookup = %+v %v", found, err)
	}

	if _, err := h.env.db.Exec(`UPDATE computers SET revoked_at = ? WHERE id = 'comp'`, h.env.fixed.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/credentials", `{}`, bearer)
	if code != http.StatusUnauthorized || body["error"] != "Invalid computer credential" {
		t.Fatalf("revoked computer = %d %#v", code, body)
	}
}

func TestRunnerHTTPStopUsesService(t *testing.T) {
	h := newRunnerHTTP(t)
	bearer := testkit.Bearer(h.computerKey)

	h.handlers.Lifecycle = nil
	code, body, _ := h.env.Serve("POST", "/internal/computer/runners/"+h.externalID+"/stop", `{}`, bearer)
	if code != http.StatusServiceUnavailable || body["code"] != "orchestrator_unavailable" {
		t.Fatalf("nil lifecycle = %d %#v", code, body)
	}
	h.handlers.Lifecycle = agent.NewService(h.store, agent.ServiceOptions{Gateway: h.gateway})

	code, body, raw := h.env.Serve("POST", "/internal/computer/runners/"+h.externalID+"/stop", `{}`, bearer)
	if code != http.StatusBadRequest || body["error"] != "External agents do not use Raft-managed runtime lifecycle" {
		t.Fatalf("external stop = %d %s", code, raw)
	}
	var status string
	if err := h.env.db.QueryRow(`SELECT status FROM agents WHERE id = ?`, h.externalID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" || h.gateway.calls != 0 {
		t.Fatalf("external status=%s calls=%d", status, h.gateway.calls)
	}

	code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+h.otherID+"/stop", `{}`, bearer)
	if code != http.StatusNotFound || body["code"] != "agent_missing" {
		t.Fatalf("cross stop = %d %s", code, raw)
	}

	code, body, raw = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/stop", `{}`, bearer)
	if code != http.StatusOK || body["ok"] != true || body["agentId"] != h.agentID {
		t.Fatalf("stop = %d %#v %s", code, body, raw)
	}
	if err := h.env.db.QueryRow(`SELECT status FROM agents WHERE id = ?`, h.agentID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "stopped" {
		t.Fatalf("status = %s", status)
	}
	cmd, _ := h.gateway.payload.(agent.MachineCommand)
	if h.gateway.calls != 1 || cmd.Type != agent.MachineCommandStop || cmd.AgentID != h.agentID {
		t.Fatalf("gateway = %+v calls=%d", h.gateway.payload, h.gateway.calls)
	}
	code, body, _ = h.env.Serve("POST", "/internal/computer/runners/"+h.agentID+"/stop", `{}`, bearer)
	if code != http.StatusOK || body["agentId"] != h.agentID {
		t.Fatalf("second stop = %d %#v", code, body)
	}
}

func TestRunnerPreflightManifest(t *testing.T) {
	h := newRunnerHTTP(t)
	code, body, raw := h.env.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer(h.computerKey))
	if code != http.StatusOK {
		t.Fatalf("preflight = %d %s", code, raw)
	}
	surface, _ := body["computerSurface"].([]any)
	need := map[string]bool{
		"GET /runners":                                       false,
		"POST /runners/:agentId/credentials":                 false,
		"DELETE /runners/:agentId/credentials/:credentialId": false,
		"POST /runners/:agentId/stop":                        false,
		"POST /runners/:agentId/provider-connection":         false,
		"POST /preflight":                                    false,
	}
	for _, item := range surface {
		row, _ := item.(map[string]any)
		key := row["method"].(string) + " " + row["path"].(string)
		if _, ok := need[key]; ok {
			if row["principal"] != "sk_computer" {
				t.Fatalf("principal %v", row)
			}
			need[key] = true
		}
	}
	for key, ok := range need {
		if !ok {
			t.Fatalf("preflight missing %s in %s", key, raw)
		}
	}
}

func stringList(items []any) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, _ := item.(string)
		out = append(out, text)
	}
	return out
}
