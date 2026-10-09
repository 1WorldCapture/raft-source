// Runtime form-definition admission for agent create and update.
// runtimecatalog.ValidateRuntimeFormDefinitionRef is not exported in this
// tree. The check below is the same pure envelope rule as
// validateRuntimeFormDefinitionRef in runtimeFormDefinitionService.ts,
// against the published builtin and kimi-sdk refs. Live catalog proof, when
// parent sets AgentHandlers.RuntimeCatalog, goes through Broker.DetectModels.
package humanapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strings"

	"raft.local/server-go/internal/runtimecatalog"
)

func validateRuntimeFormDefinitionRef(raw json.RawMessage) []runtimecatalog.Issue {
	if len(raw) == 0 || string(raw) == "null" {
		return []runtimecatalog.Issue{{Code: "form_definition_ref_required", Pointer: "/formDefinitionRef"}}
	}
	var ref map[string]json.RawMessage
	if err := json.Unmarshal(raw, &ref); err != nil || ref == nil {
		return []runtimecatalog.Issue{{Code: "form_definition_ref_required", Pointer: "/formDefinitionRef"}}
	}
	var protocol float64
	if json.Unmarshal(ref["protocolVersion"], &protocol) != nil || protocol != 1 {
		return []runtimecatalog.Issue{{Code: "unsupported_form_protocol", Pointer: "/formDefinitionRef/protocolVersion"}}
	}
	var runtimeID string
	if json.Unmarshal(ref["runtimeId"], &runtimeID) != nil {
		runtimeID = ""
	}
	registered := registeredFormSchema(runtimeID)
	if registered == "" {
		return []runtimecatalog.Issue{{Code: "unknown_form_runtime", Pointer: "/formDefinitionRef/runtimeId"}}
	}
	var schema string
	if json.Unmarshal(ref["schemaVersion"], &schema) != nil || schema != registered {
		return []runtimecatalog.Issue{{Code: "stale_form_schema", Pointer: "/formDefinitionRef/schemaVersion"}}
	}
	for key := range ref {
		if key != "protocolVersion" && key != "runtimeId" && key != "schemaVersion" {
			return []runtimecatalog.Issue{{Code: "unknown_form_ref_field", Pointer: "/formDefinitionRef"}}
		}
	}
	return nil
}

func registeredFormSchema(runtimeID string) string {
	switch runtimeID {
	case runtimecatalog.BuiltinPiFormDefinitionRef().RuntimeID:
		return runtimecatalog.BuiltinPiFormSchemaVersion
	case runtimecatalog.KimiSDKFormDefinitionRef().RuntimeID:
		return runtimecatalog.KimiSDKFormSchemaVersion
	default:
		return ""
	}
}

func formRefRuntimeID(raw json.RawMessage) string {
	var ref struct {
		RuntimeID string `json:"runtimeId"`
	}
	_ = json.Unmarshal(raw, &ref)
	return ref.RuntimeID
}

func writeFormIssues(w http.ResponseWriter, status int, message string, issues []runtimecatalog.Issue) {
	httpx.WriteJSON(w, status, map[string]any{"error": message, "issues": issues})
}

func writeFormCode(w http.ResponseWriter, status int, message, code string, issues []runtimecatalog.Issue) {
	httpx.WriteJSON(w, status, map[string]any{"error": message, "code": code, "issues": issues})
}

// rejectFormDefinitionRef validates a present ref and requires the normalized
// runtime identity to equal runtimeId. A false return means the caller stops.
func rejectFormDefinitionRef(w http.ResponseWriter, raw json.RawMessage, runtimeIdentity string) bool {
	if len(raw) == 0 {
		return false
	}
	issues := validateRuntimeFormDefinitionRef(raw)
	if len(issues) > 0 {
		writeFormIssues(w, http.StatusConflict, "Runtime form definition is stale or invalid", issues)
		return true
	}
	if runtimeIdentity != formRefRuntimeID(raw) {
		writeFormIssues(w, http.StatusBadRequest, "Runtime configuration does not match form definition",
			[]runtimecatalog.Issue{{Code: "form_runtime_mismatch", Pointer: "/runtimeConfig/runtime"}})
		return true
	}
	return false
}

// admitRuntimeCatalog runs live builtin/kimi detection when a broker is
// wired. A nil broker does not invent a catalog: a valid ref is admitted,
// and a kimi reasoning effort is refused.
func (h *AgentHandlers) admitRuntimeCatalog(w http.ResponseWriter, r *http.Request, runtime, machineID, effort string, runtimeConfig json.RawMessage) bool {
	if runtime != "builtin" && runtime != "kimi-sdk" {
		return true
	}
	effort = strings.TrimSpace(effort)
	if h.RuntimeCatalog == nil {
		if runtime == "kimi-sdk" && effort != "" {
			writeFormCode(w, http.StatusConflict, "Kimi model source is unavailable", "runtime_model_source_unavailable",
				[]runtimecatalog.Issue{{Code: "runtime_model_source_unavailable", Pointer: "/runtimeConfig/model"}})
			return false
		}
		return true
	}
	if machineID == "" {
		if runtime == "kimi-sdk" {
			writeFormIssues(w, http.StatusConflict, "Kimi model validation requires an assigned computer",
				[]runtimecatalog.Issue{{Code: "runtime_model_source_unavailable", Pointer: "/machineId"}})
			return false
		}
		writeFormCode(w, http.StatusConflict,
			"A target Computer is required to validate this Built-in model",
			"builtin_catalog_target_required",
			[]runtimecatalog.Issue{{Code: "builtin_catalog_target_required", Pointer: "/machineId"}})
		return false
	}
	outcome, err := h.RuntimeCatalog.DetectModels(r.Context(), runtimecatalog.Target{
		MachineID: machineID, WorkspaceID: agentScopeOf(r).WorkspaceID,
	}, runtime)
	if runtime == "builtin" {
		if err != nil || outcome.Kind != "live" {
			httpx.WriteJSON(w, http.StatusConflict, map[string]any{
				"error":    "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
				"code":     "builtin_catalog_unavailable",
				"recovery": "retry",
				"issues":   []runtimecatalog.Issue{{Code: "builtin_catalog_unavailable", Pointer: "/runtimeConfig/model"}},
			})
			return false
		}
		return rejectUnknownStringModel(w, outcome, runtimeConfig)
	}
	if err != nil {
		if effort == "" && (errors.Is(err, runtimecatalog.ErrTimeout) || errors.Is(err, runtimecatalog.ErrOffline)) {
			return true
		}
		code := "runtime_model_source_error"
		message := "Kimi model source is unavailable"
		switch {
		case errors.Is(err, runtimecatalog.ErrTimeout):
			code = "runtime_model_source_timeout"
			message = "Kimi model validation timed out. Your settings were not saved; try again."
		case errors.Is(err, runtimecatalog.ErrOffline):
			code = "runtime_model_source_offline"
			message = "The selected computer is unavailable. Reconnect it and try again; your settings were not saved."
		}
		writeFormCode(w, http.StatusConflict, message, code,
			[]runtimecatalog.Issue{{Code: code, Pointer: "/runtimeConfig/model"}})
		return false
	}
	if outcome.Kind != "live" {
		if effort == "" && outcome.Kind != "unsupported" {
			return true
		}
		kind := outcome.Kind
		if kind == "" {
			kind = "error"
		}
		code := "runtime_model_source_" + kind
		writeFormIssues(w, http.StatusConflict, "Kimi model source is unavailable",
			[]runtimecatalog.Issue{{Code: code, Pointer: "/runtimeConfig/model"}})
		return false
	}
	return rejectUnknownStringModel(w, outcome, runtimeConfig)
}

// rejectUnknownStringModel checks a string model id against a live list.
// An object-shaped builtin preset is not compared as a string.
func rejectUnknownStringModel(w http.ResponseWriter, outcome runtimecatalog.Outcome, runtimeConfig json.RawMessage) bool {
	id, objectShaped := runtimeConfigModelID(runtimeConfig)
	if objectShaped || id == "" || outcome.Value == nil {
		return true
	}
	for _, model := range outcome.Value.Models {
		if model.ID == id {
			return true
		}
	}
	writeFormIssues(w, http.StatusBadRequest, "Runtime configuration is invalid",
		[]runtimecatalog.Issue{{Code: "invalid_option", Pointer: "/runtimeConfig/model"}})
	return false
}

func runtimeConfigModelID(raw json.RawMessage) (id string, objectShaped bool) {
	if len(raw) == 0 || !isJSONObject(raw) {
		return "", false
	}
	var probe struct {
		Model json.RawMessage `json:"model"`
	}
	if json.Unmarshal(raw, &probe) != nil || len(probe.Model) == 0 || string(probe.Model) == "null" {
		return "", false
	}
	switch probe.Model[0] {
	case '"':
		_ = json.Unmarshal(probe.Model, &id)
		return id, false
	case '{':
		return "", true
	default:
		return "", false
	}
}

func normalizedRuntimeIdentity(runtimeConfig json.RawMessage, runtime *string, fallback string) string {
	if identity := runtimeConfigRuntimeOf(runtimeConfig); identity != "" {
		return identity
	}
	if runtime != nil && strings.TrimSpace(*runtime) != "" {
		return strings.TrimSpace(*runtime)
	}
	return strings.TrimSpace(fallback)
}
