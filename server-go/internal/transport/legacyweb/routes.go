// Route assembly for the legacy-web surface, including the honest 404/405/501
// policy: no generic 200 fallbacks, unsupported surfaces say so explicitly.
package legacyweb

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"raft.local/server-go/internal/platform/ratelimit"
)

// Deps carries everything the transport needs.
type Deps struct {
	Handlers *Handlers
	Servers  *ServersHandlers
	Avatars  *AvatarHandlers
	Logger   interface{ Info(string, ...any) } // satisfied by *slog.Logger via adapter below

	AuthRatePerMinute         int
	LoginAccountRatePerMinute int
	RegisterRatePerHour       int
	ForgotPasswordRatePerHour int
}

// router describes known /api routes for 405 handling.
type routeSpec struct {
	pattern string
	methods []string
}

func apiRoutes() []routeSpec {
	return []routeSpec{
		{"/api/auth/providers", []string{http.MethodGet}},
		{"/api/auth/register", []string{http.MethodPost}},
		{"/api/auth/login", []string{http.MethodPost}},
		{"/api/auth/refresh", []string{http.MethodPost}},
		{"/api/auth/logout", []string{http.MethodPost}},
		{"/api/auth/verify-email", []string{http.MethodPost}},
		{"/api/auth/resend-verification", []string{http.MethodPost}},
		{"/api/auth/forgot-password", []string{http.MethodPost}},
		{"/api/auth/reset-password", []string{http.MethodPost}},
		{"/api/auth/me", []string{http.MethodGet, http.MethodPatch}},
		{"/api/auth/me/avatar", []string{http.MethodPost}},
		{"/api/auth/me/complete-profile", []string{http.MethodPost}},
		{"/api/auth/me/username-available", []string{http.MethodGet}},
		{"/api/auth/me/timezone-observation", []string{http.MethodPost}},
		{"/api/servers", []string{http.MethodGet, http.MethodPost}},
	}
}

// New builds the full handler with middleware, routes and fallback policy.
func New(deps Deps) http.Handler {
	h := deps.Handlers
	mux := http.NewServeMux()

	authPerMinute := deps.AuthRatePerMinute
	if authPerMinute <= 0 {
		authPerMinute = 200
	}
	generalAuth := ratelimit.Middleware{
		Limiter: ratelimit.New(authPerMinute, minute),
		KeyFn:   func(r *http.Request) string { return "ip:" + ratelimit.ClientIP(r) },
	}

	registerLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(deps.RegisterRatePerHour, 20), hour),
		KeyFn:   func(r *http.Request) string { return "reg-ip:" + ratelimit.ClientIP(r) },
	}
	loginAccountLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(deps.LoginAccountRatePerMinute, 10), minute),
		KeyFn:   loginAccountKey, // derived from the capped body, never a spoofable header
	}
	forgotLimiter := ratelimit.Middleware{
		Limiter: ratelimit.New(orDefault(deps.ForgotPasswordRatePerHour, 5), hour),
		KeyFn:   func(r *http.Request) string { return "forgot-ip:" + ratelimit.ClientIP(r) },
		OnLimit: func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusTooManyRequests, "Too many password reset requests. Please try again later.")
		},
	}

	// Public, general-auth-limited endpoints.
	auth := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, generalAuth.Wrap(handler))
	}

	auth("GET /api/auth/providers", h.Providers)
	mux.Handle("POST /api/auth/register", registerLimiter.Wrap(generalAuth.Wrap(http.HandlerFunc(h.Register))))
	mux.Handle("POST /api/auth/login", generalAuth.Wrap(loginAccountLimiter.Wrap(http.HandlerFunc(h.Login))))
	auth("POST /api/auth/refresh", h.Refresh)
	auth("POST /api/auth/logout", h.Logout)
	auth("POST /api/auth/verify-email", h.VerifyEmail)

	// Authenticated endpoints.
	mux.Handle("POST /api/auth/resend-verification", generalAuth.Wrap(h.Gate.Require(h.ResendVerification)))
	mux.Handle("GET /api/auth/me", generalAuth.Wrap(h.Gate.Require(h.Me)))
	mux.Handle("PATCH /api/auth/me", generalAuth.Wrap(h.Gate.Require(h.UpdateProfile)))
	mux.Handle("POST /api/auth/me/avatar", generalAuth.Wrap(h.Gate.Require(deps.Avatars.Upload)))
	mux.Handle("POST /api/auth/me/complete-profile", generalAuth.Wrap(h.Gate.Require(h.CompleteProfile)))
	mux.Handle("GET /api/auth/me/username-available", generalAuth.Wrap(h.Gate.Require(h.UsernameAvailable)))
	mux.Handle("POST /api/auth/me/timezone-observation", generalAuth.Wrap(h.Gate.Require(h.TimezoneObservation)))

	mux.Handle("POST /api/auth/forgot-password", forgotLimiter.Wrap(generalAuth.Wrap(http.HandlerFunc(h.ForgotPassword))))
	auth("POST /api/auth/reset-password", h.ResetPassword)

	mux.Handle("GET /api/servers", generalAuth.Wrap(h.Gate.RequireVerifiedProfileComplete(deps.Servers.List)))
	mux.Handle("POST /api/servers", generalAuth.Wrap(h.Gate.RequireVerifiedProfileComplete(deps.Servers.CreateWorkspace)))

	mux.HandleFunc("GET /api/avatars/users/{file}", deps.Avatars.Serve)

	// Explicitly unsupported surfaces (no fake success).
	mux.HandleFunc("/socket.io/", notImplemented("Socket.IO realtime transport is not implemented in the account phase"))
	mux.HandleFunc("/internal/", notImplemented("Agent and machine APIs are not implemented in the account phase"))
	mux.HandleFunc("/daemon/", notImplemented("Daemon protocol is not implemented in the account phase"))

	// Fallback policy for everything else.
	mux.HandleFunc("/", fallback)

	return mux
}

const (
	minute = time.Minute
	hour   = time.Hour
)

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
	buffered, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodyBytes+1))
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

func notImplemented(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", message)
	}
}

func fallback(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if !strings.HasPrefix(path, "/api/") {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	trimmed := strings.TrimSuffix(path, "/")
	if trimmed == "" {
		trimmed = path
	}
	for _, spec := range apiRoutes() {
		if spec.pattern == trimmed {
			allow := strings.Join(spec.methods, ", ")
			w.Header().Set("Allow", allow)
			writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
	}
	if strings.HasPrefix(path, "/api/auth/") {
		// Unknown auth subroute: explicit unsupported, not a generic miss.
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
			"This auth capability is not implemented in the account phase")
		return
	}
	writeError(w, http.StatusNotFound, "Not found")
}
