// Agent CLI reads beyond whoami: server directory, channel roster, and the
// fail-closed answer for every later /internal/agent-api path. Handles are
// resolved in the agent store. A user JWT never succeeds here.
package legacyweb

import (
	"net/http"
	"strings"

	"raft.local/server-go/internal/agent"
)

// bindAgentCredential authenticates a Bearer sk_agent_* key and records use.
// Failures are written here. Whoami does not require a capability; later
// reads call requireAgentCapability on the returned scopes.
func (h *AgentHandlers) bindAgentCredential(w http.ResponseWriter, r *http.Request) (*agent.CredentialLookup, *agent.Agent, *string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "Missing agent credential")
		return nil, nil, nil, false
	}
	apiKey := strings.TrimPrefix(header, "Bearer ")
	if !agent.IsAgentAPIKey(apiKey) {
		writeErrorCode(w, http.StatusUnauthorized, "invalid_principal", "Invalid authentication: agent credential required")
		return nil, nil, nil, false
	}
	lookup, err := h.Store.FindCredentialByAPIKey(r.Context(), apiKey)
	if err != nil {
		if domain := agent.AsError(err); domain != nil && domain.Status == http.StatusUnauthorized {
			writeError(w, domain.Status, domain.Message)
			return nil, nil, nil, false
		}
		writeError(w, http.StatusInternalServerError, "Failed to load agent identity")
		return nil, nil, nil, false
	}
	if lookup == nil {
		writeError(w, http.StatusUnauthorized, "Invalid agent credential")
		return nil, nil, nil, false
	}
	loaded, err := h.Store.GetAgent(r.Context(), lookup.AgentID, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load agent identity")
		return nil, nil, nil, false
	}
	if loaded == nil || loaded.WorkspaceID != lookup.WorkspaceID {
		writeError(w, http.StatusUnauthorized, "Agent no longer exists")
		return nil, nil, nil, false
	}
	role, err := h.Store.AgentMemberRole(r.Context(), lookup.WorkspaceID, lookup.AgentID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load agent identity")
		return nil, nil, nil, false
	}
	ip := clientIPOf(r)
	ua := r.Header.Get("User-Agent")
	var ipPtr, uaPtr *string
	if ip != "" {
		ipPtr = &ip
	}
	if ua != "" {
		uaPtr = &ua
	}
	if err := h.Store.RecordCredentialUse(r.Context(), lookup.CredentialID, ipPtr, uaPtr); err != nil {
		_ = err
	}
	return lookup, loaded, role, true
}

func (h *AgentHandlers) requireAgentCapability(w http.ResponseWriter, r *http.Request, scopes []string, capability string) bool {
	authorized := false
	for _, scope := range scopes {
		if scope == capability {
			authorized = true
			break
		}
	}
	if !authorized {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":              "Agent credential is not authorized for this capability",
			"code":               "capability_not_authorized",
			"requiredCapability": capability,
		})
		return false
	}
	activeRaw := strings.TrimSpace(r.Header.Get("X-Slock-Agent-Active-Capabilities"))
	if activeRaw == "" {
		return true
	}
	active := false
	for _, item := range strings.Split(activeRaw, ",") {
		if strings.TrimSpace(item) == capability {
			active = true
			break
		}
	}
	if !active {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"error":              "The current runner session does not support this capability",
			"code":               "unsupported_capability",
			"requiredCapability": capability,
		})
		return false
	}
	return true
}

// ServerInfo handles GET /internal/agent-api/server.
func (h *AgentHandlers) ServerInfo(w http.ResponseWriter, r *http.Request) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "server") {
		return
	}
	directory, err := h.Store.ServerDirectoryForAgent(r.Context(), lookup.WorkspaceID, lookup.AgentID)
	if err != nil {
		if domain := agent.AsError(err); domain != nil {
			writeError(w, domain.Status, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to load server info")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, directory)
}

// ChannelMembers handles GET /internal/agent-api/channel-members?channel=.
func (h *AgentHandlers) ChannelMembers(w http.ResponseWriter, r *http.Request) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "channels") {
		return
	}
	channelRef := strings.TrimSpace(r.URL.Query().Get("channel"))
	if channelRef == "" {
		writeError(w, http.StatusBadRequest, "channel query param is required (e.g. #all, dm:@richard)")
		return
	}
	directory, err := h.Store.ChannelMembersForAgent(r.Context(), lookup.WorkspaceID, lookup.AgentID, channelRef)
	if err != nil {
		if domain := agent.AsError(err); domain != nil {
			writeError(w, domain.Status, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get channel members")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, directory)
}

// UnregisteredAgentAPI is the method that the whoami paths do not serve.
// The registry has no row, so the answer is 401 before any credential check.
func (h *AgentHandlers) UnregisteredAgentAPI(w http.ResponseWriter, r *http.Request) {
	writeErrorCode(w, http.StatusUnauthorized, "auth_policy_unregistered_path", "Unregistered internal route")
}

// deferredAgentAPIFamilies are the first path segments registered in the TS
// agent-api policy for slices this server does not serve yet (messages,
// tasks, wiki, reminders, and the rest). A hit authenticates, then 501.
// A segment outside this set is unregistered even when the key is valid.
var deferredAgentAPIFamilies = map[string]bool{
	"feedback-locators": true, "events": true, "history": true, "knowledge": true,
	"wiki": true, "mcp": true, "send": true, "v2": true, "send-receipts": true,
	"messages": true, "search": true, "channels": true, "resolve-channel": true,
	"threads": true, "mention-actions": true, "mentions": true, "tasks": true,
	"labs": true, "profile": true, "integrations": true, "wake-hints": true,
	"activity": true, "upload": true, "attachment-upload-capabilities": true,
	"attachment-upload-sessions": true, "attachments": true, "reminders": true,
	"app-sources": true, "apps": true, "prepare-action": true, "migrations": true,
	"server": true, "channel-members": true,
}

// DeferredAgentAPI denies every /internal/agent-api path this slice does not
// implement. Known future families are 501 after a real sk_agent_* check.
// Unknown paths are 401 unregistered and do not require a successful auth.
func (h *AgentHandlers) DeferredAgentAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(r.PathValue("rest"), "/")
	family := rest
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		family = rest[:i]
	}
	if family == "" || !deferredAgentAPIFamilies[family] {
		writeErrorCode(w, http.StatusUnauthorized, "auth_policy_unregistered_path", "Unregistered internal route")
		return
	}
	if _, _, _, ok := h.bindAgentCredential(w, r); !ok {
		return
	}
	writeErrorCode(w, http.StatusNotImplemented, "not_implemented", "This agent API route is not implemented")
}
