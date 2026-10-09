// Explicit phase boundaries for optional panels in the original Web. A
// missing capability is not a missing resource: authenticate and check the
// requested scope first, then return the machine-readable 501 contract. Do
// not teach clients to hide arbitrary 404s, which can be genuine failures.
package humanapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/agent"
)

func registerDeferredAgentUIRoutes(mux *http.ServeMux, h *AgentHandlers, scoped func(http.HandlerFunc) http.HandlerFunc) {
	mux.Handle("GET /api/agents/{id}/skills", scoped(h.deferredAgentSkills))
	mux.Handle("GET /api/reminders", scoped(h.deferredReminders))
}

func (h *AgentHandlers) deferredAgentSkills(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	if !h.canEditAgent(r, loaded) {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to view this agent's skills")
		return
	}
	httpx.NotImplemented("Agent skills are not enabled in this server stage")(w, r)
}

func (h *AgentHandlers) deferredReminders(w http.ResponseWriter, r *http.Request) {
	// This is not a public Agent-directory read. Deny guests before even
	// resolving an owner, so the unavailable panel is not an existence oracle.
	if agentScopeOf(r).Role == agent.RoleGuest {
		httpx.WriteError(w, http.StatusForbidden, "Guests cannot access reminders")
		return
	}
	ownerType, ownerID := r.URL.Query().Get("ownerType"), r.URL.Query().Get("ownerId")
	if ownerType == "agent" {
		loaded, err := h.Store.GetAgent(r.Context(), ownerID, false)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get agent")
			return
		}
		if loaded == nil || loaded.WorkspaceID != agentScopeOf(r).WorkspaceID {
			httpx.WriteError(w, http.StatusNotFound, "Agent not found")
			return
		}
		if !h.canEditAgent(r, loaded) {
			httpx.WriteError(w, http.StatusForbidden, "You do not have permission to view this agent's reminders")
			return
		}
	} else if ownerType == "user" {
		if ownerID != "" && ownerID != authn.UserID(r) {
			httpx.WriteError(w, http.StatusForbidden, "You do not have permission to view these reminders")
			return
		}
	} else if ownerType != "" || ownerID != "" {
		httpx.WriteError(w, http.StatusBadRequest, "Invalid reminder owner")
		return
	}
	httpx.NotImplemented("Reminders are not enabled in this server stage")(w, r)
}
