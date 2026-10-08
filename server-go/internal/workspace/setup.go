// Setup state machine — pure types and the projection function.
//
// This file is a faithful port of the TS reference
// packages/server/src/services/serverSetupStateService.ts (baseline
// c4a5015): projectServerSetup, noSetupProjection and retryProjection are
// PURE — they turn (persisted state, resolved live facts) into the exact
// ServerSetupProjection JSON the legacy Web renders. Facts resolution and
// persistence live in setup_facts.go / setup_store.go.
//
// The TS invariants preserved here, because the whole flow depends on them:
//   - setup has ONE checkpoint: the official onboarding agent was created.
//     Past it nothing rolls back; before it everything is disposable.
//   - `complete` is terminal: offline machines or a deleted agent never
//     re-block a completed owner (the resolver then answers "unknown").
//   - `defer` is retired: no writer produces it, but legacy `deferred` rows
//     still read as NON-blocking.
//   - survey/handoff are separate persisted facts, owed only to the OWNER
//     who finished the real flow (normal / complete_after_defer).
package workspace

// Setup status values (TS ServerSetupStatus). "deferred" is legacy-read-only.
const (
	SetupStatusNotStarted = "not_started"
	SetupStatusInProgress = "in_progress"
	SetupStatusDeferred   = "deferred"
	SetupStatusComplete   = "complete"
)

// Setup completion reasons (TS ServerSetupCompletionReason). Non-null only
// on status=complete; each reason has its own writer path and they are never
// unified (see design doc 10.1 / D11).
const (
	SetupReasonNormal             = "normal"
	SetupReasonGrandfathered      = "grandfathered"
	SetupReasonCompleteAfterDefer = "complete_after_defer"
	SetupReasonAdminOverride      = "admin_override"
)

// SetupContractVersion is the contract new setup rows are born under.
const SetupContractVersion = "onboarding-setup-v2"

// Setup command machine codes — the exact TS ServerSetupStateError codes the
// legacy routes emit verbatim (W13/W14/W15 error mapping). They extend the
// generic model.go taxonomy; transport maps each to its legacy status.
const (
	CodeInvalidSetupAction               = "INVALID_SETUP_ACTION"
	CodeActorNotHuman                    = "ACTOR_NOT_HUMAN"
	CodeCrossUserTransition              = "CROSS_USER_TRANSITION"
	CodeInsufficientPermission           = "INSUFFICIENT_PERMISSION"
	CodeStateNotFound                    = "STATE_NOT_FOUND"
	CodeLiveFactsUnavailable             = "LIVE_FACTS_UNAVAILABLE"
	CodeOfficialOnboardingAgentNotUsable = "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE"
	CodeServerAlreadySetUp               = "SERVER_ALREADY_SET_UP"
)

// Computer states (TS ServerSetupComputerState).
const (
	ComputerStateOnline  = "online"
	ComputerStateOffline = "offline"
	ComputerStateUnknown = "unknown"
)

// Runtime states (TS ServerSetupRuntimeState).
const (
	RuntimeStateReadyRecommended = "ready_recommended"
	RuntimeStateReadyOther       = "ready_other"
	RuntimeStateNotReady         = "not_ready"
	RuntimeStateChecking         = "checking"
	RuntimeStateError            = "error"
	RuntimeStateUnknown          = "unknown"
)

// Official onboarding agent states (TS OfficialOnboardingAgentState).
const (
	OfficialAgentStateUsable   = "usable"
	OfficialAgentStateMissing  = "missing"
	OfficialAgentStateUnusable = "unusable"
	OfficialAgentStateUnknown  = "unknown"
)

// Projection surfaces (TS ServerSetupSurface).
const (
	SetupSurfaceNone            = "none"
	SetupSurfaceComputerRuntime = "computer_runtime"
	SetupSurfaceCreateAgent     = "create_agent"
	SetupSurfaceComplete        = "complete"
	SetupSurfaceRetry           = "retry"
)

// Allowed exits (TS ServerSetupAllowedExit). "reset" is a rollback offered
// only while the workspace never had the official onboarding agent.
const (
	SetupExitReset          = "reset"
	SetupExitReturnToServer = "return_to_server"
	SetupExitRetry          = "retry"
)

// Gate reasons (TS ServerSetupGateReason).
const (
	GateReasonActorNotHuman              = "actor_not_human"
	GateReasonInsufficientPermission     = "insufficient_permission"
	GateReasonStateNotFound              = "state_not_found"
	GateReasonComputerOffline            = "computer_offline"
	GateReasonComputerStatusUnknown      = "computer_status_unknown"
	GateReasonRuntimeNotReady            = "runtime_not_ready"
	GateReasonRuntimeChecking            = "runtime_checking"
	GateReasonRuntimeError               = "runtime_error"
	GateReasonRuntimeStatusUnknown       = "runtime_status_unknown"
	GateReasonOfficialAgentMissing       = "official_onboarding_agent_missing"
	GateReasonOfficialAgentUnusable      = "official_onboarding_agent_unusable"
	GateReasonOfficialAgentStatusUnknown = "official_onboarding_agent_status_unknown"
	GateReasonCompletionPending          = "completion_pending"
	GateReasonSetupComplete              = "setup_complete"
	GateReasonResolverError              = "resolver_error"
)

// SetupState is the persisted per-member setup row (TS ServerSetupState).
type SetupState struct {
	WorkspaceID      string
	UserID           string
	Status           string
	CompletionReason *string
	ContractVersion  string
}

// OfflineComputer is one non-running computer this workspace has, by name.
// TS ServerSetupOfflineComputer: lastHeartbeat is an ISO-8601 string or null.
type OfflineComputer struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	LastHeartbeat *string `json:"lastHeartbeat"`
	IsComputer    bool    `json:"isComputer"`
}

// SetupLiveFacts is the resolver input (TS ServerSetupLiveFacts). Reading
// facts never mutates setup state; only explicit commands write it.
type SetupLiveFacts struct {
	Computer                string                   `json:"computer"`
	HasConnectedComputer    bool                     `json:"hasConnectedComputer"`
	OfflineComputers        []OfflineComputer        `json:"offlineComputers"`
	EverHadAgent            bool                     `json:"everHadAgent"`
	Runtime                 string                   `json:"runtime"`
	RuntimeOptions          []RuntimeSelectionOption `json:"runtimeOptions"`
	OfficialOnboardingAgent string                   `json:"officialOnboardingAgent"`
	OwnerSurveyPending      bool                     `json:"ownerSurveyPending"`
	OwnerHandoffPending     bool                     `json:"ownerHandoffPending"`
	ActorIsOwner            bool                     `json:"actorIsOwner"`
}

// SideEffectState mirrors the TS projection sub-object.
type SideEffectState struct {
	Transitions string `json:"transitions"`
	Completion  string `json:"completion"`
}

// PostSetupPending are the post-setup steps still owed (survey, handoff).
type PostSetupPending struct {
	SurveyPending  bool `json:"surveyPending"`
	HandoffPending bool `json:"handoffPending"`
}

// SetupProjection is the exact legacy ServerSetupProjection JSON shape.
// Slices are always non-nil so they marshal as [] and never null.
type SetupProjection struct {
	Surface              string                   `json:"surface"`
	Phase                *string                  `json:"phase"`
	CurrentStep          *string                  `json:"currentStep"`
	BlocksChat           bool                     `json:"blocksChat"`
	AllowedExits         []string                 `json:"allowedExits"`
	SideEffectState      SideEffectState          `json:"sideEffectState"`
	GateReason           *string                  `json:"gateReason"`
	ComputerStatus       string                   `json:"computerStatus"`
	RuntimeStatus        string                   `json:"runtimeStatus"`
	RuntimeOptions       []RuntimeSelectionOption `json:"runtimeOptions"`
	HasConnectedComputer bool                     `json:"hasConnectedComputer"`
	OfflineComputers     []OfflineComputer        `json:"offlineComputers"`
	PostSetup            PostSetupPending         `json:"postSetup"`
}

func ptr[S ~string](v S) *S { return &v }

// NoSetupProjection is the answer for actors who are not the owner (or not
// human): no surface, nothing blocked, no facts claimed (TS noSetupProjection).
// Absence of a reading is not a reading: computer/runtime stay "unknown".
func NoSetupProjection(reason string) SetupProjection {
	return SetupProjection{
		Surface:              SetupSurfaceNone,
		Phase:                nil,
		CurrentStep:          nil,
		BlocksChat:           false,
		AllowedExits:         []string{SetupExitReturnToServer},
		SideEffectState:      SideEffectState{Transitions: "disabled", Completion: "disabled"},
		GateReason:           ptr(reason),
		ComputerStatus:       ComputerStateUnknown,
		RuntimeStatus:        RuntimeStateUnknown,
		RuntimeOptions:       []RuntimeSelectionOption{},
		HasConnectedComputer: false,
		OfflineComputers:     []OfflineComputer{},
		PostSetup:            PostSetupPending{},
	}
}

// RetryProjection answers "could not resolve safely": never fakes complete,
// never blocks chat, and offers retry (TS retryProjection).
func RetryProjection(phase *string, reason string) SetupProjection {
	return SetupProjection{
		Surface:              SetupSurfaceRetry,
		Phase:                phase,
		CurrentStep:          nil,
		BlocksChat:           false,
		AllowedExits:         []string{SetupExitRetry, SetupExitReturnToServer},
		SideEffectState:      SideEffectState{Transitions: "disabled", Completion: "disabled"},
		GateReason:           ptr(reason),
		ComputerStatus:       ComputerStateUnknown,
		RuntimeStatus:        RuntimeStateUnknown,
		RuntimeOptions:       []RuntimeSelectionOption{},
		HasConnectedComputer: false,
		OfflineComputers:     []OfflineComputer{},
		PostSetup:            PostSetupPending{},
	}
}

func isRuntimeReady(runtime string) bool {
	return runtime == RuntimeStateReadyRecommended || runtime == RuntimeStateReadyOther
}

func runtimeGateReason(runtime string) string {
	switch runtime {
	case RuntimeStateNotReady:
		return GateReasonRuntimeNotReady
	case RuntimeStateChecking:
		return GateReasonRuntimeChecking
	case RuntimeStateError:
		return GateReasonRuntimeError
	case RuntimeStateUnknown:
		return GateReasonRuntimeStatusUnknown
	default:
		return ""
	}
}

func onboardingAgentGateReason(agent string) string {
	switch agent {
	case OfficialAgentStateMissing:
		return GateReasonOfficialAgentMissing
	case OfficialAgentStateUnusable:
		return GateReasonOfficialAgentUnusable
	case OfficialAgentStateUnknown:
		return GateReasonOfficialAgentStatusUnknown
	case OfficialAgentStateUsable:
		return GateReasonCompletionPending
	default:
		return ""
	}
}

// ProjectServerSetup renders (state, live facts) as the legacy projection.
// Pure: no database, no clock, no side effects.
func ProjectServerSetup(state SetupState, live SetupLiveFacts) SetupProjection {
	// ONE eligibility for BOTH post-setup screens: only an OWNER who reached
	// the end of the real flow is owed survey/handoff. Grandfathered or
	// admin-forced servers never went through onboarding; an admin is not
	// the owner and cannot answer someone else's personal steps.
	flowCompleted := state.CompletionReason != nil &&
		(*state.CompletionReason == SetupReasonNormal || *state.CompletionReason == SetupReasonCompleteAfterDefer)
	postSetupEligible := flowCompleted && live.ActorIsOwner
	postSetup := PostSetupPending{
		SurveyPending:  postSetupEligible && live.OwnerSurveyPending,
		HandoffPending: postSetupEligible && live.OwnerHandoffPending,
	}

	if state.Status == SetupStatusComplete {
		return SetupProjection{
			Surface:              SetupSurfaceComplete,
			Phase:                ptr(SetupStatusComplete),
			CurrentStep:          nil,
			BlocksChat:           false,
			AllowedExits:         []string{SetupExitReturnToServer},
			SideEffectState:      SideEffectState{Transitions: "disabled", Completion: "disabled"},
			GateReason:           ptr(GateReasonSetupComplete),
			ComputerStatus:       live.Computer,
			RuntimeStatus:        live.Runtime,
			RuntimeOptions:       withRuntimeOptions(live.RuntimeOptions),
			HasConnectedComputer: live.HasConnectedComputer,
			OfflineComputers:     withOfflineComputers(live.OfflineComputers),
			PostSetup:            postSetup,
		}
	}

	// Complete, or roll back and start again. `reset` is offered only while
	// the workspace never crossed the agent checkpoint; past it a reset would
	// destroy real work, so it is not offered at all. (The reset endpoint
	// re-checks this itself — a projected field never authorizes demolition.)
	canReset := !live.EverHadAgent
	exits := make([]string, 0, 2)
	if canReset {
		exits = append(exits, SetupExitReset)
	}
	exits = append(exits, SetupExitReturnToServer)

	// A legacy `deferred` row is read as NON-blocking: the runtime no longer
	// produces defer, and re-locking a straggler row would lock out an owner
	// who had already bypassed (expand-contract, task #172).
	base := SetupProjection{
		Phase:                ptr(state.Status),
		BlocksChat:           state.Status != SetupStatusDeferred,
		AllowedExits:         exits,
		SideEffectState:      SideEffectState{Transitions: "enabled", Completion: "disabled"},
		ComputerStatus:       live.Computer,
		RuntimeStatus:        live.Runtime,
		RuntimeOptions:       withRuntimeOptions(live.RuntimeOptions),
		HasConnectedComputer: live.HasConnectedComputer,
		OfflineComputers:     withOfflineComputers(live.OfflineComputers),
		PostSetup:            postSetup,
	}

	if live.Computer != ComputerStateOnline {
		base.Surface = SetupSurfaceComputerRuntime
		base.CurrentStep = ptr(SetupSurfaceComputerRuntime)
		reason := GateReasonComputerStatusUnknown
		if live.Computer == ComputerStateOffline {
			reason = GateReasonComputerOffline
		}
		base.GateReason = ptr(reason)
		return base
	}

	if !isRuntimeReady(live.Runtime) {
		base.Surface = SetupSurfaceComputerRuntime
		base.CurrentStep = ptr(SetupSurfaceComputerRuntime)
		base.GateReason = ptr(runtimeGateReason(live.Runtime))
		return base
	}

	base.Surface = SetupSurfaceCreateAgent
	base.CurrentStep = ptr(SetupSurfaceCreateAgent)
	completion := "disabled"
	if live.OfficialOnboardingAgent == OfficialAgentStateUsable {
		completion = "enabled"
	}
	base.SideEffectState = SideEffectState{Transitions: "enabled", Completion: completion}
	base.GateReason = ptr(onboardingAgentGateReason(live.OfficialOnboardingAgent))
	return base
}

func withRuntimeOptions(opts []RuntimeSelectionOption) []RuntimeSelectionOption {
	if opts == nil {
		return []RuntimeSelectionOption{}
	}
	return opts
}

func withOfflineComputers(comps []OfflineComputer) []OfflineComputer {
	if comps == nil {
		return []OfflineComputer{}
	}
	return comps
}

// NextSetupStateForAction is the pure transition rule for the two remaining
// actions (TS nextStateForAction + the complete branch of the repository
// mutate callback). start is idempotent on in_progress, revives
// not_started/deferred, and can never regress complete; every fresh
// completion is reason=normal (complete_after_defer is no longer determined).
func NextSetupStateForAction(current SetupState, action string) SetupState {
	if current.Status == SetupStatusComplete {
		return current
	}
	if action != SetupActionComplete {
		next := current
		next.Status = SetupStatusInProgress
		next.CompletionReason = nil
		return next
	}
	next := current
	next.Status = SetupStatusComplete
	reason := SetupReasonNormal
	next.CompletionReason = &reason
	return next
}

// SetupTransitionAction values (TS ServerSetupAction). defer is retired.
const (
	SetupActionStart    = "start"
	SetupActionComplete = "complete"
)
