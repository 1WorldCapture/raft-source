// Legacy-web auth routes: register/login/refresh/me/profile/verification/
// password-reset/logout, reproducing the TS server's request parsing, status
// codes and error bodies. Hardening divergences are commented inline and
// collected in the README.
package humanapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"regexp"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
)

// Handlers bundles the route dependencies.
type Handlers struct {
	Auth     *auth.Service
	Sessions *auth.SessionService
	Signer   *auth.TokenSigner
	Users    authn.UserLookup
	Gate     *authn.AuthGate
}

// ── request body parsing (zod-shaped) ──

var (
	attemptIDPattern    = regexp.MustCompile(`^arf_[0-9a-f]{16}$`)
	installationPattern = regexp.MustCompile(`^ari_[0-9a-f]{32}$`)
)

func bodyString(body map[string]any, key string) (string, bool, bool) {
	raw, present := body[key]
	if !present {
		return "", false, true
	}
	s, ok := raw.(string)
	return s, ok, false
}

func jsonTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "unknown"
	}
}

// requireStringFields emits zod-style issues for required min-1 string fields.
func requireStringFields(body map[string]any, fields ...string) []httpx.Issue {
	var issues []httpx.Issue
	for _, field := range fields {
		raw, present := body[field]
		if !present {
			issues = append(issues, httpx.Issue{Path: field, Message: "Required"})
			continue
		}
		s, ok := raw.(string)
		if !ok {
			issues = append(issues, httpx.Issue{Path: field, Message: "Expected string, received " + jsonTypeName(raw)})
			continue
		}
		if len(s) < 1 {
			issues = append(issues, httpx.Issue{Path: field, Message: "String must contain at least 1 character(s)"})
		}
	}
	return issues
}

// ── POST /api/auth/register ──

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	issues := requireStringFields(body, "email", "password")
	if rawName, present := body["name"]; present {
		if _, isString := rawName.(string); !isString {
			issues = append(issues, httpx.Issue{Path: "name", Message: "Expected string, received " + jsonTypeName(rawName)})
		}
	}
	if len(issues) > 0 {
		httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid email registration body", "email_register_body_invalid", issues)
		return
	}
	email, _, _ := bodyString(body, "email")
	password, _, _ := bodyString(body, "password")
	name, nameOK, _ := bodyString(body, "name")
	if nameOK && name != "" {
		if nameError := auth.ValidateName(name, "Name", auth.NameMinLengthUsers); nameError != "" {
			httpx.WriteError(w, http.StatusBadRequest, nameError)
			return
		}
	}
	if len(password) < 8 {
		httpx.WriteError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}
	acceptTerms, _ := body["acceptTerms"].(bool)
	termsVersion, _, _ := bodyString(body, "termsVersion")
	privacyVersion, _, _ := bodyString(body, "privacyVersion")

	ip := clientIPOrNil(r)
	agent := headerOrNil(r, "User-Agent")
	locale := headerOrNil(r, "Accept-Language")

	user, session, err := h.Auth.Register(r.Context(), auth.RegisterInput{
		Email:    email,
		Password: password,
		Name:     strings.TrimSpace(name),
		Legal: auth.LegalAcceptanceInput{
			AcceptTerms:    acceptTerms,
			TermsVersion:   termsVersion,
			PrivacyVersion: privacyVersion,
		},
		LegalMetadata: auth.LegalAcceptanceMetadata{IPAddress: ip, UserAgent: agent, Locale: locale},
	})
	if err != nil {
		h.writeRegisterError(w, err)
		return
	}
	accessToken, err := h.Signer.SignAccessToken(user.ID, session.FamilyID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Registration failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"user":         UserToDTO(user),
		"accessToken":  accessToken,
		"refreshToken": session.RefreshToken,
	})
}

func (h *Handlers) writeRegisterError(w http.ResponseWriter, err error) {
	domain := auth.AsError(err)
	if domain == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Registration failed")
		return
	}
	switch domain.Code {
	case auth.ErrCodeLegalRequired:
		httpx.WriteJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{
			"error": "LEGAL_ACCEPTANCE_REQUIRED",
			"legal": legalVersionsBody(),
		})
	case auth.ErrCodeTermsChanged:
		httpx.WriteJSON(w, http.StatusConflict, httpx.ErrorBody{
			"error": "TERMS_CHANGED",
			"legal": legalVersionsBody(),
		})
	case auth.ErrCodeEmailRegistered:
		httpx.WriteError(w, http.StatusConflict, "Email is already registered")
	case auth.ErrCodeUsernameTaken:
		httpx.WriteErrorCode(w, http.StatusConflict, "AUTH_USERNAME_TAKEN", "Username is already taken")
	case auth.ErrCodeInvalidEmail, auth.ErrCodeInvalidPassword:
		httpx.WriteError(w, http.StatusBadRequest, domain.Message)
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "Registration failed")
	}
}

func legalVersionsBody() map[string]string {
	v := auth.CurrentLegalVersions()
	return map[string]string{
		"termsVersion":   v.TermsVersion,
		"privacyVersion": v.PrivacyVersion,
		"termsUrl":       v.TermsURL,
		"privacyUrl":     v.PrivacyURL,
	}
}

// ── GET /api/auth/providers ──

func (h *Handlers) Providers(w http.ResponseWriter, r *http.Request) {
	platform := r.URL.Query().Get("platform")
	if platform == "" {
		platform = "web"
	}
	if platform != "web" && platform != "mobile" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "platform_invalid", "platform must be web or mobile")
		return
	}
	// No OAuth providers are configured in the account phase; the honest
	// answer is an empty list, not a fabricated capability.
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"providers": []any{}})
}

// ── POST /api/auth/login ──

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	if issues := requireStringFields(body, "email", "password"); len(issues) > 0 {
		httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid email login body", "email_login_body_invalid", issues)
		return
	}
	email, _, _ := bodyString(body, "email")
	password, _, _ := bodyString(body, "password")
	user, session, err := h.Auth.Login(r.Context(), email, password)
	if err != nil {
		domain := auth.AsError(err)
		if domain != nil && domain.Code == auth.ErrCodeInvalidCredentials {
			httpx.WriteErrorCode(w, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", domain.Message)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	accessToken, err := h.Signer.SignAccessToken(user.ID, session.FamilyID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"user":         UserToDTO(user),
		"accessToken":  accessToken,
		"refreshToken": session.RefreshToken,
	})
}

// ── POST /api/auth/refresh ──

func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	refreshToken, ok, _ := bodyString(body, "refreshToken")
	if !ok || refreshToken == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Refresh token is required")
		return
	}
	attemptHeader := r.Header.Get("X-Slock-Auth-Refresh-Attempt-Id")
	installationHeader := r.Header.Get("X-Slock-Auth-Installation-Id")
	attemptID := normalizeIfMatches(attemptHeader, attemptIDPattern)
	installationID := normalizeIfMatches(installationHeader, installationPattern)
	if installationHeader != "" && (attemptID == "" || installationID == "") {
		httpx.WriteError(w, http.StatusBadRequest, "Invalid refresh replay binding")
		return
	}
	var binding *auth.RefreshBinding
	if attemptID != "" && installationID != "" {
		binding = &auth.RefreshBinding{AttemptID: attemptID, InstallationID: installationID}
	}
	outcome, err := h.Sessions.Refresh(r.Context(), refreshToken, binding)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Token refresh failed")
		return
	}
	if outcome == nil || outcome.Session == nil {
		httpx.WriteError(w, http.StatusUnauthorized, "Invalid or expired refresh token")
		return
	}
	accessToken, err := h.Signer.SignAccessToken(outcome.Session.UserID, outcome.Session.FamilyID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Token refresh failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"accessToken":  accessToken,
		"refreshToken": outcome.Session.RefreshToken,
	})
}

func normalizeIfMatches(value string, pattern *regexp.Regexp) string {
	trimmed := strings.TrimSpace(value)
	if pattern.MatchString(trimmed) {
		return trimmed
	}
	return ""
}

// ── GET /api/auth/me ──

func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	user, ok := authn.RequestUser(h.Users, w, r, authn.UserID(r))
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, UserToDTO(user))
}

// ── POST /api/auth/verify-email ──

func (h *Handlers) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	token, ok, _ := bodyString(body, "token")
	if !ok || token == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Token is required")
		return
	}
	if err := h.Auth.VerifyEmail(r.Context(), token); err != nil {
		if domain := auth.AsError(err); domain != nil {
			httpx.WriteError(w, http.StatusBadRequest, domain.Message)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Email verification failed")
		return
	}
	httpx.OKTrue(w)
}

// ── POST /api/auth/resend-verification ──

func (h *Handlers) ResendVerification(w http.ResponseWriter, r *http.Request) {
	err := h.Auth.ResendVerification(r.Context(), authn.UserID(r))
	if err == nil {
		httpx.OKTrue(w)
		return
	}
	domain := auth.AsError(err)
	if domain == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to resend verification email")
		return
	}
	switch domain.Code {
	case auth.ErrCodeEmailAlreadyVerified:
		httpx.WriteError(w, http.StatusBadRequest, domain.Message)
	case auth.ErrCodeResendRateLimited, auth.ErrCodeResendCooldown:
		httpx.WriteError(w, http.StatusTooManyRequests, domain.Message)
	case auth.ErrCodeUserNotFound:
		httpx.WriteInvalidToken(w)
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to resend verification email")
	}
}

// ── GET /api/auth/me/username-available ──

func (h *Handlers) UsernameAvailable(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if nameError := auth.ValidateName(name, "Username", auth.NameMinLengthUsers); nameError != "" {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "invalid", "message": nameError})
		return
	}
	if strings.HasPrefix(strings.ToLower(name), auth.ProfileSetupPlaceholderPrefix) || auth.IsReservedAgentName(name) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "reserved", "message": "This username is reserved. Choose another name."})
		return
	}
	available := h.Auth.UsernameAvailable(r.Context(), name)
	body := map[string]any{"available": available}
	if !available {
		body["reason"] = "taken"
		body["message"] = "This username is already taken."
	}
	httpx.WriteJSON(w, http.StatusOK, body)
}

// ── POST /api/auth/me/complete-profile ──

func (h *Handlers) CompleteProfile(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if issues := strictProfileIssues(body); len(issues) > 0 {
		httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid profile setup body", "PROFILE_SETUP_BODY_INVALID", issues)
		return
	}
	name, _, _ := bodyString(body, "name")
	displayName, _, _ := bodyString(body, "displayName")
	if nameError := auth.ValidateName(name, "Name", auth.NameMinLengthUsers); nameError != "" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "PROFILE_SETUP_NAME_INVALID", nameError)
		return
	}
	if strings.HasPrefix(strings.ToLower(name), auth.ProfileSetupPlaceholderPrefix) || auth.IsReservedAgentName(name) {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "PROFILE_SETUP_NAME_RESERVED", "This username is reserved. Choose another name.")
		return
	}
	user, err := h.Auth.CompleteProfile(r.Context(), authn.UserID(r), name, displayName)
	if err != nil {
		h.writeCompleteProfileError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, UserToDTO(user))
}

// strictProfileIssues enforces the legacy strict schema: exactly name +
// displayName, both non-empty strings, displayName <= 80 after trim.
func strictProfileIssues(body map[string]any) []httpx.Issue {
	var issues []httpx.Issue
	for key := range body {
		if key != "name" && key != "displayName" {
			issues = append(issues, httpx.Issue{Path: "", Message: "Unrecognized key(s) in object: '" + key + "'"})
		}
	}
	issues = append(issues, requireStringFields(body, "name")...)
	rawDisplay, present := body["displayName"]
	if present {
		s, ok := rawDisplay.(string)
		if !ok {
			issues = append(issues, httpx.Issue{Path: "displayName", Message: "Expected string, received " + jsonTypeName(rawDisplay)})
		} else if len(strings.TrimSpace(s)) < 1 {
			issues = append(issues, httpx.Issue{Path: "displayName", Message: "String must contain at least 1 character(s)"})
		} else if len(s) > 80 {
			issues = append(issues, httpx.Issue{Path: "displayName", Message: "String must contain at most 80 character(s)"})
		}
	} else {
		issues = append(issues, httpx.Issue{Path: "displayName", Message: "Required"})
	}
	return issues
}

func (h *Handlers) writeCompleteProfileError(w http.ResponseWriter, err error) {
	domain := auth.AsError(err)
	if domain == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to complete profile setup")
		return
	}
	switch domain.Code {
	case auth.ErrCodeProfileUserNotFound:
		httpx.WriteErrorCode(w, http.StatusUnauthorized, domain.Code, domain.Message)
	case auth.ErrCodeProfileNameInvalid:
		httpx.WriteErrorCode(w, http.StatusBadRequest, domain.Code, domain.Message)
	default: // reserved handled above; taken/already-completed are conflicts
		httpx.WriteErrorCode(w, http.StatusConflict, domain.Code, domain.Message)
	}
}

// ── POST /api/auth/logout ──

func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if refreshToken, ok, _ := bodyString(body, "refreshToken"); ok && refreshToken != "" {
		if _, err := h.Sessions.Logout(r.Context(), refreshToken); err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Logout failed")
			return
		}
	}
	httpx.OKTrue(w)
}

// ── POST /api/auth/forgot-password ──

func (h *Handlers) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	email, ok, _ := bodyString(body, "email")
	if !ok || email == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Email is required")
		return
	}
	// The service logs operational failures without exposing account existence.
	_ = h.Auth.RequestPasswordReset(r.Context(), email)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "If an account exists with that email, a reset link has been sent.",
	})
}

// ── POST /api/auth/reset-password ──

func (h *Handlers) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	token, tokenOK, _ := bodyString(body, "token")
	password, passwordOK, _ := bodyString(body, "password")
	if !tokenOK || token == "" || !passwordOK || password == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Token and password are required")
		return
	}
	if len(password) < 8 {
		httpx.WriteError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}
	if err := h.Auth.ResetPassword(r.Context(), token, password); err != nil {
		if domain := auth.AsError(err); domain != nil {
			httpx.WriteError(w, http.StatusBadRequest, domain.Message)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Password reset failed")
		return
	}
	httpx.OKTrue(w)
}

// ── POST /api/auth/me/timezone-observation ──

func (h *Handlers) TimezoneObservation(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	rawTimezone, present := body["timezone"]
	if !present {
		httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
			[]httpx.Issue{{Path: "timezone", Message: "Required"}})
		return
	}
	timezone, ok := rawTimezone.(string)
	if !ok {
		httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
			[]httpx.Issue{{Path: "timezone", Message: "Expected string, received " + jsonTypeName(rawTimezone)}})
		return
	}
	// Strict schema: no extra keys.
	for key := range body {
		if key != "timezone" {
			httpx.WriteErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
				[]httpx.Issue{{Path: "", Message: "Unrecognized key(s) in object: '" + key + "'"}})
			return
		}
	}
	canonical, err := auth.ParseCanonicalBrowserTimezone(timezone)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	obs, err := h.Auth.TimezoneObservation(r.Context(), authn.UserID(r), canonical)
	if err != nil {
		if domain := auth.AsError(err); domain != nil && domain.Code == auth.ErrCodeUserNotFound {
			httpx.WriteInvalidToken(w)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to record timezone observation")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"firstObservedTimezone":   obs.FirstObservedTimezone,
		"firstObservedTimezoneAt": FormatDateMS(obs.FirstObservedTimezoneAt),
		"lastObservedTimezone":    obs.LastObservedTimezone,
		"lastObservedTimezoneAt":  FormatDateMS(obs.LastObservedTimezoneAt),
	})
}

func clientIPOrNil(r *http.Request) *string {
	ip := clientIPValue(r)
	if ip == "" {
		return nil
	}
	return &ip
}

func clientIPValue(r *http.Request) string {
	host := r.RemoteAddr
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}

func headerOrNil(r *http.Request, name string) *string {
	value := r.Header.Get(name)
	if value == "" {
		return nil
	}
	return &value
}

var _ = time.Now
