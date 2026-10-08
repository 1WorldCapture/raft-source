package runtimecatalog

import (
	"encoding/json"
	"testing"
)

func TestC0NewExistingAndSetupDiffer(t *testing.T) {
	policy := C0Policy()
	installed := []string{"codex", "grok", "omp", "builtin", "kimi-sdk", "cursor-sdk"}

	newOptions := ProjectNewAgentRuntimeOptions(installed, policy)
	if hasRuntime(newOptions, "grok") || hasRuntime(newOptions, "omp") || hasRuntime(newOptions, "kimi") || hasRuntime(newOptions, "antigravity") {
		t.Fatalf("new-agent C0 options leaked flagged or deprecated runtimes: %+v", ids(newOptions))
	}
	codex := findRuntime(t, newOptions, "codex")
	if codex.CapabilityStatus != "available" || codex.AdmissionReason != nil || !codex.CanSelectInThisContext || codex.Current || codex.FormDefinitionRef != nil {
		t.Fatalf("codex new-agent option = %+v", codex)
	}
	builtin := findRuntime(t, newOptions, "builtin")
	if builtin.CapabilityStatus != "available" || builtin.FormDefinitionRef == nil || builtin.FormDefinitionRef.SchemaVersion != BuiltinPiFormSchemaVersion {
		t.Fatalf("builtin new-agent option = %+v", builtin)
	}
	kimi := findRuntime(t, newOptions, "kimi-sdk")
	if kimi.FormDefinitionRef == nil || kimi.FormDefinitionRef.SchemaVersion != KimiSDKFormSchemaVersion {
		t.Fatalf("kimi-sdk form ref = %+v", kimi.FormDefinitionRef)
	}

	empty := ProjectNewAgentRuntimeOptions(nil, policy)
	if findRuntime(t, empty, "claude").CapabilityStatus != "not_installed" || findRuntime(t, empty, "claude").CanSelectInThisContext {
		t.Fatal("missing persisted runtimes must not look installed")
	}
	if findRuntime(t, empty, "builtin").CapabilityStatus != "update_required" || findRuntime(t, empty, "cursor-sdk").CapabilityStatus != "update_required" {
		t.Fatal("in-process runtimes the computer did not report are update_required")
	}

	setup := ProjectSetupRuntimeOptions(installed, policy)
	if hasRuntime(setup, "builtin") || hasRuntime(setup, "grok") || hasRuntime(setup, "omp") {
		t.Fatalf("setup options = %v", ids(setup))
	}
	if !findRuntime(t, setup, "codex").CanSelectInThisContext || findRuntime(t, setup, "kimi-sdk").FormDefinitionRef == nil {
		t.Fatal("setup kimi-sdk keeps its form ref and codex stays selectable")
	}

	currentGrok := ProjectExistingAgentRuntimeOptions(installed, "grok", policy)
	grok := findRuntime(t, currentGrok, "grok")
	if grok.AdmissionStatus != "grandfathered_current" || grok.AdmissionReason == nil || *grok.AdmissionReason != "feature_flag_off" || !grok.CanSelectInThisContext || grok.AvailableForNew {
		t.Fatalf("current grok = %+v", grok)
	}
	if hasRuntime(currentGrok, "omp") {
		t.Fatal("flagged omp must stay hidden when it is not the current runtime")
	}
	switched := ProjectExistingAgentRuntimeOptions([]string{"codex"}, "codex", policy)
	if hasRuntime(switched, "grok") {
		t.Fatal("existing codex picker must not offer flag-off grok")
	}

	for _, runtime := range []string{"kimi", "antigravity"} {
		options := ProjectExistingAgentRuntimeOptions([]string{runtime}, runtime, policy)
		got := findRuntime(t, options, runtime)
		if got.AdmissionReason == nil || *got.AdmissionReason != "deprecated" || got.AdmissionStatus != "grandfathered_current" || !got.CanSelectInThisContext {
			t.Fatalf("deprecated %s = %+v", runtime, got)
		}
		if hasRuntime(ProjectNewAgentRuntimeOptions([]string{runtime}, policy), runtime) {
			t.Fatalf("deprecated %s was offered for new agents", runtime)
		}
	}

	enabled := Policy{GrokRuntimeEnabled: true, OmpRuntimeEnabled: true}
	if !findRuntime(t, ProjectNewAgentRuntimeOptions([]string{"omp"}, enabled), "omp").CanSelectInThisContext {
		t.Fatal("flag-on omp is a normal new-agent runtime")
	}
	if findRuntime(t, ProjectNewAgentRuntimeOptions(nil, enabled), "omp").CapabilityStatus != "not_installed" {
		t.Fatal("flag-on omp still requires a persisted install")
	}
}

func TestSelectionOptionKeepsNullAdmissionReason(t *testing.T) {
	raw, err := json.Marshal(findRuntime(t, ProjectNewAgentRuntimeOptions([]string{"codex"}, C0Policy()), "codex"))
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["admissionReason"]; !ok || payload["admissionReason"] != nil {
		t.Fatalf("admissionReason = %#v", payload["admissionReason"])
	}
	if _, ok := payload["formDefinitionRef"]; ok {
		t.Fatal("codex must omit formDefinitionRef")
	}
}

func findRuntime(t *testing.T, options []SelectionOption, id string) SelectionOption {
	t.Helper()
	for _, option := range options {
		if option.RuntimeID == id {
			return option
		}
	}
	t.Fatalf("missing %s in %v", id, ids(options))
	return SelectionOption{}
}

func hasRuntime(options []SelectionOption, id string) bool {
	for _, option := range options {
		if option.RuntimeID == id {
			return true
		}
	}
	return false
}

func ids(options []SelectionOption) []string {
	out := make([]string, len(options))
	for i, option := range options {
		out[i] = option.RuntimeID
	}
	return out
}
