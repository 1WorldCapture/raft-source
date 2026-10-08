// HTTP handlers for the M3B agent surface: the /api/agents routes (create
// Cindy/generic agent, list/detail/settings, machine assignment, lifecycle),
// the CLI credential surfaces (manageable discovery, per-agent sk_agent_*
// mint/list/revoke, bootstrap tokens) and the /internal/computer/runners
// control plane. Ported from packages/server/src/routes/agents.ts,
// agentCredentials.ts, agentDiscovery.ts and internalComputer.ts; domain
// rules live in internal/agent.
package legacyweb

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/runtimecatalog"
)

// AgentHandlers serves the agent identity surface.
type AgentHandlers struct {
	Store   *agent.Store
	Service *agent.Service

	// Computers authenticates the /internal/computer/runners control plane
	// (sk_computer_* canonical, sk_machine_* phase-1 alias). nil keeps those
	// routes honestly unavailable (503), never unauthenticated.
	Computers *ComputerHandlers

	// RuntimeCatalog is the live builtin/kimi detect seam. Nil skips detect
	// for a valid form ref (parent has not wired the broker yet) and still
	// refuses a kimi reasoning effort that needs a live catalog.
	RuntimeCatalog *runtimecatalog.Broker

	// AvatarDir is the private data directory for content-addressed PNG
	// avatars. Empty refuses the upload after the capability check.
	AvatarDir string
}

const maxAgentDescriptionLength = 3000

var machineIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// agentScope is the requireServer equivalent for /api/agents: X-Server-Id
// header + live membership. The resolved scope lives in the request context.
func (h *AgentHandlers) agentScope(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := r.Header.Get("X-Server-Id")
		if serverID == "" {
			writeError(w, http.StatusBadRequest, "Missing X-Server-Id header")
			return
		}
		role, err := h.Store.MemberRole(r.Context(), serverID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to load server membership")
			return
		}
		if role == nil {
			writeError(w, http.StatusForbidden, "Not a member of this server")
			return
		}
		ctx := withAgentScope(r.Context(), serverID, *role)
		next(w, r.WithContext(ctx))
	}
}

// agentGuestGate mirrors the router-level gate: guests reach only the list
// and detail reads; every other method on this surface is denied.
func (h *AgentHandlers) agentGuestGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope := agentScopeOf(r)
		if scope.Role == agent.RoleGuest {
			segments := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			// List is /api/agents. Detail is /api/agents/{id}, including a
			// soft-deleted profile. Longer paths stay denied.
			isPublicRead := r.Method == http.MethodGet &&
				(len(segments) == 2 || (len(segments) == 3 && segments[1] == "agents"))
			if !isPublicRead {
				writeError(w, http.StatusForbidden, "Guests cannot access the server Agent directory")
				return
			}
		}
		next(w, r)
	}
}

// fetchAgent loads the agent and enforces the workspace isolation the TS
// handlers apply (agent.serverId must equal the scope; 404 otherwise).
func (h *AgentHandlers) fetchAgent(w http.ResponseWriter, r *http.Request, includeDeleted bool) (*agent.Agent, bool) {
	scope := agentScopeOf(r)
	loaded, err := h.Store.GetAgent(r.Context(), r.PathValue("id"), includeDeleted)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get agent")
		return nil, false
	}
	if loaded == nil || loaded.WorkspaceID != scope.WorkspaceID {
		writeError(w, http.StatusNotFound, "Agent not found")
		return nil, false
	}
	return loaded, true
}

// canEditAgent is the editAgents-or-creator authority used by the settings,
// adoption and observability reads.
func (h *AgentHandlers) canEditAgent(r *http.Request, a *agent.Agent) bool {
	scope := agentScopeOf(r)
	return agent.UserCanActOnAgentResource(scope.Role, userID(r), a, "editAgents")
}

// respondAgentDTO writes the enriched member projection (200).
func (h *AgentHandlers) respondAgentDTO(w http.ResponseWriter, r *http.Request, a *agent.Agent, serverRole *string) {
	strip := !h.canEditAgent(r, a)
	dto, err := h.buildAgentDTO(r.Context(), a, serverRole, strip)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to load agent")
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

// List handles GET /api/agents.
func (h *AgentHandlers) List(w http.ResponseWriter, r *http.Request) {
	scope := agentScopeOf(r)
	agents, err := h.Store.ListAgents(r.Context(), scope.WorkspaceID, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list agents")
		return
	}
	if scope.Role == agent.RoleGuest {
		visible, err := h.Store.GuestVisibleAgentIDs(r.Context(), scope.WorkspaceID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list agents")
			return
		}
		out := []*guestAgentDTO{}
		for _, a := range agents {
			if visible[a.ID] {
				out = append(out, buildGuestAgentDTO(a))
			}
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	out := make([]*agentDTO, 0, len(agents))
	for _, a := range agents {
		role, err := h.Store.AgentMemberRole(r.Context(), scope.WorkspaceID, a.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list agents")
			return
		}
		dto, err := h.buildAgentDTO(r.Context(), a, role, !agent.UserCanActOnAgentResource(scope.Role, userID(r), a, "editAgents"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list agents")
			return
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

// Get handles GET /api/agents/{id}. Soft-deleted agents stay readable (TS
// getAgent(id, true)) for members; guests get the bounded channel profile.
func (h *AgentHandlers) Get(w http.ResponseWriter, r *http.Request) {
	scope := agentScopeOf(r)
	loaded, ok := h.fetchAgent(w, r, true)
	if !ok {
		return
	}
	if scope.Role == agent.RoleGuest {
		visible, err := h.Store.GuestVisibleAgentIDs(r.Context(), scope.WorkspaceID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to get agent")
			return
		}
		if !visible[loaded.ID] {
			writeError(w, http.StatusNotFound, "Agent not found")
			return
		}
		writeJSON(w, http.StatusOK, buildGuestAgentDTO(loaded))
		return
	}
	role, err := h.Store.AgentMemberRole(r.Context(), scope.WorkspaceID, loaded.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get agent")
		return
	}
	h.respondAgentDTO(w, r, loaded, role)
}

// createAgentBody is the create request payload (raw JSON-decoded fields).
type createAgentBody struct {
	Name              *string         `json:"name"`
	Description       *string         `json:"description"`
	Model             *string         `json:"model"`
	Runtime           *string         `json:"runtime"`
	RuntimeConfig     json.RawMessage `json:"runtimeConfig"`
	FormDefinitionRef json.RawMessage `json:"formDefinitionRef"`
	ReasoningEffort   *string         `json:"reasoningEffort"`
	MachineID         *string         `json:"machineId"`
	EnvVars           json.RawMessage `json:"envVars"`
	AvatarURL         *string         `json:"avatarUrl"`
	Onboarding        bool            `json:"onboarding"`
	External          bool            `json:"external"`
}

// Create handles POST /api/agents (generic and official onboarding agent).
func (h *AgentHandlers) Create(w http.ResponseWriter, r *http.Request) {
	scope := agentScopeOf(r)
	if !agent.HasServerCapability(scope.Role, "createAgents") {
		writeError(w, http.StatusForbidden, "The `createAgents` capability is required to create agents")
		return
	}
	// Snapshot the owner's setup status for the create-vs-reset CAS; the
	// store re-reads it inside the transaction and 409s on mismatch.
	expected, err := h.Store.OwnerSetupStatus(r.Context(), scope.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to create agent")
		return
	}

	var body createAgentBody
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.External && body.Onboarding {
		writeError(w, http.StatusBadRequest, "Onboarding agent cannot be external")
		return
	}

	name := ""
	if body.Name != nil {
		name = *body.Name
	}
	description := body.Description
	avatarURL := body.AvatarURL
	if body.Onboarding {
		name = agent.OfficialAgentName
		officialDescription := agent.OfficialAgentDescription
		description = &officialDescription
		officialAvatar := agent.OfficialAgentAvatarURL
		avatarURL = &officialAvatar
	}
	if message := agent.ValidateAgentName(name); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if description != nil && len([]rune(*description)) > maxAgentDescriptionLength {
		writeError(w, http.StatusBadRequest, "Description must be a string of at most 3000 characters")
		return
	}
	if avatarURL != nil && !strings.HasPrefix(*avatarURL, "pixel:") {
		writeError(w, http.StatusBadRequest, "avatarUrl must be a pixel: URL at creation time")
		return
	}
	if body.External && len(body.FormDefinitionRef) > 0 {
		writeErrorIssues(w, http.StatusBadRequest, "External agents cannot use runtime form definitions",
			"external_form_definition_forbidden", []Issue{{Path: "/formDefinitionRef"}})
		return
	}
	runtimeConfigRuntime := runtimeConfigRuntimeOf(body.RuntimeConfig)
	if !body.External && runtimeConfigRuntime == "builtin" && len(body.FormDefinitionRef) == 0 {
		writeErrorIssues(w, http.StatusConflict, "This runtime requires a runtime form definition reference",
			"form_definition_ref_required", []Issue{{Path: "/formDefinitionRef"}})
		return
	}
	formRuntime := normalizedRuntimeIdentity(body.RuntimeConfig, body.Runtime, "")
	if rejectFormDefinitionRef(w, body.FormDefinitionRef, formRuntime) {
		return
	}
	if !body.External && formRuntime == "kimi-sdk" && len(body.FormDefinitionRef) == 0 &&
		body.ReasoningEffort != nil && strings.TrimSpace(*body.ReasoningEffort) != "" {
		writeFormCode(w, http.StatusConflict, "Update Raft on this device before changing Kimi reasoning settings",
			"upgrade_required", []runtimecatalog.Issue{{
				Code: "kimi_reasoning_effort_upgrade_required", Pointer: "/formDefinitionRef",
			}})
		return
	}

	// External agents: the only admitted launch shape is the sentinel
	// runtime with its fixed model and no machine.
	if body.External {
		if body.MachineID != nil && *body.MachineID != "" {
			writeError(w, http.StatusBadRequest, "External agents cannot be assigned to a Computer")
			return
		}
		if body.Runtime != nil && *body.Runtime != "" && !agent.IsExternalAgentRuntime(*body.Runtime) {
			writeError(w, http.StatusBadRequest, "External agents cannot select a managed runtime")
			return
		}
		created, err := h.Store.CreateAgent(r.Context(), agent.CreateAgentInput{
			WorkspaceID:              scope.WorkspaceID,
			Name:                     strings.TrimSpace(name),
			Description:              description,
			Runtime:                  agent.EXTERNAL_AGENT_RUNTIME_ID,
			AvatarURL:                avatarURL,
			CreatorType:              "user",
			CreatorID:                userID(r),
			ExpectedOwnerSetupStatus: expected,
		})
		if err != nil {
			h.writeCreateError(w, err)
			return
		}
		h.respondAgentDTO(w, r, created, rolePtr("member"))
		return
	}

	// Managed path.
	if body.ReasoningEffort != nil && *body.ReasoningEffort != "" &&
		runtimeConfigRuntime != "kimi-sdk" && !agent.KnownReasoningEffort(*body.ReasoningEffort) {
		writeError(w, http.StatusBadRequest, "Invalid reasoning effort: "+*body.ReasoningEffort)
		return
	}
	envVars, envErr := parseAgentEnvVars(body.EnvVars)
	if envErr != "" {
		writeError(w, http.StatusBadRequest, envErr)
		return
	}
	// The official agent carries the documented memory seed exactly like the
	// TS create (SLOCK_ONBOARDING_MEMORY_SEED=first-cindy).
	if body.Onboarding {
		seeded := withOnboardingMemorySeed(envVars)
		envVars = seeded
	}
	machineID := (*string)(nil)
	if body.MachineID != nil && *body.MachineID != "" {
		if !machineIDPattern.MatchString(*body.MachineID) {
			writeError(w, http.StatusBadRequest, "Invalid machineId: must be a UUID")
			return
		}
		machine, err := h.Store.GetMachine(r.Context(), scope.WorkspaceID, *body.MachineID)
		if err != nil || machine == nil {
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to create agent")
				return
			}
			writeError(w, http.StatusBadRequest, "Machine not found in this server")
			return
		}
		value := *body.MachineID
		machineID = &value
	}

	runtime := "claude"
	if body.Runtime != nil && strings.TrimSpace(*body.Runtime) != "" {
		runtime = strings.TrimSpace(*body.Runtime)
	} else if formRuntime != "" {
		runtime = formRuntime
	}
	if runtime == "" || !agent.RuntimeKnown(runtime) {
		writeError(w, http.StatusBadRequest, "Invalid runtime: "+runtime)
		return
	}
	if agent.RuntimeDeprecated(runtime) {
		writeError(w, http.StatusBadRequest, "Runtime is deprecated and cannot be selected: "+runtime)
		return
	}
	if len(body.RuntimeConfig) > 0 && !isJSONObject(body.RuntimeConfig) {
		writeError(w, http.StatusBadRequest, "Runtime configuration is invalid")
		return
	}

	effort := ""
	if body.ReasoningEffort != nil {
		effort = *body.ReasoningEffort
	}
	assignedMachine := ""
	if machineID != nil {
		assignedMachine = *machineID
	}
	if !h.admitRuntimeCatalog(w, r, runtime, assignedMachine, effort, body.RuntimeConfig) {
		return
	}

	if body.Onboarding {
		if pointer, err := h.Store.OnboardingAgentID(r.Context(), scope.WorkspaceID); err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create agent")
			return
		} else if pointer != nil {
			existing, err := h.Store.GetAgent(r.Context(), *pointer, false)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Failed to create agent")
				return
			}
			if existing != nil && existing.WorkspaceID == scope.WorkspaceID {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error":             "Onboarding agent already exists in this server",
					"onboardingAgentId": existing.ID,
				})
				return
			}
		}
		cindyTaken, err := h.Store.ActiveAgentNamedCindy(r.Context(), scope.WorkspaceID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create agent")
			return
		}
		if cindyTaken {
			writeError(w, http.StatusConflict, "Cindy agent already exists in this server")
			return
		}
	}

	created, err := h.Store.CreateAgent(r.Context(), agent.CreateAgentInput{
		WorkspaceID:              scope.WorkspaceID,
		Name:                     strings.TrimSpace(name),
		Description:              description,
		Model:                    body.Model,
		Runtime:                  runtime,
		RuntimeConfig:            body.RuntimeConfig,
		ReasoningEffort:          body.ReasoningEffort,
		MachineID:                machineID,
		EnvVars:                  envVars,
		AvatarURL:                avatarURL,
		CreatorType:              "user",
		CreatorID:                userID(r),
		Onboarding:               body.Onboarding,
		ExpectedOwnerSetupStatus: expected,
	})
	if err != nil {
		h.writeCreateError(w, err)
		return
	}

	// Auto-start after create when a machine is bound (TS startAgent with
	// failure logged, never blocking the create response).
	if created.MachineID.Valid && created.MachineID.String != "" && !agent.IsExternalAgentRuntime(created.Runtime) {
		if err := h.Service.Start(r.Context(), created); err != nil {
			// Log-only, exactly like the TS create path.
			scopeLog(r, "agent auto-start after create did not dispatch", created.ID, err)
		}
	}

	role := "member"
	if body.Onboarding {
		role = agent.OfficialAgentServerRole
	}
	h.respondAgentDTO(w, r, created, rolePtr(role))
}

// writeCreateError maps store/domain failures to the legacy bodies.
func (h *AgentHandlers) writeCreateError(w http.ResponseWriter, err error) {
	if domain := agent.AsError(err); domain != nil {
		message := domain.Message
		if domain.Code == "SERVER_SETUP_CHANGED_RETRY" {
			message = domain.Code
		}
		writeError(w, domain.Status, message)
		return
	}
	writeError(w, http.StatusInternalServerError, "Failed to create agent")
}

// ---------------------------------------------------------------------------
// Settings (PATCH /api/agents/{id})
// ---------------------------------------------------------------------------

// patchAgentBody is the update payload; absent fields keep their value.
type patchAgentBody struct {
	DisplayName       *string         `json:"displayName"`
	Description       *string         `json:"description"`
	AvatarURL         *string         `json:"avatarUrl"` // JSON null clears
	Model             *string         `json:"model"`
	Runtime           *string         `json:"runtime"`
	RuntimeConfig     json.RawMessage `json:"runtimeConfig"`
	FormDefinitionRef json.RawMessage `json:"formDefinitionRef"`
	ReasoningEffort   *string         `json:"reasoningEffort"` // null clears
	EnvVars           json.RawMessage `json:"envVars"`         // null clears, object sets
	RestartMode       *string         `json:"restartMode"`
	ServerRole        *string         `json:"serverRole"`
}

// Update handles PATCH /api/agents/{id}.
func (h *AgentHandlers) Update(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	if !h.canEditAgent(r, loaded) {
		writeError(w, http.StatusForbidden, "The `editAgents` capability or human creator authority is required to edit agents")
		return
	}
	var body patchAgentBody
	if !decodeJSONBody(w, r, &body) {
		return
	}
	scope := agentScopeOf(r)

	runtimeTouched := body.Runtime != nil || len(body.RuntimeConfig) > 0 || body.Model != nil ||
		body.ReasoningEffort != nil || len(body.EnvVars) > 0
	if agent.IsExternalAgentRuntime(loaded.Runtime) && runtimeTouched {
		writeError(w, http.StatusBadRequest, "External agent runtime fields are immutable")
		return
	}
	if body.Description != nil && len([]rune(*body.Description)) > maxAgentDescriptionLength {
		writeError(w, http.StatusBadRequest, "Description must be a string of at most 3000 characters")
		return
	}
	nextRuntime := loaded.Runtime
	if body.Runtime != nil && *body.Runtime != "" {
		if !agent.RuntimeKnown(*body.Runtime) {
			writeError(w, http.StatusBadRequest, "Invalid runtime: "+*body.Runtime)
			return
		}
		nextRuntime = *body.Runtime
	}
	if body.ReasoningEffort != nil && *body.ReasoningEffort != "" &&
		!agent.KnownReasoningEffort(*body.ReasoningEffort) {
		writeError(w, http.StatusBadRequest, "Invalid reasoning effort: "+*body.ReasoningEffort)
		return
	}
	if body.RestartMode != nil && *body.RestartMode != "restart" && *body.RestartMode != "session" {
		writeError(w, http.StatusBadRequest, "Invalid restart mode: "+*body.RestartMode)
		return
	}
	formRuntime := normalizedRuntimeIdentity(body.RuntimeConfig, body.Runtime, loaded.Runtime)
	if rejectFormDefinitionRef(w, body.FormDefinitionRef, formRuntime) {
		return
	}
	if formRuntime == "kimi-sdk" && len(body.FormDefinitionRef) == 0 &&
		body.ReasoningEffort != nil && strings.TrimSpace(*body.ReasoningEffort) != "" {
		writeFormCode(w, http.StatusConflict, "Update Raft on this device before changing Kimi reasoning settings",
			"upgrade_required", []runtimecatalog.Issue{{
				Code: "kimi_reasoning_effort_upgrade_required", Pointer: "/formDefinitionRef",
			}})
		return
	}
	runtimeChanged := nextRuntime != loaded.Runtime
	runtimeConfigRuntime := runtimeConfigRuntimeOf(body.RuntimeConfig)
	if !agent.IsExternalAgentRuntime(loaded.Runtime) && !agent.IsExternalAgentRuntime(nextRuntime) &&
		runtimeConfigRuntime == "builtin" && len(body.FormDefinitionRef) == 0 && len(body.RuntimeConfig) > 0 {
		writeErrorIssues(w, http.StatusConflict, "This runtime requires a runtime form definition reference",
			"form_definition_ref_required", []Issue{{Path: "/formDefinitionRef"}})
		return
	}

	// serverRole change: capability + actor-can-change policy (canChangeMemberRole).
	if body.ServerRole != nil {
		if *body.ServerRole != agent.RoleAdmin && *body.ServerRole != agent.RoleMember {
			writeError(w, http.StatusBadRequest, "Role must be admin or member")
			return
		}
		if !agent.HasServerCapability(scope.Role, "changeMemberRoles") {
			writeError(w, http.StatusForbidden, "The `changeMemberRoles` capability is required to change agent roles")
			return
		}
		currentRole, roleErr := h.Store.AgentMemberRole(r.Context(), scope.WorkspaceID, loaded.ID)
		if roleErr != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update agent")
			return
		}
		targetRole := ""
		if currentRole != nil {
			targetRole = *currentRole
		}
		if !agent.CanChangeMemberRole(scope.Role, targetRole, *body.ServerRole) {
			writeError(w, http.StatusForbidden, "You are not allowed to make that role change")
			return
		}
	}

	// avatarUrl: null clears; otherwise pixel: or the avatar CDN path shape.
	clearAvatar := false
	if body.AvatarURL != nil {
		if *body.AvatarURL != "" && !strings.HasPrefix(*body.AvatarURL, "pixel:") &&
			!strings.HasPrefix(*body.AvatarURL, "/api/avatars/") {
			writeError(w, http.StatusBadRequest, "Invalid avatar URL")
			return
		}
		clearAvatar = *body.AvatarURL == ""
	}

	// envVars: absent keeps, null clears, object sets.
	patch := agent.AgentPatch{}
	if body.DisplayName != nil {
		patch.DisplayName = nullStringOf(body.DisplayName)
	}
	if body.Description != nil {
		patch.Description = nullStringOf(body.Description)
	}
	if body.AvatarURL != nil {
		if clearAvatar {
			patch.AvatarURL = nullStringEmpty()
		} else {
			patch.AvatarURL = nullStringOf(body.AvatarURL)
		}
	}
	if body.Model != nil {
		patch.Model = body.Model
	}
	if body.Runtime != nil && *body.Runtime != "" {
		patch.Runtime = body.Runtime
	}
	if len(body.RuntimeConfig) > 0 {
		if !isJSONObject(body.RuntimeConfig) {
			writeError(w, http.StatusBadRequest, "Runtime configuration is invalid")
			return
		}
		patch.RuntimeConfig = &body.RuntimeConfig
	}
	if body.ReasoningEffort != nil {
		patch.ReasoningEffort = nullStringOf(body.ReasoningEffort)
	}
	if len(body.EnvVars) > 0 {
		if string(body.EnvVars) == "null" {
			empty := json.RawMessage(nil)
			patch.EnvVars = &empty
		} else {
			parsed, envErr := parseAgentEnvVars(body.EnvVars)
			if envErr != "" {
				writeError(w, http.StatusBadRequest, envErr)
				return
			}
			patch.EnvVars = &parsed
		}
	}

	if len(body.FormDefinitionRef) > 0 || runtimeTouched {
		effort := ""
		if body.ReasoningEffort != nil {
			effort = *body.ReasoningEffort
		} else if loaded.ReasoningEffort.Valid {
			effort = loaded.ReasoningEffort.String
		}
		machine := ""
		if loaded.MachineID.Valid {
			machine = loaded.MachineID.String
		}
		if !h.admitRuntimeCatalog(w, r, formRuntime, machine, effort, body.RuntimeConfig) {
			return
		}
	}

	updated, err := h.Store.UpdateAgent(r.Context(), scope.WorkspaceID, loaded.ID, patch)
	if err != nil {
		if domain := agent.AsError(err); domain != nil {
			writeError(w, domain.Status, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to update agent")
		return
	}
	if body.ServerRole != nil {
		if err := h.Store.UpdateAgentMemberRole(r.Context(), scope.WorkspaceID, loaded.ID, *body.ServerRole); err != nil {
			if domain := agent.AsError(err); domain != nil {
				writeError(w, domain.Status, domain.Message)
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to update agent")
			return
		}
	}
	// restartMode: the effective mode is forced to "session" when the runtime
	// identity changed (server-enforced invariant), then a bounded reset runs.
	if body.RestartMode != nil {
		mode := *body.RestartMode
		codexModelChanged := nextRuntime == "codex" && body.Model != nil && *body.Model != loaded.Model
		if runtimeChanged || codexModelChanged {
			mode = "session"
		}
		fresh, err := h.Store.GetAgent(r.Context(), loaded.ID, false)
		if err != nil || fresh == nil {
			writeError(w, http.StatusInternalServerError, "Failed to update agent")
			return
		}
		if err := h.Service.ResetForSettings(r.Context(), fresh, mode); err != nil {
			if domain := agent.AsError(err); domain != nil {
				writeError(w, domain.Status, domain.Message)
				return
			}
			writeError(w, http.StatusInternalServerError, "Failed to update agent")
			return
		}
	}
	updated, err = h.Store.GetAgent(r.Context(), loaded.ID, true)
	if err != nil || updated == nil {
		writeError(w, http.StatusInternalServerError, "Failed to update agent")
		return
	}
	role, err := h.Store.AgentMemberRole(r.Context(), scope.WorkspaceID, loaded.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to update agent")
		return
	}
	h.respondAgentDTO(w, r, updated, role)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Start handles POST /api/agents/{id}/start.
func (h *AgentHandlers) Start(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, "controlAgentRuntime") {
		writeError(w, http.StatusForbidden, "The `controlAgentRuntime` capability or human creator authority is required to control agents")
		return
	}
	if err := h.Service.Start(r.Context(), loaded); err != nil {
		h.writeLifecycleError(w, err, "Failed to start agent")
		return
	}
	okTrue(w)
}

// Stop handles POST /api/agents/{id}/stop.
func (h *AgentHandlers) Stop(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, "controlAgentRuntime") {
		writeError(w, http.StatusForbidden, "The `controlAgentRuntime` capability or human creator authority is required to control agents")
		return
	}
	if err := h.Service.Stop(r.Context(), loaded); err != nil {
		h.writeLifecycleError(w, err, "Failed to stop agent")
		return
	}
	okTrue(w)
}

// Reset handles POST /api/agents/{id}/reset {mode}.
func (h *AgentHandlers) Reset(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	var body struct {
		Mode *string `json:"mode"`
	}
	if r.ContentLength != 0 {
		if !decodeJSONBody(w, r, &body) {
			return
		}
	}
	mode := "session"
	if body.Mode != nil && *body.Mode != "" {
		mode = *body.Mode
	}
	capability := "controlAgentRuntime"
	if mode == agent.ResetModeFull {
		capability = "resetAgentWorkspace"
	}
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, capability) {
		writeError(w, http.StatusForbidden, "The `"+capability+"` capability or human creator authority is required to control agents")
		return
	}
	if err := h.Service.Reset(r.Context(), loaded, mode); err != nil {
		h.writeLifecycleError(w, err, "Failed to reset agent")
		return
	}
	okTrue(w)
}

// Delete handles DELETE /api/agents/{id}.
func (h *AgentHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, "deleteAgents") {
		writeError(w, http.StatusForbidden, "The `deleteAgents` capability or human creator authority is required to delete agents")
		return
	}
	if err := h.Service.Delete(r.Context(), scope.WorkspaceID, loaded); err != nil {
		if domain := agent.AsError(err); domain != nil {
			writeError(w, domain.Status, domain.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to delete agent")
		return
	}
	okTrue(w)
}

// AssignMachine handles POST /api/agents/{id}/assign-machine {machineId|null}.
func (h *AgentHandlers) AssignMachine(w http.ResponseWriter, r *http.Request) {
	loaded, ok := h.fetchAgent(w, r, false)
	if !ok {
		return
	}
	scope := agentScopeOf(r)
	if !agent.UserCanActOnAgentResource(scope.Role, userID(r), loaded, "migrateAgents") {
		writeError(w, http.StatusForbidden, "The `migrateAgents` capability or human creator authority is required to assign agent machines")
		return
	}
	var body struct {
		MachineID *string `json:"machineId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	machineID := (*string)(nil)
	if body.MachineID != nil && *body.MachineID != "" {
		if agent.IsExternalAgentRuntime(loaded.Runtime) {
			writeError(w, http.StatusBadRequest, "External agents cannot be assigned to a Computer")
			return
		}
		if !machineIDPattern.MatchString(*body.MachineID) {
			writeError(w, http.StatusBadRequest, "Invalid machineId: must be a UUID")
			return
		}
		machine, err := h.Store.GetMachine(r.Context(), scope.WorkspaceID, *body.MachineID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to assign machine")
			return
		}
		if machine == nil {
			writeError(w, http.StatusBadRequest, "Machine not found in this server")
			return
		}
		value := *body.MachineID
		machineID = &value
	}
	if err := h.Store.AssignMachine(r.Context(), scope.WorkspaceID, loaded.ID, machineID); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to assign machine")
		return
	}
	okTrue(w)
}

func (h *AgentHandlers) writeLifecycleError(w http.ResponseWriter, err error, fallback string) {
	if domain := agent.AsError(err); domain != nil {
		body := map[string]any{"error": domain.Message}
		if domain.Code != "" {
			body["code"] = domain.Code
		}
		writeJSON(w, domain.Status, body)
		return
	}
	writeError(w, http.StatusInternalServerError, fallback)
}

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

// Manageable handles GET /api/agents/manageable (no X-Server-Id).
func (h *AgentHandlers) Manageable(w http.ResponseWriter, r *http.Request) {
	memberships, err := h.Store.Memberships(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list manageable agents")
		return
	}
	if len(memberships) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"data": map[string]any{
				"agents":                  []any{},
				"reason":                  "no_manageable_server",
				"manageable_server_count": 0,
			},
		})
		return
	}
	workspaceIDs := make([]string, 0, len(memberships))
	capable := map[string]bool{}
	names := map[string]string{}
	for _, membership := range memberships {
		workspaceIDs = append(workspaceIDs, membership.WorkspaceID)
		names[membership.WorkspaceID] = membership.Name
		if agent.HasServerCapability(membership.Role, "issueAgentCredentials") {
			capable[membership.WorkspaceID] = true
		}
	}
	rows, err := h.Store.ListAgentsInWorkspaces(r.Context(), workspaceIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list manageable agents")
		return
	}
	agents := []map[string]any{}
	manageableServers := map[string]bool{}
	for _, capableID := range workspaceIDs {
		if capable[capableID] {
			manageableServers[capableID] = true
		}
	}
	for _, row := range rows {
		creatorAuthority := row.CreatorType.Valid && row.CreatorType.String == "user" &&
			row.CreatorID.Valid && row.CreatorID.String == userID(r)
		if !capable[row.WorkspaceID] && !creatorAuthority {
			continue
		}
		manageableServers[row.WorkspaceID] = true
		agents = append(agents, map[string]any{
			"id":          row.ID,
			"name":        row.Name,
			"displayName": nullableString(row.DisplayName),
			"description": nullableString(row.Description),
			"serverId":    row.WorkspaceID,
			"serverName":  names[row.WorkspaceID],
		})
	}
	if len(manageableServers) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"data": map[string]any{
				"agents":                  []any{},
				"reason":                  "no_manageable_server",
				"manageable_server_count": 0,
			},
		})
		return
	}
	reason := "ok"
	if len(agents) == 0 {
		reason = "no_agents_on_manageable_servers"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"data": map[string]any{
			"agents":                  agents,
			"reason":                  reason,
			"manageable_server_count": len(manageableServers),
		},
	})
}
