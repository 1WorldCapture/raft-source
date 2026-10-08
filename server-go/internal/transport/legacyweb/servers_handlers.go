// GET /api/servers (real membership query) and the explicit unsupported
// workspace-creation response.
package legacyweb

import (
	"net/http"
	"time"

	"raft.local/server-go/internal/workspace"
)

// ServersHandlers serves the workspace projection.
type ServersHandlers struct {
	Store *workspace.Store
}

// planHistoryDays mirrors the legacy free/pro message-window policy.
func planHistoryDays(plan string) int {
	if plan == "" || plan == "free" {
		return 30
	}
	return -1
}

func historyCutoff(plan string, now time.Time) *string {
	days := planHistoryDays(plan)
	if days < 0 {
		return nil
	}
	cutoff := now.UTC().AddDate(0, 0, -days).Format("2006-01-02T15:04:05.000Z")
	return &cutoff
}

// List writes the user's real memberships; [] is a true answer.
func (h *ServersHandlers) List(w http.ResponseWriter, r *http.Request) {
	memberships, err := h.Store.ListUserServers(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list servers")
		return
	}
	now := time.Now()
	out := make([]map[string]any, 0, len(memberships))
	for _, m := range memberships {
		plan := m.Plan
		out = append(out, map[string]any{
			"id":                    m.ID,
			"name":                  m.Name,
			"avatarUrl":             m.AvatarURL,
			"slug":                  m.Slug,
			"ownerId":               m.OwnerID,
			"onboardingAgentId":     m.OnboardingAgentID,
			"hideHumansFromMembers": m.HideHumansFromMembers,
			"plan":                  plan,
			"planDowngradedAt":      FormatDateMS(m.PlanDowngradedAt),
			"role":                  m.Role,
			"serverPushMuted":       m.ServerPushMuted,
			"createdAt":             FormatDateMS(&m.CreatedAt),
			"messageHistoryDays":    planHistoryDays(plan),
			"historyCutoff":         historyCutoff(plan, now),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateWorkspace answers the M1 boundary honestly: unsupported until M2.
func (h *ServersHandlers) CreateWorkspace(w http.ResponseWriter, _ *http.Request) {
	writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
		"Workspace creation is not implemented in the account phase")
}
