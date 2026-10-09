// Device-code user login grant HTTP layer, ported from routes/deviceAuth.ts.
package computerapi

import (
	"errors"
	"net/http"
	"net/url"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/computer"
)

const deviceLoginPath = "/login/device"

// deviceSurfaceDisabled answers the flag-off 404 (defense in depth: the
// parent may or may not gate the mount itself).
func (h *ComputerHandlers) deviceSurfaceDisabled(w http.ResponseWriter) bool {
	if h.DeviceLoginEnabled {
		return false
	}
	httpx.WriteErrorCode(w, http.StatusNotFound, "device_login_disabled", "Device login is not enabled")
	return true
}

// DeviceAuthorize implements POST /api/auth/device/authorize (public).
func (h *ComputerHandlers) DeviceAuthorize(w http.ResponseWriter, r *http.Request) {
	if h.deviceSurfaceDisabled(w) {
		return
	}
	var body struct {
		ClientName *string `json:"clientName"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	clientName := ""
	if body.ClientName != nil {
		// TS: any string up to 200 chars is accepted (empty string included).
		if len(*body.ClientName) > 200 {
			httpx.WriteErrorCode(w, http.StatusBadRequest, "client_name_invalid", "clientName must be a string up to 200 chars")
			return
		}
		clientName = *body.ClientName
	}

	grant, err := h.Store.CreateDeviceAuthorization(r.Context(), clientName, 0)
	if err != nil {
		if errors.Is(err, computer.ErrNotAuthorized) {
			httpx.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to start device authorization")
		return
	}

	base := h.VerificationBaseURL
	if base == nil {
		httpx.WriteErrorCode(w, http.StatusServiceUnavailable, computer.DeviceLoginURLUnavailable, "Device login URL is not configured")
		return
	}
	verification := *base
	verification.Path = deviceLoginPath
	complete := verification
	q := url.Values{}
	q.Set("user_code", grant.UserCode)
	complete.RawQuery = q.Encode()

	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"deviceCode":              grant.DeviceCode,
		"userCode":                grant.UserCode,
		"verificationUri":         verification.String(),
		"verificationUriComplete": complete.String(),
		"expiresIn":               grant.ExpiresInSeconds,
		"interval":                grant.PollIntervalSeconds,
	})
}

// DeviceApprove implements POST /api/auth/device/approve (USER-authenticated;
// the only authenticated phase — it binds the approving user identity).
func (h *ComputerHandlers) DeviceApprove(w http.ResponseWriter, r *http.Request) {
	if h.deviceSurfaceDisabled(w) {
		return
	}
	var body struct {
		UserCode *string `json:"userCode"`
		Approve  *bool   `json:"approve"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body.UserCode == nil || *body.UserCode == "" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "user_code_required", "userCode is required")
		return
	}
	approve := true
	if body.Approve != nil {
		approve = *body.Approve
	}

	result, err := h.Store.ApproveDeviceAuthorization(r.Context(), *body.UserCode, authn.UserID(r), approve)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to update device authorization")
		return
	}
	if !result.OK {
		status := http.StatusNotFound
		if result.Err == computer.Expired {
			status = http.StatusGone
		} else if result.Err == computer.AlreadyResolved {
			status = http.StatusConflict
		}
		httpx.WriteErrorCode(w, status, result.Err, "Device authorization could not be updated")
		return
	}
	action := "approved"
	if !approve {
		action = "denied"
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "action": action})
}

// DeviceToken implements POST /api/auth/device/token (public poll; the
// device_code is the credential). On success it issues a NORMAL user session
// — the grant never mints sk_* principals.
func (h *ComputerHandlers) DeviceToken(w http.ResponseWriter, r *http.Request) {
	if h.deviceSurfaceDisabled(w) {
		return
	}
	var body struct {
		DeviceCode *string `json:"deviceCode"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body.DeviceCode == nil || *body.DeviceCode == "" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, computer.DeviceCodeRequired, "deviceCode is required")
		return
	}

	result, err := h.Store.ConsumeDeviceAuthorization(r.Context(), *body.DeviceCode, computer.TokenUseObservation{
		IP:        httpx.ClientIPOf(r),
		UserAgent: r.Header.Get("User-Agent"),
	})
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to complete device authorization")
		return
	}
	if !result.OK {
		status := http.StatusBadRequest
		switch result.Err {
		case computer.ExpiredToken, computer.DeviceCodeConsumed:
			status = http.StatusGone
		case computer.AccessDenied:
			status = http.StatusForbidden
		}
		httpx.WriteErrorCode(w, status, result.Err, "Device authorization not ready")
		return
	}

	if h.Sessions == nil {
		// Wiring error, not a client failure: answer 503 honestly rather
		// than minting a partial response.
		httpx.WriteErrorCode(w, http.StatusServiceUnavailable, "session_issuer_unavailable", "Session issuance is not configured")
		return
	}
	session, err := h.Sessions.CreateSession(r.Context(), result.ApprovedByUserID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to complete device authorization")
		return
	}
	accessToken, err := h.Sessions.SignAccessToken(result.ApprovedByUserID, session.FamilyID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to complete device authorization")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"accessToken":  accessToken,
		"refreshToken": session.RefreshToken,
		"userId":       result.ApprovedByUserID,
	})
}

// httpx.ClientIPOf mirrors the ratelimit client-IP resolution for audit writes.
