// Human machine management on the workspace surface (routes/servers.ts):
//
//	POST   /api/servers/{id}/machines
//	PATCH  /api/servers/{id}/machines/{machineId}
//	DELETE /api/servers/{id}/machines/{machineId}
//	POST   /api/servers/{id}/machines/{machineId}/rotate-key
//
// This is the HUMAN management surface (R12): verified-profile gate, the
// shared /api/servers scope middleware and the role/capability policy from
// the TS handlers. It depends on the computer DOMAIN store only — it borrows
// no other HTTP handler type. Admission exchange (device authorize/token,
// attach, bootstrap login) and the sk_computer internal surface stay in
// computerapi. Guest denial matches the /:id/machines prefix middleware
// ("Guests cannot access server management data") and runs before capability
// checks; the collection GET/POST Allow list is owned by the parent; this
// file only adds the single-machine and rotate-key 405 fallbacks.
package humanapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

const (
	errRegisterMachine   = "Failed to register machine"
	errUpdateMachine     = "Failed to update machine"
	errDeleteMachine     = "Failed to delete machine"
	errRotateMachineKey  = "Failed to regenerate API key"
	errRegisterForbidden = "The `registerMachines` capability is required to register machines"
	errEditForbidden     = "The `editMachines` capability or machine creator authority is required to edit machines"
	errRemoveForbidden   = "The `removeMachines` capability or machine creator authority is required to remove machines"
	errRotateForbidden   = "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys"
	errGuestMachines     = "Guests cannot access server management data"
	errMachineMissing    = "Machine not found in this server"
	errServerMissing     = "Server not found"
)

// MachineHandlers carries the machine-management dependencies: the computer
// domain store (machines rows), the workspace scope middleware and the
// post-commit disconnect callback. Nil Scope keeps isolated tests fail-closed
// inside the handler.
type MachineHandlers struct {
	Store *computer.Store
	// Scope wraps the routes with the shared X-Server-Id middleware (the
	// parent passes ServersHandlers.RequireServerScope). Nil is legal:
	// handlers then resolve membership themselves and stay fail-closed.
	Scope func(http.HandlerFunc) http.HandlerFunc
	// DisconnectMachine is called with the machine id only after a key
	// rotation or machine deletion has committed. Nil is safe. The callback
	// never receives key material.
	DisconnectMachine func(machineID string)
}

// RegisterMachineRoutes mounts the workspace machine-management routes on
// the shared mux behind the verified-profile gate.
func RegisterMachineRoutes(mux *http.ServeMux, handlers *MachineHandlers, gate *authn.AuthGate) {
	machineGate := func(handler http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(handlers.guardMachineRoute(handler))
	}
	mux.Handle("POST /api/servers/{id}/machines", machineGate(handlers.RegisterMachineRoute))
	mux.Handle("PATCH /api/servers/{id}/machines/{machineId}", machineGate(handlers.UpdateMachineRoute))
	mux.Handle("DELETE /api/servers/{id}/machines/{machineId}", machineGate(handlers.DeleteMachineRoute))
	mux.Handle("/api/servers/{id}/machines/{machineId}", machineGate(handlers.machineMethodNotAllowed(http.MethodPatch, http.MethodDelete)))
	mux.Handle("POST /api/servers/{id}/machines/{machineId}/rotate-key", machineGate(handlers.RotateMachineKeyRoute))
	mux.Handle("/api/servers/{id}/machines/{machineId}/rotate-key", machineGate(handlers.machineMethodNotAllowed(http.MethodPost)))
}

// workspaceMemberRole resolves the caller's role inside the URL workspace.
// The shared scope middleware (when wired) already proved membership; this
// read is the same fact the TS handler fetches via getActorServerRoleInServer
// (non-member and deleted workspaces lose the role -> 404).
func (h *MachineHandlers) workspaceMemberRole(r *http.Request, workspaceID string) (string, error) {
	return h.Store.MemberRole(r.Context(), workspaceID, authn.UserID(r))
}

// guardMachineRoute applies the parent scope middleware when it is wired.
// A nil Scope keeps isolated tests fail-closed inside the handler.
func (h *MachineHandlers) guardMachineRoute(next http.HandlerFunc) http.HandlerFunc {
	if h != nil && h.Scope != nil {
		return h.Scope(next)
	}
	return next
}

// beginMachineManagement resolves the caller after the verified-profile and
// scope gates. Guests are refused for every method, including 405 fallbacks.
func (h *MachineHandlers) beginMachineManagement(w http.ResponseWriter, r *http.Request, infra string) (string, bool) {
	var role string
	if m := httpx.ScopeMembership(r); m != nil {
		role = m.Role
	} else {
		var err error
		role, err = h.workspaceMemberRole(r, r.PathValue("id"))
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, infra)
			return "", false
		}
		if role == "" {
			httpx.WriteError(w, http.StatusNotFound, errServerMissing)
			return "", false
		}
	}
	if role == "guest" {
		httpx.WriteError(w, http.StatusForbidden, errGuestMachines)
		return "", false
	}
	return role, true
}

func (h *MachineHandlers) disconnectMachine(machineID string) {
	if h != nil && h.DisconnectMachine != nil && machineID != "" {
		h.DisconnectMachine(machineID)
	}
}

func writeMachineFailure(w http.ResponseWriter, err error, infra, forbidden string) {
	switch {
	case errors.Is(err, computer.ErrMachineNotFound):
		httpx.WriteError(w, http.StatusNotFound, errMachineMissing)
	case errors.Is(err, computer.ErrNotAuthorized):
		httpx.WriteError(w, http.StatusNotFound, errServerMissing)
	case errors.Is(err, computer.ErrForbidden):
		httpx.WriteError(w, http.StatusForbidden, forbidden)
	default:
		var conflict *computer.MachineDeleteConflictError
		if errors.As(err, &conflict) {
			httpx.WriteErrorCode(w, http.StatusConflict, conflict.Code, conflict.Error())
			return
		}
		if infra == errDeleteMachine {
			httpx.WriteErrorCode(w, http.StatusInternalServerError, "machine_delete_failed", infra)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, infra)
	}
}

// RegisterMachineRoute implements POST /api/servers/{id}/machines.
// The response carries the read model plus the raw sk_machine_* key exactly
// once. The key is not logged.
func (h *MachineHandlers) RegisterMachineRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	role, ok := h.beginMachineManagement(w, r, errRegisterMachine)
	if !ok {
		return
	}
	if !computer.RoleHasMachineCapability(role, "registerMachines") {
		httpx.WriteError(w, http.StatusForbidden, errRegisterForbidden)
		return
	}
	var body struct {
		Name *string `json:"name"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if body.Name == nil || strings.TrimSpace(*body.Name) == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Name is required")
		return
	}
	registered, err := h.Store.RegisterMachine(r.Context(), workspaceID, authn.UserID(r), *body.Name)
	if err != nil {
		writeMachineFailure(w, err, errRegisterMachine, errRegisterForbidden)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"machine": registered.ReadModel,
		"apiKey":  registered.APIKey,
	})
}

// UpdateMachineRoute implements PATCH /api/servers/{id}/machines/{machineId}.
func (h *MachineHandlers) UpdateMachineRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	role, ok := h.beginMachineManagement(w, r, errUpdateMachine)
	if !ok {
		return
	}
	machineID := r.PathValue("machineId")
	owner, err := h.Store.MachineBinding(r.Context(), workspaceID, machineID)
	if err != nil {
		writeMachineFailure(w, err, errUpdateMachine, errEditForbidden)
		return
	}
	if owner != authn.UserID(r) && !computer.RoleHasMachineCapability(role, "editMachines") {
		httpx.WriteError(w, http.StatusForbidden, errEditForbidden)
		return
	}
	patch, ok := parseMachinePatch(w, r)
	if !ok {
		return
	}
	updated, err := h.Store.UpdateMachine(r.Context(), workspaceID, machineID, authn.UserID(r), patch)
	if err != nil {
		writeMachineFailure(w, err, errUpdateMachine, errEditForbidden)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, updated)
}

// DeleteMachineRoute implements DELETE /api/servers/{id}/machines/{machineId}.
// DisconnectMachine runs only after the delete transaction commits.
func (h *MachineHandlers) DeleteMachineRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	role, ok := h.beginMachineManagement(w, r, errDeleteMachine)
	if !ok {
		return
	}
	machineID := r.PathValue("machineId")
	owner, err := h.Store.MachineBinding(r.Context(), workspaceID, machineID)
	if err != nil {
		writeMachineFailure(w, err, errDeleteMachine, errRemoveForbidden)
		return
	}
	if owner != authn.UserID(r) && !computer.RoleHasMachineCapability(role, "removeMachines") {
		httpx.WriteError(w, http.StatusForbidden, errRemoveForbidden)
		return
	}
	if err := h.Store.DeleteMachine(r.Context(), workspaceID, machineID, authn.UserID(r)); err != nil {
		writeMachineFailure(w, err, errDeleteMachine, errRemoveForbidden)
		return
	}
	h.disconnectMachine(machineID)
	httpx.OKTrue(w)
}

// RotateMachineKeyRoute implements POST /api/servers/{id}/machines/{machineId}/rotate-key.
// DisconnectMachine runs only after the new verifier commits. The raw key is
// the response body and is not logged.
func (h *MachineHandlers) RotateMachineKeyRoute(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("id")
	role, ok := h.beginMachineManagement(w, r, errRotateMachineKey)
	if !ok {
		return
	}
	machineID := r.PathValue("machineId")
	if machineID == "" {
		httpx.WriteError(w, http.StatusNotFound, errMachineMissing)
		return
	}
	owner, err := h.Store.MachineBinding(r.Context(), workspaceID, machineID)
	if err != nil {
		writeMachineFailure(w, err, errRotateMachineKey, errRotateForbidden)
		return
	}
	if owner != authn.UserID(r) && !computer.RoleHasMachineCapability(role, "rotateMachineKeys") {
		httpx.WriteError(w, http.StatusForbidden, errRotateForbidden)
		return
	}
	apiKey, err := h.Store.RotateMachineKey(r.Context(), workspaceID, machineID, authn.UserID(r), role)
	if err != nil {
		writeMachineFailure(w, err, errRotateMachineKey, errRotateForbidden)
		return
	}
	h.disconnectMachine(machineID)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"apiKey": apiKey})
}

// machineMethodNotAllowed is the method-free fallback for one machine path.
// Identity, scope and the guest wall run before 405.
func (h *MachineHandlers) machineMethodNotAllowed(allow ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := h.beginMachineManagement(w, r, "Internal server error"); !ok {
			return
		}
		w.Header().Set("Allow", strings.Join(allow, ", "))
		httpx.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
	}
}

// parseMachinePatch matches the TS name/description checks, including absent
// vs null vs wrong JSON types and JavaScript UTF-16 string length. It writes
// the error response itself and returns false when the body is refused.
func parseMachinePatch(w http.ResponseWriter, r *http.Request) (computer.MachinePatch, bool) {
	var raw map[string]json.RawMessage
	if !httpx.DecodeJSONBody(w, r, &raw) {
		return computer.MachinePatch{}, false
	}
	var patch computer.MachinePatch
	nameRaw, nameSet := raw["name"]
	if nameSet {
		value, err := decodeJSONValue(nameRaw)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "Invalid JSON body")
			return computer.MachinePatch{}, false
		}
		text, isString := value.(string)
		if !isString {
			httpx.WriteError(w, http.StatusBadRequest, "Name is required")
			return computer.MachinePatch{}, false
		}
		trimmed := jsTrim(text)
		if trimmed == "" {
			httpx.WriteError(w, http.StatusBadRequest, "Name is required")
			return computer.MachinePatch{}, false
		}
		patch.Name = &trimmed
	}
	descRaw, descSet := raw["description"]
	if descSet {
		value, err := decodeJSONValue(descRaw)
		if err != nil {
			httpx.WriteError(w, http.StatusBadRequest, "Invalid JSON body")
			return computer.MachinePatch{}, false
		}
		if value != nil {
			text, isString := value.(string)
			if !isString {
				httpx.WriteError(w, http.StatusBadRequest, "Description must be a string")
				return computer.MachinePatch{}, false
			}
			trimmed := jsTrim(text)
			if computerUTF16Len(trimmed) > 500 {
				httpx.WriteError(w, http.StatusBadRequest, "Description must be 500 characters or less")
				return computer.MachinePatch{}, false
			}
			if trimmed != "" {
				patch.Description = &trimmed
			}
		}
		patch.DescriptionSet = true
	}
	if patch.Name == nil && !patch.DescriptionSet {
		httpx.WriteError(w, http.StatusBadRequest, "Name or description is required")
		return computer.MachinePatch{}, false
	}
	return patch, true
}

func decodeJSONValue(raw json.RawMessage) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

// jsTrim matches String.prototype.trim (WhiteSpace + LineTerminator).
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSTrimRune)
}

func isJSTrimRune(r rune) bool {
	switch r {
	case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\uFEFF', '\u2028', '\u2029':
		return true
	default:
		return unicode.Is(unicode.Zs, r)
	}
}

// computerUTF16Len is JavaScript string length: UTF-16 code units, so a surrogate
// pair counts as two.
func computerUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}
