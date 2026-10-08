// Computer attach + legacy machine roster HTTP layer, ported from
// routes/computerAttach.ts and routes/computerLegacyMachines.ts.
package legacyweb

import (
	"errors"
	"net/http"

	"raft.local/server-go/internal/computer"
)

// ComputerAttach implements POST /api/computer/attach (USER-authenticated;
// issues the raw sk_computer_* exactly once).
func (h *ComputerHandlers) ComputerAttach(w http.ResponseWriter, r *http.Request) {
	if !h.DeviceLoginEnabled {
		writeErrorCode(w, http.StatusNotFound, "computer_attach_disabled", "Computer attach is not enabled")
		return
	}
	var body struct {
		ServerSlug *string `json:"serverSlug"`
		Name       *string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.ServerSlug == nil || *body.ServerSlug == "" {
		writeErrorCode(w, http.StatusBadRequest, "server_slug_required", "serverSlug is required")
		return
	}
	name := "raft-computer"
	if body.Name != nil {
		if *body.Name == "" || len(*body.Name) > 200 {
			writeErrorCode(w, http.StatusBadRequest, "name_invalid", "name must be a non-empty string up to 200 chars")
			return
		}
		name = *body.Name
	}

	result, err := h.Store.AttachComputer(r.Context(), userID(r), *body.ServerSlug, name)
	var attachErr *computer.AttachError
	if errors.As(err, &attachErr) {
		switch attachErr.Code {
		case computer.AttachNameCollision:
			writeErrorCode(w, http.StatusConflict, "COMPUTER_NAME_COLLISION",
				"A Computer with this display name already exists on this server")
		case computer.AttachRequiresAdmin:
			writeErrorCode(w, http.StatusForbidden, attachErr.Code,
				"Attaching a Computer requires the admin or owner role on this server")
		default:
			// Uniform 403: non-member / missing / deleted server collapse
			// (no existence enumeration).
			writeErrorCode(w, http.StatusForbidden, attachErr.Code,
				"Not authorized to attach a Computer to this server")
		}
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to attach Computer")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"apiKey":          result.APIKey,
		"serverMachineId": result.ServerMachineID,
		"machineId":       result.MachineID,
		"serverId":        result.WorkspaceID,
		"serverSlug":      result.ServerSlug,
		"resumed":         result.Resumed,
	})
}

// ComputerLegacyMachines implements GET /api/computer/legacy-machines.
func (h *ComputerHandlers) ComputerLegacyMachines(w http.ResponseWriter, r *http.Request) {
	if !h.DeviceLoginEnabled {
		writeErrorCode(w, http.StatusNotFound, "computer_legacy_roster_disabled", "Computer legacy roster is not enabled")
		return
	}
	serverSlug := r.URL.Query().Get("serverSlug")
	if serverSlug == "" {
		writeErrorCode(w, http.StatusBadRequest, "server_slug_required", "serverSlug is required")
		return
	}
	includeAll := false
	switch r.URL.Query().Get("includeAll") {
	case "1", "true":
		includeAll = true
	}
	entries, err := h.Store.ListLegacyMachineRoster(r.Context(), userID(r), serverSlug, includeAll)
	if errors.Is(err, computer.ErrNotAuthorized) {
		writeErrorCode(w, http.StatusForbidden, "not_authorized",
			"Not authorized to list legacy machines for this server")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list legacy machines")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}
