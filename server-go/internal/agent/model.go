// Package agent owns the M3B agent slice: agent identity, machine binding,
// lifecycle, `sk_agent_*` credentials and bootstrap tokens. It is a port of
// the TS surfaces in packages/server/src (routes/agents.ts, agentLogin.ts,
// agentCredentials.ts, agentDiscovery.ts, services/agentService.ts,
// services/agentCredentialService.ts and the identity part of
// routes/internalAgentApi.ts) onto the Go SQLite schema.
//
// Three principals stay strictly separate here: a human user (JWT), a
// Computer (sk_computer_*), and an Agent runner credential (sk_agent_*).
// Internal agent credentials are never user JWTs and never machine keys.
package agent

import (
	"database/sql"
	"encoding/json"
	"strings"
	"unicode"
)

// Persisted status values (TS AgentStatus). There is no "starting"/"error"
// status; runtime error state is a separate projection this slice does not own.
const (
	StatusActive   = "active"
	StatusInactive = "inactive"
	StatusStopped  = "stopped"
)

// Known reasoning-effort vocabulary (TS KnownReasoningEffort), the closed
// database-backed set persisted on agents.reasoning_effort.
var knownReasoningEfforts = map[string]bool{
	"low": true, "medium": true, "high": true, "xhigh": true, "max": true, "ultra": true,
}

// EXTERNAL_AGENT_RUNTIME_ID is the sentinel runtime for operator-run agents
// (TS EXTERNAL_AGENT_RUNTIME_ID). External agents never get a machine
// assigned and never use the managed start/stop lifecycle.
const EXTERNAL_AGENT_RUNTIME_ID = "external"

// IsExternalAgentRuntime mirrors isExternalAgentRuntime.
func IsExternalAgentRuntime(runtime string) bool {
	return strings.EqualFold(strings.TrimSpace(runtime), EXTERNAL_AGENT_RUNTIME_ID)
}

// runtimeInfo is the subset of the TS RUNTIMES catalog this slice enforces.
// Deprecation and disabled-ness gate creation/updates exactly like the TS
// route (deprecated runtimes cannot be selected for NEW agents but persist
// on existing rows).
type runtimeInfo struct {
	deprecated bool
}

var runtimes = map[string]runtimeInfo{
	"claude":      {},
	"codex":       {},
	"grok":        {},
	"builtin":     {},
	"antigravity": {deprecated: true},
	"kimi-sdk":    {},
	"kimi":        {deprecated: true},
	"copilot":     {},
	"cursor-sdk":  {},
	"gemini":      {deprecated: true},
	"opencode":    {},
	"pi":          {},
	"omp":         {},
}

// RuntimeKnown reports whether the id is in the TS RUNTIMES catalog.
func RuntimeKnown(id string) bool {
	_, ok := runtimes[id]
	return ok
}

// RuntimeDeprecated mirrors isRuntimeDeprecated.
func RuntimeDeprecated(id string) bool {
	info, ok := runtimes[id]
	return ok && info.deprecated
}

// runtimeFirstModels mirrors RUNTIME_MODELS[x][0].id — the default model the
// TS service persists when a create request leaves model unset (the SQL
// default 'sonnet' only applies to rows written without the product writer).
var runtimeFirstModels = map[string]string{
	"claude":      "opus",
	"codex":       "gpt-6-astra",
	"grok":        "grok-4.5",
	"antigravity": "default",
	"copilot":     "gpt-5.4",
	"cursor-sdk":  "default",
	"gemini":      "default",
	"opencode":    "default",
	"pi":          "default",
	"kimi":        "default",
	"kimi-sdk":    "kimi-code/kimi-for-coding",
	"omp":         "default",
	"builtin":     "default",
	"external":    "external",
}

// DefaultModelForRuntime mirrors getDefaultModel.
func DefaultModelForRuntime(runtimeID string) string {
	if id, ok := runtimeFirstModels[runtimeID]; ok {
		return id
	}
	return "sonnet"
}

// Reserved agent names (TS RESERVED_AGENT_NAMES, @-stripped, lowercased).
var reservedAgentNames = map[string]bool{
	"all": true, "human": true, "humans": true, "agent": true, "agents": true,
	"here": true, "idle": true, "busy": true, "system": true,
}

const (
	nameMinLength = 1
	nameMaxLength = 32
)

// validLetter matches the TS NAME_REGEX start / body classes for ASCII; Go
// port keeps the unicode intent: letters (unicode) first, then letters,
// digits, underscore or hyphen.
func validAgentName(name string) (reason string) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "Agent name is required"
	}
	if isReservedAgentName(trimmed) {
		return "Agent name @" + strings.ToLower(strings.TrimPrefix(trimmed, "@")) + " is reserved. Choose another name."
	}
	if len([]rune(trimmed)) > nameMaxLength {
		return "Agent name must be at most 32 characters"
	}
	runes := []rune(trimmed)
	first := runes[0]
	if !isLetter(first) {
		return "Agent name must start with a letter and can only contain letters, numbers, hyphens, and underscores"
	}
	for _, r := range runes {
		if !isLetter(r) && !isDigit(r) && r != '_' && r != '-' {
			return "Agent name must start with a letter and can only contain letters, numbers, hyphens, and underscores"
		}
	}
	return ""
}

func isReservedAgentName(name string) bool {
	normalized := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	return reservedAgentNames[normalized]
}

// isLetter matches \p{L} (unicode.IsLetter), the TS NAME_REGEX class.
func isLetter(r rune) bool { return unicode.IsLetter(r) }

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// Agent is the persisted agent row (Go column names). Nullable columns use
// sql.NullString/NullInt64 so the store layer never fabricates values.
type Agent struct {
	ID              string
	WorkspaceID     string
	Name            string
	DisplayName     sql.NullString
	Description     sql.NullString
	AvatarURL       sql.NullString
	Status          string
	StatusChangedAt sql.NullInt64
	SessionID       sql.NullString
	Model           string
	Runtime         string
	RuntimeConfig   json.RawMessage // canonical JSON or nil
	ReasoningEffort sql.NullString
	ExecutionMode   string
	EnvVars         json.RawMessage // canonical JSON object or nil
	CreatorType     sql.NullString
	CreatorID       sql.NullString
	MachineID       sql.NullString
	DeletedAt       sql.NullInt64
	CreatedAt       int64
	UpdatedAt       int64
}

// Official onboarding agent identity (TS officialOnboardingAgentIdentity).
const (
	OfficialAgentName        = "Cindy"
	OfficialAgentDisplayName = "Cindy"
	OfficialAgentDescription = "Onboarding Assistant"
	OfficialAgentAvatarURL   = "pixel:mug"
	OfficialAgentServerRole  = "admin"
)

// ServerRole values for workspace membership (human and agent).
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleGuest  = "guest"
)

// serverCapabilityKeys is the full TS SERVER_CAPABILITY_KEYS list; the
// matrix below is the frozen role->capability mapping this slice enforces.
var allServerCapabilities = []string{
	"viewChannel", "createChannels", "editChannelMetadata", "archiveChannels",
	"deleteChannels", "changeChannelVisibility", "manageGuestAccess", "federateChannels",
	"viewChannelMembers", "joinPublicChannels", "addChannelMembers", "removeChannelMembers",
	"changeChannelMemberRoles", "viewMembers", "inviteMembers", "removeMembers",
	"changeMemberRoles", "viewServerSettings", "editServerSettings", "manageIntegrations",
	"manageExternalAuth", "rotateServerSecrets", "viewAgents", "createAgents", "editAgents",
	"controlAgentRuntime", "resetAgentWorkspace", "deleteAgents", "migrateAgents",
	"issueAgentCredentials", "viewMachines", "registerMachines", "editMachines",
	"controlComputers", "removeMachines", "rotateMachineKeys", "assignTasks",
	"deleteAnyTask", "viewBilling", "manageBilling",
}

var memberServerCapabilities = map[string]bool{
	"viewChannel": true, "createChannels": true, "viewChannelMembers": true,
	"joinPublicChannels": true, "addChannelMembers": true, "viewMembers": true,
	"viewAgents": true, "controlAgentRuntime": true, "viewMachines": true,
	"assignTasks": true,
}

// HasServerCapability mirrors hasServerCapability for the four roles. Guest
// holds nothing; admin holds everything except manageBilling.
func HasServerCapability(role string, capability string) bool {
	switch role {
	case RoleOwner:
		return true
	case RoleAdmin:
		return capability != "manageBilling"
	case RoleMember:
		return memberServerCapabilities[capability]
	default:
		return false
	}
}

// ServerCapabilities returns the full frozen record for a role (or all-false
// for an unknown/absent role), the exact wire shape of getServerCapabilities.
func ServerCapabilities(role string) map[string]bool {
	out := make(map[string]bool, len(allServerCapabilities))
	for _, capability := range allServerCapabilities {
		out[capability] = HasServerCapability(role, capability)
	}
	return out
}

// CanChangeMemberRole mirrors shared canChangeMemberRole. Owner may set any
// role; admin may only promote a member to admin. Agents are never owners.
func CanChangeMemberRole(actorRole, targetRole, nextRole string) bool {
	if actorRole == "" || targetRole == "" {
		return false
	}
	if actorRole == RoleOwner {
		return true
	}
	if actorRole == RoleAdmin {
		return targetRole == RoleMember && nextRole == RoleAdmin
	}
	return false
}

// UserCanActOnAgentResource mirrors userCanActOnAgentResource: the capability
// OR human-creator authority over this specific agent.
func UserCanActOnAgentResource(role, userID string, a *Agent, capability string) bool {
	return HasServerCapability(role, capability) ||
		(a.CreatorType.Valid && a.CreatorType.String == "user" &&
			a.CreatorID.Valid && a.CreatorID.String == userID)
}

// Agent capabilities for `sk_agent_*` credentials (TS ALLOWED_AGENT_CAPABILITIES).
var AllowedAgentCapabilities = []string{
	"send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp",
}

var allowedAgentCapabilitySet = func() map[string]bool {
	set := make(map[string]bool, len(AllowedAgentCapabilities))
	for _, capability := range AllowedAgentCapabilities {
		set[capability] = true
	}
	return set
}()

// NormalizeAgentCapabilities validates and canonicalizes (dedup + sort) a
// submitted scope list; unknown literals are rejected.
func NormalizeAgentCapabilities(input []string) ([]string, bool) {
	seen := make(map[string]bool, len(input))
	for _, raw := range input {
		if !allowedAgentCapabilitySet[raw] {
			return nil, false
		}
		seen[raw] = true
	}
	out := make([]string, 0, len(seen))
	for capability := range seen {
		out = append(out, capability)
	}
	// deterministic order
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, true
}

// ValidateAgentName mirrors validateAgentName: the exact legacy error
// sentence, or "" when valid.
func ValidateAgentName(name string) string { return validAgentName(name) }

// KnownReasoningEffort reports membership in the closed vocabulary.
func KnownReasoningEffort(v string) bool { return knownReasoningEfforts[v] }
