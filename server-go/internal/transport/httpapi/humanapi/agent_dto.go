// Agent DTO projection — the exact legacy JSON shape of the TS agents row
// plus the route-level projections (external, serverRole, creator,
// createdAgents, activity). Timestamps are ms-precision UTC ISO strings.
package humanapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"raft.local/server-go/internal/transport/httpapi/httpx"

	"raft.local/server-go/internal/agent"
)

// agentDTO is the wire row. lastRuntimeError and runtimeProfile are always
// null in this slice: no runtime-error or runtime-profile projection exists
// yet, and the DTO says so rather than fabricating one.
type agentDTO struct {
	ID               string                      `json:"id"`
	ServerID         string                      `json:"serverId"`
	Name             string                      `json:"name"`
	DisplayName      *string                     `json:"displayName"`
	AvatarURL        *string                     `json:"avatarUrl"`
	Description      *string                     `json:"description"`
	Status           string                      `json:"status"`
	StatusChangedAt  *string                     `json:"statusChangedAt"`
	SessionID        *string                     `json:"sessionId"`
	Model            string                      `json:"model"`
	Runtime          string                      `json:"runtime"`
	External         bool                        `json:"external"`
	ServerRole       *string                     `json:"serverRole"`
	RuntimeConfig    json.RawMessage             `json:"runtimeConfig"`
	LastRuntimeError *struct{}                   `json:"lastRuntimeError"`
	ReasoningEffort  *string                     `json:"reasoningEffort"`
	ExecutionMode    string                      `json:"executionMode"`
	EnvVars          json.RawMessage             `json:"envVars"`
	MachineID        *string                     `json:"machineId"`
	CreatorType      *string                     `json:"creatorType"`
	CreatorID        *string                     `json:"creatorId"`
	Creator          *agent.CreatorSummary       `json:"creator"`
	CreatedAgents    []agent.CreatedAgentSummary `json:"createdAgents"`
	DeletedAt        *string                     `json:"deletedAt"`
	CreatedAt        string                      `json:"createdAt"`
	UpdatedAt        string                      `json:"updatedAt"`
	Activity         string                      `json:"activity"`
	ActivityDetail   string                      `json:"activityDetail"`
	RuntimeProfile   *struct{}                   `json:"runtimeProfile"`
}

// guestAgentDTO is the bounded channel-summary profile (TS
// toGuestChannelAgentProfile).
type guestAgentDTO struct {
	ID                string  `json:"id"`
	ServerID          string  `json:"serverId"`
	Name              string  `json:"name"`
	DisplayName       *string `json:"displayName"`
	AvatarURL         *string `json:"avatarUrl"`
	Description       *string `json:"description"`
	Status            string  `json:"status"`
	DeletedAt         *string `json:"deletedAt"`
	CreatedAt         string  `json:"createdAt"`
	Activity          string  `json:"activity"`
	ActivityDetail    string  `json:"activityDetail"`
	ProfileProjection string  `json:"profileProjection"`
}

// agentActivity projects the honest status-derived activity: the persisted
// status is the only liveness fact this build has.
func agentActivity(a *agent.Agent) (activity, detail string) {
	if a.Status == agent.StatusActive {
		return "online", ""
	}
	if a.Status == agent.StatusStopped {
		return "offline", "Agent stopped by user"
	}
	return "offline", ""
}

// buildAgentDTO renders the full member projection. stripSecrets removes
// envVars/runtimeConfig for callers without editAgents/creator authority.
func (h *AgentHandlers) buildAgentDTO(ctx context.Context, a *agent.Agent, serverRole *string, stripSecrets bool) (*agentDTO, error) {
	activity, detail := agentActivity(a)
	dto := &agentDTO{
		ID:              a.ID,
		ServerID:        a.WorkspaceID,
		Name:            a.Name,
		DisplayName:     nullStringPtr(a.DisplayName),
		AvatarURL:       nullStringPtr(a.AvatarURL),
		Description:     nullStringPtr(a.Description),
		Status:          a.Status,
		SessionID:       nullStringPtr(a.SessionID),
		Model:           a.Model,
		Runtime:         a.Runtime,
		External:        agent.IsExternalAgentRuntime(a.Runtime),
		ServerRole:      serverRole,
		RuntimeConfig:   rawOrNull(a.RuntimeConfig),
		ReasoningEffort: nullStringPtr(a.ReasoningEffort),
		ExecutionMode:   a.ExecutionMode,
		EnvVars:         rawOrNull(a.EnvVars),
		MachineID:       nullStringPtr(a.MachineID),
		CreatorType:     nullStringPtr(a.CreatorType),
		CreatorID:       nullStringPtr(a.CreatorID),
		CreatedAgents:   []agent.CreatedAgentSummary{},
		CreatedAt:       httpx.ISOMillisStr(a.CreatedAt),
		UpdatedAt:       httpx.ISOMillisStr(a.UpdatedAt),
		Activity:        activity,
		ActivityDetail:  detail,
	}
	if a.StatusChangedAt.Valid {
		dto.StatusChangedAt = isoMillisPtr(a.StatusChangedAt.Int64)
	}
	if a.DeletedAt.Valid {
		dto.DeletedAt = isoMillisPtr(a.DeletedAt.Int64)
	}
	if stripSecrets {
		dto.EnvVars = nil
		dto.RuntimeConfig = nil
	}
	creator, err := h.Store.Creator(ctx, a)
	if err != nil {
		return nil, err
	}
	dto.Creator = creator
	created, err := h.Store.CreatedAgents(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	dto.CreatedAgents = created
	return dto, nil
}

// buildGuestAgentDTO renders the bounded guest projection.
func buildGuestAgentDTO(a *agent.Agent) *guestAgentDTO {
	activity, detail := agentActivity(a)
	dto := &guestAgentDTO{
		ID:                a.ID,
		ServerID:          a.WorkspaceID,
		Name:              a.Name,
		DisplayName:       nullStringPtr(a.DisplayName),
		AvatarURL:         nullStringPtr(a.AvatarURL),
		Description:       nullStringPtr(a.Description),
		Status:            a.Status,
		CreatedAt:         httpx.ISOMillisStr(a.CreatedAt),
		Activity:          activity,
		ActivityDetail:    detail,
		ProfileProjection: "channel_summary",
	}
	if a.DeletedAt.Valid {
		dto.DeletedAt = isoMillisPtr(a.DeletedAt.Int64)
	}
	return dto
}

func nullStringPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	value := v.String
	return &value
}

func rawOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

func isoMillisPtr(ms int64) *string {
	value := httpx.ISOMillisStr(ms)
	return &value
}
