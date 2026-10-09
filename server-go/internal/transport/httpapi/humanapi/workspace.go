// HTTP handlers for the workspace sub-surfaces (W08-W17): member directory,
// aggregated and onboarding settings, the setup projection and its commands,
// sidebar order and the machine directory. Every handler assumes the auth
// gates and (for /:id routes) the scope middleware have already run; domain
// answers map to the legacy statuses/bodies here and nowhere else.
package humanapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/workspace"
)

// familyID is the session family of the access token ("" when the token
// carries none); setup-handoff persists it as the account-level fact.
func familyID(r *http.Request) string {
	v, _ := r.Context().Value(authn.FamilyID).(string)
	return v
}

// Members implements GET /api/servers/:id/members (W08). Guests are rejected
// by this endpoint itself (the legacy handler-level check), then the domain
// applies the email-visibility and hideHumansFromMembers privacy rules.
func (h *ServersHandlers) Members(w http.ResponseWriter, r *http.Request) {
	if scopeRole(r) == workspace.RoleGuest {
		httpx.WriteError(w, http.StatusForbidden, "Guests cannot access server management data")
		return
	}
	members, err := h.Store.ListMembers(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get members")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, members)
}

// GetSettings implements GET /api/servers/:id/settings (W09): the aggregated
// {settings:{onboardSettings, feedbackSettings}} payload.
func (h *ServersHandlers) GetSettings(w http.ResponseWriter, r *http.Request) {
	payload, err := h.Store.GetSettings(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get server settings")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// GetOnboardingSettings implements GET /api/servers/:id/onboarding-settings
// (W10): the inner onboardSettings projection, aliases included.
func (h *ServersHandlers) GetOnboardingSettings(w http.ResponseWriter, r *http.Request) {
	payload, err := h.Store.GetOnboardingSettings(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get onboarding settings")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// PatchOnboardingSettings implements PATCH /api/servers/:id/onboarding-settings
// (W11). The raw decoded body crosses the seam unchanged so the domain can
// apply the exact absent/null/false distinctions, the reminder-alias
// coalescing, the manager-field gate and the grandfathered reconcile in one
// transaction.
func (h *ServersHandlers) PatchOnboardingSettings(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	payload, err := h.Store.UpdateOnboardingSettings(r.Context(), r.PathValue("id"), authn.UserID(r), body)
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to update onboarding settings")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// SetupProjection implements GET /api/servers/:id/setup-projection (W12): a
// pure read with no transition or delivery side effects. Business failures
// carry the setup machine codes; anything else is the legacy unhandled-error
// shape (this legacy route has no endpoint-specific catch).
func (h *ServersHandlers) SetupProjection(w http.ResponseWriter, r *http.Request) {
	projection, err := h.Store.GetSetupProjection(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeSetupDomainError(w, err) {
			httpx.WriteErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, projection)
}

// setupActions is the closed action set; `defer` is retired and unknown
// actions (including it) answer INVALID_SETUP_ACTION.
var setupActions = map[string]bool{"start": true, "complete": true}

// SetupTransition implements POST /api/servers/:id/setup-transition (W13).
// The action is validated here exactly like the legacy route; the state
// machine rules (idempotent start, official-agent-gated complete, no
// regression from complete) and the re-read projection belong to the domain.
func (h *ServersHandlers) SetupTransition(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	action, ok := body["action"].(string)
	if !ok || !setupActions[action] {
		httpx.WriteError(w, http.StatusBadRequest, "INVALID_SETUP_ACTION")
		return
	}
	projection, err := h.Store.TransitionSetup(r.Context(), r.PathValue("id"), authn.UserID(r), action)
	if err != nil {
		if !writeSetupDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "SERVER_SETUP_TRANSITION_FAILED")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, projection)
}

// SetupReset implements POST /api/servers/:id/setup-reset (W14). The domain
// result carries the re-read projection separately; merge it into the legacy
// top-level response alongside the actually-revoked computer count.
func (h *ServersHandlers) SetupReset(w http.ResponseWriter, r *http.Request) {
	result, err := h.Store.ResetSetup(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeSetupDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "SERVER_SETUP_RESET_FAILED")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, struct {
		workspace.SetupProjection
		RevokedComputers int `json:"revokedComputers"`
	}{SetupProjection: result.Projection, RevokedComputers: result.RevokedComputers})
}

// SetupHandoff implements POST /api/servers/:id/setup-handoff (W15): the
// owner's "Let's Go". Authorization is the workspace ownerId (not merely a
// manager role), the first acknowledgment timestamp is persisted before any
// optional briefing, and — faithfully to the reference — there is no
// complete-status prerequisite and an early call never advances setup.status.
func (h *ServersHandlers) SetupHandoff(w http.ResponseWriter, r *http.Request) {
	projection, err := h.Store.HandoffSetup(r.Context(), r.PathValue("id"), authn.UserID(r), familyID(r))
	if err != nil {
		if de := workspace.AsDomainError(err); de != nil {
			switch de.Code {
			case workspace.CodeNotFound:
				httpx.WriteError(w, http.StatusNotFound, "Server not found")
				return
			case workspace.CodeForbidden, workspace.CodeInsufficientPermission:
				httpx.WriteError(w, http.StatusForbidden, "INSUFFICIENT_PERMISSION")
				return
			case workspace.CodeStateNotFound:
				httpx.WriteError(w, http.StatusNotFound, "STATE_NOT_FOUND")
				return
			}
		}
		httpx.WriteError(w, http.StatusInternalServerError, "SERVER_SETUP_HANDOFF_FAILED")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, projection)
}

// SidebarOrder implements GET /api/servers/:id/sidebar-order (W16): the full
// sanitized per-member projection (typed and legacy pinned fields, sections,
// versions) produced by the domain; this is a read-only surface in M2.
func (h *ServersHandlers) SidebarOrder(w http.ResponseWriter, r *http.Request) {
	payload, err := h.Store.GetSidebarOrder(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get sidebar order")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// Machines implements GET /api/servers/:id/machines (W17). The response
// envelope matches the legacy object shape ({machines, latestDaemonVersion,
// latestComputerVersion}); M2 has no daemon/computer release catalog, so the
// version hints are honest nulls while the machines array is the real
// directory query ([] is a true answer).
func (h *ServersHandlers) Machines(w http.ResponseWriter, r *http.Request) {
	machines, err := h.Store.ListMachines(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if !writeDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to list machines")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"machines":              machines,
		"latestDaemonVersion":   nil,
		"latestComputerVersion": nil,
	})
}
