// Runtime option projection tests (pure). The DB-backed resolver can only
// produce computer=unknown in M2 (no connection layer), so the picker logic
// is verified here against fixture reports; M3 inherits this contract.
package workspace

import "testing"

func TestProjectSetupRuntimeOptionsC0Catalog(t *testing.T) {
	// C0: grok/omp flags missing → enabled:false. Order is the TS catalog
	// order for setup candidates (builtin and deprecated entries excluded).
	options := ProjectSetupRuntimeOptions(nil, DefaultRuntimeAdmissionPolicy())
	ids := make([]string, 0, len(options))
	for _, o := range options {
		ids = append(ids, o.RuntimeID)
	}
	want := []string{"claude", "codex", "kimi-sdk", "copilot", "cursor-sdk", "opencode", "pi"}
	if len(ids) != len(want) {
		t.Fatalf("catalog %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("catalog %v, want %v", ids, want)
		}
	}
}

func TestProjectSetupRuntimeOptionsFlagGating(t *testing.T) {
	enabled := RuntimeAdmissionPolicy{GrokRuntimeEnabled: true, OmpRuntimeEnabled: true}
	ids := map[string]bool{}
	for _, o := range ProjectSetupRuntimeOptions(nil, enabled) {
		ids[o.RuntimeID] = true
	}
	if !ids["grok"] || !ids["omp"] {
		t.Fatalf("flagged runtimes must appear when enabled: %v", ids)
	}
	// Flag off but reported installed: still listed (grok) but NOT selectable
	// for new use — admission and capability stay orthogonal.
	options := ProjectSetupRuntimeOptions([]string{"grok", "claude"}, DefaultRuntimeAdmissionPolicy())
	for _, o := range options {
		if o.RuntimeID == "grok" {
			if o.CapabilityStatus != "available" || o.CanSelectInThisContext {
				t.Fatalf("grok under disabled flag: %+v", o)
			}
		}
	}
}

func TestProjectSetupRuntimeOptionsCapabilityStatus(t *testing.T) {
	options := ProjectSetupRuntimeOptions([]string{"claude"}, DefaultRuntimeAdmissionPolicy())
	byID := map[string]RuntimeSelectionOption{}
	for _, o := range options {
		byID[o.RuntimeID] = o
	}
	if c := byID["claude"]; c.CapabilityStatus != "available" || !c.CanSelectInThisContext {
		t.Fatalf("installed claude: %+v", c)
	}
	// Local CLI runtime not installed → not_installed.
	if c := byID["codex"]; c.CapabilityStatus != "not_installed" || c.CanSelectInThisContext {
		t.Fatalf("missing codex: %+v", c)
	}
	// In-process runtime not shipped yet → update_required, never
	// "not_installed" (nothing to install locally).
	if c := byID["kimi-sdk"]; c.CapabilityStatus != "update_required" {
		t.Fatalf("unshipped kimi-sdk: %+v", c)
	}
	// New-use options always carry the fresh-admission field set.
	if c := byID["claude"]; !c.AvailableForNew || c.Current || c.ManageableForCurrentAgent || c.AdmissionStatus != "available_for_new" || c.AdmissionReason != nil {
		t.Fatalf("fresh-use option fields: %+v", c)
	}
	// Only kimi-sdk carries the versioned form ref (builtin is not a setup
	// candidate); its omission elsewhere is the legacy-safe contract.
	if c := byID["kimi-sdk"]; c.FormDefinitionRef == nil ||
		c.FormDefinitionRef.ProtocolVersion != 1 ||
		c.FormDefinitionRef.SchemaVersion != "kimi-sdk.create.v1" {
		t.Fatalf("kimi-sdk form ref: %+v", c.FormDefinitionRef)
	}
	if c := byID["claude"]; c.FormDefinitionRef != nil {
		t.Fatalf("claude must not opt into the form protocol: %+v", c)
	}
}

func TestResolveSetupRuntimeStates(t *testing.T) {
	cases := []struct {
		name      string
		per       []MachineRuntimeReport
		wantState string
	}{
		{"recommended wins", []MachineRuntimeReport{
			{Reported: true, RuntimeIDs: []string{"codex"}},
			{Reported: true, RuntimeIDs: []string{"copilot"}},
		}, RuntimeStateReadyRecommended},
		{"other only", []MachineRuntimeReport{
			{Reported: true, RuntimeIDs: []string{"copilot"}},
		}, RuntimeStateReadyOther},
		{"nothing reported yet", []MachineRuntimeReport{
			{Reported: false},
		}, RuntimeStateUnknown},
		{"reported empty list", []MachineRuntimeReport{
			{Reported: true},
		}, RuntimeStateNotReady},
		{"flag-off runtime is not availability", []MachineRuntimeReport{
			{Reported: true, RuntimeIDs: []string{"grok"}},
		}, RuntimeStateNotReady},
	}
	for _, tc := range cases {
		state, options := ResolveSetupRuntime(tc.per, DefaultRuntimeAdmissionPolicy())
		if state != tc.wantState {
			t.Fatalf("%s: state %s, want %s", tc.name, state, tc.wantState)
		}
		if options == nil {
			t.Fatalf("%s: options must be [] not null", tc.name)
		}
	}
}
