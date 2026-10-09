// The sk_agent_* internal API: whoami plus the agent-key reads (server
// directory, channel roster) and the fail-closed answer for every later
// /internal/agent-api path. A user JWT never succeeds here; the only
// accepted principal is a live agent credential checked against the agent
// store on every request.
package agentapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/agent"
)

// Handlers carries the sk_agent_* API dependencies: the agent store owns
// credential lookup, revocation and the directory projections.
type Handlers struct {
	Store *agent.Store
}

// RegisterRoutes mounts the internal agent-key surface. These endpoints
// authenticate the Bearer sk_agent_* credential themselves (per-request
// against the store); they never accept a human session and are therefore
// NOT wrapped in the human auth gate.
func RegisterRoutes(mux *http.ServeMux, handlers *Handlers) {
	mux.Handle("GET /internal/agent-api", http.HandlerFunc(handlers.Whoami))
	mux.Handle("GET /internal/agent-api/{$}", http.HandlerFunc(handlers.Whoami))
	mux.Handle("/internal/agent-api", http.HandlerFunc(handlers.UnregisteredAgentAPI))
	mux.Handle("GET /internal/agent-api/server", http.HandlerFunc(handlers.ServerInfo))
	mux.Handle("GET /internal/agent-api/channel-members", http.HandlerFunc(handlers.ChannelMembers))
	mux.Handle("/internal/agent-api/{rest...}", http.HandlerFunc(handlers.DeferredAgentAPI))
}

// Whoami handles GET /internal/agent-api and GET /internal/agent-api/.
func (h *Handlers) Whoami(w http.ResponseWriter, r *http.Request) {
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
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"agentId":            lookup.AgentID,
		"agentName":          loaded.Name,
		"agentDisplayName":   httpx.NullableString(loaded.DisplayName),
		"serverId":           lookup.WorkspaceID,
		"serverRole":         role,
		"serverCapabilities": agent.ServerCapabilities(roleName),
		"credentialId":       lookup.CredentialID,
		"scopes":             scopes,
	})
}
