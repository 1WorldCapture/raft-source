package humanapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"raft.local/server-go/internal/platform/ratelimit"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

// RateLimits carries the four auth-surface throttles from configuration;
// zero values fall back to the documented defaults.
type RateLimits struct {
	AuthPerMinute         int
	LoginAccountPerMinute int
	RegisterPerHour       int
	ForgotPasswordPerHour int
}

// RegisterAccountRoutes mounts the public/account surface: providers,
// register/login/refresh/logout, email verification, password reset, the
// authenticated me/profile endpoints, the invitation accept surface and the
// avatar uploads. Identity policy is per route: the token-exchange and
// public endpoints take no session; the me-surface keeps the
// verified/profile-complete chain.
func RegisterAccountRoutes(mux *http.ServeMux, h *Handlers, invites *InviteHandlers, avatars *AvatarHandlers, gate *authn.AuthGate, limits RateLimits) {
	authPerMinute := limits.AuthPerMinute
	if authPerMinute <= 0 {
		authPerMinute = 200
	}
	generalAuth := ratelimit.Middleware{
		Limiter: ratelimit.New(authPerMinute, time.Minute),
		KeyFn:   func(r *http.Request) string { return "ip:" + ratelimit.ClientIP(r) },
	}

	registerLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(limits.RegisterPerHour, 20), time.Hour),
		KeyFn:   func(r *http.Request) string { return "reg-ip:" + ratelimit.ClientIP(r) },
	}
	loginAccountLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(limits.LoginAccountPerMinute, 10), time.Minute),
		KeyFn:   loginAccountKey, // derived from the capped body, never a spoofable header
	}
	forgotLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(limits.ForgotPasswordPerHour, 5), time.Hour),
		KeyFn:   func(r *http.Request) string { return "forgot-ip:" + ratelimit.ClientIP(r) },
		OnLimit: func(w http.ResponseWriter, _ *http.Request) {
			httpx.WriteError(w, http.StatusTooManyRequests, "Too many password reset requests. Please try again later.")
		},
	}

	auth := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, generalAuth.Wrap(handler))
	}

	auth("GET /api/auth/providers", h.Providers)
	mux.Handle("POST /api/auth/register", registerLimiter.Wrap(generalAuth.Wrap(http.HandlerFunc(h.Register))))
	mux.Handle("POST /api/auth/login", generalAuth.Wrap(loginAccountLimiter.Wrap(http.HandlerFunc(h.Login))))
	auth("POST /api/auth/refresh", h.Refresh)
	auth("POST /api/auth/logout", h.Logout)
	auth("POST /api/auth/verify-email", h.VerifyEmail)

	mux.Handle("POST /api/auth/resend-verification", generalAuth.Wrap(gate.Require(h.ResendVerification)))
	mux.Handle("GET /api/auth/me", generalAuth.Wrap(gate.Require(h.Me)))
	mux.Handle("PATCH /api/auth/me", generalAuth.Wrap(gate.Require(h.UpdateProfile)))
	mux.Handle("POST /api/auth/me/avatar", generalAuth.Wrap(gate.Require(avatars.Upload)))
	mux.Handle("POST /api/auth/me/complete-profile", generalAuth.Wrap(gate.Require(h.CompleteProfile)))
	mux.Handle("GET /api/auth/me/username-available", generalAuth.Wrap(gate.Require(h.UsernameAvailable)))
	mux.Handle("POST /api/auth/me/timezone-observation", generalAuth.Wrap(gate.Require(h.TimezoneObservation)))

	mux.Handle("POST /api/auth/forgot-password", forgotLimiter.Wrap(generalAuth.Wrap(http.HandlerFunc(h.ForgotPassword))))
	auth("POST /api/auth/reset-password", h.ResetPassword)

	// Invitation accept surface: the preview is public (the token itself is
	// the capability, exactly like the TS route); accepting requires the full
	// verified+profile-complete identity chain.
	if invites != nil {
		auth("GET /api/auth/invite-info", invites.InviteInfo)
		mux.Handle("POST /api/auth/accept-invite", generalAuth.Wrap(gate.RequireVerifiedProfileComplete(invites.AcceptInvite)))
	}
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// loginAccountKey extracts the per-account login throttle key by buffering
// the (small, capped) request body and restoring it for the handler. Bodies
// that do not parse simply do not get an account key.
func loginAccountKey(r *http.Request) string {
	if r.Method != http.MethodPost || r.Body == nil {
		return ""
	}
	buffered, err := io.ReadAll(io.LimitReader(r.Body, httpx.MaxJSONBodyBytes+1))
	r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(buffered))
	if err != nil {
		return ""
	}
	var body struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(buffered, &body) != nil || strings.TrimSpace(body.Email) == "" {
		return ""
	}
	return "acct:" + strings.ToLower(strings.TrimSpace(body.Email))
}
