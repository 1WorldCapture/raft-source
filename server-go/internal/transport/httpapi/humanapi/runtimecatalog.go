package humanapi

import (
	"context"
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/runtimecatalog"
)

// RuntimeCatalogHandlers serves the Web Agent runtime picker: new-agent and
// existing-agent options, versioned create forms, model detection and
// runtime rescan. Parent wires RegisterRuntimeCatalogRoutes.
type RuntimeCatalogHandlers struct {
	Store  *runtimecatalog.Store
	Broker *runtimecatalog.Broker
	// Policy overrides the C0 missing-flag evaluation. Nil keeps grok and
	// omp disabled.
	Policy func(ctx context.Context, workspaceID, userID string) runtimecatalog.Policy
}

// RegisterRuntimeCatalogRoutes mounts the runtime-catalog surface behind the
// verified profile gate. Handlers enforce X-Server-Id, membership and the
// guest denials themselves so a mount without extra scope middleware still
// fails closed.
func RegisterRuntimeCatalogRoutes(mux *http.ServeMux, handlers *RuntimeCatalogHandlers, gate *authn.AuthGate) {
	if handlers == nil {
		handlers = &RuntimeCatalogHandlers{}
	}
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		if gate == nil {
			return func(w http.ResponseWriter, _ *http.Request) {
				httpx.WriteErrorCode(w, http.StatusUnauthorized, "auth_required", "Missing or invalid Authorization header")
			}
		}
		return gate.RequireVerifiedProfileComplete(next)
	}
	mux.Handle("GET /api/servers/{id}/machines/{machineId}/runtime-options", auth(handlers.MachineRuntimeOptions))
	mux.Handle("GET /api/servers/{id}/machines/{machineId}/runtime-form-definitions/{runtimeId}", auth(handlers.RuntimeFormDefinition))
	mux.Handle("GET /api/servers/{id}/machines/{machineId}/runtime-form-definitions/{runtimeId}/option-sources/{sourceId}", auth(handlers.RuntimeFormOptionSource))
	mux.Handle("GET /api/servers/{id}/machines/{machineId}/runtime-models/{runtime}", auth(handlers.RuntimeModels))
	mux.Handle("POST /api/servers/{id}/machines/{machineId}/runtimes/rescan", auth(handlers.RescanRuntimes))
	mux.Handle("GET /api/agents/{id}/runtime-options", auth(handlers.AgentRuntimeOptions))
}

func (h *RuntimeCatalogHandlers) policy(ctx context.Context, workspaceID, userID string) runtimecatalog.Policy {
	if h.Policy == nil {
		return runtimecatalog.C0Policy()
	}
	return h.Policy(ctx, workspaceID, userID)
}

func (h *RuntimeCatalogHandlers) MachineRuntimeOptions(w http.ResponseWriter, r *http.Request) {
	machine, ok := h.permitMachine(w, r, "Failed to load runtime options", "The `editMachines` capability or machine creator authority is required to inspect runtime options", "Computer not found")
	if !ok {
		return
	}
	installed, ok := reportedRuntimes(machine)
	if !ok {
		return
	}
	id := machine.ID
	httpx.WriteJSON(w, http.StatusOK, runtimecatalog.SelectionCatalog{
		Context:   runtimecatalog.ContextNewAgent,
		MachineID: &id,
		Options:   runtimecatalog.ProjectNewAgentRuntimeOptions(installed, h.policy(r.Context(), machine.WorkspaceID, authn.UserID(r))),
	})
}

func (h *RuntimeCatalogHandlers) AgentRuntimeOptions(w http.ResponseWriter, r *http.Request) {
	workspaceID, role, ok := h.permitAgent(w, r)
	if !ok {
		return
	}
	if !agent.HasServerCapability(role, "viewAgents") {
		httpx.WriteError(w, http.StatusForbidden, "The `viewAgents` capability is required to inspect runtime options")
		return
	}
	if h.Store == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime options")
		return
	}
	loaded, err := h.Store.Agent(r.Context(), r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime options")
		return
	}
	if loaded == nil || loaded.WorkspaceID != workspaceID {
		httpx.WriteError(w, http.StatusNotFound, "Agent not found")
		return
	}
	var machineID *string
	var installed []string
	if loaded.MachineID != nil {
		machine, err := h.Store.Machine(r.Context(), *loaded.MachineID)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime options")
			return
		}
		if machine != nil && machine.WorkspaceID == workspaceID {
			id := machine.ID
			machineID = &id
			if machine.RuntimesReported {
				installed = machine.RuntimeIDs
			}
		}
	}
	httpx.WriteJSON(w, http.StatusOK, runtimecatalog.SelectionCatalog{
		Context:   runtimecatalog.ContextExistingAgent,
		MachineID: machineID,
		Options:   runtimecatalog.ProjectExistingAgentRuntimeOptions(installed, loaded.Runtime, h.policy(r.Context(), workspaceID, authn.UserID(r))),
	})
}

func (h *RuntimeCatalogHandlers) RuntimeFormDefinition(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.permitMachine(w, r, "Failed to load runtime form definition", "The `editMachines` capability or machine creator authority is required to inspect runtime form definitions", "Computer not found"); !ok {
		return
	}
	runtimeID := r.PathValue("runtimeId")
	schema, definition, issues, status := formDefinition(runtimeID, r.URL.Query().Get("schemaVersion"))
	if status != 0 {
		if issues != nil {
			httpx.WriteJSON(w, status, map[string]any{"error": schema, "issues": issues})
			return
		}
		httpx.WriteError(w, status, schema)
		return
	}
	if drift := definitionDrift(runtimeID); len(drift) > 0 {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": "Runtime form projection drift", "issues": drift})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, definition)
}

func (h *RuntimeCatalogHandlers) RuntimeFormOptionSource(w http.ResponseWriter, r *http.Request) {
	machine, ok := h.permitMachine(w, r, "Failed to load runtime form option source", "The `editMachines` capability or machine creator authority is required to inspect runtime form option sources", "Computer not found")
	if !ok {
		return
	}
	runtimeID := r.PathValue("runtimeId")
	if runtimeID != "builtin" && runtimeID != "kimi-sdk" {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{
			"error":  "Runtime form option source not found",
			"issues": []runtimecatalog.Issue{{Code: "unknown_form_runtime", Pointer: "/runtimeId"}},
		})
		return
	}
	want := runtimecatalog.BuiltinPiFormSchemaVersion
	if runtimeID == "kimi-sdk" {
		want = runtimecatalog.KimiSDKFormSchemaVersion
	}
	if r.URL.Query().Get("schemaVersion") != want {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":  "Runtime form schema is stale or unknown",
			"issues": []runtimecatalog.Issue{{Code: "stale_form_schema", Pointer: "/schemaVersion"}},
		})
		return
	}
	sourceID := r.PathValue("sourceId")
	if runtimeID == "builtin" {
		h.builtinOptionSource(w, r, machine, sourceID)
		return
	}
	h.kimiOptionSource(w, r, machine, sourceID)
}

func (h *RuntimeCatalogHandlers) builtinOptionSource(w http.ResponseWriter, r *http.Request, machine *runtimecatalog.Machine, sourceID string) {
	if !h.computerOnline(machine.ID) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":    "The target Computer's Built-in model catalog is unavailable",
			"code":     "builtin_catalog_unavailable",
			"recovery": "retry",
		})
		return
	}
	outcome, err := h.Broker.DetectModels(r.Context(), runtimecatalog.Target{
		MachineID:   machine.ID,
		WorkspaceID: machine.WorkspaceID,
	}, "builtin")
	if err != nil {
		if errors.Is(err, runtimecatalog.ErrStale) {
			httpx.WriteJSON(w, http.StatusConflict, map[string]any{
				"error":    "The target Computer connection changed after its model catalog was validated. Retry against the current Computer connection.",
				"code":     "builtin_catalog_stale",
				"recovery": "retry",
			})
			return
		}
		writeCatalogFailure(w, machine, "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.", "builtin_catalog_unavailable", "retry")
		return
	}
	supported, catalogErr := runtimecatalog.RequireBuiltinCatalog(outcome, machine.ID, machine.DaemonVersion, machine.ComputerVersion)
	if catalogErr != nil {
		writeCatalogFailure(w, machine, catalogErr.Message, catalogErr.Code, catalogErr.Recovery)
		return
	}
	unfiltered, ok := runtimecatalog.BuildBuiltinPiFormOptionSource(sourceID)
	if !ok {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{
			"error":  "Runtime form option source not found",
			"issues": []runtimecatalog.Issue{{Code: "unknown_option_source", Pointer: "/sourceId"}},
		})
		return
	}
	if drift := runtimecatalog.ValidateBuiltinPiDefinitionProjection(); len(drift) > 0 {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": "Runtime form projection drift", "issues": drift})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, runtimecatalog.FilterBuiltinPiFormOptionSource(unfiltered, supported))
}

func (h *RuntimeCatalogHandlers) kimiOptionSource(w http.ResponseWriter, r *http.Request, machine *runtimecatalog.Machine, sourceID string) {
	if sourceID != "model" {
		httpx.WriteJSON(w, http.StatusNotFound, map[string]any{
			"error":  "Runtime form option source not found",
			"issues": []runtimecatalog.Issue{{Code: "unknown_option_source", Pointer: "/sourceId"}},
		})
		return
	}
	if !h.computerOnline(machine.ID) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "Computer is offline",
			"issues": []runtimecatalog.Issue{{
				Code:    "runtime_model_source_unavailable",
				Pointer: "/optionSources/model",
			}},
		})
		return
	}
	outcome, err := h.Broker.DetectModels(r.Context(), runtimecatalog.Target{
		MachineID:   machine.ID,
		WorkspaceID: machine.WorkspaceID,
	}, "kimi-sdk")
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime form option source")
		return
	}
	if outcome.Kind != "live" || outcome.Value == nil {
		kind := outcome.Kind
		if kind == "" {
			kind = "error"
		}
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error": "Kimi model source is unavailable",
			"issues": []runtimecatalog.Issue{{
				Code:    "runtime_model_source_" + kind,
				Pointer: "/optionSources/model",
			}},
		})
		return
	}
	if drift := runtimecatalog.ValidateKimiSDKDefinitionProjection(); len(drift) > 0 {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]any{"error": "Runtime form projection drift", "issues": drift})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, runtimecatalog.BuildKimiSDKFormOptionSource(outcome.Value.Models, outcome.Value.Default))
}

func (h *RuntimeCatalogHandlers) RuntimeModels(w http.ResponseWriter, r *http.Request) {
	machine, ok := h.permitMachine(w, r, "Failed to load runtime models", "The `editMachines` capability or machine creator authority is required to inspect runtime models", "Machine not found in this server")
	if !ok {
		return
	}
	runtime := r.PathValue("runtime")
	if runtime == "" || len(runtime) > 128 || strings.ContainsRune(runtime, 0) {
		writeModelFailure(w)
		return
	}
	if h.Broker == nil || !h.computerOnline(machine.ID) {
		writeModelFailure(w)
		return
	}
	outcome, err := h.Broker.DetectModels(r.Context(), runtimecatalog.Target{
		MachineID:   machine.ID,
		WorkspaceID: machine.WorkspaceID,
	}, runtime)
	if err != nil {
		writeModelFailure(w)
		return
	}
	writeModelOutcome(w, outcome)
}

func (h *RuntimeCatalogHandlers) RescanRuntimes(w http.ResponseWriter, r *http.Request) {
	machine, ok := h.permitMachine(w, r, "Failed to request a runtime rescan", "The `editMachines` capability or machine creator authority is required to rescan runtimes", "Computer not found")
	if !ok {
		return
	}
	if h.Broker == nil {
		httpx.WriteError(w, http.StatusConflict, "Computer is offline")
		return
	}
	if err := h.Broker.Rescan(r.Context(), machine.ID); err != nil {
		if errors.Is(err, runtimecatalog.ErrOffline) || errors.Is(err, runtimecatalog.ErrMiswired) {
			httpx.WriteError(w, http.StatusConflict, "Computer is offline")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to request a runtime rescan")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"requested": true})
}

func (h *RuntimeCatalogHandlers) computerOnline(machineID string) bool {
	return h.Broker != nil && h.Broker.Online(machineID)
}

func (h *RuntimeCatalogHandlers) permitMachine(w http.ResponseWriter, r *http.Request, failure, forbidden, missing string) (*runtimecatalog.Machine, bool) {
	workspaceID := r.PathValue("id")
	if !scopeHeader(w, r, workspaceID) {
		return nil, false
	}
	if h.Store == nil {
		httpx.WriteError(w, http.StatusInternalServerError, failure)
		return nil, false
	}
	role, err := h.Store.MemberRole(r.Context(), workspaceID, authn.UserID(r))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, failure)
		return nil, false
	}
	if role == "" {
		httpx.WriteError(w, http.StatusForbidden, "Not a member of this server")
		return nil, false
	}
	if role == agent.RoleGuest {
		httpx.WriteError(w, http.StatusForbidden, "Guests cannot access server management data")
		return nil, false
	}
	machine, err := h.Store.Machine(r.Context(), r.PathValue("machineId"))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, failure)
		return nil, false
	}
	if machine == nil || machine.WorkspaceID != workspaceID {
		httpx.WriteError(w, http.StatusNotFound, missing)
		return nil, false
	}
	if machine.UserID != authn.UserID(r) && !agent.HasServerCapability(role, "editMachines") {
		httpx.WriteError(w, http.StatusForbidden, forbidden)
		return nil, false
	}
	return machine, true
}

func (h *RuntimeCatalogHandlers) permitAgent(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	workspaceID := r.Header.Get("X-Server-Id")
	if workspaceID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Missing X-Server-Id header")
		return "", "", false
	}
	if h.Store == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime options")
		return "", "", false
	}
	role, err := h.Store.MemberRole(r.Context(), workspaceID, authn.UserID(r))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load runtime options")
		return "", "", false
	}
	if role == "" {
		httpx.WriteError(w, http.StatusForbidden, "Not a member of this server")
		return "", "", false
	}
	if role == agent.RoleGuest {
		httpx.WriteError(w, http.StatusForbidden, "Guests cannot access the server Agent directory")
		return "", "", false
	}
	return workspaceID, role, true
}

func scopeHeader(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	header := r.Header.Get("X-Server-Id")
	if header == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Missing X-Server-Id header")
		return false
	}
	if header != workspaceID {
		httpx.WriteError(w, http.StatusBadRequest, "X-Server-Id must match server id in URL")
		return false
	}
	return true
}

func reportedRuntimes(machine *runtimecatalog.Machine) ([]string, bool) {
	if machine == nil || !machine.RuntimesReported {
		return nil, true
	}
	return machine.RuntimeIDs, true
}

func formDefinition(runtimeID, schemaVersion string) (string, any, []runtimecatalog.Issue, int) {
	switch runtimeID {
	case "builtin":
		if schemaVersion != runtimecatalog.BuiltinPiFormSchemaVersion {
			return "Runtime form schema is stale or unknown", nil, []runtimecatalog.Issue{{Code: "stale_form_schema", Pointer: "/schemaVersion"}}, http.StatusConflict
		}
		return "", runtimecatalog.BuildBuiltinPiFormDefinition(), nil, 0
	case "kimi-sdk":
		if schemaVersion != runtimecatalog.KimiSDKFormSchemaVersion {
			return "Runtime form schema is stale or unknown", nil, []runtimecatalog.Issue{{Code: "stale_form_schema", Pointer: "/schemaVersion"}}, http.StatusConflict
		}
		return "", runtimecatalog.BuildKimiSDKFormDefinition(), nil, 0
	default:
		return "Runtime form definition not found", nil, []runtimecatalog.Issue{{Code: "unknown_form_runtime", Pointer: "/runtimeId"}}, http.StatusNotFound
	}
}

func definitionDrift(runtimeID string) []runtimecatalog.Issue {
	if runtimeID == "kimi-sdk" {
		return runtimecatalog.ValidateKimiSDKDefinitionProjection()
	}
	return runtimecatalog.ValidateBuiltinPiDefinitionProjection()
}

func writeCatalogFailure(w http.ResponseWriter, machine *runtimecatalog.Machine, message, code, recovery string) {
	body := map[string]any{
		"error":           message,
		"code":            code,
		"daemonVersion":   nil,
		"computerVersion": nil,
		"recovery":        recovery,
	}
	if machine != nil {
		body["daemonVersion"] = machine.DaemonVersion
		body["computerVersion"] = machine.ComputerVersion
	}
	httpx.WriteJSON(w, http.StatusConflict, body)
}

func writeModelFailure(w http.ResponseWriter) {
	httpx.WriteJSON(w, http.StatusOK, runtimecatalog.Outcome{Kind: "error", Retryable: true})
}

func writeModelOutcome(w http.ResponseWriter, outcome runtimecatalog.Outcome) {
	if outcome.Kind == "live" && outcome.Value != nil {
		body := map[string]any{
			"kind":   "live",
			"value":  outcome.Value,
			"models": outcome.Value.Models,
		}
		if outcome.Value.Default != "" {
			body["default"] = outcome.Value.Default
		}
		if body["models"] == nil {
			body["models"] = []runtimecatalog.ModelInfo{}
		}
		httpx.WriteJSON(w, http.StatusOK, body)
		return
	}
	if outcome.Kind == "" {
		writeModelFailure(w)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, outcome)
}
