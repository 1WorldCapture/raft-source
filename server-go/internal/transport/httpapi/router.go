// Package httpapi is the single HTTP surface assembly: it builds the router
// from the identity-scoped leaf adapters (humanapi / agentapi / computerapi),
// the Socket.IO transport and the daemon endpoint, and owns the honest
// 404/405/501 policy for unknown and not-yet-implemented surfaces. No route
// is registered twice and no leaf reaches back into this package.
package httpapi

import (
	"net/http"
	"strings"

	"raft.local/server-go/internal/transport/httpapi/agentapi"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/computerapi"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
)

// Config names every leaf's handler set plus the two non-JSON transports.
// All fields are required at assembly except where documented; nil is a
// construction error, never a silent stage fallback.
type Config struct {
	Gate *authn.AuthGate

	// Human account + workspace surfaces.
	Account    *humanapi.Handlers
	Servers    *humanapi.ServersHandlers
	Invites    *humanapi.InviteHandlers
	Avatars    *humanapi.AvatarHandlers
	RateLimits humanapi.RateLimits

	// Human chat surfaces.
	Channels     *humanapi.ChannelHandlers
	Conversation *humanapi.ConversationHandlers
	Messages     *humanapi.MessageHandlers
	Readstate    *humanapi.ReadstateHandlers

	// Human management of agents and the runtime catalog.
	Agents   *humanapi.AgentHandlers
	Catalog  *humanapi.RuntimeCatalogHandlers
	AgentAPI *agentapi.Handlers

	// Human machine management on the workspace surface.
	Machines *humanapi.MachineHandlers

	// Computer identity: admission exchange, internal control plane and the
	// runner API.
	Computers *computerapi.ComputerHandlers
	Runners   *computerapi.RunnerHandlers

	// Daemon is the /daemon/connect machine WebSocket transport.
	Daemon http.Handler

	// SocketIO owns the actual Engine.IO/Socket.IO HTTP upgrade surface.
	SocketIO http.Handler
}

// New builds the full handler: leaf routes, middleware and the fallback
// policy. It performs no I/O.
func New(cfg Config) http.Handler {
	if cfg.Gate == nil {
		panic("httpapi: Gate is required")
	}
	mux := http.NewServeMux()

	humanapi.RegisterAccountRoutes(mux, cfg.Account, cfg.Invites, cfg.Avatars, cfg.Gate, cfg.RateLimits)
	humanapi.RegisterServerRoutes(mux, cfg.Servers, cfg.Invites, cfg.Gate)
	mux.HandleFunc("GET /api/avatars/users/{file}", cfg.Avatars.Serve)
	mux.HandleFunc("GET /api/avatars/servers/{file}", cfg.Avatars.ServeServer)

	humanapi.RegisterChannelRoutes(mux, cfg.Channels, cfg.Gate)
	humanapi.RegisterConversationRoutes(mux, cfg.Conversation, cfg.Gate)
	humanapi.RegisterMessageRoutes(mux, cfg.Messages, cfg.Gate)
	humanapi.RegisterReadstateRoutes(mux, cfg.Readstate, cfg.Gate)

	humanapi.RegisterAgentRoutes(mux, cfg.Agents, cfg.Gate)
	agentapi.RegisterRoutes(mux, cfg.AgentAPI)
	humanapi.RegisterRuntimeCatalogRoutes(mux, cfg.Catalog, cfg.Gate)
	humanapi.RegisterMachineRoutes(mux, cfg.Machines, cfg.Gate)

	computerapi.RegisterRoutes(mux, cfg.Computers, cfg.Gate)
	computerapi.RegisterRunnerRoutes(mux, cfg.Runners)
	mux.Handle("GET /daemon/connect", cfg.Daemon)

	// Explicitly unsupported surfaces (no fake success).
	if cfg.SocketIO != nil {
		mux.Handle("/socket.io/", cfg.SocketIO)
	} else {
		mux.HandleFunc("/socket.io/", httpx.NotImplemented("Socket.IO realtime transport is not enabled in this server stage"))
	}
	mux.HandleFunc("/internal/", httpx.NotImplemented("Agent and machine APIs are not implemented in the account phase"))
	mux.HandleFunc("/daemon/", httpx.NotImplemented("Daemon protocol is not implemented in the account phase"))

	// Fallback policy for everything else.
	mux.HandleFunc("/", fallback)
	return mux
}

// apiRoutes describes known /api routes whose unknown-method answers are a
// 405 with an Allow header rather than the generic 404.
var apiRoutes = []struct {
	pattern string
	methods []string
}{
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
	// Workspace routes answer 405 through the workspace method fallbacks
	// (auth/scope/guest gates run first), so no dynamic specs are needed
	// here.
}

func fallback(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if !strings.HasPrefix(path, "/api/") {
		httpx.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	trimmed := strings.TrimSuffix(path, "/")
	if trimmed == "" {
		trimmed = path
	}
	for _, spec := range apiRoutes {
		if spec.pattern == trimmed {
			allow := strings.Join(spec.methods, ", ")
			w.Header().Set("Allow", allow)
			httpx.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
	}
	if strings.HasPrefix(path, "/api/auth/") {
		// Unknown auth subroute: explicit unsupported, not a generic miss.
		httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
			"This auth capability is not implemented in the account phase")
		return
	}
	httpx.WriteError(w, http.StatusNotFound, "Not found")
}
