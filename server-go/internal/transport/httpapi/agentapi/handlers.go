// The sk_agent_* internal API: whoami plus the agent-key reads (server
// directory, channel roster), the M5 Agent CLI messaging surface
// (send/v2-send, events/claim/ack, history, resolve-channel) and the
// fail-closed answer for every later /internal/agent-api path. A user JWT
// never succeeds here; the only accepted principal is a live agent
// credential checked against the agent store on every request, and the M5
// use cases revalidate credentials and permissions inside their own
// transactions.
package agentapi

import (
	"errors"
	"net/http"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

// Handlers carries the sk_agent_* API dependencies: the agent store owns
// credential lookup, revocation and the directory projections; the M5 ports
// (send/targets/history/events) are wired through NewHandlers and are
// immutable afterwards. An unwired family keeps its deferred 501 answer —
// never a fake success.
type Handlers struct {
	Store *agent.Store

	send    SendAgentPort
	targets WritableTargetPort
	history AgentHistoryPort
	events  AgentEventsPort
}

// NewHandlers validates and freezes the M5 wiring. The store is required;
// every port is optional per family, except that Send requires Targets (a
// send surface without target-DSL resolution cannot serve the CLI contract).
// Fields are unexported after construction so a live handler cannot be
// rewired.
func NewHandlers(store *agent.Store, deps Dependencies) (*Handlers, error) {
	if store == nil {
		return nil, errors.New("agentapi: agent store is required")
	}
	if deps.Send != nil && deps.Targets == nil {
		return nil, errors.New("agentapi: send port requires the writable-target port")
	}
	return &Handlers{
		Store:   store,
		send:    deps.Send,
		targets: deps.Targets,
		history: deps.History,
		events:  deps.Events,
	}, nil
}

// RegisterRoutes mounts the internal agent-key surface. These endpoints
// authenticate the Bearer sk_agent_* credential themselves (per-request
// against the store); they never accept a human session and are therefore
// NOT wrapped in the human auth gate.
//
// The M5 exact method routes are registered only when their port is wired;
// otherwise the path stays on the deferred family answer (auth, then 501).
// Each wired path also registers a method-less fallback: Go's method-specific
// patterns win for the exact method, so the fallback answers every OTHER
// method on an implemented route with 405 + Allow — behind the same agent
// proof and capability gates — instead of the misleading family 501. The
// identity-family fallback semantics (unknown family 401, deferred family
// auth-then-501) are untouched, and an unwired family never registers either
// pattern.
func RegisterRoutes(mux *http.ServeMux, handlers *Handlers) {
	mux.Handle("GET /internal/agent-api", http.HandlerFunc(handlers.Whoami))
	mux.Handle("GET /internal/agent-api/{$}", http.HandlerFunc(handlers.Whoami))
	mux.Handle("/internal/agent-api", http.HandlerFunc(handlers.UnregisteredAgentAPI))
	mux.Handle("GET /internal/agent-api/server", http.HandlerFunc(handlers.ServerInfo))
	mux.Handle("GET /internal/agent-api/channel-members", http.HandlerFunc(handlers.ChannelMembers))
	if handlers.send != nil && handlers.targets != nil {
		mux.Handle("POST /internal/agent-api/send", http.HandlerFunc(handlers.MessageSend))
		mux.Handle("POST /internal/agent-api/v2/send", http.HandlerFunc(handlers.MessageSendV2))
		mux.Handle("POST /internal/agent-api/resolve-channel", http.HandlerFunc(handlers.ResolveChannel))
		mux.Handle("/internal/agent-api/send", handlers.methodNotAllowed("send", "POST"))
		mux.Handle("/internal/agent-api/v2/send", handlers.methodNotAllowed("send", "POST"))
		mux.Handle("/internal/agent-api/resolve-channel", handlers.methodNotAllowed("send", "POST"))
	}
	if handlers.events != nil {
		mux.Handle("GET /internal/agent-api/events", http.HandlerFunc(handlers.Events))
		mux.Handle("GET /internal/agent-api/events/claim", http.HandlerFunc(handlers.EventsClaim))
		mux.Handle("POST /internal/agent-api/events/ack", http.HandlerFunc(handlers.EventsAck))
		mux.Handle("/internal/agent-api/events", handlers.methodNotAllowed("read", "GET"))
		mux.Handle("/internal/agent-api/events/claim", handlers.methodNotAllowed("read", "GET"))
		mux.Handle("/internal/agent-api/events/ack", handlers.methodNotAllowed("read", "POST"))
	}
	if handlers.history != nil {
		mux.Handle("GET /internal/agent-api/history", http.HandlerFunc(handlers.History))
		mux.Handle("/internal/agent-api/history", handlers.methodNotAllowed("read", "GET"))
	}
	mux.Handle("/internal/agent-api/{rest...}", http.HandlerFunc(handlers.DeferredAgentAPI))
}

// methodNotAllowed answers a wrong-method request on an IMPLEMENTED M5 route.
// The agent credential and the route capability gate run first (401/403/501
// capability answers win over 405), then the response names the one correct
// method in both the Allow header and the body.
func (h *Handlers) methodNotAllowed(capability, allow string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lookup, _, _, ok := h.bindAgentCredential(w, r)
		if !ok {
			return
		}
		if !h.requireAgentCapability(w, r, lookup.Scopes, capability) {
			return
		}
		w.Header().Set("Allow", allow)
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSON(w, http.StatusMethodNotAllowed, httpx.ErrorBody{
			"error": "Method not allowed",
			"code":  "method_not_allowed",
			"allow": allow,
		})
	})
}

// Whoami handles GET /internal/agent-api and GET /internal/agent-api/.
func (h *Handlers) Whoami(w http.ResponseWriter, r *http.Request) {
	lookup, loaded, role, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	scopes := lookup.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	roleName := ""
	if role != nil {
		roleName = *role
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"agentId":            lookup.AgentID,
		"agentName":          loaded.Name,
		"agentDisplayName":   httpx.NullableString(loaded.DisplayName),
		"serverId":           lookup.WorkspaceID,
		"serverRole":         role,
		"serverCapabilities": agent.ServerCapabilities(roleName),
		"credentialId":       lookup.CredentialID,
		"scopes":             scopes,
	})
}
