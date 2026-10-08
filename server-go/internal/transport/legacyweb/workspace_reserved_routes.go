package legacyweb

import "net/http"

// These are real user-scoped names in the frozen TS server router, not UUID
// workspace identifiers. Keep unsupported reads explicit instead of routing
// the browser's polling request into the X-Server-Id validation for /{id}.
// This does NOT reserve workspace slugs: a workspace with such a slug still
// has a UUID id and remains accessible through its normal list/detail paths.
func deferredWorkspaceUserRoute(id string) bool {
	return id == "unread-summary" || id == "join-community"
}

func deferredWorkspaceUserResponse(w http.ResponseWriter, r *http.Request) {
	writeErrorCode(w, http.StatusNotFound, "feature_not_implemented", "This user-scoped workspace capability is not implemented")
}

func registerReservedWorkspaceRoutes(mux *http.ServeMux, gate func(http.HandlerFunc) http.Handler) {
	mux.Handle("GET /api/servers/unread-summary", gate(deferredWorkspaceUserResponse))
	mux.Handle("POST /api/servers/join-community", gate(deferredWorkspaceUserResponse))
}
