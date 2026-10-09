// Legacy-web channel handlers (M3A). Every handler mirrors the exact TS route
// logic in packages/server/src/routes/channels.ts: validation order, error
// sentences, status codes and side effects (minus the Socket.IO / system-
// message fan-out that belongs to M4/M5). The auth gate and the channel
// server-scope middleware run before every handler here.
package humanapi

import (
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strings"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/transport/presenter"
	"raft.local/server-go/internal/workspace"
)

// ChannelHandlers carries the channel store, the channel read-model service
// and the workspace membership fact owner for the whole surface. The
// list/detail/create exits always read through channelview.Service: channels,
// authority and the viewer's read/mute/display/last-message state resolve on
// ONE pinned read snapshot and emit the real values. There is no
// projector-free fixture path anymore: a fresh account or an empty channel
// naturally reads absent/0/null.
type ChannelHandlers struct {
	Store     *channel.Store
	View      *channelview.Service
	Workspace *workspace.Store
}

type ctxChannelServerKeyType struct{}

var ctxChannelServer ctxChannelServerKeyType

// channelServerID returns the workspace id resolved by RequireChannelServer.
func channelServerID(r *http.Request) string {
	v, _ := r.Context().Value(ctxChannelServer).(string)
	return v
}

// RequireChannelServer ports the legacy requireServer middleware: the
// X-Server-Id header names the acting workspace and the caller must hold an
// eligible membership (deleted and joint_storage workspaces do not count).
// Unlike the /api/servers/:id scope there is no URL id to match — the path
// parameter is a channel id and cross-server access is refused per handler.

// scopedChannel loads the channel and refuses cross-workspace access with the
// legacy 404 ("Channel not found"). ok=false means the response was written.
func (h *ChannelHandlers) scopedChannel(w http.ResponseWriter, r *http.Request) (*channel.Channel, bool) {
	channelID := r.PathValue("id")
	c, err := h.Store.GetChannel(r.Context(), channelID)
	if err != nil {
		httpx.WriteErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
		return nil, false
	}
	if c == nil || c.WorkspaceID != channelServerID(r) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return nil, false
	}
	return c, true
}

// canSeeChannel ports the route helper of the same name.
func (h *ChannelHandlers) canSeeChannel(r *http.Request, c *channel.Channel) bool {
	ok, err := h.Store.CanUserAccessChannel(r.Context(), c.WorkspaceID, c.ID, authn.UserID(r))
	return err == nil && ok
}

// writeChannelDomainError maps a channel.DomainError to the legacy statuses;
// the archived sentence keeps its machine code. False means "not a domain
// error" and the caller must use its endpoint-specific 500 fallback.
func writeChannelDomainError(w http.ResponseWriter, err error) bool {
	de := channel.AsDomainError(err)
	if de == nil {
		return false
	}
	switch de.Code {
	case channel.CodeInvalidInput:
		httpx.WriteError(w, http.StatusBadRequest, de.Message)
	case channel.CodeForbidden:
		httpx.WriteError(w, http.StatusForbidden, de.Message)
	case channel.CodeNotFound:
		httpx.WriteError(w, http.StatusNotFound, de.Message)
	case channel.CodeConflict:
		if de.Message == "This channel is archived" {
			httpx.WriteErrorCode(w, http.StatusConflict, "channel_archived", de.Message)
		} else {
			httpx.WriteError(w, http.StatusConflict, de.Message)
		}
	default:
		return false
	}
	return true
}

// List handles GET /api/channels.
func (h *ChannelHandlers) List(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("archived")
	filter := channel.ArchivedExclude
	if raw != "" {
		switch raw {
		case channel.ArchivedExclude, channel.ArchivedInclude, channel.ArchivedOnly:
			filter = raw
		default:
			httpx.WriteError(w, http.StatusBadRequest, "archived must be one of: exclude, include, only")
			return
		}
	}
	// Channels, authority and viewer projections share ONE pinned snapshot;
	// nothing here reads from a second connection.
	rows, err := h.View.List(r.Context(), authn.AccessClaims(r), channelServerID(r), authn.UserID(r), filter)
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to list channels")
		}
		return
	}
	views := make([]channelView, 0, len(rows))
	for _, row := range rows {
		views = append(views, channelListItem(row.Channel, row.Joined, row.ActorCtx, row.Projection))
	}
	httpx.WriteJSON(w, http.StatusOK, views)
}

// visibility parsing (parseChannelVisibility): absent/public → public,
// private → private, joint → accepted then refused honestly (501), anything
// else → the legacy 400.
func parseChannelVisibility(raw any) (string, bool, bool) {
	switch v := raw.(type) {
	case nil:
		return channel.TypeChannel, false, true
	case string:
		switch v {
		case "public", "":
			return channel.TypeChannel, false, true
		case "private":
			return channel.TypePrivate, false, true
		case "joint":
			return channel.TypeJoint, true, true
		}
	}
	return "", false, false
}

// Create handles POST /api/channels.
func (h *ChannelHandlers) Create(w http.ResponseWriter, r *http.Request) {
	serverID := channelServerID(r)
	actor := authn.UserID(r)
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}

	// 1. Server capability gate.
	serverRole, err := h.Store.HumanServerRole(r.Context(), serverID, actor)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to create channel")
		return
	}
	if !channel.HasServerCapability(serverRole, channel.CapCreateChannels) {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to create channels")
		return
	}

	// 2. Visibility (joint accepted for validation parity, refused honestly
	// at the create point below).
	channelType, isJoint, visibilityOK := parseChannelVisibility(body["visibility"])
	if !visibilityOK {
		httpx.WriteError(w, http.StatusBadRequest, "visibility must be one of: public, private, joint")
		return
	}

	// 3. Name (TS validateName sentences; a non-string name answers the
	// "required" sentence instead of crashing — documented deviation).
	rawName, _ := body["name"].(string)
	if nameError := channel.ValidateChannelName(rawName); nameError != "" {
		httpx.WriteError(w, http.StatusBadRequest, nameError)
		return
	}
	name := strings.TrimSpace(rawName)
	if name == "all" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "channel_name_reserved", `Channel name "all" is reserved`)
		return
	}

	// 4. Joint parameter validation (parity for the 400s TS answers before
	// refusing to federate).
	if isJoint {
		targetSlug, _ := body["targetServerSlug"].(string)
		if strings.TrimSpace(targetSlug) == "" && !hasJointInviteTargets(body) {
			httpx.WriteError(w, http.StatusBadRequest, "Invite server slug is required")
			return
		}
		if !jointInvitesHavePeople(body) {
			httpx.WriteError(w, http.StatusBadRequest, "At least one invited person is required")
			return
		}
	}

	// 5. Description: at most 500 UTF-16 units when a non-empty value is set.
	if description, present := body["description"]; present && !isEmptyJSONValue(description) {
		text, ok := description.(string)
		if !ok || utf16Len(text) > 500 {
			httpx.WriteError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
			return
		}
	}

	// 6. Joint requires the federate capability (owner/admin hold it).
	if isJoint && !channel.HasServerCapability(serverRole, channel.CapFederateChannels) {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to federate channels")
		return
	}

	// 7/8. Target validation: every selected agent/user must belong to the
	// acting workspace before anything is written.
	selectedAgentIDs := stringSet(body["agentIds"])
	for _, agentID := range selectedAgentIDs {
		exists, err := h.Store.AgentExists(r.Context(), agentID, serverID)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to create channel")
			return
		}
		if !exists {
			httpx.WriteError(w, http.StatusBadRequest, "Agent not found in this server")
			return
		}
	}
	selectedUserIDs := stringSet(body["userIds"])
	for _, targetID := range selectedUserIDs {
		role, err := h.Store.HumanServerRole(r.Context(), serverID, targetID)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to create channel")
			return
		}
		if role == "" {
			httpx.WriteError(w, http.StatusBadRequest, "User is not a member of this server")
			return
		}
	}

	if isJoint {
		// Joint channels remain deferred: refuse honestly rather than
		// creating a local stand-in (docs/m3-channel-contract.md §1).
		httpx.WriteErrorCode(w, http.StatusNotImplemented, "joint_channels_not_implemented", "Joint channels are not implemented in this phase")
		return
	}

	var description *string
	if text, present := body["description"]; present {
		if s, ok := text.(string); ok {
			description = &s
		}
	}
	created, err := h.Store.CreateChannel(r.Context(), channel.CreateInput{
		WorkspaceID:     serverID,
		Name:            name,
		Description:     description,
		Type:            channelType,
		CreatorUserID:   actor,
		InitialUserIDs:  selectedUserIDs,
		InitialAgentIDs: selectedAgentIDs,
	})
	if err != nil {
		h.writeCreateError(w, r, err)
		return
	}
	// The channel exists now; its (legitimately empty) viewer state is read
	// on one snapshot through the same read model as the other exits, so the
	// response states fresh-scope facts instead of an old scope's defaults.
	row, err := h.View.CreateResult(r.Context(), authn.AccessClaims(r), serverID, actor, *created)
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to create channel")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, channelCreateView(row.Channel, row.ActorCtx, row.Projection))
}

// writeCreateError maps create failures to the exact TS statuses/bodies.
func (h *ChannelHandlers) writeCreateError(w http.ResponseWriter, r *http.Request, err error) {
	if collision := channel.AsArchivedNameCollision(err); collision != nil {
		canUnarchive := false
		if collision.ArchivedChannelType == channel.TypeChannel || collision.ArchivedChannelType == channel.TypePrivate {
			ok, cerr := h.Store.ActorHasChannelCapability(r.Context(), channelServerID(r), collision.ArchivedChannelID, "user", authn.UserID(r), channel.CapArchiveChannels)
			canUnarchive = cerr == nil && ok
		}
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":                       collision.Error(),
			"code":                        "archived_name_collision",
			"archivedChannelId":           collision.ArchivedChannelID,
			"archivedChannelName":         collision.ChannelName,
			"archivedChannelType":         collision.ArchivedChannelType,
			"canUnarchiveArchivedChannel": canUnarchive,
		})
		return
	}
	if de := channel.AsDomainError(err); de != nil {
		switch {
		case strings.Contains(de.Message, "already taken"):
			httpx.WriteError(w, http.StatusConflict, de.Message)
			return
		case strings.Contains(de.Message, "Channel limit reached"):
			httpx.WriteError(w, http.StatusForbidden, de.Message)
			return
		case strings.Contains(de.Message, "is reserved"):
			httpx.WriteErrorCode(w, http.StatusBadRequest, "channel_name_reserved", de.Message)
			return
		case de.Message == "You do not have permission to create channels":
			httpx.WriteError(w, http.StatusForbidden, de.Message)
			return
		}
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Failed to create channel")
}

// Get handles GET /api/channels/{id}.
func (h *ChannelHandlers) Get(w http.ResponseWriter, r *http.Request) {
	row, err := h.View.Detail(r.Context(), authn.AccessClaims(r), channelServerID(r), authn.UserID(r), r.PathValue("id"))
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		if errors.Is(err, channelview.ErrNotFound) {
			httpx.WriteError(w, http.StatusNotFound, "Channel not found")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get channel")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, channelDetailView(row.Channel, row.Joined, row.ActorCtx, row.Projection))
}

// parseRegularVisibility ports parseRegularChannelVisibility for PATCH.
func parseRegularVisibility(raw any) (*string, bool) {
	switch v := raw.(type) {
	case nil:
		return nil, true
	case string:
		switch v {
		case "public":
			out := channel.TypeChannel
			return &out, true
		case "private":
			out := channel.TypePrivate
			return &out, true
		}
	}
	return nil, false
}

// Update handles PATCH /api/channels/{id}.
func (h *ChannelHandlers) Update(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	actor := authn.UserID(r)
	serverID := channelServerID(r)

	serverRole, err := h.Store.HumanServerRole(r.Context(), serverID, actor)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to update channel")
		return
	}
	ac, err := h.Store.ResolveChannelActorContext(r.Context(), serverID, c.ID, "user", actor)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to update channel")
		return
	}
	canEditMetadata := ac != nil && channel.ChannelActorHasCapability(ac, channel.CapEditChannelMetadata)
	canChangeVisibility := channel.HasServerCapability(serverRole, channel.CapChangeChannelVis)
	canManageGuestAccess := ac != nil && channel.ChannelActorHasCapability(ac, channel.CapManageGuestAccess)
	canManageRequestedChange := canEditMetadata || canChangeVisibility || canManageGuestAccess

	isHiddenAllChannel := channel.IsAllSystemChannel(c) && !channel.IsEnabledAllChannel(c)
	if isHiddenAllChannel && !canManageRequestedChange {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if !isHiddenAllChannel && !h.canSeeChannel(r, c) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.Type == channel.TypeDM {
		httpx.WriteError(w, http.StatusForbidden, "Cannot edit DM channels")
		return
	}
	if c.ArchivedAt != nil {
		httpx.WriteErrorCode(w, http.StatusConflict, "channel_archived", "This channel is archived")
		return
	}

	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	rawName, hasName := body["name"]
	rawDescription, hasDescription := body["description"]
	rawVisibility, hasVisibility := body["visibility"]
	_, hasGuestVisible := body["guestVisible"]
	_, hasGuestJoinable := body["guestJoinable"]
	guestPolicyRequested := hasGuestVisible || hasGuestJoinable

	if (hasName || hasDescription) && !canEditMetadata {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to edit channel metadata")
		return
	}
	if hasVisibility && !canChangeVisibility {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to change channel visibility")
		return
	}
	if guestPolicyRequested && !canManageGuestAccess {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to manage guest access")
		return
	}
	if guestPolicyRequested {
		// The guest feature gate stays disabled in the frozen policy vector;
		// the legacy answer for a disabled gate is this 404.
		httpx.WriteError(w, http.StatusNotFound, "Guest access is not enabled")
		return
	}
	if !hasName && !hasDescription && !hasVisibility && !canEditMetadata {
		httpx.WriteError(w, http.StatusForbidden, "You do not have permission to update channels")
		return
	}

	var updates channel.ChannelUpdates
	if hasName {
		name, _ := rawName.(string)
		if nameError := channel.ValidateChannelName(name); nameError != "" {
			httpx.WriteError(w, http.StatusBadRequest, nameError)
			return
		}
		trimmed := strings.TrimSpace(name)
		updates.Name = &trimmed
	}
	if hasDescription {
		if text, ok := rawDescription.(string); ok {
			if utf16Len(text) > 500 {
				httpx.WriteError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
				return
			}
			updates.Description = &text
		} else if rawDescription != nil {
			httpx.WriteError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
			return
		} else {
			empty := ""
			updates.Description = &empty
		}
	}
	if hasVisibility {
		nextType, valid := parseRegularVisibility(rawVisibility)
		if !valid {
			httpx.WriteError(w, http.StatusBadRequest, "visibility must be one of: public, private")
			return
		}
		updates.Type = nextType
	}

	if hasVisibility && channel.IsAllSystemChannel(c) {
		httpx.WriteErrorCode(w, http.StatusForbidden, "all_channel_visibility_managed_separately", channel.ALLChannelVisibilityRefusal)
		return
	}
	if hasVisibility {
		member, err := h.Store.IsChannelHuman(r.Context(), c.ID, actor)
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to update channel")
			return
		}
		if !member {
			httpx.WriteErrorCode(w, http.StatusForbidden, "channel_membership_required", channel.VisibilityMembershipRequiredMessage)
			return
		}
	}

	updated, err := h.Store.UpdateChannel(r.Context(), serverID, actor, c.ID, updates)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, presenter.ChannelWire(*updated))
}

// writeUpdateError maps update failures to the TS statuses/bodies.
func (h *ChannelHandlers) writeUpdateError(w http.ResponseWriter, err error) {
	de := channel.AsDomainError(err)
	if de != nil {
		switch {
		case de.Message == channel.CapabilityRequiredMessage:
			httpx.WriteError(w, http.StatusForbidden, "You do not have permission to update channels")
			return
		case de.Message == channel.VisibilityMembershipRequiredMessage:
			httpx.WriteErrorCode(w, http.StatusForbidden, "channel_membership_required", de.Message)
			return
		case de.Message == "This channel is archived":
			httpx.WriteErrorCode(w, http.StatusConflict, "channel_archived", de.Message)
			return
		case de.Message == "Channel not found":
			httpx.WriteError(w, http.StatusNotFound, de.Message)
			return
		case strings.Contains(de.Message, "already taken"):
			httpx.WriteError(w, http.StatusConflict, de.Message)
			return
		case strings.Contains(de.Message, "Cannot rename"),
			strings.Contains(de.Message, "Cannot edit"),
			strings.Contains(de.Message, "Cannot change visibility"),
			strings.Contains(de.Message, "reserved"):
			httpx.WriteError(w, http.StatusForbidden, de.Message)
			return
		case strings.Contains(de.Message, "Guest-joinable"),
			strings.Contains(de.Message, "Guest access"),
			strings.Contains(de.Message, "Guest joining"):
			httpx.WriteError(w, http.StatusBadRequest, de.Message)
			return
		}
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Failed to update channel")
}

// Archive handles POST /api/channels/{id}/archive.
func (h *ChannelHandlers) Archive(w http.ResponseWriter, r *http.Request) {
	h.archiveRoute(w, r, true)
}

// Unarchive handles POST /api/channels/{id}/unarchive.
func (h *ChannelHandlers) Unarchive(w http.ResponseWriter, r *http.Request) {
	h.archiveRoute(w, r, false)
}

func (h *ChannelHandlers) archiveRoute(w http.ResponseWriter, r *http.Request, archive bool) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	verb := "archived"
	if !archive {
		verb = "unarchived"
	}
	regular := c.Type == channel.TypeChannel || c.Type == channel.TypePrivate
	if !regular && c.Type != channel.TypeJoint {
		httpx.WriteError(w, http.StatusBadRequest, "Only regular channels can be "+verb)
		return
	}
	if !h.canSeeChannel(r, c) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	var allowed bool
	if regular {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", authn.UserID(r))
		allowed = err == nil && ac != nil && channel.ChannelActorHasCapability(ac, channel.CapArchiveChannels)
	} else {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, authn.UserID(r))
		allowed = err == nil && channel.HasServerCapability(role, channel.CapArchiveChannels)
	}
	if !allowed {
		httpx.WriteError(w, http.StatusForbidden, "Only admins can "+verb+" channels")
		return
	}
	var (
		updated *channel.Channel
		err     error
	)
	if archive {
		updated, err = h.Store.ArchiveChannel(r.Context(), c.WorkspaceID, c.ID, authn.UserID(r))
	} else {
		updated, err = h.Store.UnarchiveChannel(r.Context(), c.WorkspaceID, c.ID, authn.UserID(r))
	}
	if err != nil {
		de := channel.AsDomainError(err)
		if de != nil {
			switch {
			case de.Message == channel.CapabilityRequiredMessage:
				httpx.WriteError(w, http.StatusForbidden, "Only admins can "+verb+" channels")
			case strings.Contains(de.Message, "#all"), strings.Contains(de.Message, "#announcement"),
				strings.Contains(de.Message, "Only regular"):
				httpx.WriteError(w, http.StatusBadRequest, de.Message)
			case de.Message == "Channel not found":
				httpx.WriteError(w, http.StatusNotFound, de.Message)
			default:
				httpx.WriteError(w, http.StatusInternalServerError, "Failed to "+verb+" channel")
			}
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to "+verb+" channel")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, presenter.ChannelWire(*updated))
}

// Delete handles DELETE /api/channels/{id}.
func (h *ChannelHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.Type == channel.TypeJoint {
		httpx.WriteError(w, http.StatusBadRequest, "Joint channels cannot be deleted; disconnect this server instead")
		return
	}
	if c.Type != channel.TypeDM {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, authn.UserID(r))
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to delete channel")
			return
		}
		if !channel.HasServerCapability(role, channel.CapDeleteChannels) {
			httpx.WriteError(w, http.StatusForbidden, "Only admins can delete channels")
			return
		}
	}
	if err := h.Store.DeleteChannel(r.Context(), c.WorkspaceID, c.ID, authn.UserID(r)); err != nil {
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to delete channel")
		}
		return
	}
	httpx.OKTrue(w)
}

// Join handles POST /api/channels/{id}/join.
func (h *ChannelHandlers) Join(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.JoinChannel(r.Context(), channelServerID(r), r.PathValue("id"), authn.UserID(r)); err != nil {
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to join channel")
		}
		return
	}
	httpx.OKTrue(w)
}

// Leave handles POST /api/channels/{id}/leave. Both system-channel refusals
// are typed forbidden errors, so they answer 403 with the original sentence
// (the #all wording does not contain the TS catch's "Cannot remove" substring,
// which would otherwise collapse that refusal into a generic 500).
func (h *ChannelHandlers) Leave(w http.ResponseWriter, r *http.Request) {
	err := h.Store.LeaveChannel(r.Context(), channelServerID(r), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		if de := channel.AsDomainError(err); de != nil {
			if strings.Contains(de.Message, "Cannot remove") {
				httpx.WriteError(w, http.StatusForbidden, de.Message)
				return
			}
			if !writeChannelDomainError(w, err) {
				httpx.WriteError(w, http.StatusInternalServerError, "Failed to leave channel")
			}
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to leave channel")
		return
	}
	httpx.OKTrue(w)
}

// Members handles GET /api/channels/{id}/members.
func (h *ChannelHandlers) Members(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	roster, err := h.Store.GetChannelMembers(r.Context(), c.ID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get members")
		return
	}
	viewerContext, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", authn.UserID(r))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get members")
		return
	}
	viewerCanChangeRoles := viewerContext != nil && channel.ChannelActorHasCapability(viewerContext, channel.CapChangeChannelRoles)

	// Hidden human directory: only the #all family is filtered, and only for
	// member-viewers of a hideHumansFromMembers workspace.
	hideHumans := false
	if c.Type == channel.TypeChannel && channel.IsAllSystemChannel(c) {
		hideHumans, err = h.Store.ShouldHideHumanDirectory(r.Context(), c.WorkspaceID, authn.UserID(r))
		if err != nil {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to get members")
			return
		}
	}

	if viewerContext != nil && viewerContext.ServerRole == channel.RoleGuest {
		agents := make([]guestRosterAgentWire, 0, len(roster.Agents))
		for _, a := range roster.Agents {
			agents = append(agents, guestRosterAgentWire{
				ID: a.ID, ServerID: channelServerID(r), Name: a.Name, DisplayName: a.DisplayName,
				AvatarURL: a.AvatarURL, Status: a.Status, ProfileProjection: "channel_summary",
				EffectiveChannelRole: channel.ChannelRoleMember, CanChangeChannelRole: false,
			})
		}
		humans := make([]guestRosterHumanWire, 0, len(roster.Humans))
		for _, hm := range roster.Humans {
			role := channel.ChannelRoleMember
			if hm.ServerRole == channel.RoleGuest {
				role = channel.RoleGuest
			}
			humans = append(humans, guestRosterHumanWire{
				ID: hm.ID, Name: hm.Name, DisplayName: hm.DisplayName, AvatarURL: hm.AvatarURL,
				GravatarHash: hm.GravatarHash, EffectiveChannelRole: role, CanChangeChannelRole: false,
			})
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"agents": agents, "humans": humans,
		})
		return
	}

	roster.Project(viewerCanChangeRoles, authn.UserID(r))
	agents := make([]rosterAgentWire, 0, len(roster.Agents))
	for _, a := range roster.Agents {
		agents = append(agents, rosterAgentWireFrom(a))
	}
	humans := make([]rosterHumanWire, 0, len(roster.Humans))
	for _, hm := range roster.Humans {
		if hideHumans && !channel.ExposeHumanInHiddenDirectory(hm, authn.UserID(r)) {
			continue
		}
		humans = append(humans, rosterHumanWireFrom(hm))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"agents": agents, "humans": humans, "externalMembers": []any{},
	})
}

// ListAgents handles GET /api/channels/{id}/agents: the raw agent rows
// without any per-viewer projection (TS res.json(getChannelAgents(...))).
func (h *ChannelHandlers) ListAgents(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	agents, err := h.Store.GetChannelAgents(r.Context(), c.ID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get agents")
		return
	}
	// Derived #all/#announcement audiences have no stored role keys. Explicit
	// rows always carry channelRole and serverRole, and a missing
	// agent_members row is JSON null (LEFT JOIN), not a dropped key.
	if channel.HasImplicitServerMembership(c) {
		type derivedAgent struct {
			ID          string  `json:"id"`
			ServerID    string  `json:"serverId"`
			ServerName  string  `json:"serverName"`
			ServerSlug  string  `json:"serverSlug"`
			Name        string  `json:"name"`
			DisplayName *string `json:"displayName"`
			Status      string  `json:"status"`
			AvatarURL   *string `json:"avatarUrl"`
		}
		raw := make([]derivedAgent, 0, len(agents))
		for _, a := range agents {
			raw = append(raw, derivedAgent{
				ID: a.ID, ServerID: a.ServerID, ServerName: a.ServerName, ServerSlug: a.ServerSlug,
				Name: a.Name, DisplayName: a.DisplayName, Status: a.Status, AvatarURL: a.AvatarURL,
			})
		}
		httpx.WriteJSON(w, http.StatusOK, raw)
		return
	}
	type explicitAgent struct {
		ID          string  `json:"id"`
		ServerID    string  `json:"serverId"`
		ServerName  string  `json:"serverName"`
		ServerSlug  string  `json:"serverSlug"`
		Name        string  `json:"name"`
		DisplayName *string `json:"displayName"`
		Status      string  `json:"status"`
		AvatarURL   *string `json:"avatarUrl"`
		ChannelRole *string `json:"channelRole"`
		ServerRole  *string `json:"serverRole"`
	}
	raw := make([]explicitAgent, 0, len(agents))
	for _, a := range agents {
		raw = append(raw, explicitAgent{
			ID: a.ID, ServerID: a.ServerID, ServerName: a.ServerName, ServerSlug: a.ServerSlug,
			Name: a.Name, DisplayName: a.DisplayName, Status: a.Status, AvatarURL: a.AvatarURL,
			ChannelRole: a.ChannelRole, ServerRole: a.ServerRole,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, raw)
}

// HideAll handles POST /api/channels/system/all/hide; RestoreAll the restore
// mirror. The generic visibility field refuses #all, so these are the only
// ways in.
func (h *ChannelHandlers) HideAll(w http.ResponseWriter, r *http.Request) {
	h.allVisibilityRoute(w, r, false)
}

func (h *ChannelHandlers) RestoreAll(w http.ResponseWriter, r *http.Request) {
	h.allVisibilityRoute(w, r, true)
}

func (h *ChannelHandlers) allVisibilityRoute(w http.ResponseWriter, r *http.Request, restore bool) {
	verb := "hide"
	if restore {
		verb = "restore"
	}
	serverID := channelServerID(r)
	role, err := h.Store.HumanServerRole(r.Context(), serverID, authn.UserID(r))
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	if !channel.HasServerCapability(role, channel.CapChangeChannelVis) {
		httpx.WriteError(w, http.StatusForbidden, "Only admins can "+verb+" #all")
		return
	}
	c, err := h.Store.GetSystemAllChannel(r.Context(), serverID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	if c == nil {
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.ArchivedAt != nil {
		httpx.WriteErrorCode(w, http.StatusConflict, "channel_archived", "This channel is archived")
		return
	}
	if channel.IsEnabledAllChannel(c) == restore {
		// Already in the requested state — idempotent, return the row.
		httpx.WriteJSON(w, http.StatusOK, presenter.ChannelWire(*c))
		return
	}
	nextType := channel.TypePrivate
	if restore {
		nextType = channel.TypeChannel
	}
	updated, err := h.Store.UpdateChannel(r.Context(), serverID, authn.UserID(r), c.ID, channel.ChannelUpdates{Type: &nextType})
	if err != nil {
		if de := channel.AsDomainError(err); de != nil && de.Message == channel.CapabilityRequiredMessage {
			httpx.WriteError(w, http.StatusForbidden, "Only admins can "+verb+" #all")
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, presenter.ChannelWire(*updated))
}

// stringSet extracts a deduped string list from a raw JSON array value.
func stringSet(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, item := range list {
		s, ok := item.(string)
		if !ok || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func isEmptyJSONValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	default:
		return false
	}
}

func hasJointInviteTargets(body map[string]any) bool {
	list, ok := body["jointInvites"].([]any)
	return ok && len(list) > 0
}

func jointInvitesHavePeople(body map[string]any) bool {
	if list, ok := body["jointInvites"].([]any); ok && len(list) > 0 {
		for _, item := range list {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if people := stringSet(entry["invitedPeople"]); len(people) > 0 {
				return true
			}
		}
		return false
	}
	return len(stringSet(body["invitedPeople"])) > 0
}

// utf16Len counts UTF-16 code units like TS string.length.
func utf16Len(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}
