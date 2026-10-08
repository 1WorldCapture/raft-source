// Pure-projector behavioral tests: every legacy projection branch must be
// reproduced exactly (design 10.3 / T16). The exhaustive TS-executed
// differential (1216 cases) runs separately under the `reference` build tag;
// these tests name and explain each branch in Go terms.
package workspace

import (
	"encoding/json"
	"testing"
)

func reasonPtr(r string) *string { return &r }

func baseLive() SetupLiveFacts {
	return SetupLiveFacts{
		Computer:                ComputerStateOffline,
		HasConnectedComputer:    false,
		OfflineComputers:        []OfflineComputer{},
		EverHadAgent:            false,
		Runtime:                 RuntimeStateUnknown,
		RuntimeOptions:          []RuntimeSelectionOption{},
		OfficialOnboardingAgent: OfficialAgentStateMissing,
		OwnerSurveyPending:      true,
		OwnerHandoffPending:     true,
		ActorIsOwner:            true,
	}
}

func notStartedState() SetupState {
	return SetupState{
		WorkspaceID:     "ws",
		UserID:          "user",
		Status:          SetupStatusNotStarted,
		ContractVersion: SetupContractVersion,
	}
}

func completeState(reason string) SetupState {
	return SetupState{
		WorkspaceID:      "ws",
		UserID:           "user",
		Status:           SetupStatusComplete,
		CompletionReason: reasonPtr(reason),
		ContractVersion:  SetupContractVersion,
	}
}

func TestProjectSetupNewOwnerNoComputerIsDesignTenPointTwo(t *testing.T) {
	// The exact acceptance projection from phase-2-workspaces.md §10.2.
	proj := ProjectServerSetup(notStartedState(), baseLive())
	data, err := json.Marshal(proj)
	if err != nil {
		t.Fatal(err)
	}
	want := `{
		"surface": "computer_runtime",
		"phase": "not_started",
		"currentStep": "computer_runtime",
		"blocksChat": true,
		"allowedExits": ["reset", "return_to_server"],
		"sideEffectState": {"transitions": "enabled", "completion": "disabled"},
		"gateReason": "computer_offline",
		"computerStatus": "offline",
		"runtimeStatus": "unknown",
		"runtimeOptions": [],
		"hasConnectedComputer": false,
		"offlineComputers": [],
		"postSetup": {"surveyPending": false, "handoffPending": false}
	}`
	var gotMap, wantMap map[string]any
	if err := json.Unmarshal(data, &gotMap); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &wantMap); err != nil {
		t.Fatal(err)
	}
	if err := deepEqualJSON("projection", gotMap, wantMap); err != nil {
		t.Fatalf("new-owner projection mismatch: %v\nGo: %s", err, data)
	}
}

// deepEqualJSON compares decoded JSON values with path-annotated failures.
func deepEqualJSON(path string, got, want any) error {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return jsonMismatch(path, got, want)
		}
		for k, wv := range w {
			gv, ok := g[k]
			if !ok {
				return jsonMismatch(path+"."+k, "<missing>", wv)
			}
			if err := deepEqualJSON(path+"."+k, gv, wv); err != nil {
				return err
			}
		}
		for k := range g {
			if _, ok := w[k]; !ok {
				return jsonMismatch(path+"."+k, g[k], "<unexpected>")
			}
		}
		return nil
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return jsonMismatch(path, got, want)
		}
		for i := range w {
			if err := deepEqualJSON(path+"[]", g[i], w[i]); err != nil {
				return err
			}
		}
		return nil
	default:
		if got != want {
			return jsonMismatch(path, got, want)
		}
		return nil
	}
}

func jsonMismatch(path string, got, want any) error {
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	return &mismatchError{path: path, got: string(g), want: string(w)}
}

type mismatchError struct{ path, got, want string }

func (e *mismatchError) Error() string {
	return e.path + ": got " + e.got + ", want " + e.want
}

func TestProjectSetupComputerUnknownAndOfflineGates(t *testing.T) {
	offline := ProjectServerSetup(notStartedState(), baseLive())
	if offline.Surface != SetupSurfaceComputerRuntime || *offline.GateReason != GateReasonComputerOffline {
		t.Fatalf("offline computer must gate on computer_offline, got %s/%v", offline.Surface, offline.GateReason)
	}
	if !offline.BlocksChat {
		t.Fatal("unfinished setup blocks chat")
	}
	if len(offline.AllowedExits) != 2 || offline.AllowedExits[0] != SetupExitReset {
		t.Fatalf("pre-checkpoint exits must offer reset first: %v", offline.AllowedExits)
	}

	unknown := baseLive()
	unknown.Computer = ComputerStateUnknown
	unknown.HasConnectedComputer = true
	unknown.OfflineComputers = []OfflineComputer{{
		ID: "c1", Name: "Maria-laptop",
		LastHeartbeat: reasonPtr("2026-07-01T12:34:56.789Z"), IsComputer: true,
	}}
	proj := ProjectServerSetup(notStartedState(), unknown)
	if proj.Surface != SetupSurfaceComputerRuntime || *proj.GateReason != GateReasonComputerStatusUnknown {
		t.Fatalf("unknown computer must gate on computer_status_unknown, got %s/%v", proj.Surface, proj.GateReason)
	}
	if !proj.HasConnectedComputer || len(proj.OfflineComputers) != 1 || proj.OfflineComputers[0].Name != "Maria-laptop" {
		t.Fatalf("offline computers must render by name from the same source: %+v", proj.OfflineComputers)
	}
}

func TestProjectSetupRuntimeGates(t *testing.T) {
	for _, tc := range []struct{ runtime, gate string }{
		{RuntimeStateNotReady, GateReasonRuntimeNotReady},
		{RuntimeStateChecking, GateReasonRuntimeChecking},
		{RuntimeStateError, GateReasonRuntimeError},
		{RuntimeStateUnknown, GateReasonRuntimeStatusUnknown},
	} {
		live := baseLive()
		live.Computer = ComputerStateOnline
		live.Runtime = tc.runtime
		proj := ProjectServerSetup(notStartedState(), live)
		if proj.Surface != SetupSurfaceComputerRuntime || proj.CurrentStep == nil || *proj.CurrentStep != SetupSurfaceComputerRuntime {
			t.Fatalf("%s: must stay on computer_runtime step", tc.runtime)
		}
		if *proj.GateReason != tc.gate {
			t.Fatalf("%s: gate %v, want %s", tc.runtime, proj.GateReason, tc.gate)
		}
	}
}

func TestProjectSetupCreateAgentBranch(t *testing.T) {
	ready := baseLive()
	ready.Computer = ComputerStateOnline
	ready.Runtime = RuntimeStateReadyRecommended

	missing := ProjectServerSetup(notStartedState(), ready)
	if missing.Surface != SetupSurfaceCreateAgent || *missing.GateReason != GateReasonOfficialAgentMissing {
		t.Fatalf("no official agent: %s/%v", missing.Surface, missing.GateReason)
	}
	if missing.SideEffectState.Completion != "disabled" {
		t.Fatal("completion must be disabled until the official agent is usable")
	}

	usableLive := ready
	usableLive.OfficialOnboardingAgent = OfficialAgentStateUsable
	usable := ProjectServerSetup(notStartedState(), usableLive)
	if usable.SideEffectState.Completion != "enabled" || *usable.GateReason != GateReasonCompletionPending {
		t.Fatalf("usable official agent must enable completion: %+v", usable.SideEffectState)
	}

	for _, tc := range []struct{ agent, gate string }{
		{OfficialAgentStateUnusable, GateReasonOfficialAgentUnusable},
		{OfficialAgentStateUnknown, GateReasonOfficialAgentStatusUnknown},
	} {
		live := ready
		live.OfficialOnboardingAgent = tc.agent
		proj := ProjectServerSetup(notStartedState(), live)
		if *proj.GateReason != tc.gate || proj.SideEffectState.Completion != "disabled" {
			t.Fatalf("%s: gate %v completion %s", tc.agent, proj.GateReason, proj.SideEffectState.Completion)
		}
	}
}

func TestProjectSetupCompleteIsTerminal(t *testing.T) {
	live := baseLive()
	// Machine "went offline" after completion: the terminal branch keeps the
	// resolved facts as given; the resolver is the one that answers unknown.
	live.Computer = ComputerStateOffline
	proj := ProjectServerSetup(completeState(SetupReasonNormal), live)
	if proj.Surface != SetupSurfaceComplete || proj.BlocksChat {
		t.Fatal("complete must never re-block chat")
	}
	if *proj.GateReason != GateReasonSetupComplete {
		t.Fatalf("gate %v", proj.GateReason)
	}
	if len(proj.AllowedExits) != 1 || proj.AllowedExits[0] != SetupExitReturnToServer {
		t.Fatalf("terminal exits: %v", proj.AllowedExits)
	}
	if proj.SideEffectState.Transitions != "disabled" {
		t.Fatal("terminal transitions are disabled")
	}
}

func TestProjectSetupPostSetupEligibility(t *testing.T) {
	// Owed only to an OWNER who finished the real flow.
	cases := []struct {
		reason       string
		actorIsOwner bool
		survey       bool
		handoff      bool
	}{
		{SetupReasonNormal, true, true, true},
		{SetupReasonCompleteAfterDefer, true, true, true},
		{SetupReasonGrandfathered, true, false, false},
		{SetupReasonAdminOverride, true, false, false},
		{SetupReasonNormal, false, false, false},
	}
	for _, tc := range cases {
		live := baseLive()
		live.Computer = ComputerStateOffline
		live.ActorIsOwner = tc.actorIsOwner
		live.OwnerSurveyPending = true
		live.OwnerHandoffPending = true
		proj := ProjectServerSetup(completeState(tc.reason), live)
		if proj.PostSetup.SurveyPending != tc.survey || proj.PostSetup.HandoffPending != tc.handoff {
			t.Fatalf("reason=%s owner=%v: postSetup %+v", tc.reason, tc.actorIsOwner, proj.PostSetup)
		}
	}
}

func TestProjectSetupLegacyDeferredIsNonBlocking(t *testing.T) {
	state := notStartedState()
	state.Status = SetupStatusDeferred
	proj := ProjectServerSetup(state, baseLive())
	if proj.BlocksChat {
		t.Fatal("legacy deferred rows must read as non-blocking (expand-contract)")
	}
	if *proj.Phase != SetupStatusDeferred {
		t.Fatal("phase reports the persisted status")
	}
}

func TestProjectSetupResetOfferedByCheckpointOnly(t *testing.T) {
	pre := baseLive()
	pre.EverHadAgent = false
	proj := ProjectServerSetup(notStartedState(), pre)
	if proj.AllowedExits[0] != SetupExitReset {
		t.Fatalf("pre-checkpoint must offer reset: %v", proj.AllowedExits)
	}
	post := baseLive()
	post.EverHadAgent = true
	proj = ProjectServerSetup(notStartedState(), post)
	if len(proj.AllowedExits) != 1 || proj.AllowedExits[0] != SetupExitReturnToServer {
		t.Fatalf("post-checkpoint must not offer demolition: %v", proj.AllowedExits)
	}
}

func TestNoSetupAndRetryProjections(t *testing.T) {
	no := NoSetupProjection(GateReasonInsufficientPermission)
	if no.Surface != SetupSurfaceNone || no.BlocksChat || no.Phase != nil ||
		no.ComputerStatus != ComputerStateUnknown || no.RuntimeStatus != RuntimeStateUnknown {
		t.Fatalf("no-setup projection: %+v", no)
	}
	if len(no.AllowedExits) != 1 || no.AllowedExits[0] != SetupExitReturnToServer {
		t.Fatalf("no-setup exits: %v", no.AllowedExits)
	}
	// Marshal: slices must be [] never null, and the shape must be complete.
	data, err := json.Marshal(no)
	if err != nil {
		t.Fatal(err)
	}
	if string(data[0:1]) != "{" || !containsJSONKey(data, "runtimeOptions") {
		t.Fatalf("no-setup wire: %s", data)
	}

	retry := RetryProjection(nil, GateReasonStateNotFound)
	if retry.Surface != SetupSurfaceRetry || retry.BlocksChat {
		t.Fatalf("retry projection: %+v", retry)
	}
	if len(retry.AllowedExits) != 2 || retry.AllowedExits[0] != SetupExitRetry {
		t.Fatalf("retry exits: %v", retry.AllowedExits)
	}
}

func containsJSONKey(data []byte, key string) bool {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

func TestNextSetupStateForActionRules(t *testing.T) {
	// start: not_started/deferred → in_progress; in_progress unchanged;
	// complete never regresses.
	start := NextSetupStateForAction(notStartedState(), SetupActionStart)
	if start.Status != SetupStatusInProgress || start.CompletionReason != nil {
		t.Fatalf("start from not_started: %+v", start)
	}
	deferred := notStartedState()
	deferred.Status = SetupStatusDeferred
	if next := NextSetupStateForAction(deferred, SetupActionStart); next.Status != SetupStatusInProgress {
		t.Fatalf("start from deferred: %+v", next)
	}
	inProgress := notStartedState()
	inProgress.Status = SetupStatusInProgress
	if next := NextSetupStateForAction(inProgress, SetupActionStart); next.Status != SetupStatusInProgress {
		t.Fatalf("idempotent start: %+v", next)
	}
	done := completeState(SetupReasonNormal)
	if next := NextSetupStateForAction(done, SetupActionStart); next.Status != SetupStatusComplete || *next.CompletionReason != SetupReasonNormal {
		t.Fatalf("start cannot regress complete: %+v", next)
	}
	// complete: fresh completions are always reason normal.
	if next := NextSetupStateForAction(inProgress, SetupActionComplete); next.Status != SetupStatusComplete || *next.CompletionReason != SetupReasonNormal {
		t.Fatalf("fresh complete: %+v", next)
	}
}
