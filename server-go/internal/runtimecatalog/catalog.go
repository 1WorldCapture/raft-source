package runtimecatalog

import "encoding/json"

// Policy is the rollout gate for flag-backed runtimes. C0 has no flag rows:
// TS evaluateFeatureFlag returns enabled:false for a missing flag, and this
// slice does not invent grok_runtime_v0 / omp_runtime_v0 as on.
type Policy struct {
	GrokRuntimeEnabled bool
	OmpRuntimeEnabled  bool
}

// C0Policy is the missing-flag evaluation (both runtimes disabled).
func C0Policy() Policy { return Policy{} }

// FormDefinitionRef opts a runtime into the versioned Create Agent form
// protocol. Omission is the legacy contract: JSON must leave the field out.
type FormDefinitionRef struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RuntimeID       string `json:"runtimeId"`
	SchemaVersion   string `json:"schemaVersion"`
}

const (
	formProtocolVersion        = 1
	BuiltinPiFormSchemaVersion = "builtin-pi.create.v2"
	KimiSDKFormSchemaVersion   = "kimi-sdk.create.v1"
)

// BuiltinPiFormDefinitionRef is the ref advertised on an admitted builtin row.
func BuiltinPiFormDefinitionRef() FormDefinitionRef {
	return FormDefinitionRef{
		ProtocolVersion: formProtocolVersion,
		RuntimeID:       "builtin",
		SchemaVersion:   BuiltinPiFormSchemaVersion,
	}
}

// KimiSDKFormDefinitionRef is the ref advertised on an admitted kimi-sdk row.
func KimiSDKFormDefinitionRef() FormDefinitionRef {
	return FormDefinitionRef{
		ProtocolVersion: formProtocolVersion,
		RuntimeID:       "kimi-sdk",
		SchemaVersion:   KimiSDKFormSchemaVersion,
	}
}

// SelectionOption is the TS RuntimeSelectionOption projection.
// AdmissionReason is always encoded, including JSON null.
type SelectionOption struct {
	RuntimeID                 string
	CapabilityStatus          string
	AdmissionStatus           string
	AdmissionReason           *string
	Current                   bool
	AvailableForNew           bool
	ManageableForCurrentAgent bool
	CanSelectInThisContext    bool
	FormDefinitionRef         *FormDefinitionRef
}

type selectionOptionJSON struct {
	RuntimeID                 string             `json:"runtimeId"`
	CapabilityStatus          string             `json:"capabilityStatus"`
	AdmissionStatus           string             `json:"admissionStatus"`
	AdmissionReason           *string            `json:"admissionReason"`
	Current                   bool               `json:"current"`
	AvailableForNew           bool               `json:"availableForNew"`
	ManageableForCurrentAgent bool               `json:"manageableForCurrentAgent"`
	CanSelectInThisContext    bool               `json:"canSelectInThisContext"`
	FormDefinitionRef         *FormDefinitionRef `json:"formDefinitionRef,omitempty"`
}

// MarshalJSON keeps admissionReason present when it is null.
func (o SelectionOption) MarshalJSON() ([]byte, error) {
	return json.Marshal(selectionOptionJSON{
		RuntimeID:                 o.RuntimeID,
		CapabilityStatus:          o.CapabilityStatus,
		AdmissionStatus:           o.AdmissionStatus,
		AdmissionReason:           o.AdmissionReason,
		Current:                   o.Current,
		AvailableForNew:           o.AvailableForNew,
		ManageableForCurrentAgent: o.ManageableForCurrentAgent,
		CanSelectInThisContext:    o.CanSelectInThisContext,
		FormDefinitionRef:         o.FormDefinitionRef,
	})
}

// SelectionCatalog is the body of the runtime-options endpoints and the
// setup projection (context new_agent | existing_agent | setup).
type SelectionCatalog struct {
	Context   string            `json:"context"`
	MachineID *string           `json:"machineId"`
	Options   []SelectionOption `json:"options"`
}

const (
	ContextNewAgent      = "new_agent"
	ContextExistingAgent = "existing_agent"
	ContextSetup         = "setup"
)

type runtimeInfo struct {
	id         string
	binary     string
	deprecated bool
	supported  bool
}

// runtimeCatalog is packages/shared RUNTIMES, display order preserved.
var runtimeCatalog = []runtimeInfo{
	{id: "claude", binary: "claude", supported: true},
	{id: "codex", binary: "codex", supported: true},
	{id: "grok", binary: "grok", supported: true},
	{id: "builtin", binary: "", supported: true},
	{id: "antigravity", binary: "agy", supported: true, deprecated: true},
	{id: "kimi-sdk", binary: "", supported: true},
	{id: "kimi", binary: "kimi", supported: true, deprecated: true},
	{id: "copilot", binary: "copilot", supported: true},
	{id: "cursor-sdk", binary: "", supported: true},
	{id: "gemini", binary: "gemini", supported: true, deprecated: true},
	{id: "opencode", binary: "opencode", supported: true},
	{id: "pi", binary: "pi", supported: true},
	{id: "omp", binary: "omp", supported: true},
}

func creatableRuntimes() []runtimeInfo {
	out := make([]runtimeInfo, 0, len(runtimeCatalog))
	for _, runtime := range runtimeCatalog {
		if runtime.supported && !runtime.deprecated {
			out = append(out, runtime)
		}
	}
	return out
}

func setupRuntimes() []runtimeInfo {
	out := make([]runtimeInfo, 0, len(runtimeCatalog))
	for _, runtime := range runtimeCatalog {
		if runtime.supported && !runtime.deprecated && runtime.id != "builtin" {
			out = append(out, runtime)
		}
	}
	return out
}

func existingRuntimes(current string) []runtimeInfo {
	out := make([]runtimeInfo, 0, len(runtimeCatalog))
	for _, runtime := range runtimeCatalog {
		if !runtime.deprecated || runtime.id == current {
			out = append(out, runtime)
		}
	}
	return out
}

func admittedForNewUse(runtime runtimeInfo, policy Policy) bool {
	if runtime.id == "grok" && !policy.GrokRuntimeEnabled {
		return false
	}
	if runtime.id == "omp" && !policy.OmpRuntimeEnabled {
		return false
	}
	return true
}

func capabilityStatus(runtime runtimeInfo, installed map[string]struct{}) string {
	if _, ok := installed[runtime.id]; ok {
		return "available"
	}
	if runtime.binary == "" {
		return "update_required"
	}
	return "not_installed"
}

func projectOption(runtime runtimeInfo, installed map[string]struct{}, current string, reason *string) SelectionOption {
	isCurrent := runtime.id == current && current != ""
	capability := capabilityStatus(runtime, installed)
	admission := "available_for_new"
	if reason != nil {
		admission = "grandfathered_current"
	}
	availableForNew := admission == "available_for_new"
	capabilityAvailable := capability == "available"
	option := SelectionOption{
		RuntimeID:                 runtime.id,
		CapabilityStatus:          capability,
		AdmissionStatus:           admission,
		AdmissionReason:           reason,
		Current:                   isCurrent,
		AvailableForNew:           availableForNew,
		ManageableForCurrentAgent: isCurrent && capabilityAvailable,
		CanSelectInThisContext: capabilityAvailable &&
			(availableForNew || (isCurrent && admission == "grandfathered_current")),
	}
	if (runtime.id == "builtin" || runtime.id == "kimi-sdk") && (availableForNew || isCurrent) {
		ref := BuiltinPiFormDefinitionRef()
		if runtime.id == "kimi-sdk" {
			ref = KimiSDKFormDefinitionRef()
		}
		option.FormDefinitionRef = &ref
	}
	return option
}

func installedSet(ids []string) map[string]struct{} {
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" {
			set[id] = struct{}{}
		}
	}
	return set
}

func projectNewUse(candidates []runtimeInfo, installedIDs []string, policy Policy) []SelectionOption {
	installed := installedSet(installedIDs)
	options := make([]SelectionOption, 0, len(candidates))
	for _, runtime := range candidates {
		if !admittedForNewUse(runtime, policy) {
			continue
		}
		options = append(options, projectOption(runtime, installed, "", nil))
	}
	return options
}

// ProjectNewAgentRuntimeOptions is the new-agent picker
// (getCreatableRuntimeOptions + new-use admission).
func ProjectNewAgentRuntimeOptions(installedRuntimeIDs []string, policy Policy) []SelectionOption {
	return projectNewUse(creatableRuntimes(), installedRuntimeIDs, policy)
}

// ProjectSetupRuntimeOptions is the setup picker: new-use admission without
// builtin (isRuntimeSetupCandidate).
func ProjectSetupRuntimeOptions(installedRuntimeIDs []string, policy Policy) []SelectionOption {
	return projectNewUse(setupRuntimes(), installedRuntimeIDs, policy)
}

func reasonString(value string) *string { return &value }

// ProjectExistingAgentRuntimeOptions is the edit picker. The current runtime
// stays visible when it is deprecated or behind a disabled flag, and is then
// grandfathered rather than offered for new use.
func ProjectExistingAgentRuntimeOptions(installedRuntimeIDs []string, currentRuntime string, policy Policy) []SelectionOption {
	installed := installedSet(installedRuntimeIDs)
	candidates := existingRuntimes(currentRuntime)
	options := make([]SelectionOption, 0, len(candidates))
	for _, runtime := range candidates {
		if runtime.id != currentRuntime && !admittedForNewUse(runtime, policy) {
			continue
		}
		var reason *string
		if runtime.id == currentRuntime {
			switch {
			case runtime.deprecated:
				reason = reasonString("deprecated")
			case (runtime.id == "grok" && !policy.GrokRuntimeEnabled) ||
				(runtime.id == "omp" && !policy.OmpRuntimeEnabled):
				reason = reasonString("feature_flag_off")
			}
		}
		options = append(options, projectOption(runtime, installed, currentRuntime, reason))
	}
	return options
}
