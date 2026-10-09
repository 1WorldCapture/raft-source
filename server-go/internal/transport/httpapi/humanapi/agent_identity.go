// Avatar upload and official onboarding-identity adoption. Capability is
// checked before any avatar bytes are decoded. Adoption commits through
// Store.AdoptOnboardingIdentity, which is one transaction.
package humanapi

import (
	"database/sql"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/agent"
)

// UploadAvatar handles POST /api/agents/{id}/avatar.
func (h *AgentHandlers) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	if !h.canEditAgent(r, loaded) {
		httpx.WriteError(w, http.StatusForbidden, "The `editAgents` capability or human creator authority is required to edit agents")
		return
	}
	if h.AvatarDir == "" {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	png, ok := decodeValidatedAvatarPNG(w, r, maxAvatarBytesDefault, maxAvatarSideDefault)
	if !ok {
		return
	}
	avatarURL, err := publishServerAvatar(h.AvatarDir, png)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	updated, err := h.Store.UpdateAgent(r.Context(), loaded.WorkspaceID, loaded.ID, agent.AgentPatch{
		AvatarURL: &sql.NullString{String: avatarURL, Valid: true},
	})
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	role, err := h.Store.AgentMemberRole(r.Context(), loaded.WorkspaceID, loaded.ID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	h.respondAgentDTO(w, r, updated, role)
}

type onboardingIdentity struct {
	Name        string  `json:"name"`
	DisplayName *string `json:"displayName"`
	Role        *string `json:"role"`
	ServerRole  *string `json:"serverRole"`
	AvatarURL   *string `json:"avatarUrl"`
}

type onboardingChange struct {
	Field  string  `json:"field"`
	Label  string  `json:"label"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}

func buildOnboardingAdoption(a *agent.Agent, serverRole *string) map[string]any {
	current := onboardingIdentity{
		Name:        a.Name,
		DisplayName: nullStringPtr(a.DisplayName),
		Role:        nullStringPtr(a.Description),
		ServerRole:  serverRole,
		AvatarURL:   nullStringPtr(a.AvatarURL),
	}
	officialRole := agent.OfficialAgentDescription
	officialDisplay := agent.OfficialAgentDisplayName
	officialAvatar := agent.OfficialAgentAvatarURL
	officialServerRole := agent.OfficialAgentServerRole
	official := onboardingIdentity{
		Name:        agent.OfficialAgentName,
		DisplayName: &officialDisplay,
		Role:        &officialRole,
		ServerRole:  &officialServerRole,
		AvatarURL:   &officialAvatar,
	}
	labels := []struct {
		field, label  string
		before, after *string
	}{
		{"name", "Name", stringPtr(current.Name), stringPtr(official.Name)},
		{"displayName", "Display name", current.DisplayName, official.DisplayName},
		{"role", "Role", current.Role, official.Role},
		{"serverRole", "Server role", current.ServerRole, official.ServerRole},
		{"avatarUrl", "Avatar", current.AvatarURL, official.AvatarURL},
	}
	var changes []onboardingChange
	for _, item := range labels {
		if !sameOptional(item.before, item.after) {
			changes = append(changes, onboardingChange{
				Field: item.field, Label: item.label, Before: item.before, After: item.after,
			})
		}
	}
	if changes == nil {
		changes = []onboardingChange{}
	}
	return map[string]any{
		"canAdopt":         len(changes) > 0,
		"currentIdentity":  current,
		"officialIdentity": official,
		"changes":          changes,
	}
}

func (h *AgentHandlers) onboardingSubject(w http.ResponseWriter, r *http.Request) (*agent.Agent, *string, bool) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return nil, nil, false
	}
	if !h.canEditAgent(r, loaded) {
		httpx.WriteError(w, http.StatusForbidden, "The `editAgents` capability or human creator authority is required to edit agents")
		return nil, nil, false
	}
	pointer, err := h.Store.OnboardingAgentID(r.Context(), loaded.WorkspaceID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load onboarding identity adoption")
		return nil, nil, false
	}
	if pointer == nil || *pointer != loaded.ID {
		httpx.WriteError(w, http.StatusBadRequest, "Agent is not this server's onboarding agent")
		return nil, nil, false
	}
	role, err := h.Store.AgentMemberRole(r.Context(), loaded.WorkspaceID, loaded.ID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load onboarding identity adoption")
		return nil, nil, false
	}
	return loaded, role, true
}

// GetOnboardingAdoption handles GET /api/agents/{id}/onboarding-identity-adoption.
func (h *AgentHandlers) GetOnboardingAdoption(w http.ResponseWriter, r *http.Request) {
	loaded, role, ok := h.onboardingSubject(w, r)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, buildOnboardingAdoption(loaded, role))
}

// PostOnboardingAdoption handles POST /api/agents/{id}/onboarding-identity-adoption.
func (h *AgentHandlers) PostOnboardingAdoption(w http.ResponseWriter, r *http.Request) {
	loaded, role, ok := h.onboardingSubject(w, r)
	if !ok {
		return
	}
	preview := buildOnboardingAdoption(loaded, role)
	updated := loaded
	if preview["canAdopt"] == true {
		if err := h.Store.AdoptOnboardingIdentity(r.Context(), loaded.WorkspaceID, loaded.ID); err != nil {
			if domain := agent.AsError(err); domain != nil {
				httpx.WriteError(w, domain.Status, domain.Message)
				return
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to adopt onboarding identity")
			return
		}
		refreshed, err := h.Store.GetAgent(r.Context(), loaded.ID, false)
		if err != nil || refreshed == nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to adopt onboarding identity")
			return
		}
		updated = refreshed
		role, err = h.Store.AgentMemberRole(r.Context(), loaded.WorkspaceID, loaded.ID)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to adopt onboarding identity")
			return
		}
	}
	body := buildOnboardingAdoption(updated, role)
	body["appliedChanges"] = preview["changes"]
	dto, err := h.buildAgentDTO(r.Context(), updated, role, false)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to adopt onboarding identity")
		return
	}
	body["agent"] = dto
	httpx.WriteJSON(w, http.StatusOK, body)
}

func stringPtr(v string) *string { return &v }

func sameOptional(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
