package humanapi

import (
	"net/http"

	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/workspace"
)

// RequireAgreementManagement preserves the original agreement surface's
// owner/admin policy even while the capability is unavailable. Authentication,
// workspace scoping and the guest guard must run before this wrapper. An
// unsupported capability must not replace a real authorization failure.
func (h *ServersHandlers) RequireAgreementManagement(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role := scopeRole(r)
		if role != workspace.RoleOwner && role != workspace.RoleAdmin {
			httpx.WriteError(w, http.StatusForbidden, "Only server owners and admins can manage the pre-join agreement")
			return
		}
		next(w, r)
	}
}
