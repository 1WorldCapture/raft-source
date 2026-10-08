// Setup runtime options — port of the TS runtime admission projection used
// by the setup live-facts resolver:
// packages/server/src/services/runtimeAdmissionService.ts
// (projectSetupRuntimeOptions / projectRuntimeOption) over the shared
// RUNTIMES catalog (packages/shared/src/index.ts).
//
// The runtime options only become non-empty once a connected computer is
// ONLINE; M2 has no machine connection layer, so the DB-backed resolver in
// setup_facts.go always answers computer=unknown and empty options. The
// projection itself is still implemented and unit-tested against fixtures so
// the M3 connection work inherits the exact legacy contract.
package workspace

// RuntimeAdmissionPolicy gates rollout-flagged runtimes. C0 baseline: both
// false — TS evaluates missing feature flags as enabled:false, and the M2
// common store policy does not carry these keys (coordination: do not enable
// unsupported platform flags). M3 wires these to a real provider.
type RuntimeAdmissionPolicy struct {
	GrokRuntimeEnabled bool
	OmpRuntimeEnabled  bool
}

// DefaultRuntimeAdmissionPolicy is the C0 evaluation (all flags missing).
func DefaultRuntimeAdmissionPolicy() RuntimeAdmissionPolicy {
	return RuntimeAdmissionPolicy{}
}

// FormDefinitionRef opts a runtime into the versioned Create Agent form
// protocol. Omission is the migration-safe legacy contract (TS marks the
// field optional; JSON must omit it entirely, hence omitempty).
type FormDefinitionRef struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RuntimeID       string `json:"runtimeId"`
	SchemaVersion   string `json:"schemaVersion"`
}

// RuntimeSelectionOption is the exact TS shape (packages/shared
// RuntimeSelectionOption). admissionReason is always present and may be
// null; formDefinitionRef is present only when TS would add it.
type RuntimeSelectionOption struct {
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

// machineRuntimeCatalog mirrors the setup candidates of the shared RUNTIMES
// catalog: supported, not deprecated, not "builtin" (isRuntimeSetupCandidate).
// Order matters — it is the display order TS emits.
type machineRuntimeCatalogEntry struct {
	ID     string
	Binary string // "" = in-process runtime (Computer-shipped, not user-installable)
}

var setupRuntimeCatalog = []machineRuntimeCatalogEntry{
	{ID: "claude", Binary: "claude"},
	{ID: "codex", Binary: "codex"},
	{ID: "grok", Binary: "grok"},
	{ID: "kimi-sdk", Binary: ""},
	{ID: "copilot", Binary: "copilot"},
	{ID: "cursor-sdk", Binary: ""},
	{ID: "opencode", Binary: "opencode"},
	{ID: "pi", Binary: "pi"},
	{ID: "omp", Binary: "omp"},
}

// recommendedSetupRuntimes is the TS RECOMMENDED_SETUP_RUNTIMES set.
var recommendedSetupRuntimes = map[string]bool{"claude": true, "codex": true}

const kimiSDKFormSchemaVersion = "kimi-sdk.create.v1"

// ProjectSetupRuntimeOptions projects the setup runtime picker from the
// runtimes the ONLINE connected machines reported (TS
// projectSetupRuntimeOptions with currentRuntime=null, admissionReason=null).
func ProjectSetupRuntimeOptions(installedRuntimeIDs []string, policy RuntimeAdmissionPolicy) []RuntimeSelectionOption {
	installed := make(map[string]bool, len(installedRuntimeIDs))
	for _, id := range installedRuntimeIDs {
		installed[id] = true
	}
	options := make([]RuntimeSelectionOption, 0, len(setupRuntimeCatalog))
	for _, entry := range setupRuntimeCatalog {
		// isRuntimeAdmittedForNewUse: grok/omp ride behind rollout flags.
		if entry.ID == "grok" && !policy.GrokRuntimeEnabled {
			continue
		}
		if entry.ID == "omp" && !policy.OmpRuntimeEnabled {
			continue
		}
		capability := "not_installed"
		if installed[entry.ID] {
			capability = "available"
		} else if entry.Binary == "" {
			// Nothing to install locally: the Computer ships it.
			capability = "update_required"
		}
		option := RuntimeSelectionOption{
			RuntimeID:                 entry.ID,
			CapabilityStatus:          capability,
			AdmissionStatus:           "available_for_new",
			AdmissionReason:           nil,
			Current:                   false,
			AvailableForNew:           true,
			ManageableForCurrentAgent: false,
			CanSelectInThisContext:    capability == "available",
		}
		if entry.ID == "kimi-sdk" {
			option.FormDefinitionRef = &FormDefinitionRef{
				ProtocolVersion: 1,
				RuntimeID:       "kimi-sdk",
				SchemaVersion:   kimiSDKFormSchemaVersion,
			}
		}
		options = append(options, option)
	}
	return options
}

// MachineRuntimeReport is one ONLINE machine's persisted runtimes column:
// Reported=false reproduces TS `runtimes == null` ("not reported yet").
type MachineRuntimeReport struct {
	Reported   bool
	RuntimeIDs []string
}

// ResolveSetupRuntime implements the runtime branch of the TS live-facts
// resolver: build the picker from every online machine's reported runtimes,
// then derive the machine-level runtime state from the SELECTABLE options —
// ready_recommended (claude/codex), ready_other (anything selectable),
// unknown (some online machine has not reported yet), else not_ready.
func ResolveSetupRuntime(perMachine []MachineRuntimeReport, policy RuntimeAdmissionPolicy) (string, []RuntimeSelectionOption) {
	var installed []string
	for _, report := range perMachine {
		if report.Reported {
			installed = append(installed, report.RuntimeIDs...)
		}
	}
	options := ProjectSetupRuntimeOptions(installed, policy)
	availableRecommended := false
	availableOther := false
	anyUnreported := false
	for _, report := range perMachine {
		if !report.Reported {
			anyUnreported = true
		}
	}
	for _, option := range options {
		if option.CanSelectInThisContext {
			if recommendedSetupRuntimes[option.RuntimeID] {
				availableRecommended = true
			} else {
				availableOther = true
			}
		}
	}
	switch {
	case availableRecommended:
		return RuntimeStateReadyRecommended, options
	case availableOther:
		return RuntimeStateReadyOther, options
	case anyUnreported:
		return RuntimeStateUnknown, options
	default:
		return RuntimeStateNotReady, options
	}
}
