// CLI credential, discovery registration, bootstrap-token issue and the
// sk_agent_* whoami read. Runner control-plane routes and runtime-catalog
// routes are owned by other workers and are not mounted here.
package legacyweb

import (
	"encoding/json"
	"net/http"
	"strings"

	"raft.local/server-go/internal/agent"
)

// RegisterAgentRoutes mounts the M3B agent identity surface. Parent calls
// this from legacyweb assembly; this package does not edit routes.go.
// Credential and discovery routes do not require X-Server-Id. Lifecycle and
// bootstrap-token routes do. Whoami authenticates sk_agent_*, never a user JWT.
func RegisterAgentRoutes(mux *http.ServeMux, handlers *AgentHandlers, gate *AuthGate) {
	verified := gate.RequireVerified
	mux.Handle("GET /api/agents/manageable", verified(handlers.Manageable))
	mux.Handle("POST /api/agents/{id}/credentials", verified(handlers.MintCredential))
	mux.Handle("GET /api/agents/{id}/credentials", verified(handlers.ListCredentials))
	mux.Handle("DELETE /api/agents/{id}/credentials/{credentialId}", verified(handlers.RevokeCredentialHTTP))

	scoped := func(next http.HandlerFunc) http.HandlerFunc {
		return verified(handlers.agentScope(handlers.agentGuestGate(next)))
	}
	mux.Handle("GET /api/agents", scoped(handlers.List))
	mux.Handle("POST /api/agents", scoped(handlers.Create))
	mux.Handle("GET /api/agents/{id}", scoped(handlers.Get))
	mux.Handle("PATCH /api/agents/{id}", scoped(handlers.Update))
	mux.Handle("DELETE /api/agents/{id}", scoped(handlers.Delete))
	mux.Handle("POST /api/agents/{id}/start", scoped(handlers.Start))
	mux.Handle("POST /api/agents/{id}/stop", scoped(handlers.Stop))
	mux.Handle("POST /api/agents/{id}/reset", scoped(handlers.Reset))
	mux.Handle("POST /api/agents/{id}/assign-machine", scoped(handlers.AssignMachine))
	mux.Handle("POST /api/agents/{id}/bootstrap-tokens", scoped(handlers.IssueBootstrapToken))
	mux.Handle("POST /api/agents/{id}/avatar", scoped(handlers.UploadAvatar))
	mux.Handle("GET /api/agents/{id}/onboarding-identity-adoption", scoped(handlers.GetOnboardingAdoption))
	mux.Handle("POST /api/agents/{id}/onboarding-identity-adoption", scoped(handlers.PostOnboardingAdoption))

	mux.Handle("GET /internal/agent-api", http.HandlerFunc(handlers.Whoami))
	mux.Handle("GET /internal/agent-api/{$}", http.HandlerFunc(handlers.Whoami))
	mux.Handle("/internal/agent-api", http.HandlerFunc(handlers.UnregisteredAgentAPI))
	mux.Handle("GET /internal/agent-api/server", http.HandlerFunc(handlers.ServerInfo))
	mux.Handle("GET /internal/agent-api/channel-members", http.HandlerFunc(handlers.ChannelMembers))
	mux.Handle("/internal/agent-api/{rest...}", http.HandlerFunc(handlers.DeferredAgentAPI))
}

// MintCredential handles POST /api/agents/{id}/credentials.
func (h *AgentHandlers) MintCredential(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		writeError(w, http.StatusInternalServerError, "Failed to mint agent credential")
		return
	}
	if !h.Service.DeviceAuthEnabled() {
		writeErrorCode(w, http.StatusNotFound, agent.ErrDeviceLoginDisabled.Code, agent.ErrDeviceLoginDisabled.Message)
		return
	}
	loaded, ok := h.credentialSubject(w, r)
	if !ok {
		return
	}
	var body struct {
		Scopes json.RawMessage `json:"scopes"`
		Name   json.RawMessage `json:"name"`
	}
	if r.ContentLength != 0 {
		if !decodeJSONBody(w, r, &body) {
			return
		}
	}
	scopes, scopesOK := h.parseCredentialScopes(w, body.Scopes, true)
	if !scopesOK {
		return
	}
	name, nameOK := parseCredentialName(w, body.Name)
	if !nameOK {
		return
	}
	user := userID(r)
	minted, err := h.Store.MintCredential(r.Context(), loaded.ID, scopes, name, &user)
	if err != nil {
		h.writeCredentialError(w, err, "Failed to mint agent credential")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"credentialId": minted.CredentialID,
		"apiKey":       minted.APIKey,
		"scopes":       minted.Scopes,
		"agentId":      minted.AgentID,
		"agentName":    minted.AgentName,
		"serverId":     minted.WorkspaceID,
	})
}

// ListCredentials handles GET /api/agents/{id}/credentials.
func (h *AgentHandlers) ListCredentials(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.credentialSubject(w, r)
	if !ok {
		return
	}
	rows, err := h.Store.ListCredentials(r.Context(), loaded.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list agent credentials")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"agentId": loaded.ID, "credentials": rows})
}

// RevokeCredentialHTTP handles DELETE /api/agents/{id}/credentials/{credentialId}.
// A repeat revoke of an already-revoked row is 204; the first timestamp stays.
func (h *AgentHandlers) RevokeCredentialHTTP(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.credentialSubject(w, r)
	if !ok {
		return
	}
	credentialID := r.PathValue("credentialId")
	user := userID(r)
	var revoked bool
	var err error
	if machineIDPattern.MatchString(credentialID) {
		revoked, err = h.Store.RevokeCredential(r.Context(), credentialID, loaded.ID, loaded.WorkspaceID, "user_revoked", &user)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to revoke agent credential")
		return
	}
	if !revoked {
		writeErrorCode(w, http.StatusNotFound, "credential_missing", "Credential not found")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// IssueBootstrapToken handles POST /api/agents/{id}/bootstrap-tokens.
func (h *AgentHandlers) IssueBootstrapToken(w http.ResponseWriter, r *http.Request) {
	if !h.Store.SelfHostedRunnerEnabled() {
		writeErrorCode(w, http.StatusNotFound, agent.ErrBootstrapDisabled.Code, agent.ErrBootstrapDisabled.Message)
		return
	}
	loaded, ok := h.fetchAgent(w, r, true)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, "issueAgentCredentials") {
		writeErrorCode(w, http.StatusForbidden, "insufficient_role",
			"The `issueAgentCredentials` capability or human creator authority is required to issue agent bootstrap tokens")
		return
	}
	var body struct {
		Scopes json.RawMessage `json:"scopes"`
		TTLMs  *float64        `json:"ttlMs"`
	}
	if r.ContentLength != 0 {
		if !decodeJSONBody(w, r, &body) {
			return
		}
	}
	scopes, scopesOK := h.parseCredentialScopes(w, body.Scopes, true)
	if !scopesOK {
		return
	}
	var ttl *int64
	if body.TTLMs != nil {
		if *body.TTLMs <= 0 || *body.TTLMs != float64(int64(*body.TTLMs)) {
			writeErrorCode(w, http.StatusBadRequest, "ttl_invalid", "ttlMs must be a positive number of milliseconds")
			return
		}
		value := int64(*body.TTLMs)
		const maxTTL = int64(24 * 60 * 60 * 1000)
		if value > maxTTL {
			writeErrorCode(w, http.StatusBadRequest, "ttl_too_long", "ttlMs cannot exceed 24 hours")
			return
		}
		ttl = &value
	}
	issued, err := h.Store.IssueBootstrapToken(r.Context(), loaded.ID, scope.WorkspaceID, userID(r), scopes, ttl)
	if err != nil {
		h.writeCredentialError(w, err, "Failed to issue bootstrap token")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"tokenId":        issued.TokenID,
		"bootstrapToken": issued.RawToken,
		"tokenPrefix":    issued.TokenPrefix,
		"ttlExpiresAt":   isoMillisStr(issued.TTLExpiresAtMS),
		"scopes":         issued.Scopes,
		"agentId":        loaded.ID,
		"agentName":      loaded.Name,
		"serverId":       scope.WorkspaceID,
	})
}

// Whoami handles GET /internal/agent-api and GET /internal/agent-api/.
func (h *AgentHandlers) Whoami(w http.ResponseWriter, r *http.Request) {
	lookup, loaded, role, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	scopes := lookup.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	roleName := ""
	if role != nil {
		roleName = *role
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"agentId":            lookup.AgentID,
		"agentName":          loaded.Name,
		"agentDisplayName":   nullableString(loaded.DisplayName),
		"serverId":           lookup.WorkspaceID,
		"serverRole":         role,
		"serverCapabilities": agent.ServerCapabilities(roleName),
		"credentialId":       lookup.CredentialID,
		"scopes":             scopes,
	})
}

// credentialSubject resolves the agent from the path and applies the
// anti-enumeration rule: missing agent and non-member are the same 404.
func (h *AgentHandlers) credentialSubject(w http.ResponseWriter, r *http.Request) (*agent.Agent, bool) {
	loaded, err := h.Store.GetAgent(r.Context(), r.PathValue("id"), false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load agent")
		return nil, false
	}
	if loaded == nil {
		writeAgentMissing(w)
		return nil, false
	}
	role, err := h.Store.MemberRole(r.Context(), loaded.WorkspaceID, userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load agent")
		return nil, false
	}
	if role == nil {
		writeAgentMissing(w)
		return nil, false
	}
	if !agent.UserCanActOnAgentResource(*role, userID(r), loaded, "issueAgentCredentials") {
		writeErrorCode(w, http.StatusForbidden, "insufficient_role",
			"The `issueAgentCredentials` capability or human creator authority is required to manage agent credentials")
		return nil, false
	}
	return loaded, true
}

func writeAgentMissing(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusNotFound, "agent_missing", "Agent not found")
}

func (h *AgentHandlers) parseCredentialScopes(w http.ResponseWriter, raw json.RawMessage, allowDefault bool) ([]string, bool) {
	if len(raw) == 0 {
		if !allowDefault {
			writeErrorCode(w, http.StatusBadRequest, "scopes_invalid", "scopes must be an array of capability literals")
			return nil, false
		}
		out := append([]string(nil), agent.AllowedAgentCapabilities...)
		return out, true
	}
	if string(raw) == "null" || !strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
		writeErrorCode(w, http.StatusBadRequest, "scopes_invalid", "scopes must be an array of capability literals")
		return nil, false
	}
	var scopes []string
	if err := json.Unmarshal(raw, &scopes); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "scopes_invalid", "scopes must be an array of capability literals")
		return nil, false
	}
	normalized, ok := agent.NormalizeAgentCapabilities(scopes)
	if !ok {
		writeErrorCode(w, http.StatusBadRequest, "scopes_invalid",
			"scopes must each be one of: "+strings.Join(agent.AllowedAgentCapabilities, ", "))
		return nil, false
	}
	if len(normalized) == 0 {
		writeErrorCode(w, http.StatusBadRequest, "scopes_empty", "scopes must include at least one capability")
		return nil, false
	}
	return normalized, true
}

func parseCredentialName(w http.ResponseWriter, raw json.RawMessage) (*string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var name string
	if err := json.Unmarshal(raw, &name); err != nil || len([]rune(name)) > 200 {
		writeErrorCode(w, http.StatusBadRequest, "name_invalid", "name must be a string up to 200 chars")
		return nil, false
	}
	return &name, true
}

func (h *AgentHandlers) writeCredentialError(w http.ResponseWriter, err error, fallback string) {
	domain := agent.AsError(err)
	if domain == nil {
		writeError(w, http.StatusInternalServerError, fallback)
		return
	}
	if domain == agent.ErrAgentMissing || domain.Code == "agent_missing" {
		writeAgentMissing(w)
		return
	}
	if domain.Code == "agent_server_mismatch" {
		writeAgentMissing(w)
		return
	}
	if domain.Code != "" {
		writeErrorCode(w, domain.Status, domain.Code, domain.Message)
		return
	}
	writeError(w, domain.Status, domain.Message)
}
