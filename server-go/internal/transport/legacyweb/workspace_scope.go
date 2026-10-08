// Workspace-scoped request guards (design §3.1 / R06): the X-Server-Id header
// must match the URL id, the caller must hold a real membership (deleted and
// joint_storage workspaces do not count), and guest roles are denied on the
// legacy management surfaces. Handlers never re-derive these facts: the scope
// middleware stashes the resolved membership so role checks reuse one read.
package legacyweb

import (
	"context"
	"net/http"

	"raft.local/server-go/internal/workspace"
)

// ctxScopeMembership holds the *workspace.Membership resolved by the scope
// middleware for the current request.
type ctxScopeMembershipKeyType struct{}

var ctxScopeMembership ctxScopeMembershipKeyType

// RequireServerScope mirrors the legacy requireServerMatchesParam middleware:
// missing header -> 400, header/URL mismatch -> 400, no eligible membership
// (non-member, deleted workspace, joint_storage) -> 403 with the legacy body.
// It must run after the verified+profile-complete auth gates.
func (h *ServersHandlers) RequireServerScope(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("X-Server-Id")
		if header == "" {
			writeError(w, http.StatusBadRequest, "Missing X-Server-Id header")
			return
		}
		id := r.PathValue("id")
		if header != id {
			writeError(w, http.StatusBadRequest, "X-Server-Id must match server id in URL")
			return
		}
		membership, err := h.Store.GetMembership(r.Context(), id, userID(r))
		if err != nil {
			if workspace.AsDomainError(err) != nil {
				// The only business answer here is the non-member 403; any
				// other code would be a domain contract drift, so surface it
				// verbatim rather than silently reinterpreting it.
				writeDomainError(w, err)
				return
			}
			// Infrastructure failures are never an authentication failure
			// (D07): report the legacy unhandled-error shape.
			writeErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
			return
		}
		ctx := context.WithValue(r.Context(), ctxScopeMembership, &membership)
		next(w, r.WithContext(ctx))
	}
}

// DenyGuests mirrors the legacy guestHiddenServerSurfaces middleware: guests
// keep minimal server identity but never reach settings, directories or
// setup-management surfaces, for every method on those paths. It must run
// after RequireServerScope (the role comes from that membership read).
func (h *ServersHandlers) DenyGuests(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if m := scopeMembership(r); m != nil && m.Role == workspace.RoleGuest {
			writeError(w, http.StatusForbidden, "Guests cannot access server management data")
			return
		}
		next(w, r)
	}
}

// scopeMembership returns the membership resolved by RequireServerScope, or
// nil when the handler was mounted without the scope middleware.
func scopeMembership(r *http.Request) *workspace.Membership {
	m, _ := r.Context().Value(ctxScopeMembership).(*workspace.Membership)
	return m
}

// scopeRole is the caller's real membership role ("" when unscoped).
func scopeRole(r *http.Request) string {
	if m := scopeMembership(r); m != nil {
		return m.Role
	}
	return ""
}

// writeDomainError maps a workspace DomainError to the legacy status/body:
// the generic codes keep the TS sentences as the {error:...} body. It returns
// false (and writes nothing) for non-business errors and unrecognized codes,
// so callers can apply their endpoint-specific 500 fallbacks.
func writeDomainError(w http.ResponseWriter, err error) bool {
	de := workspace.AsDomainError(err)
	if de == nil {
		return false
	}
	return writeDomainCode(w, de.Code, de.Message)
}

// writeDomainCode maps one domain error code to its legacy response shape.
func writeDomainCode(w http.ResponseWriter, code, message string) bool {
	switch code {
	case workspace.CodeInvalidInput:
		writeError(w, http.StatusBadRequest, message)
	case workspace.CodeForbidden:
		writeError(w, http.StatusForbidden, message)
	case workspace.CodeNotFound:
		writeError(w, http.StatusNotFound, message)
	case workspace.CodeConflict:
		writeError(w, http.StatusConflict, message)
	default:
		return false
	}
	return true
}

// setupErrorStatus maps the exact TS ServerSetupStateError codes (R09) to the
// legacy statuses; false means the code is not a setup machine code.
func setupErrorStatus(code string) (int, bool) {
	switch code {
	case workspace.CodeActorNotHuman, workspace.CodeCrossUserTransition, workspace.CodeInsufficientPermission:
		return http.StatusForbidden, true
	case workspace.CodeStateNotFound:
		return http.StatusNotFound, true
	case workspace.CodeOfficialOnboardingAgentNotUsable, workspace.CodeServerAlreadySetUp:
		return http.StatusConflict, true
	case workspace.CodeLiveFactsUnavailable:
		return http.StatusFailedDependency, true
	}
	return 0, false
}

// writeSetupDomainError answers setup endpoints: TS machine codes render as
// {"error": code} with the mapped status, the generic codes keep their
// legacy sentence bodies. False means "not a business error this endpoint
// recognizes" and the caller must use its endpoint-specific 500 fallback.
func writeSetupDomainError(w http.ResponseWriter, err error) bool {
	de := workspace.AsDomainError(err)
	if de == nil {
		return false
	}
	if status, ok := setupErrorStatus(de.Code); ok {
		writeError(w, status, de.Code)
		return true
	}
	return writeDomainCode(w, de.Code, de.Message)
}
