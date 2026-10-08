// M3B computer admission HTTP surface: registration entrypoint, shared
// handler struct and the SessionIssuer adapter. Behavior is ported from the
// TS routes listed in docs/m3-computer-contract.md; wire names, status codes
// and error bodies stay byte-identical.
package legacyweb

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/ratelimit"
)

// SessionIssuer issues the normal user session after a device grant is
// consumed (TS deviceAuth.ts token phase: sessionService.createSession +
// signAccessToken).
type SessionIssuer interface {
	CreateSession(ctx context.Context, userID string) (*auth.IssuedSession, error)
	SignAccessToken(userID, familyID string) (string, error)
}

// SessionServices adapts the real auth services to SessionIssuer.
type SessionServices struct {
	Sessions *auth.SessionService
	Signer   *auth.TokenSigner
}

// CreateSession implements SessionIssuer.
func (s SessionServices) CreateSession(ctx context.Context, userID string) (*auth.IssuedSession, error) {
	return s.Sessions.CreateSession(ctx, userID)
}

// SignAccessToken implements SessionIssuer.
func (s SessionServices) SignAccessToken(userID, familyID string) (string, error) {
	return s.Signer.SignAccessToken(userID, familyID)
}

// ComputerHandlers carries every dependency of the admission surface. All
// fields are wired by the parent (see docs/m3-computer-contract.md §3).
type ComputerHandlers struct {
	Store *computer.Store

	// Sessions issues the user session on device-token success. Required
	// for the device surface; nil fails that one route closed.
	Sessions SessionIssuer

	// VerificationBaseURL is the web origin for the approve page
	// (<base>/login/device[?user_code=...]). nil -> authorize answers 503
	// DEVICE_LOGIN_URL_UNAVAILABLE, like an unconfigured TS app URL.
	VerificationBaseURL *url.URL

	// DeviceLoginEnabled is the SLOCK_DEVICE_LOGIN_ENABLED equivalent
	// (defaults to true in TS; the parent decides the configured value).
	DeviceLoginEnabled bool

	// AgentBootstrapEnabled is the SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED
	// equivalent. TS default is disabled (#1836 unpublished surface).
	AgentBootstrapEnabled bool

	// AgentBootstrap consumes bootstrap tokens; implemented by the AGENT
	// worker's credential service. nil while enabled -> honest 503.
	AgentBootstrap computer.AgentBootstrapExchanger

	// Scope wraps the workspace-scoped machine routes with the shared
	// X-Server-Id middleware (parent passes ServersHandlers.RequireServerScope).
	// nil is legal: handlers then resolve membership themselves and stay
	// fail-closed. Isolated tests may leave it nil.
	Scope func(http.HandlerFunc) http.HandlerFunc

	// DisconnectMachine is called with the machine id only after a key
	// rotation or machine deletion has committed. Nil is safe. Parent wires
	// machinews.Hub.Disconnect. The callback never receives key material.
	DisconnectMachine func(machineID string)

	// InternalRoutes is the /internal/* registry this process actually
	// mounts (preflight reflects it; see docs §2.8).
	InternalRoutes []computer.InternalRouteEntry

	// ClaimedPrefixes defaults to ["/internal/computer/"].
	ClaimedPrefixes []string

	// RatePerMinute caps the per-IP limiter for the public surfaces
	// (0 -> 200, mirroring the TS authLimiter default).
	RatePerMinute int
}

// InternalRouteEntry is one row of the internal-surface registry.
type internalRouteEntry = computer.InternalRouteEntry

// RegisterComputerRoutes mounts every admission route on the shared mux.
// Parent wiring: call from legacyweb.New once the ComputerHandlers are built.
func RegisterComputerRoutes(mux *http.ServeMux, handlers *ComputerHandlers, gate *AuthGate) {
	perMinute := handlers.RatePerMinute
	if perMinute <= 0 {
		perMinute = 200
	}
	limited := func(handler http.HandlerFunc) http.Handler {
		return ratelimit.Middleware{
			Limiter: ratelimit.New(perMinute, time.Minute),
			KeyFn:   func(r *http.Request) string { return "ip:" + ratelimit.ClientIP(r) },
		}.Wrap(handler)
	}

	// Device-code user login grant (public + the one USER-authed phase).
	mux.Handle("POST /api/auth/device/authorize", limited(handlers.DeviceAuthorize))
	mux.Handle("POST /api/auth/device/approve", limited(gate.Require(handlers.DeviceApprove)))
	mux.Handle("POST /api/auth/device/token", limited(handlers.DeviceToken))

	// Computer attach + legacy roster (user-authed, flag-gated 404 inside).
	mux.Handle("POST /api/computer/attach", limited(gate.Require(handlers.ComputerAttach)))
	mux.Handle("GET /api/computer/legacy-machines", limited(gate.Require(handlers.ComputerLegacyMachines)))

	// Agent bootstrap login (public; bootstrapToken is the only credential).
	mux.Handle("POST /api/agent/login", limited(handlers.AgentLogin))

	// Workspace machine management sits behind the same verified+profile gate
	// as the rest of /api/servers, then the parent scope middleware. Public
	// device/attach/login routes above keep gate.Require (or no user gate).
	// Nil Scope and nil DisconnectMachine stay legal for isolated tests.
	// The machines collection Allow list (GET, and this POST) is not given a
	// method-free fallback here; the parent owns that registration.
	machineGate := func(handler http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(handlers.guardMachineRoute(handler))
	}
	mux.Handle("POST /api/servers/{id}/machines", machineGate(handlers.RegisterMachineRoute))
	mux.Handle("PATCH /api/servers/{id}/machines/{machineId}", machineGate(handlers.UpdateMachineRoute))
	mux.Handle("DELETE /api/servers/{id}/machines/{machineId}", machineGate(handlers.DeleteMachineRoute))
	mux.Handle("/api/servers/{id}/machines/{machineId}", machineGate(handlers.machineMethodNotAllowed(http.MethodPatch, http.MethodDelete)))
	mux.Handle("POST /api/servers/{id}/machines/{machineId}/rotate-key", machineGate(handlers.RotateMachineKeyRoute))
	mux.Handle("/api/servers/{id}/machines/{machineId}/rotate-key", machineGate(handlers.machineMethodNotAllowed(http.MethodPost)))

	// Internal computer control plane: dispatcher fail-closes every
	// unregistered sibling path (authFromRegistry contract).
	mux.Handle("/internal/computer/", http.HandlerFunc(handlers.internalComputer))
}
