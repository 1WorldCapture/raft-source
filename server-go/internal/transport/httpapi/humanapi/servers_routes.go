package humanapi

import (
	"net/http"

	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

// RegisterServerRoutes mounts the workspace surface. Every route sits behind
// the verified+complete auth gates, exactly like the legacy /api/servers
// mount; workspace-scoped {id} routes add the scope middleware and the
// management surfaces additionally deny guests for every method on those
// paths. The user-scoped unread-summary surface is always mounted (the
// readstate slice owns it); there is no stage toggle anymore.
func RegisterServerRoutes(mux *http.ServeMux, servers *ServersHandlers, invites *InviteHandlers, gate *authn.AuthGate) {
	gateWrap := func(handler http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(handler)
	}
	// User-scoped routes (no X-Server-Id; a foreign header never changes the
	// acting user). Registered before/alongside the {id} patterns; the exact
	// literal "/api/servers/order" outranks "/api/servers/{id}".
	mux.Handle("GET /api/servers", gateWrap(servers.List))
	mux.Handle("POST /api/servers", gateWrap(servers.Create))
	// Original Computer ServersClient requests this exact trailing-slash
	// path. An exact {$} alias avoids both redirects and wildcard ID capture.
	mux.Handle("GET /api/servers/{$}", gateWrap(servers.List))
	mux.Handle("POST /api/servers/{$}", gateWrap(servers.Create))
	mux.Handle("/api/servers/{$}", gateWrap(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "GET, POST")
		httpx.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
	}))
	mux.Handle("GET /api/servers/order", gateWrap(servers.GetOrder))
	mux.Handle("PATCH /api/servers/order", gateWrap(servers.UpdateOrder))
	RegisterReservedWorkspaceRoutes(mux, gateWrap)

	// Workspace-scoped routes: X-Server-Id must match the URL id and the
	// caller must be a real member; management surfaces additionally deny
	// guests for every method on those paths.
	scope := servers.RequireServerScope
	guestFree := servers.DenyGuests
	mux.Handle("GET /api/servers/{id}", gateWrap(scope(servers.GetWorkspace)))
	mux.Handle("PATCH /api/servers/{id}", gateWrap(scope(servers.UpdateWorkspace)))
	mux.Handle("POST /api/servers/{id}/avatar", gateWrap(scope(servers.UploadWorkspaceAvatar)))
	mux.Handle("GET /api/servers/{id}/members", gateWrap(scope(servers.Members)))
	mux.Handle("GET /api/servers/{id}/settings", gateWrap(scope(guestFree(servers.GetSettings))))
	mux.Handle("GET /api/servers/{id}/onboarding-settings", gateWrap(scope(guestFree(servers.GetOnboardingSettings))))
	mux.Handle("PATCH /api/servers/{id}/onboarding-settings", gateWrap(scope(guestFree(servers.PatchOnboardingSettings))))
	mux.Handle("GET /api/servers/{id}/setup-projection", gateWrap(scope(guestFree(servers.SetupProjection))))
	mux.Handle("POST /api/servers/{id}/setup-transition", gateWrap(scope(servers.SetupTransition)))
	mux.Handle("POST /api/servers/{id}/setup-reset", gateWrap(scope(servers.SetupReset)))
	mux.Handle("POST /api/servers/{id}/setup-handoff", gateWrap(scope(servers.SetupHandoff)))
	mux.Handle("GET /api/servers/{id}/sidebar-order", gateWrap(scope(servers.SidebarOrder)))
	mux.Handle("GET /api/servers/{id}/machines", gateWrap(scope(guestFree(servers.Machines))))
	if invites != nil {
		// Join links and email invites are legacy guest-hidden management
		// surfaces (TS guestHiddenServerSurfaces lists both).
		mux.Handle("GET /api/servers/{id}/join-links", gateWrap(scope(guestFree(invites.ListJoinLinks))))
		mux.Handle("POST /api/servers/{id}/join-links", gateWrap(scope(guestFree(invites.CreateJoinLink))))
		mux.Handle("DELETE /api/servers/{id}/join-links/{linkId}", gateWrap(scope(guestFree(invites.RevokeJoinLink))))
		mux.Handle("GET /api/servers/{id}/invites", gateWrap(scope(guestFree(invites.ListInvites))))
		mux.Handle("POST /api/servers/{id}/invites", gateWrap(scope(guestFree(invites.CreateInvite))))
		mux.Handle("DELETE /api/servers/{id}/invites/{inviteId}", gateWrap(scope(guestFree(invites.RevokeInvite))))
	}
	mux.Handle("GET /api/servers/{id}/agent-overview", gateWrap(scope(guestFree(httpx.NotImplemented("Office overview is not enabled in this server stage")))))
	RegisterWorkspaceMethodFallbacks(mux, servers, gateWrap)
}
