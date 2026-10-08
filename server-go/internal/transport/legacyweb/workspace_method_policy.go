package legacyweb

import (
	"net/http"
	"strings"
)

// registerWorkspaceMethodFallbacks extends the existing M1 explicit 405/Allow
// policy to M2 while still running identity, scope and guest checks first.
// Method-specific ServeMux registrations win over these method-free fallbacks.
func registerWorkspaceMethodFallbacks(mux *http.ServeMux, servers *ServersHandlers, gate func(http.HandlerFunc) http.Handler, readstateEnabled bool) {
	reject := func(methods ...string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Allow", strings.Join(methods, ", "))
			writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	}
	mux.Handle("/api/servers", gate(reject(http.MethodGet, http.MethodPost)))
	// A separate method-free literal /order registration would conflict with
	// GET /{id} in Go's specificity rules. Resolve the user-scoped literal here
	// instead; it never becomes a workspace or requires X-Server-Id.
	mux.Handle("/api/servers/{id}", gate(func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "order" {
			reject(http.MethodGet, http.MethodPatch)(w, r)
			return
		}
		if readstateEnabled && r.PathValue("id") == "unread-summary" {
			reject(http.MethodGet)(w, r)
			return
		}
		servers.RequireServerScope(reject(http.MethodGet, http.MethodPatch))(w, r)
	}))
	for _, spec := range []struct {
		path       string
		methods    []string
		denyGuests bool
	}{
		{"avatar", []string{http.MethodPost}, false},
		{"members", []string{http.MethodGet}, false},
		{"settings", []string{http.MethodGet}, true},
		{"onboarding-settings", []string{http.MethodGet, http.MethodPatch}, true},
		{"setup-projection", []string{http.MethodGet}, true},
		{"setup-transition", []string{http.MethodPost}, false},
		{"setup-reset", []string{http.MethodPost}, false},
		{"setup-handoff", []string{http.MethodPost}, false},
		{"sidebar-order", []string{http.MethodGet}, false},
		{"machines", []string{http.MethodGet}, true},
		{"join-links", []string{http.MethodGet, http.MethodPost}, true},
		{"invites", []string{http.MethodGet, http.MethodPost}, true},
	} {
		handler := reject(spec.methods...)
		if spec.denyGuests {
			handler = servers.DenyGuests(handler)
		}
		mux.Handle("/api/servers/{id}/"+spec.path, gate(servers.RequireServerScope(handler)))
	}
	for _, nested := range []struct {
		path    string
		methods []string
	}{
		{"join-links/{linkId}", []string{http.MethodDelete}},
		{"invites/{inviteId}", []string{http.MethodDelete}},
	} {
		mux.Handle("/api/servers/{id}/"+nested.path,
			gate(servers.RequireServerScope(servers.DenyGuests(reject(nested.methods...)))))
	}
}
