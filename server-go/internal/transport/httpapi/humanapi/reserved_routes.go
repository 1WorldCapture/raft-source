package humanapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

// These are real user-scoped names in the frozen TS server router, not UUID
// workspace identifiers. Keep unsupported reads explicit instead of routing
// the browser's polling request into the X-Server-Id validation for /{id}.
// This does NOT reserve workspace slugs: a workspace with such a slug still
// has a UUID id and remains accessible through its normal list/detail paths.
func deferredWorkspaceUserRoute(id string) bool {
	return id == "unread-summary" || id == "join-community"
}

func deferredWorkspaceUserResponse(w http.ResponseWriter, r *http.Request) {
	httpx.WriteErrorCode(w, http.StatusNotFound, "feature_not_implemented", "This user-scoped workspace capability is not implemented")
}

func RegisterReservedWorkspaceRoutes(mux *http.ServeMux, gate func(http.HandlerFunc) http.Handler) {
	// PATCH /servers/{id} is itself method-specific, so a method-free
	// fallback cannot prevent it swallowing this literal. Register the
	// unsupported verbs at the exact user-level path before dispatch.
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodPut, http.MethodOptions} {
		mux.Handle(method+" /api/servers/unread-summary", gate(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", http.MethodGet)
			httpx.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}))
	}
	mux.Handle("POST /api/servers/join-community", gate(deferredWorkspaceUserResponse))
}
