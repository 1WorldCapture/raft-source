// /internal/computer/* control plane: the authFromRegistry-style dispatcher
// (fail-closed on unregistered sibling paths), the requireComputerAuth
// equivalent (sk_computer_* canonical, sk_machine_* phase-1 alias), and the
// side-effect-free preflight, all ported from middleware/authFromRegistry.ts,
// middleware/auth.ts (requireComputerAuth) and routes/internalComputer.ts.
package computerapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"sort"
	"strings"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/buildinfo"
)

// computerPrincipal echoes what requireComputerAuth proved for THIS request.
type computerPrincipal struct {
	Kind       string  `json:"kind"`
	ComputerID *string `json:"computerId"`
	ServerID   *string `json:"serverId"`
}

// internalComputer is the dispatcher for the claimed /internal/computer/
// prefix. Unregistered paths fail closed with 401
// auth_policy_unregistered_path BEFORE any handler runs.
func (h *ComputerHandlers) internalComputer(w http.ResponseWriter, r *http.Request) {
	// Strip the mount prefix; r.URL.Path starts with /internal/computer/.
	rel := strings.TrimPrefix(r.URL.Path, "/internal/computer")
	for _, entry := range h.InternalRoutes {
		if entry.Method == r.Method && internalPathMatches(rel, entry.Path) {
			// Registry says sk_computer; authenticate accordingly.
			principal, ok := h.requireComputerAuth(w, r)
			if !ok {
				return
			}
			h.serveInternalComputer(w, r, entry, principal)
			return
		}
	}
	httpx.WriteErrorCode(w, http.StatusUnauthorized, "auth_policy_unregistered_path", "Unregistered internal route")
}

// serveInternalComputer dispatches one authenticated registered route.
// M3 registers only preflight; sibling handlers (runners/...) belong to the
// AGENT slice and are appended by registering both the mux route and the
// registry entry (parent wiring), never by loosening this fail-close.
func (h *ComputerHandlers) serveInternalComputer(w http.ResponseWriter, r *http.Request, entry computer.InternalRouteEntry, principal computer.Principal) {
	if entry.Path != "/preflight" {
		// Defensive: a registry row without a handler in this build stays a
		// fail-closed miss, not a silent 200.
		httpx.WriteErrorCode(w, http.StatusUnauthorized, "auth_policy_unregistered_path", "Unregistered internal route")
		return
	}
	h.computerPreflight(w, r, principal)
}

// internalPathMatches compares the request path against a registry pattern
// with ":name" placeholder segments (authFromRegistry pathMatches).
func internalPathMatches(reqPath, pattern string) bool {
	reqSegs := nonEmptySegments(reqPath)
	patSegs := nonEmptySegments(pattern)
	if len(reqSegs) != len(patSegs) {
		return false
	}
	for i, pat := range patSegs {
		if strings.HasPrefix(pat, ":") {
			continue
		}
		if pat != reqSegs[i] {
			return false
		}
	}
	return true
}

func nonEmptySegments(path string) []string {
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// requireComputerAuth is the requireComputerAuth port for this surface:
//   - no bearer            -> 401 Missing computer credential
//   - sk_machine_* alias   -> legacy machine principal, exposed AS computer
//     (computerId = machineId, exactly like the TS alias)
//   - sk_daemon_*          -> wrong principal (alias is sk_machine_ only)
//   - anything else        -> 401 invalid_principal
//
// Best-effort last-use observability mirrors recordComputerUse.
func (h *ComputerHandlers) requireComputerAuth(w http.ResponseWriter, r *http.Request) (computer.Principal, bool) {
	return authenticateComputer(h.Store, w, r)
}

// authenticateComputer is the requireComputerAuth equivalent over the
// COMPUTER DOMAIN store: sk_computer_* canonical, sk_machine_* phase-1 alias.
// It is a shared package helper, not a handler-type method, so sibling
// surfaces (the runner API) authenticate through the domain fact owner
// instead of borrowing another HTTP handler (R12).
func authenticateComputer(store *computer.Store, w http.ResponseWriter, r *http.Request) (computer.Principal, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		httpx.WriteError(w, http.StatusUnauthorized, "Missing computer credential")
		return computer.Principal{}, false
	}
	key := strings.TrimPrefix(header, "Bearer ")

	if strings.HasPrefix(key, computer.MachineKeyPrefix) {
		principal, err := store.Authenticate(r.Context(), key)
		if err != nil {
			writeMachineAliasAuthError(w, err)
			return computer.Principal{}, false
		}
		// Preserve the actual proven identity for transaction revalidation.
		// The phase-1 Computer alias is only an outward DTO projection.
		return principal, true
	}

	if !computer.IsComputerAPIKey(key) {
		httpx.WriteErrorCode(w, http.StatusUnauthorized, "invalid_principal",
			"Invalid authentication: computer credential required")
		return computer.Principal{}, false
	}

	principal, err := store.Authenticate(r.Context(), key)
	if err != nil {
		if authErr := computer.AsAuthError(err); authErr != nil {
			if authErr.Reason == computer.ReasonServerNotFound {
				httpx.WriteError(w, http.StatusUnauthorized, "Server no longer exists")
				return computer.Principal{}, false
			}
			httpx.WriteError(w, http.StatusUnauthorized, "Invalid computer credential")
			return computer.Principal{}, false
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Authentication temporarily unavailable")
		return computer.Principal{}, false
	}
	// Best-effort observability; failure never affects the decision.
	store.RecordComputerUse(r.Context(), principal.ComputerID, httpx.ClientIPOf(r), r.Header.Get("User-Agent"))
	return principal, true
}

// writeMachineAliasAuthError maps legacy-machine denials for the alias path.
func writeMachineAliasAuthError(w http.ResponseWriter, err error) {
	authErr := computer.AsAuthError(err)
	if authErr == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Authentication temporarily unavailable")
		return
	}
	switch authErr.Reason {
	case computer.ReasonLegacyKeyMigrated:
		httpx.WriteErrorCode(w, http.StatusUnauthorized, computer.ReasonLegacyKeyMigrated,
			"Legacy machine key has been migrated to a Computer attachment")
	case computer.ReasonServerNotFound:
		httpx.WriteError(w, http.StatusUnauthorized, "Server no longer exists")
	default:
		httpx.WriteError(w, http.StatusUnauthorized, "Invalid computer credential")
	}
}

// computerPreflight implements POST /internal/computer/preflight: synthetic,
// READ-ONLY, side-effect-free. The response is derived LIVE from the
// injected registry so client and server cannot drift from a static list.
func (h *ComputerHandlers) computerPreflight(w http.ResponseWriter, r *http.Request, principal computer.Principal) {
	computerSurface := make([]map[string]any, 0, len(h.InternalRoutes))
	principals := map[string]bool{}
	for _, entry := range h.InternalRoutes {
		computerSurface = append(computerSurface, map[string]any{
			"method":    entry.Method,
			"path":      entry.Path,
			"principal": entry.Principal,
		})
		principals[entry.Principal] = true
	}
	registered := make([]string, 0, len(principals))
	for p := range principals {
		registered = append(registered, p)
	}
	sort.Strings(registered)

	claims := h.ClaimedPrefixes
	if claims == nil {
		claims = []string{"/internal/computer/"}
	}

	var serverSlug any
	if principal.WorkspaceID != "" {
		if slug, ok := h.Store.WorkspaceSlug(r.Context(), principal.WorkspaceID); ok {
			serverSlug = slug
		}
	}

	kind := principal.Kind
	computerID := principal.ComputerID
	if principal.Kind == computer.KindLegacyMachine {
		kind = computer.KindComputer
		computerID = principal.MachineID
	}
	serverID := principal.WorkspaceID
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":                   true,
		"serverSlug":           serverSlug,
		"surfaceVersion":       surfaceVersion(),
		"claimedPrefixes":      claims,
		"registeredPrincipals": registered,
		"computerSurface":      computerSurface,
		"principal": computerPrincipal{
			Kind:       kind,
			ComputerID: &computerID,
			ServerID:   &serverID,
		},
	})
}

// surfaceVersion derives the build identity the way this Go server reports
// it (TS uses SERVER_VERSION; the Go server has no release channel, so the
// stage+revision of THIS process is the honest value).
func surfaceVersion() string {
	info := buildinfo.Current()
	rev := info.Revision
	if len(rev) > 12 {
		rev = rev[:12]
	}
	return info.Stage + "+" + rev
}
