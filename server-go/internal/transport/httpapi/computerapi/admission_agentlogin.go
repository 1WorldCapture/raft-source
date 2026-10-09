// Agent bootstrap login HTTP layer, ported from routes/agentLogin.ts.
// Gated by the unpublished self-hosted runner bootstrap surface flag (TS
// #1836); the bootstrapToken is the only credential this public route takes.
package computerapi

import (
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strings"

	"raft.local/server-go/internal/computer"
)

// AgentLogin implements POST /api/agent/login.
func (h *ComputerHandlers) AgentLogin(w http.ResponseWriter, r *http.Request) {
	if !h.AgentBootstrapEnabled {
		httpx.WriteErrorCode(w, http.StatusNotFound, computer.BootstrapSurfaceDisabled,
			"Self-hosted runner bootstrap is not enabled")
		return
	}
	var body struct {
		BootstrapToken *string `json:"bootstrapToken"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	rawToken := ""
	if body.BootstrapToken != nil {
		rawToken = strings.TrimSpace(*body.BootstrapToken)
	}
	if rawToken == "" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, computer.BootstrapMissingToken,
			"bootstrapToken is required")
		return
	}
	if h.AgentBootstrap == nil {
		// Honest wiring-state answer; never a fake success.
		httpx.WriteErrorCode(w, http.StatusServiceUnavailable, computer.BootstrapExchangerMissing,
			"Agent bootstrap token exchange is not configured")
		return
	}

	exchange, err := h.AgentBootstrap.ExchangeAgentBootstrapToken(r.Context(), rawToken, computer.TokenUseObservation{
		IP:        httpx.ClientIPOf(r),
		UserAgent: r.Header.Get("User-Agent"),
	})
	var bootstrapErr *computer.BootstrapError
	if errors.As(err, &bootstrapErr) {
		status := http.StatusInternalServerError
		switch bootstrapErr.Code {
		case computer.BootstrapTokenInvalid, computer.BootstrapTokenRevoked, computer.BootstrapTokenExpired:
			status = http.StatusUnauthorized
		case computer.BootstrapTokenConsumed, computer.BootstrapAgentMissing:
			status = http.StatusGone
		case computer.BootstrapPepperMissing:
			status = http.StatusServiceUnavailable
		}
		httpx.WriteErrorCode(w, status, bootstrapErr.Code, bootstrapErr.Code)
		return
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to exchange bootstrap token")
		return
	}

	var slug any
	if exchange.WorkspaceSlug != "" {
		slug = exchange.WorkspaceSlug
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"apiKey":       exchange.APIKey,
		"credentialId": exchange.CredentialID,
		"agentId":      exchange.AgentID,
		"agentName":    exchange.AgentName,
		"serverId":     exchange.WorkspaceID,
		"serverSlug":   slug,
		"scopes":       exchange.Scopes,
	})
}
