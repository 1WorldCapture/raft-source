// Computer runner control plane required by the original daemon at startup:
// list, stop, credential mint/revoke, and the C0 provider-connection refusal.
//
// These routes are more specific than ComputerHandlers' /internal/computer/
// dispatcher, so Go's mux selects them when the parent calls
// RegisterRunnerRoutes. The dispatcher itself still fail-closes every
// non-preflight registry row; parent must also append RunnerRouteManifest
// to ComputerHandlers.InternalRoutes so preflight reports the real surface.
// Authentication reuses requireComputerAuth (sk_computer_* canonical,
// sk_machine_* phase-1 alias). Lifecycle stop is the Agent service seam.
package legacyweb

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/computer"
)

// RunnerHandlers serves /internal/computer/runners/*.
type RunnerHandlers struct {
	// Access mints, revokes and lists on agent_credentials. Nil answers 503.
	Access *agent.RunnerAccess
	// Computers authenticates the computer credential. Nil answers 503.
	Computers *ComputerHandlers
	// Lifecycle is the manual stop owned by *agent.Service. Nil answers
	// 503 orchestrator_unavailable after the agent binding check, matching
	// the TS handler's missing-orchestrator branch.
	Lifecycle agent.RunnerLifecycle
}

// RunnerRouteManifest is the preflight registry block for this surface.
// Paths are the authFromRegistry form (":name" placeholders) relative to
// /internal/computer. Principal is sk_computer; the alias is enforced inside
// requireComputerAuth, not as a second registry principal.
func RunnerRouteManifest() []computer.InternalRouteEntry {
	return []computer.InternalRouteEntry{
		{Method: http.MethodGet, Path: "/runners", Principal: "sk_computer"},
		{Method: http.MethodPost, Path: "/runners/:agentId/stop", Principal: "sk_computer"},
		{Method: http.MethodPost, Path: "/runners/:agentId/credentials", Principal: "sk_computer"},
		{Method: http.MethodDelete, Path: "/runners/:agentId/credentials/:credentialId", Principal: "sk_computer"},
		{Method: http.MethodPost, Path: "/runners/:agentId/provider-connection", Principal: "sk_computer"},
	}
}

// RegisterRunnerRoutes mounts the runner surface. Parent calls this in
// addition to RegisterComputerRoutes; it does not edit the shared route table.
func RegisterRunnerRoutes(mux *http.ServeMux, handlers *RunnerHandlers) {
	if mux == nil || handlers == nil {
		return
	}
	mux.HandleFunc("GET /internal/computer/runners", handlers.list)
	mux.HandleFunc("POST /internal/computer/runners/{agentId}/stop", handlers.stop)
	mux.HandleFunc("POST /internal/computer/runners/{agentId}/credentials", handlers.mint)
	mux.HandleFunc("DELETE /internal/computer/runners/{agentId}/credentials/{credentialId}", handlers.revoke)
	mux.HandleFunc("POST /internal/computer/runners/{agentId}/provider-connection", handlers.providerConnection)
}

func (h *RunnerHandlers) list(w http.ResponseWriter, r *http.Request) {
	binding, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.Access == nil {
		writeRunnerUnavailable(w)
		return
	}
	rows, err := h.Access.List(r.Context(), binding, r.URL.Query().Get("scope"))
	if err != nil {
		writeRunnerError(w, err, "Failed to list runners")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"whitelist": append([]string(nil), agent.RunnerListFields...),
		"runners":   rows,
	})
}

func (h *RunnerHandlers) stop(w http.ResponseWriter, r *http.Request) {
	binding, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.Access == nil {
		writeRunnerUnavailable(w)
		return
	}
	row, err := h.Access.ConfirmRunner(r.Context(), binding, r.PathValue("agentId"))
	if err != nil {
		writeRunnerError(w, err, "Failed to stop runner")
		return
	}
	if h.Lifecycle == nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "orchestrator_unavailable", "Orchestrator unavailable")
		return
	}
	if err := h.Lifecycle.Stop(r.Context(), row); err != nil {
		writeRunnerError(w, err, "Failed to stop runner")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "agentId": row.ID})
}

func (h *RunnerHandlers) mint(w http.ResponseWriter, r *http.Request) {
	binding, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.Access == nil {
		writeRunnerUnavailable(w)
		return
	}
	scopes, name, err := runnerMintBody(r)
	if err != nil {
		writeRunnerError(w, err, "Failed to mint runner credential")
		return
	}
	minted, err := h.Access.Mint(r.Context(), binding, r.PathValue("agentId"), scopes, name)
	if err != nil {
		writeRunnerError(w, err, "Failed to mint runner credential")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"credentialId": minted.CredentialID,
		"apiKey":       minted.APIKey,
		"scopes":       minted.Scopes,
		"agentId":      minted.AgentID,
		"agentName":    minted.AgentName,
		"serverId":     minted.WorkspaceID,
	})
}

func (h *RunnerHandlers) revoke(w http.ResponseWriter, r *http.Request) {
	binding, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.Access == nil {
		writeRunnerUnavailable(w)
		return
	}
	if err := h.Access.Revoke(r.Context(), binding, r.PathValue("agentId"), r.PathValue("credentialId")); err != nil {
		writeRunnerError(w, err, "Failed to revoke runner credential")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// providerConnection is the C0 refusal. Provider connections are a missing
// feature flag on this server (no flag store, no ciphertext table). The
// handler authenticates and re-checks the computer binding, then answers
// the original disabled body. It never reads a stored provider secret and
// never echoes one.
func (h *RunnerHandlers) providerConnection(w http.ResponseWriter, r *http.Request) {
	binding, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	if h.Access == nil {
		writeRunnerUnavailable(w)
		return
	}
	if err := h.Access.Authorize(r.Context(), binding, true); err != nil {
		writeRunnerError(w, err, "Failed to materialize provider connection")
		return
	}
	writeErrorCode(w, http.StatusNotFound, "provider_connections_disabled",
		"Provider connections are not enabled for this server")
}

func (h *RunnerHandlers) authenticate(w http.ResponseWriter, r *http.Request) (agent.RunnerBinding, bool) {
	if h == nil || h.Computers == nil || h.Computers.Store == nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "computer_auth_unavailable", "Computer authentication is not available")
		return agent.RunnerBinding{}, false
	}
	principal, ok := h.Computers.requireComputerAuth(w, r)
	if !ok {
		return agent.RunnerBinding{}, false
	}
	legacy := principal.Kind == computer.KindLegacyMachine
	binding := agent.RunnerBinding{
		Principal:     principal,
		MachineID:     principal.MachineID,
		WorkspaceID:   principal.WorkspaceID,
		LegacyMachine: legacy,
	}
	if !legacy {
		binding.ComputerID = principal.ComputerID
	}
	return binding, true
}

func runnerMintBody(r *http.Request) (scopes []string, name *string, err error) {
	obj, err := readJSONObject(r)
	if err != nil {
		return nil, nil, errfBadJSON()
	}
	rawScopes, ok := obj["scopes"]
	if !ok || len(bytes.TrimSpace(rawScopes)) == 0 {
		scopes = nil
	} else if bytes.TrimSpace(rawScopes)[0] != '[' {
		return nil, nil, agent.ErrRunnerScopesType
	} else {
		var items []any
		if err := json.Unmarshal(rawScopes, &items); err != nil {
			return nil, nil, agent.ErrRunnerScopesType
		}
		scopes = make([]string, 0, len(items))
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil, nil, agent.ErrRunnerScopesValue
			}
			scopes = append(scopes, text)
		}
	}
	rawName, ok := obj["name"]
	if ok && len(bytes.TrimSpace(rawName)) > 0 && string(bytes.TrimSpace(rawName)) != "null" {
		var text string
		if err := json.Unmarshal(rawName, &text); err != nil {
			return nil, nil, agent.ErrRunnerNameInvalid
		}
		name = &text
	}
	return scopes, name, nil
}

func readJSONObject(r *http.Request) (map[string]json.RawMessage, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, errors.New("body too large")
	}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return map[string]json.RawMessage{}, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	if obj == nil {
		return map[string]json.RawMessage{}, nil
	}
	return obj, nil
}

// errfBadJSON is a transport-level body failure. The daemon always sends a
// JSON object; this is the closed answer for anything else.
func errfBadJSON() error {
	return agentBadJSON
}

var agentBadJSON = &agent.Error{Status: http.StatusBadRequest, Message: "Invalid JSON"}

func writeRunnerError(w http.ResponseWriter, err error, fallback string) {
	domain := agent.AsError(err)
	if domain == nil {
		writeError(w, http.StatusInternalServerError, fallback)
		return
	}
	if domain.Code == "" {
		writeError(w, domain.Status, domain.Message)
		return
	}
	writeErrorCode(w, domain.Status, domain.Code, domain.Message)
}

func writeRunnerUnavailable(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusServiceUnavailable, "runner_access_unavailable", "Runner access is not available")
}
