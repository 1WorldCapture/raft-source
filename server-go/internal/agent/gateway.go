// The machine command gateway seam. The MACHINEWS hub satisfies this
// interface (IsOnline/Send per the coordination contract); the agent service
// depends on the interface, never on the transport. Wire payloads are the
// exact TS ServerToMachineMessage variants the existing daemon parses
// (packages/shared/src/index.ts) — agent:start, agent:stop,
// agent:reset-workspace and agent:purge.
package agent

import (
	"context"
	"database/sql"
	"encoding/json"
)

// Gateway is the minimal outbound machine-command surface satisfied by the
// MACHINEWS hub. Send must be bounded and must not hold a SQLite transaction.
type Gateway interface {
	// IsOnline reports whether the machine currently holds a live connection.
	IsOnline(machineID string) bool
	// Send delivers one ServerToMachineMessage payload to the machine.
	Send(ctx context.Context, machineID string, payload any) error
}

// AgentRuntimeContext is the config-embedded machine description
// (TS AgentConfig.runtimeContext).
type AgentRuntimeContext struct {
	AgentID            string  `json:"agentId"`
	ServerID           string  `json:"serverId"`
	MachineID          *string `json:"machineId"`
	MachineName        *string `json:"machineName"`
	MachineDescription *string `json:"machineDescription"`
	MachineHostname    *string `json:"machineHostname"`
	MachineOs          *string `json:"machineOs"`
	DaemonVersion      *string `json:"daemonVersion"`
	WorkspacePath      *string `json:"workspacePath"`
}

// AgentStartConfig is the AgentConfig frame the daemon spawns the runtime
// with (TS AgentConfig). authToken stays empty: the daemon authenticates
// with its own Computer/machine credential (TS: "Daemon will use its own API
// key"), and the per-agent runner credential is intentionally absent in this
// slice (no Computer-hosted mint surface yet).
type AgentStartConfig struct {
	Name            string              `json:"name"`
	DisplayName     *string             `json:"displayName"`
	Description     *string             `json:"description"`
	Model           string              `json:"model"`
	Runtime         string              `json:"runtime"`
	RuntimeConfig   json.RawMessage     `json:"runtimeConfig,omitempty"`
	ReasoningEffort *string             `json:"reasoningEffort"`
	ExecutionMode   string              `json:"executionMode,omitempty"`
	EnvVars         json.RawMessage     `json:"envVars"`
	SessionID       *string             `json:"sessionId"`
	ServerURL       string              `json:"serverUrl"`
	AuthToken       string              `json:"authToken"`
	RuntimeContext  AgentRuntimeContext `json:"runtimeContext"`
}

// MachineCommand carries the exact wire envelope for a machine command.
type MachineCommand struct {
	Type    string `json:"type"`
	AgentID string `json:"agentId,omitempty"`
	// Config is present for agent:start only.
	Config *AgentStartConfig `json:"config,omitempty"`
	// LaunchID is the server fence for this start (TS agent:start.launchId).
	// Empty for daemons older than 0.30.1, which never echo the field.
	LaunchID string `json:"launchId,omitempty"`
}

// Machine command types (TS ServerToMachineMessage variants).
const (
	MachineCommandStart          = "agent:start"
	MachineCommandStop           = "agent:stop"
	MachineCommandResetWorkspace = "agent:reset-workspace"
	MachineCommandPurge          = "agent:purge"
)

// NewStartCommand builds the agent:start payload for an agent. The machine
// projection pointers come from machineFields.
func NewStartCommand(a *Agent, serverURL string, machineName, machineDescription, machineHostname, machineOS, daemonVersion *string) MachineCommand {
	return MachineCommand{
		Type:    MachineCommandStart,
		AgentID: a.ID,
		Config: &AgentStartConfig{
			Name:            a.Name,
			DisplayName:     nullString(a.DisplayName),
			Description:     nullString(a.Description),
			Model:           a.Model,
			Runtime:         a.Runtime,
			RuntimeConfig:   a.RuntimeConfig,
			ReasoningEffort: nullString(a.ReasoningEffort),
			ExecutionMode:   a.ExecutionMode,
			EnvVars:         a.EnvVars,
			SessionID:       nullString(a.SessionID),
			ServerURL:       serverURL,
			AuthToken:       "",
			RuntimeContext: AgentRuntimeContext{
				AgentID:            a.ID,
				ServerID:           a.WorkspaceID,
				MachineID:          nullString(a.MachineID),
				MachineName:        machineName,
				MachineDescription: machineDescription,
				MachineHostname:    machineHostname,
				MachineOs:          machineOS,
				DaemonVersion:      daemonVersion,
				WorkspacePath:      nil,
			},
		},
	}
}

// NewStopCommand builds the agent:stop payload.
func NewStopCommand(agentID string) MachineCommand {
	return MachineCommand{Type: MachineCommandStop, AgentID: agentID}
}

// NewResetWorkspaceCommand builds the agent:reset-workspace payload.
func NewResetWorkspaceCommand(agentID string) MachineCommand {
	return MachineCommand{Type: MachineCommandResetWorkspace, AgentID: agentID}
}

// NewPurgeCommand builds the agent:purge payload.
func NewPurgeCommand(agentID string) MachineCommand {
	return MachineCommand{Type: MachineCommandPurge, AgentID: agentID}
}

func nullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	value := v.String
	return &value
}
