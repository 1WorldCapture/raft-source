// Legacy-web auth routes: register/login/refresh/me/profile/verification/
// password-reset/logout, reproducing the TS server's request parsing, status
// codes and error bodies. Hardening divergences are commented inline and
// collected in the README.
package legacyweb

import (
	"net/http"
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
	Users    UserLookup
	Gate     *AuthGate
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
func requireStringFields(body map[string]any, fields ...string) []Issue {
	var issues []Issue
	for _, field := range fields {
		raw, present := body[field]
		if !present {
			issues = append(issues, Issue{Path: field, Message: "Required"})
			continue
		}
		s, ok := raw.(string)
		if !ok {
			issues = append(issues, Issue{Path: field, Message: "Expected string, received " + jsonTypeName(raw)})
			continue
		}
		if len(s) < 1 {
			issues = append(issues, Issue{Path: field, Message: "String must contain at least 1 character(s)"})
		}
	}
	return issues
}

// ── POST /api/auth/register ──

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	issues := requireStringFields(body, "email", "password")
	if rawName, present := body["name"]; present {
		if _, isString := rawName.(string); !isString {
			issues = append(issues, Issue{Path: "name", Message: "Expected string, received " + jsonTypeName(rawName)})
		}
	}
	if len(issues) > 0 {
		writeErrorIssues(w, http.StatusBadRequest, "Invalid email registration body", "email_register_body_invalid", issues)
		return
	}
	email, _, _ := bodyString(body, "email")
	password, _, _ := bodyString(body, "password")
	name, nameOK, _ := bodyString(body, "name")
	if nameOK && name != "" {
		if nameError := auth.ValidateName(name, "Name", auth.NameMinLengthUsers); nameError != "" {
			writeError(w, http.StatusBadRequest, nameError)
			return
		}
	}
	if len(password) < 8 {
		writeError(w, http.StatusBadRequest, "Password must be at least 8 characters")
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
		writeError(w, http.StatusInternalServerError, "Registration failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":         UserToDTO(user),
		"accessToken":  accessToken,
		"refreshToken": session.RefreshToken,
	})
}

func (h *Handlers) writeRegisterError(w http.ResponseWriter, err error) {
	domain := auth.AsError(err)
	if domain == nil {
		writeError(w, http.StatusInternalServerError, "Registration failed")
		return
	}
	switch domain.Code {
	case auth.ErrCodeLegalRequired:
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{
			"error": "LEGAL_ACCEPTANCE_REQUIRED",
			"legal": legalVersionsBody(),
		})
	case auth.ErrCodeTermsChanged:
		writeJSON(w, http.StatusConflict, errorBody{
			"error": "TERMS_CHANGED",
			"legal": legalVersionsBody(),
		})
	case auth.ErrCodeEmailRegistered:
		writeError(w, http.StatusConflict, "Email is already registered")
	case auth.ErrCodeUsernameTaken:
		writeErrorCode(w, http.StatusConflict, "AUTH_USERNAME_TAKEN", "Username is already taken")
	case auth.ErrCodeInvalidEmail, auth.ErrCodeInvalidPassword:
		writeError(w, http.StatusBadRequest, domain.Message)
	default:
		writeError(w, http.StatusInternalServerError, "Registration failed")
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
		writeErrorCode(w, http.StatusBadRequest, "platform_invalid", "platform must be web or mobile")
		return
	}
	// No OAuth providers are configured in the account phase; the honest
	// answer is an empty list, not a fabricated capability.
	writeJSON(w, http.StatusOK, map[string]any{"providers": []any{}})
}

// ── POST /api/auth/login ──

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	if issues := requireStringFields(body, "email", "password"); len(issues) > 0 {
		writeErrorIssues(w, http.StatusBadRequest, "Invalid email login body", "email_login_body_invalid", issues)
		return
	}
	email, _, _ := bodyString(body, "email")
	password, _, _ := bodyString(body, "password")
	user, session, err := h.Auth.Login(r.Context(), email, password)
	if err != nil {
		domain := auth.AsError(err)
		if domain != nil && domain.Code == auth.ErrCodeInvalidCredentials {
			writeErrorCode(w, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	accessToken, err := h.Signer.SignAccessToken(user.ID, session.FamilyID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Login failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":         UserToDTO(user),
		"accessToken":  accessToken,
		"refreshToken": session.RefreshToken,
	})
}

// ── POST /api/auth/refresh ──

func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	refreshToken, ok, _ := bodyString(body, "refreshToken")
	if !ok || refreshToken == "" {
		writeError(w, http.StatusBadRequest, "Refresh token is required")
		return
	}
	attemptHeader := r.Header.Get("X-Slock-Auth-Refresh-Attempt-Id")
	installationHeader := r.Header.Get("X-Slock-Auth-Installation-Id")
	attemptID := normalizeIfMatches(attemptHeader, attemptIDPattern)
	installationID := normalizeIfMatches(installationHeader, installationPattern)
	if installationHeader != "" && (attemptID == "" || installationID == "") {
		writeError(w, http.StatusBadRequest, "Invalid refresh replay binding")
		return
	}
	var binding *auth.RefreshBinding
	if attemptID != "" && installationID != "" {
		binding = &auth.RefreshBinding{AttemptID: attemptID, InstallationID: installationID}
	}
	outcome, err := h.Sessions.Refresh(r.Context(), refreshToken, binding)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Token refresh failed")
		return
	}
	if outcome == nil || outcome.Session == nil {
		writeError(w, http.StatusUnauthorized, "Invalid or expired refresh token")
		return
	}
	accessToken, err := h.Signer.SignAccessToken(outcome.Session.UserID, outcome.Session.FamilyID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Token refresh failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
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
	user, ok := requestUser(h.Users, w, r, userID(r))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, UserToDTO(user))
}

// ── POST /api/auth/verify-email ──

func (h *Handlers) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	token, ok, _ := bodyString(body, "token")
	if !ok || token == "" {
		writeError(w, http.StatusBadRequest, "Token is required")
		return
	}
	if err := h.Auth.VerifyEmail(r.Context(), token); err != nil {
		if domain := auth.AsError(err); domain != nil {
			writeError(w, http.StatusBadRequest, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Email verification failed")
		return
	}
	okTrue(w)
}

// ── POST /api/auth/resend-verification ──

func (h *Handlers) ResendVerification(w http.ResponseWriter, r *http.Request) {
	err := h.Auth.ResendVerification(r.Context(), userID(r))
	if err == nil {
		okTrue(w)
		return
	}
	domain := auth.AsError(err)
	if domain == nil {
		writeError(w, http.StatusInternalServerError, "Failed to resend verification email")
		return
	}
	switch domain.Code {
	case auth.ErrCodeEmailAlreadyVerified:
		writeError(w, http.StatusBadRequest, domain.Message)
	case auth.ErrCodeResendRateLimited, auth.ErrCodeResendCooldown:
		writeError(w, http.StatusTooManyRequests, domain.Message)
	case auth.ErrCodeUserNotFound:
		writeInvalidToken(w)
	default:
		writeError(w, http.StatusInternalServerError, "Failed to resend verification email")
	}
}

// ── GET /api/auth/me/username-available ──

func (h *Handlers) UsernameAvailable(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if nameError := auth.ValidateName(name, "Username", auth.NameMinLengthUsers); nameError != "" {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "invalid", "message": nameError})
		return
	}
	if strings.HasPrefix(strings.ToLower(name), auth.ProfileSetupPlaceholderPrefix) || auth.IsReservedAgentName(name) {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "reserved", "message": "This username is reserved. Choose another name."})
		return
	}
	available := h.Auth.UsernameAvailable(r.Context(), name)
	body := map[string]any{"available": available}
	if !available {
		body["reason"] = "taken"
		body["message"] = "This username is already taken."
	}
	writeJSON(w, http.StatusOK, body)
}

// ── POST /api/auth/me/complete-profile ──

func (h *Handlers) CompleteProfile(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if issues := strictProfileIssues(body); len(issues) > 0 {
		writeErrorIssues(w, http.StatusBadRequest, "Invalid profile setup body", "PROFILE_SETUP_BODY_INVALID", issues)
		return
	}
	name, _, _ := bodyString(body, "name")
	displayName, _, _ := bodyString(body, "displayName")
	if nameError := auth.ValidateName(name, "Name", auth.NameMinLengthUsers); nameError != "" {
		writeErrorCode(w, http.StatusBadRequest, "PROFILE_SETUP_NAME_INVALID", nameError)
		return
	}
	if strings.HasPrefix(strings.ToLower(name), auth.ProfileSetupPlaceholderPrefix) || auth.IsReservedAgentName(name) {
		writeErrorCode(w, http.StatusBadRequest, "PROFILE_SETUP_NAME_RESERVED", "This username is reserved. Choose another name.")
		return
	}
	user, err := h.Auth.CompleteProfile(r.Context(), userID(r), name, displayName)
	if err != nil {
		h.writeCompleteProfileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, UserToDTO(user))
}

// strictProfileIssues enforces the legacy strict schema: exactly name +
// displayName, both non-empty strings, displayName <= 80 after trim.
func strictProfileIssues(body map[string]any) []Issue {
	var issues []Issue
	for key := range body {
		if key != "name" && key != "displayName" {
			issues = append(issues, Issue{Path: "", Message: "Unrecognized key(s) in object: '" + key + "'"})
		}
	}
	issues = append(issues, requireStringFields(body, "name")...)
	rawDisplay, present := body["displayName"]
	if present {
		s, ok := rawDisplay.(string)
		if !ok {
			issues = append(issues, Issue{Path: "displayName", Message: "Expected string, received " + jsonTypeName(rawDisplay)})
		} else if len(strings.TrimSpace(s)) < 1 {
			issues = append(issues, Issue{Path: "displayName", Message: "String must contain at least 1 character(s)"})
		} else if len(s) > 80 {
			issues = append(issues, Issue{Path: "displayName", Message: "String must contain at most 80 character(s)"})
		}
	} else {
		issues = append(issues, Issue{Path: "displayName", Message: "Required"})
	}
	return issues
}

func (h *Handlers) writeCompleteProfileError(w http.ResponseWriter, err error) {
	domain := auth.AsError(err)
	if domain == nil {
		writeError(w, http.StatusInternalServerError, "Failed to complete profile setup")
		return
	}
	switch domain.Code {
	case auth.ErrCodeProfileUserNotFound:
		writeErrorCode(w, http.StatusUnauthorized, domain.Code, domain.Message)
	case auth.ErrCodeProfileNameInvalid:
		writeErrorCode(w, http.StatusBadRequest, domain.Code, domain.Message)
	default: // reserved handled above; taken/already-completed are conflicts
		writeErrorCode(w, http.StatusConflict, domain.Code, domain.Message)
	}
}

// ── POST /api/auth/logout ──

func (h *Handlers) Logout(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if refreshToken, ok, _ := bodyString(body, "refreshToken"); ok && refreshToken != "" {
		if _, err := h.Sessions.Logout(r.Context(), refreshToken); err != nil {
			writeError(w, http.StatusInternalServerError, "Logout failed")
			return
		}
	}
	okTrue(w)
}

// ── POST /api/auth/forgot-password ──

func (h *Handlers) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	email, ok, _ := bodyString(body, "email")
	if !ok || email == "" {
		writeError(w, http.StatusBadRequest, "Email is required")
		return
	}
	// The service logs operational failures without exposing account existence.
	_ = h.Auth.RequestPasswordReset(r.Context(), email)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "If an account exists with that email, a reset link has been sent.",
	})
}

// ── POST /api/auth/reset-password ──

func (h *Handlers) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	token, tokenOK, _ := bodyString(body, "token")
	password, passwordOK, _ := bodyString(body, "password")
	if !tokenOK || token == "" || !passwordOK || password == "" {
		writeError(w, http.StatusBadRequest, "Token and password are required")
		return
	}
	if len(password) < 8 {
		writeError(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}
	if err := h.Auth.ResetPassword(r.Context(), token, password); err != nil {
		if domain := auth.AsError(err); domain != nil {
			writeError(w, http.StatusBadRequest, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Password reset failed")
		return
	}
	okTrue(w)
}

// ── POST /api/auth/me/timezone-observation ──

func (h *Handlers) TimezoneObservation(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	rawTimezone, present := body["timezone"]
	if !present {
		writeErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
			[]Issue{{Path: "timezone", Message: "Required"}})
		return
	}
	timezone, ok := rawTimezone.(string)
	if !ok {
		writeErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
			[]Issue{{Path: "timezone", Message: "Expected string, received " + jsonTypeName(rawTimezone)}})
		return
	}
	// Strict schema: no extra keys.
	for key := range body {
		if key != "timezone" {
			writeErrorIssues(w, http.StatusBadRequest, "Invalid timezone observation body", "timezone_observation_body_invalid",
				[]Issue{{Path: "", Message: "Unrecognized key(s) in object: '" + key + "'"}})
			return
		}
	}
	canonical, err := auth.ParseCanonicalBrowserTimezone(timezone)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	obs, err := h.Auth.TimezoneObservation(r.Context(), userID(r), canonical)
	if err != nil {
		if domain := auth.AsError(err); domain != nil && domain.Code == auth.ErrCodeUserNotFound {
			writeInvalidToken(w)
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to record timezone observation")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
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
