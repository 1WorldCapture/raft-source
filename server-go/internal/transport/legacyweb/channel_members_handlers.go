// Roster mutation handlers (M3A): add single/batch members, remove human or
// agent members, change a channel-local role. Ports the TS routes' validation
// order, capability re-checks inside the committing transaction, and exact
// error bodies.
package legacyweb

import (
	"net/http"
	"strings"

	"raft.local/server-go/internal/channel"
)

// addRemoveGuards resolves the shared preconditions of the add/remove routes:
// cross-workspace 404, thread 400, archived 409 and the DM-participant rule.
// The non-DM capability check is left to the caller (its error sentence
// differs per route).
func (h *ChannelHandlers) addRemoveGuards(w http.ResponseWriter, r *http.Request) (*channel.Channel, bool) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return nil, false
	}
	// Server owner/admin may manage a private channel they have not joined
	// (canManageUnjoined); other callers must be able to see it.
	if !h.canSeeChannel(r, c) {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, userID(r))
		canManageUnjoined := err == nil &&
			(c.Type == channel.TypeChannel || c.Type == channel.TypePrivate) &&
			(role == channel.RoleOwner || role == channel.RoleAdmin)
		if !canManageUnjoined {
			writeError(w, http.StatusNotFound, "Channel not found")
			return nil, false
		}
	}
	if c.Type == channel.TypeThread {
		writeError(w, http.StatusBadRequest, "Thread membership is managed via follow/unfollow")
		return nil, false
	}
	if c.ArchivedAt != nil {
		writeErrorCode(w, http.StatusConflict, "channel_archived", "This channel is archived")
		return nil, false
	}
	return c, true
}

// dmParticipantGuard enforces the DM rule: only participants may act.
func (h *ChannelHandlers) dmParticipantGuard(w http.ResponseWriter, r *http.Request, c *channel.Channel) bool {
	if c.Type != channel.TypeDM {
		return true
	}
	member, err := h.Store.IsChannelHuman(r.Context(), c.ID, userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to add member")
		return false
	}
	if !member {
		writeError(w, http.StatusNotFound, "Channel not found")
		return false
	}
	return true
}

// commitMemberChange re-checks the actor inside the write transaction. DMs
// re-check participant binding; every other channel re-checks the capability.
func (h *ChannelHandlers) commitMemberChange(r *http.Request, c *channel.Channel, capability string, fn func(channel.Executor) error) error {
	if c.Type == channel.TypeDM {
		return h.Store.CommitDMParticipant(r.Context(), c.WorkspaceID, c.ID, userID(r), fn)
	}
	return h.Store.CommitAuthorized(r.Context(), c.WorkspaceID, c.ID, userID(r), []string{capability}, fn)
}

// writeMemberMutationError maps add/remove failures to the TS bodies. The
// capability sentence is rewritten per mutation family ("Failed to add
// member" vs "Failed to remove member").
func (h *ChannelHandlers) writeMemberMutationError(w http.ResponseWriter, err error, family string) {
	if de := channel.AsDomainError(err); de != nil {
		switch de.Message {
		case "Guest cannot be added to the #all channel":
			writeError(w, http.StatusForbidden, de.Message)
			return
		case "You do not have permission to add channel members":
			writeError(w, http.StatusForbidden, de.Message)
			return
		case channel.CapabilityRequiredMessage:
			if family == "remove" {
				writeError(w, http.StatusForbidden, de.Message)
			} else {
				writeError(w, http.StatusForbidden, "You do not have permission to add channel members")
			}
			return
		}
		if strings.Contains(de.Message, "Cannot remove") {
			writeError(w, http.StatusForbidden, de.Message)
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to "+family+" member")
		}
		return
	}
	writeError(w, http.StatusInternalServerError, "Failed to "+family+" member")
}

// AddMember handles POST /api/channels/{id}/members (single-row legacy
// surface; multi-select clients use /members/batch).
func (h *ChannelHandlers) AddMember(w http.ResponseWriter, r *http.Request) {
	c, ok := h.addRemoveGuards(w, r)
	if !ok {
		return
	}
	if !h.dmParticipantGuard(w, r, c) {
		return
	}
	if c.Type != channel.TypeDM {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to add member")
			return
		}
		if ac == nil || !channel.ChannelActorHasCapability(ac, channel.CapAddChannelMembers) {
			writeError(w, http.StatusForbidden, "You do not have permission to add channel members")
			return
		}
	}

	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	agentID, _ := body["agentId"].(string)
	targetUserID, _ := body["userId"].(string)
	if agentID == "" && targetUserID == "" {
		writeError(w, http.StatusBadRequest, "Either agentId or userId is required")
		return
	}

	if agentID != "" {
		exists, err := h.Store.AgentExistsInWorkspace(r.Context(), h.Store.DB(), agentID, c.WorkspaceID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to add member")
			return
		}
		if !exists {
			writeError(w, http.StatusBadRequest, "Agent not found in this server")
			return
		}
		if err := h.commitMemberChange(r, c, channel.CapAddChannelMembers, func(tx channel.Executor) error {
			_, err := h.Store.AddAgent(r.Context(), c.ID, agentID, "", tx)
			return err
		}); err != nil {
			h.writeMemberMutationError(w, err, "add")
			return
		}
		okTrue(w)
		return
	}

	role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, targetUserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to add member")
		return
	}
	if role == "" {
		writeError(w, http.StatusBadRequest, "User is not a member of this server")
		return
	}
	if err := h.commitMemberChange(r, c, channel.CapAddChannelMembers, func(tx channel.Executor) error {
		_, err := h.Store.AddHuman(r.Context(), c.ID, targetUserID, "", tx)
		return err
	}); err != nil {
		h.writeMemberMutationError(w, err, "add")
		return
	}
	okTrue(w)
}

// AddMembersBatch handles POST /api/channels/{id}/members/batch: validate the
// whole target set, then commit membership rows in one transaction; existing
// members are idempotent successes reported separately.
func (h *ChannelHandlers) AddMembersBatch(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	batchUserIDs, batchAgentIDs, parseOK := parseMemberBatch(body)
	if !parseOK {
		writeErrorCode(w, http.StatusBadRequest, "invalid_member_batch", "userIds and agentIds must be arrays of UUIDs")
		return
	}
	if len(batchUserIDs) == 0 && len(batchAgentIDs) == 0 {
		writeErrorCode(w, http.StatusBadRequest, "empty_member_batch", "At least one userId or agentId is required")
		return
	}

	c, ok := h.addRemoveGuards(w, r)
	if !ok {
		return
	}
	if !h.dmParticipantGuard(w, r, c) {
		return
	}
	if c.Type != channel.TypeDM {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to add channel members")
			return
		}
		if ac == nil || !channel.ChannelActorHasCapability(ac, channel.CapAddChannelMembers) {
			writeError(w, http.StatusForbidden, "You do not have permission to add channel members")
			return
		}
	}

	var invalidAgentIDs []string
	for _, agentID := range batchAgentIDs {
		exists, err := h.Store.AgentExistsInWorkspace(r.Context(), h.Store.DB(), agentID, c.WorkspaceID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to add channel members")
			return
		}
		if !exists {
			invalidAgentIDs = append(invalidAgentIDs, agentID)
		}
	}
	if len(invalidAgentIDs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "One or more agents are not members of this server", "code": "agents_not_in_server",
			"invalidAgentIds": invalidAgentIDs,
		})
		return
	}
	var invalidUserIDs []string
	for _, targetID := range batchUserIDs {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, targetID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to add channel members")
			return
		}
		if role == "" {
			invalidUserIDs = append(invalidUserIDs, targetID)
		}
	}
	if len(invalidUserIDs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "One or more users are not members of this server", "code": "users_not_in_server",
			"invalidUserIds": invalidUserIDs,
		})
		return
	}

	addedUsers := []string{}
	alreadyUsers := []string{}
	addedAgents := []string{}
	alreadyAgents := []string{}
	err := h.commitMemberChange(r, c, channel.CapAddChannelMembers, func(tx channel.Executor) error {
		for _, targetID := range batchUserIDs {
			added, err := h.Store.AddHuman(r.Context(), c.ID, targetID, "", tx)
			if err != nil {
				return err
			}
			if added {
				addedUsers = append(addedUsers, targetID)
			} else {
				alreadyUsers = append(alreadyUsers, targetID)
			}
		}
		for _, agentID := range batchAgentIDs {
			added, err := h.Store.AddAgent(r.Context(), c.ID, agentID, "", tx)
			if err != nil {
				return err
			}
			if added {
				addedAgents = append(addedAgents, agentID)
			} else {
				alreadyAgents = append(alreadyAgents, agentID)
			}
		}
		return nil
	})
	if err != nil {
		h.writeBatchMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"added": map[string]any{
			"userIds":  addedUsers,
			"agentIds": addedAgents,
		},
		"alreadyMembers": map[string]any{
			"userIds":  alreadyUsers,
			"agentIds": alreadyAgents,
		},
	})
}

// writeBatchMutationError maps a failed batch to the TS catch sentences.
// Pre-validation already named invalid ids; an in-transaction membership miss
// repeats the code without an id list, matching the route catch.
func (h *ChannelHandlers) writeBatchMutationError(w http.ResponseWriter, err error) {
	if de := channel.AsDomainError(err); de != nil {
		if de.Message == channel.CapabilityRequiredMessage {
			writeError(w, http.StatusForbidden, "You do not have permission to add channel members")
			return
		}
		switch de.Message {
		case "Human is not a member of this channel's server":
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "One or more users are not members of this server",
				"code":  "users_not_in_server",
			})
			return
		case "Agent is not a member of this channel's server":
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "One or more agents are not members of this server",
				"code":  "agents_not_in_server",
			})
			return
		}
		if writeChannelDomainError(w, err) {
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "Failed to add channel members")
}

// RemoveAgent handles DELETE /api/channels/{id}/members/agent/{memberId}.
func (h *ChannelHandlers) RemoveAgent(w http.ResponseWriter, r *http.Request) {
	h.removeMemberRoute(w, r, "agent")
}

// RemoveHuman handles DELETE /api/channels/{id}/members/user/{memberId}.
func (h *ChannelHandlers) RemoveHuman(w http.ResponseWriter, r *http.Request) {
	h.removeMemberRoute(w, r, "user")
}

func (h *ChannelHandlers) removeMemberRoute(w http.ResponseWriter, r *http.Request, kind string) {
	c, ok := h.addRemoveGuards(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	memberID := r.PathValue("memberId")
	if c.Type == channel.TypeDM {
		member, err := h.Store.IsChannelHuman(r.Context(), c.ID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove member")
			return
		}
		if !member {
			writeError(w, http.StatusNotFound, "Channel not found")
			return
		}
		if kind == "user" && memberID != userID(r) {
			writeError(w, http.StatusForbidden, "Cannot remove other participants from a DM")
			return
		}
	} else {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to remove member")
			return
		}
		if ac == nil || !channel.ChannelActorHasCapability(ac, channel.CapRemoveChannelMembers) {
			if kind == "agent" {
				writeError(w, http.StatusForbidden, "Only admins can remove channel agents")
			} else {
				writeError(w, http.StatusForbidden, "Only admins can remove channel members")
			}
			return
		}
	}

	err := h.commitMemberChange(r, c, channel.CapRemoveChannelMembers, func(tx channel.Executor) error {
		if kind == "agent" {
			return h.Store.RemoveAgent(r.Context(), c.ID, memberID, tx)
		}
		return h.Store.RemoveHuman(r.Context(), c.ID, memberID, tx)
	})
	if err != nil {
		h.writeMemberMutationError(w, err, "remove")
		return
	}
	okTrue(w)
}

// ChangeMemberRole handles PATCH /api/channels/{id}/members/{targetType}/
// {memberId}/role.
func (h *ChannelHandlers) ChangeMemberRole(w http.ResponseWriter, r *http.Request) {
	targetType := r.PathValue("targetType")
	if targetType != "user" && targetType != "agent" {
		writeError(w, http.StatusBadRequest, "targetType and role must be user|agent and member|admin")
		return
	}
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	nextRole, _ := body["role"].(string)
	if nextRole != channel.ChannelRoleMember && nextRole != channel.ChannelRoleAdmin {
		writeError(w, http.StatusBadRequest, "targetType and role must be user|agent and member|admin")
		return
	}
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	result, err := h.Store.ChangeChannelMembershipRole(r.Context(), c.WorkspaceID, c.ID,
		userID(r), targetType, r.PathValue("memberId"), nextRole)
	if err != nil {
		if rme := channel.AsRoleMutationError(err); rme != nil {
			switch rme.Code {
			case channel.RoleCodeChannelNotFound:
				writeErrorCode(w, http.StatusNotFound, rme.Code, rme.Message)
			case channel.RoleCodeCapabilityRequired, channel.RoleCodeProtectedServerRole:
				writeErrorCode(w, http.StatusForbidden, rme.Code, rme.Message)
			case channel.RoleCodeUnsupportedShape:
				writeErrorCode(w, http.StatusBadRequest, rme.Code, rme.Message)
			default:
				writeErrorCode(w, http.StatusConflict, rme.Code, rme.Message)
			}
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to change channel member role")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// parseMemberBatch ports parseChannelMemberBatch (UUID-shaped id arrays).
func parseMemberBatch(body map[string]any) (userIDs, agentIDs []string, ok bool) {
	userIDs, ok = parseUUIDList(body, "userIds")
	if !ok {
		return nil, nil, false
	}
	agentIDs, ok = parseUUIDList(body, "agentIds")
	if !ok {
		return nil, nil, false
	}
	return userIDs, agentIDs, true
}

// parseUUIDList ports the TS default (`userIds = []` when the key is absent).
// JSON null and non-arrays are invalid; an empty array is a valid empty set.
func parseUUIDList(body map[string]any, key string) ([]string, bool) {
	raw, present := body[key]
	if !present {
		return []string{}, true
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	seen := map[string]bool{}
	out := []string{}
	for _, item := range list {
		s, isString := item.(string)
		if !isString || !uuidPattern.MatchString(s) {
			return nil, false
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out, true
}
