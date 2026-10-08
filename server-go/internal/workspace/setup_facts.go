// Setup facts boundary — the read side of the setup state machine.
//
// Port of the TS resolvers in serverSetupStateService.ts:
//   - resolveServerSetupLiveFacts (the route wires the orchestrator version)
//   - resolvePersistedCompletionFacts (used for status=complete)
//   - resolveOfficialOnboardingAgentState (the "Cindy usable" definition, R19)
//   - resolveOwnerPostSetupFacts (survey / handoff, fail-open)
//
// Fact reads NEVER mutate setup state: no auto-complete, no messages, no
// agent creation (design doc 10.1). The one deliberate Go deviation is the
// machine-status source, injected per Store (never a mutable global).
package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// errNoLiveMachineConnection is the M2 stand-in for the TS orchestrator:
// there is no daemon/Computer connection layer yet, so online-ness can never
// be proven. The TS resolver maps a getMachineStatus failure to "unknown";
// Go answers "unknown" for every machine, which is the honest reading of a
// question this build cannot ask (design 2.2: never fabricate online state).
var errNoLiveMachineConnection = errors.New("no live machine connection layer in M2")

// probeMachineStatus returns unknown without a connection layer (M2), or
// asks the instance-local M3 presence provider. Multiple servers/tests sharing
// a process must never overwrite each other's view of live machines.
func (s *Store) probeMachineStatus(ctx context.Context, machineID string) (bool, error) {
	if s.machineStatusProbe == nil {
		return false, errNoLiveMachineConnection
	}
	return s.machineStatusProbe(ctx, machineID)
}

// isoMillis renders a millisecond-precision UTC ISO-8601 timestamp, the
// legacy JSON convention (JS Date.toISOString equivalent).
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// officialOnboardingAgentIdentity is the exact official identity contract
// (packages/server/src/services/officialOnboardingAgentIdentity.ts). The
// usable check is NOT "an agent named Cindy exists" nor "an agent is online":
// it is pointer + local + not deleted + machine + non-empty runtime + THIS
// identity + server-role admin.
const (
	officialOnboardingAgentName        = "Cindy"
	officialOnboardingAgentDisplayName = "Cindy"
	officialOnboardingAgentDescription = "Onboarding Assistant"
	officialOnboardingAgentAvatarURL   = "pixel:mug"
	officialOnboardingAgentServerRole  = "admin"
)

func hasOfficialOnboardingAgentIdentity(name, displayName, description, avatarURL sql.NullString, serverRole sql.NullString) bool {
	return name.Valid && name.String == officialOnboardingAgentName &&
		displayName.Valid && displayName.String == officialOnboardingAgentDisplayName &&
		description.Valid && description.String == officialOnboardingAgentDescription &&
		avatarURL.Valid && avatarURL.String == officialOnboardingAgentAvatarURL &&
		serverRole.Valid && serverRole.String == officialOnboardingAgentServerRole
}

// workspaceAgentRow is the official-agent lookup result.
type workspaceAgentRow struct {
	Name        sql.NullString
	DisplayName sql.NullString
	Description sql.NullString
	AvatarURL   sql.NullString
	MachineID   sql.NullString
	Runtime     string
	ServerRole  sql.NullString
}

// resolveOfficialAgentState ports resolveOfficialOnboardingAgentState:
//
//	missing  = workspace gone (deleted) or pointer null
//	unknown  = only when the workspace row itself is unreadable/absent in the
//	           initial lookup while a pointer exists is impossible; TS keeps
//	           "unknown" as the initial value when no server row matched.
//	usable   = agent row found, machine bound, runtime non-blank, identity ok
//	unusable = pointer set but any condition fails
func (s *Store) resolveOfficialAgentState(ctx context.Context, q executor, workspaceID string) (string, error) {
	var onboardingAgentID sql.NullString
	err := q.QueryRowContext(ctx, `
		SELECT onboarding_agent_id FROM workspaces
		WHERE id = ? AND deleted_at IS NULL`, workspaceID).Scan(&onboardingAgentID)
	if errors.Is(err, sql.ErrNoRows) {
		// TS: server missing while resolving the pointer keeps "unknown".
		return OfficialAgentStateUnknown, nil
	}
	if err != nil {
		return "", fmt.Errorf("read workspace onboarding agent: %w", err)
	}
	if !onboardingAgentID.Valid || onboardingAgentID.String == "" {
		return OfficialAgentStateMissing, nil
	}

	var agent workspaceAgentRow
	err = q.QueryRowContext(ctx, `
		SELECT a.name, a.display_name, a.description, a.avatar_url,
		       a.machine_id, a.runtime, am.role
		FROM agents a
		LEFT JOIN agent_members am
		       ON am.workspace_id = a.workspace_id AND am.agent_id = a.id
		WHERE a.id = ? AND a.workspace_id = ? AND a.deleted_at IS NULL`,
		onboardingAgentID.String, workspaceID).
		Scan(&agent.Name, &agent.DisplayName, &agent.Description, &agent.AvatarURL,
			&agent.MachineID, &agent.Runtime, &agent.ServerRole)
	if errors.Is(err, sql.ErrNoRows) {
		return OfficialAgentStateUnusable, nil
	}
	if err != nil {
		return "", fmt.Errorf("read onboarding agent: %w", err)
	}
	usable := agent.MachineID.Valid && agent.MachineID.String != "" &&
		strings.TrimSpace(agent.Runtime) != "" &&
		hasOfficialOnboardingAgentIdentity(agent.Name, agent.DisplayName, agent.Description, agent.AvatarURL, agent.ServerRole)
	if usable {
		return OfficialAgentStateUsable, nil
	}
	return OfficialAgentStateUnusable, nil
}

// ownerPostSetupFacts mirrors resolveOwnerPostSetupFacts. Fail-open like TS:
// an unreadable survey must never lock an owner out of their workspace, so
// unreadable facts owe nothing. The handoff is owed until the OWNER pressed
// "Let's Go" — a missing setup row counts as still owed (TS !prefs?.…ack).
type ownerPostSetupFacts struct {
	OwnerSurveyPending  bool
	OwnerHandoffPending bool
	ActorIsOwner        bool
}

func resolveOwnerPostSetupFacts(ctx context.Context, q executor, workspaceID, actorUserID string) (ownerPostSetupFacts, error) {
	var ownerID string
	err := q.QueryRowContext(ctx, `SELECT owner_id FROM workspaces WHERE id = ?`, workspaceID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ownerPostSetupFacts{}, nil
	}
	if err != nil {
		return ownerPostSetupFacts{}, fmt.Errorf("read workspace owner: %w", err)
	}

	// TS: ownerSurveyPending = !!owner && owner.signupSurveyCompletedAt ===
	// null — the owner ROW must exist and the answer still be unanswered; a
	// missing owner row owes nothing.
	ownerRowExists := true
	var signupSurveyCompletedAt sql.NullInt64
	err = q.QueryRowContext(ctx,
		`SELECT signup_survey_completed_at FROM users WHERE id = ?`, ownerID).
		Scan(&signupSurveyCompletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		ownerRowExists = false
	} else if err != nil {
		return ownerPostSetupFacts{}, fmt.Errorf("read owner survey: %w", err)
	}

	// The handoff is owed until the owner PRESSES "Let's Go". A missing setup
	// row counts as still owed (TS !prefs?.setupHandoffAcknowledgedAt).
	var handoffAck sql.NullInt64
	err = q.QueryRowContext(ctx, `
		SELECT handoff_acknowledged_at FROM workspace_member_setup
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, ownerID).Scan(&handoffAck)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ownerPostSetupFacts{}, fmt.Errorf("read owner handoff: %w", err)
	}

	return ownerPostSetupFacts{
		OwnerSurveyPending:  ownerRowExists && !signupSurveyCompletedAt.Valid,
		OwnerHandoffPending: !handoffAck.Valid,
		ActorIsOwner:        actorUserID == ownerID,
	}, nil
}

// machineRuntimesRow is one machine's persisted runtime report.
type machineRuntimesRow struct {
	ID       string
	Runtimes []byte // JSON array; SQL NULL → nil
}

func decodeMachineRuntimes(raw []byte) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// connectedComputerRow is a non-revoked computer with its machine heartbeat.
type connectedComputerRow struct {
	ID            string
	Name          string
	MachineID     sql.NullString
	LastHeartbeat sql.NullInt64
}

// ResolveSetupLiveFacts ports resolveServerSetupLiveFacts (orchestrator
// version, which is what the legacy route wires):
//   - online-ness is revocation-aware and keyed off the NON-REVOKED
//     computers' machine ids (a revoked row never filters a fresh one);
//   - offline computers are listed BY NAME from the same table that answers
//     hasConnectedComputer (one question, one source);
//   - runtime facts are read from the persisted machines.runtimes column of
//     the online machines;
//   - everHadAgent is the workspace's onboarding-agent pointer (deleted
//     agents keep counting — what happened, happened);
//   - the official-agent state is resolved separately.
func (s *Store) ResolveSetupLiveFacts(ctx context.Context, q executor, workspaceID, actorUserID string) (SetupLiveFacts, error) {
	facts := SetupLiveFacts{
		Computer:                ComputerStateOffline,
		OfflineComputers:        []OfflineComputer{},
		RuntimeOptions:          []RuntimeSelectionOption{},
		OfficialOnboardingAgent: OfficialAgentStateUnknown,
	}

	machineRows, err := q.QueryContext(ctx,
		`SELECT id, runtimes FROM machines WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return facts, fmt.Errorf("read machines: %w", err)
	}
	type machineStatus struct {
		id     string
		online bool
		known  bool // false = probe failed → "unknown"
	}
	var machines []machineStatus
	runtimesByID := make(map[string][]byte)
	for machineRows.Next() {
		var row machineRuntimesRow
		if err := machineRows.Scan(&row.ID, &row.Runtimes); err != nil {
			machineRows.Close()
			return facts, fmt.Errorf("scan machine: %w", err)
		}
		runtimesByID[row.ID] = row.Runtimes
		online, probeErr := s.probeMachineStatus(ctx, row.ID)
		machines = append(machines, machineStatus{id: row.ID, online: online && probeErr == nil, known: probeErr == nil})
	}
	if err := machineRows.Err(); err != nil {
		machineRows.Close()
		return facts, fmt.Errorf("iterate machines: %w", err)
	}
	machineRows.Close()

	computerRows, err := q.QueryContext(ctx, `
		SELECT c.id, c.name, c.machine_id, m.last_heartbeat
		FROM computers c
		LEFT JOIN machines m ON m.id = c.machine_id
		WHERE c.workspace_id = ? AND c.revoked_at IS NULL`, workspaceID)
	if err != nil {
		return facts, fmt.Errorf("read computers: %w", err)
	}
	var connected []connectedComputerRow
	for computerRows.Next() {
		var row connectedComputerRow
		if err := computerRows.Scan(&row.ID, &row.Name, &row.MachineID, &row.LastHeartbeat); err != nil {
			computerRows.Close()
			return facts, fmt.Errorf("scan computer: %w", err)
		}
		connected = append(connected, row)
	}
	if err := computerRows.Err(); err != nil {
		computerRows.Close()
		return facts, fmt.Errorf("iterate computers: %w", err)
	}
	computerRows.Close()

	facts.HasConnectedComputer = len(connected) > 0

	onlineMachineIDs := make(map[string]bool, len(machines))
	for _, m := range machines {
		if m.online {
			onlineMachineIDs[m.id] = true
		}
	}
	offline := make([]OfflineComputer, 0, len(connected))
	for _, c := range connected {
		linkedAndOnline := c.MachineID.Valid && onlineMachineIDs[c.MachineID.String]
		if !linkedAndOnline {
			var heartbeat *string
			if c.LastHeartbeat.Valid {
				v := isoMillis(time.UnixMilli(c.LastHeartbeat.Int64))
				heartbeat = &v
			}
			off := OfflineComputer{ID: c.ID, Name: c.Name, LastHeartbeat: heartbeat, IsComputer: true}
			offline = append(offline, off)
		}
	}
	facts.OfflineComputers = offline

	// Online-ness for the setup surface keys off the machines the NON-REVOKED
	// computers reference (not "has any computers row"): a same-machine
	// re-setup mints a fresh row and legitimately comes back online.
	connectedMachineIDs := make(map[string]bool, len(connected))
	for _, c := range connected {
		if c.MachineID.Valid && c.MachineID.String != "" {
			connectedMachineIDs[c.MachineID.String] = true
		}
	}
	onlineConnected := 0
	unknownConnected := false
	onlineConnectedRuntimes := make([]MachineRuntimeReport, 0, len(connected))
	for _, m := range machines {
		if !connectedMachineIDs[m.id] {
			continue
		}
		switch {
		case m.online:
			onlineConnected++
			ids, err := decodeMachineRuntimes(runtimesByID[m.id])
			if err != nil {
				return facts, fmt.Errorf("machine %s has unparseable runtimes: %w", m.id, err)
			}
			onlineConnectedRuntimes = append(onlineConnectedRuntimes, MachineRuntimeReport{
				Reported:   runtimesByID[m.id] != nil,
				RuntimeIDs: ids,
			})
		case !m.known:
			unknownConnected = true
		}
	}
	switch {
	case onlineConnected > 0:
		facts.Computer = ComputerStateOnline
	case unknownConnected:
		facts.Computer = ComputerStateUnknown
	default:
		facts.Computer = ComputerStateOffline
	}

	if facts.Computer == ComputerStateOnline {
		state, options := ResolveSetupRuntime(onlineConnectedRuntimes, DefaultRuntimeAdmissionPolicy())
		facts.Runtime = state
		facts.RuntimeOptions = options
	} else {
		facts.Runtime = RuntimeStateUnknown
		facts.RuntimeOptions = []RuntimeSelectionOption{}
	}

	var onboardingAgentID sql.NullString
	err = q.QueryRowContext(ctx,
		`SELECT onboarding_agent_id FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
		workspaceID).Scan(&onboardingAgentID)
	if errors.Is(err, sql.ErrNoRows) {
		facts.EverHadAgent = false
	} else if err != nil {
		return facts, fmt.Errorf("read workspace agent pointer: %w", err)
	} else {
		facts.EverHadAgent = onboardingAgentID.Valid && onboardingAgentID.String != ""
	}

	officialState, err := s.resolveOfficialAgentState(ctx, q, workspaceID)
	if err != nil {
		return facts, err
	}
	facts.OfficialOnboardingAgent = officialState

	postSetup, err := resolveOwnerPostSetupFacts(ctx, q, workspaceID, actorUserID)
	if err != nil {
		return facts, err
	}
	facts.OwnerSurveyPending = postSetup.OwnerSurveyPending
	facts.OwnerHandoffPending = postSetup.OwnerHandoffPending
	facts.ActorIsOwner = postSetup.ActorIsOwner
	return facts, nil
}

// ResolvePersistedCompletionFacts ports resolvePersistedCompletionFacts: the
// fact set the resolver uses once status=complete. The completed owner's
// resolver does NOT re-read live machine inventory (D09): computer facts
// degrade to unknown and everHadAgent fails CLOSED — an unasked question must
// never authorize a demolition. The official-agent state is still resolved
// from persisted rows.
func (s *Store) ResolvePersistedCompletionFacts(ctx context.Context, q executor, workspaceID, actorUserID string) (SetupLiveFacts, error) {
	officialState, err := s.resolveOfficialAgentState(ctx, q, workspaceID)
	if err != nil {
		return SetupLiveFacts{}, err
	}
	postSetup, err := resolveOwnerPostSetupFacts(ctx, q, workspaceID, actorUserID)
	if err != nil {
		return SetupLiveFacts{}, err
	}
	return SetupLiveFacts{
		Computer:                ComputerStateUnknown,
		HasConnectedComputer:    false,
		OfflineComputers:        []OfflineComputer{},
		EverHadAgent:            true,
		Runtime:                 RuntimeStateUnknown,
		RuntimeOptions:          []RuntimeSelectionOption{},
		OfficialOnboardingAgent: officialState,
		OwnerSurveyPending:      postSetup.OwnerSurveyPending,
		OwnerHandoffPending:     postSetup.OwnerHandoffPending,
		ActorIsOwner:            postSetup.ActorIsOwner,
	}, nil
}
