// Legacy-web channel handlers (M3A). Every handler mirrors the exact TS route
// logic in packages/server/src/routes/channels.ts: validation order, error
// sentences, status codes and side effects (minus the Socket.IO / system-
// message fan-out that belongs to M4/M5). The auth gate and the channel
// server-scope middleware run before every handler here.
package legacyweb

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// ChannelHandlers carries the channel store for the whole surface.
//
// M4 is the optional viewer-projection seam for the list/detail/create
// exits. Wired (production M4): the exits read channels, authority and the
// viewer's read/mute/display/last-message state on ONE pinned read snapshot
// and emit the real values. Nil (standalone M3 suites): the exits keep the
// explicit M3 fixture defaults (readState absent, cursor 0, unmuted,
// collapse-on, null last message) — those defaults stay visible in
// channel_dto.go rather than becoming silent zeros. Parent wiring in
// app/m4.go: `channels := &legacyweb.ChannelHandlers{Store: m.channels,
// M4: m4Projector}` where m4Projector adapts readstate/message projections.
type ChannelHandlers struct {
	Store *channel.Store
	M4    M4ChannelProjector
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
func (h *ChannelHandlers) RequireChannelServer(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := r.Header.Get("X-Server-Id")
		if serverID == "" {
			writeError(w, http.StatusBadRequest, "Missing X-Server-Id header")
			return
		}
		var one int
		err := h.Store.DB().QueryRowContext(r.Context(), `
			SELECT 1
			FROM workspace_memberships m
			JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.workspace_id = ? AND m.user_id = ?
			  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
			serverID, userID(r)).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusForbidden, "Not a member of this server")
			return
		}
		if err != nil {
			writeErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
			return
		}
		ctx := context.WithValue(r.Context(), ctxChannelServer, serverID)
		next(w, r.WithContext(ctx))
	}
}

// scopedChannel loads the channel and refuses cross-workspace access with the
// legacy 404 ("Channel not found"). ok=false means the response was written.
func (h *ChannelHandlers) scopedChannel(w http.ResponseWriter, r *http.Request) (*channel.Channel, bool) {
	channelID := r.PathValue("id")
	c, err := h.Store.GetChannel(r.Context(), channelID)
	if err != nil {
		writeErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
		return nil, false
	}
	if c == nil || c.WorkspaceID != channelServerID(r) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return nil, false
	}
	return c, true
}

// canSeeChannel ports the route helper of the same name.
func (h *ChannelHandlers) canSeeChannel(r *http.Request, c *channel.Channel) bool {
	ok, err := h.Store.CanUserAccessChannel(r.Context(), c.WorkspaceID, c.ID, userID(r))
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
		writeError(w, http.StatusBadRequest, de.Message)
	case channel.CodeForbidden:
		writeError(w, http.StatusForbidden, de.Message)
	case channel.CodeNotFound:
		writeError(w, http.StatusNotFound, de.Message)
	case channel.CodeConflict:
		if de.Message == "This channel is archived" {
			writeErrorCode(w, http.StatusConflict, "channel_archived", de.Message)
		} else {
			writeError(w, http.StatusConflict, de.Message)
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
			writeError(w, http.StatusBadRequest, "archived must be one of: exclude, include, only")
			return
		}
	}
	if h.M4 == nil {
		// Standalone M3 path (fixture defaults, lazy system-channel ensure).
		h.listM3(w, r, filter)
		return
	}
	// M4: channels, authority and viewer projections share ONE pinned
	// snapshot; nothing here reads from a second connection.
	var views []channelView
	err := platformdb.WithReadSnapshot(r.Context(), h.Store.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(r.Context(), ex, accessClaims(r), time.Now()); err != nil {
			return err
		}
		serverID, actor := channelServerID(r), userID(r)
		items, err := h.Store.ListChannelsTx(r.Context(), ex, serverID, actor, filter)
		if err != nil {
			return err
		}
		rows := make([]channel.Channel, 0, len(items))
		for _, item := range items {
			rows = append(rows, item.Channel)
		}
		projections, err := h.M4(r.Context(), ex, serverID, actor, rows, true)
		if err != nil {
			return err
		}
		views = make([]channelView, 0, len(items))
		for _, item := range items {
			ac, err := h.Store.ResolveChannelActorContextTx(r.Context(), ex, item.Channel.WorkspaceID, item.Channel.ID, "user", actor)
			if err != nil {
				return err
			}
			views = append(views, channelListItem(item.Channel, item.Joined, ac, m4ProjectionFor(projections, true, item.Channel.ID)))
		}
		return nil
	})
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to list channels")
		}
		return
	}
	writeJSON(w, http.StatusOK, views)
}

// listM3 is the projector-free list exit: byte-identical to the M3 behavior
// (separate store reads, lazy system-channel ensure, fixture defaults).
func (h *ChannelHandlers) listM3(w http.ResponseWriter, r *http.Request, filter string) {
	items, err := h.Store.ListChannels(r.Context(), channelServerID(r), userID(r), filter)
	if err != nil {
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to list channels")
		}
		return
	}
	views := make([]channelView, 0, len(items))
	for _, item := range items {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), item.Channel.WorkspaceID, item.Channel.ID, "user", userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to list channels")
			return
		}
		views = append(views, channelListItem(item.Channel, item.Joined, ac, m4ChannelProjectionRow{}))
	}
	writeJSON(w, http.StatusOK, views)
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

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Create handles POST /api/channels.
func (h *ChannelHandlers) Create(w http.ResponseWriter, r *http.Request) {
	serverID := channelServerID(r)
	actor := userID(r)
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}

	// 1. Server capability gate.
	serverRole, err := h.Store.HumanServerRole(r.Context(), serverID, actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to create channel")
		return
	}
	if !channel.HasServerCapability(serverRole, channel.CapCreateChannels) {
		writeError(w, http.StatusForbidden, "You do not have permission to create channels")
		return
	}

	// 2. Visibility (joint accepted for validation parity, refused honestly
	// at the create point below).
	channelType, isJoint, visibilityOK := parseChannelVisibility(body["visibility"])
	if !visibilityOK {
		writeError(w, http.StatusBadRequest, "visibility must be one of: public, private, joint")
		return
	}

	// 3. Name (TS validateName sentences; a non-string name answers the
	// "required" sentence instead of crashing — documented deviation).
	rawName, _ := body["name"].(string)
	if nameError := channel.ValidateChannelName(rawName); nameError != "" {
		writeError(w, http.StatusBadRequest, nameError)
		return
	}
	name := strings.TrimSpace(rawName)
	if name == "all" {
		writeErrorCode(w, http.StatusBadRequest, "channel_name_reserved", `Channel name "all" is reserved`)
		return
	}

	// 4. Joint parameter validation (parity for the 400s TS answers before
	// refusing to federate).
	if isJoint {
		targetSlug, _ := body["targetServerSlug"].(string)
		if strings.TrimSpace(targetSlug) == "" && !hasJointInviteTargets(body) {
			writeError(w, http.StatusBadRequest, "Invite server slug is required")
			return
		}
		if !jointInvitesHavePeople(body) {
			writeError(w, http.StatusBadRequest, "At least one invited person is required")
			return
		}
	}

	// 5. Description: at most 500 UTF-16 units when a non-empty value is set.
	if description, present := body["description"]; present && !isEmptyJSONValue(description) {
		text, ok := description.(string)
		if !ok || utf16Len(text) > 500 {
			writeError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
			return
		}
	}

	// 6. Joint requires the federate capability (owner/admin hold it).
	if isJoint && !channel.HasServerCapability(serverRole, channel.CapFederateChannels) {
		writeError(w, http.StatusForbidden, "You do not have permission to federate channels")
		return
	}

	// 7/8. Target validation: every selected agent/user must belong to the
	// acting workspace before anything is written.
	selectedAgentIDs := stringSet(body["agentIds"])
	for _, agentID := range selectedAgentIDs {
		exists, err := h.Store.AgentExistsInWorkspace(r.Context(), h.Store.DB(), agentID, serverID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create channel")
			return
		}
		if !exists {
			writeError(w, http.StatusBadRequest, "Agent not found in this server")
			return
		}
	}
	selectedUserIDs := stringSet(body["userIds"])
	for _, targetID := range selectedUserIDs {
		role, err := h.Store.HumanServerRole(r.Context(), serverID, targetID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create channel")
			return
		}
		if role == "" {
			writeError(w, http.StatusBadRequest, "User is not a member of this server")
			return
		}
	}

	if isJoint {
		// Joint channels remain deferred: refuse honestly rather than
		// creating a local stand-in (docs/m3-channel-contract.md §1).
		writeErrorCode(w, http.StatusNotImplemented, "joint_channels_not_implemented", "Joint channels are not implemented in this phase")
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
	if h.M4 == nil {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), serverID, created.ID, "user", actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to create channel")
			return
		}
		writeJSON(w, http.StatusOK, channelCreateView(*created, ac, m4ChannelProjectionRow{}))
		return
	}
	// The channel exists now; its (legitimately empty) viewer state is read
	// on one snapshot through the same projector as the other exits, so the
	// response states fresh-scope facts instead of an old scope's defaults.
	var view *createView
	err = platformdb.WithReadSnapshot(r.Context(), h.Store.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(r.Context(), ex, accessClaims(r), time.Now()); err != nil {
			return err
		}
		ac, err := h.Store.ResolveChannelActorContextTx(r.Context(), ex, serverID, created.ID, "user", actor)
		if err != nil {
			return err
		}
		projections, err := h.M4(r.Context(), ex, serverID, actor, []channel.Channel{*created}, false)
		if err != nil {
			return err
		}
		built := channelCreateView(*created, ac, m4ProjectionFor(projections, true, created.ID))
		view = &built
		return nil
	})
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to create channel")
		return
	}
	writeJSON(w, http.StatusOK, *view)
}

// writeCreateError maps create failures to the exact TS statuses/bodies.
func (h *ChannelHandlers) writeCreateError(w http.ResponseWriter, r *http.Request, err error) {
	if collision := channel.AsArchivedNameCollision(err); collision != nil {
		canUnarchive := false
		if collision.ArchivedChannelType == channel.TypeChannel || collision.ArchivedChannelType == channel.TypePrivate {
			ok, cerr := h.Store.ActorHasChannelCapability(r.Context(), channelServerID(r), collision.ArchivedChannelID, "user", userID(r), channel.CapArchiveChannels)
			canUnarchive = cerr == nil && ok
		}
		writeJSON(w, http.StatusConflict, map[string]any{
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
			writeError(w, http.StatusConflict, de.Message)
			return
		case strings.Contains(de.Message, "Channel limit reached"):
			writeError(w, http.StatusForbidden, de.Message)
			return
		case strings.Contains(de.Message, "is reserved"):
			writeErrorCode(w, http.StatusBadRequest, "channel_name_reserved", de.Message)
			return
		case de.Message == "You do not have permission to create channels":
			writeError(w, http.StatusForbidden, de.Message)
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "Failed to create channel")
}

// Get handles GET /api/channels/{id}.
func (h *ChannelHandlers) Get(w http.ResponseWriter, r *http.Request) {
	if h.M4 == nil {
		h.getM3(w, r)
		return
	}
	serverID, actor := channelServerID(r), userID(r)
	var view *channelView
	err := platformdb.WithReadSnapshot(r.Context(), h.Store.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(r.Context(), ex, accessClaims(r), time.Now()); err != nil {
			return err
		}
		c, err := h.Store.GetChannelTx(r.Context(), ex, r.PathValue("id"))
		if err != nil {
			return err
		}
		if c == nil || c.WorkspaceID != serverID {
			return &m4GetChannelNotFound{}
		}
		visible, err := h.Store.CanUserAccessChannelTx(r.Context(), ex, serverID, c.ID, actor)
		if err != nil {
			return err
		}
		if !visible {
			return &m4GetChannelNotFound{}
		}
		joined, err := h.channelJoinedTx(r.Context(), ex, c, actor)
		if err != nil {
			return err
		}
		ac, err := h.Store.ResolveChannelActorContextTx(r.Context(), ex, c.WorkspaceID, c.ID, "user", actor)
		if err != nil {
			return err
		}
		projections, err := h.M4(r.Context(), ex, serverID, actor, []channel.Channel{*c}, false)
		if err != nil {
			return err
		}
		built := channelDetailView(*c, joined, ac, m4ProjectionFor(projections, true, c.ID))
		view = &built
		return nil
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4getChannelNotFound):
			writeError(w, http.StatusNotFound, "Channel not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get channel")
		return
	}
	writeJSON(w, http.StatusOK, *view)
}

type m4GetChannelNotFound struct{}

func (m4GetChannelNotFound) Error() string { return "channel not found or invisible" }

var m4getChannelNotFound = &m4GetChannelNotFound{}

// channelJoinedTx ports the detail exit's joined derivation onto the pinned
// executor (DM and implicit-membership channels read joined; the hidden #all
// never does for guests).
func (h *ChannelHandlers) channelJoinedTx(ctx context.Context, ex channel.Executor, c *channel.Channel, actor string) (bool, error) {
	if c.Type == channel.TypeDM {
		return true, nil
	}
	serverRole, err := h.Store.HumanServerRoleTx(ctx, ex, c.WorkspaceID, actor)
	if err != nil {
		return false, err
	}
	if serverRole != channel.RoleGuest && channel.HasImplicitServerMembership(c) {
		return true, nil
	}
	if channel.IsAllSystemChannel(c) && serverRole == channel.RoleGuest {
		return false, nil
	}
	return h.Store.IsChannelHumanTx(ctx, ex, c.ID, actor)
}

// getM3 is the projector-free detail exit, byte-identical to M3.
func (h *ChannelHandlers) getM3(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	actor := userID(r)
	serverRole, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get channel")
		return
	}
	var joined bool
	if c.Type == channel.TypeDM {
		joined = true
	} else if serverRole != channel.RoleGuest && channel.HasImplicitServerMembership(c) {
		joined = true
	} else if channel.IsAllSystemChannel(c) && serverRole == channel.RoleGuest {
		joined = false
	} else {
		joined, err = h.Store.IsChannelHuman(r.Context(), c.ID, actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to get channel")
			return
		}
	}
	ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get channel")
		return
	}
	writeJSON(w, http.StatusOK, channelDetailView(*c, joined, ac, m4ChannelProjectionRow{}))
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
	actor := userID(r)
	serverID := channelServerID(r)

	serverRole, err := h.Store.HumanServerRole(r.Context(), serverID, actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to update channel")
		return
	}
	ac, err := h.Store.ResolveChannelActorContext(r.Context(), serverID, c.ID, "user", actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to update channel")
		return
	}
	canEditMetadata := ac != nil && channel.ChannelActorHasCapability(ac, channel.CapEditChannelMetadata)
	canChangeVisibility := channel.HasServerCapability(serverRole, channel.CapChangeChannelVis)
	canManageGuestAccess := ac != nil && channel.ChannelActorHasCapability(ac, channel.CapManageGuestAccess)
	canManageRequestedChange := canEditMetadata || canChangeVisibility || canManageGuestAccess

	isHiddenAllChannel := channel.IsAllSystemChannel(c) && !channel.IsEnabledAllChannel(c)
	if isHiddenAllChannel && !canManageRequestedChange {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if !isHiddenAllChannel && !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.Type == channel.TypeDM {
		writeError(w, http.StatusForbidden, "Cannot edit DM channels")
		return
	}
	if c.ArchivedAt != nil {
		writeErrorCode(w, http.StatusConflict, "channel_archived", "This channel is archived")
		return
	}

	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	rawName, hasName := body["name"]
	rawDescription, hasDescription := body["description"]
	rawVisibility, hasVisibility := body["visibility"]
	_, hasGuestVisible := body["guestVisible"]
	_, hasGuestJoinable := body["guestJoinable"]
	guestPolicyRequested := hasGuestVisible || hasGuestJoinable

	if (hasName || hasDescription) && !canEditMetadata {
		writeError(w, http.StatusForbidden, "You do not have permission to edit channel metadata")
		return
	}
	if hasVisibility && !canChangeVisibility {
		writeError(w, http.StatusForbidden, "You do not have permission to change channel visibility")
		return
	}
	if guestPolicyRequested && !canManageGuestAccess {
		writeError(w, http.StatusForbidden, "You do not have permission to manage guest access")
		return
	}
	if guestPolicyRequested {
		// The guest feature gate stays disabled in the frozen policy vector;
		// the legacy answer for a disabled gate is this 404.
		writeError(w, http.StatusNotFound, "Guest access is not enabled")
		return
	}
	if !hasName && !hasDescription && !hasVisibility && !canEditMetadata {
		writeError(w, http.StatusForbidden, "You do not have permission to update channels")
		return
	}

	var updates channel.ChannelUpdates
	if hasName {
		name, _ := rawName.(string)
		if nameError := channel.ValidateChannelName(name); nameError != "" {
			writeError(w, http.StatusBadRequest, nameError)
			return
		}
		trimmed := strings.TrimSpace(name)
		updates.Name = &trimmed
	}
	if hasDescription {
		if text, ok := rawDescription.(string); ok {
			if utf16Len(text) > 500 {
				writeError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
				return
			}
			updates.Description = &text
		} else if rawDescription != nil {
			writeError(w, http.StatusBadRequest, "Description must be a string of at most 500 characters")
			return
		} else {
			empty := ""
			updates.Description = &empty
		}
	}
	if hasVisibility {
		nextType, valid := parseRegularVisibility(rawVisibility)
		if !valid {
			writeError(w, http.StatusBadRequest, "visibility must be one of: public, private")
			return
		}
		updates.Type = nextType
	}

	if hasVisibility && channel.IsAllSystemChannel(c) {
		writeErrorCode(w, http.StatusForbidden, "all_channel_visibility_managed_separately", channel.ALLChannelVisibilityRefusal)
		return
	}
	if hasVisibility {
		member, err := h.Store.IsChannelHuman(r.Context(), c.ID, actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to update channel")
			return
		}
		if !member {
			writeErrorCode(w, http.StatusForbidden, "channel_membership_required", channel.VisibilityMembershipRequiredMessage)
			return
		}
	}

	updated, err := h.Store.UpdateChannel(r.Context(), serverID, actor, c.ID, updates)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// writeUpdateError maps update failures to the TS statuses/bodies.
func (h *ChannelHandlers) writeUpdateError(w http.ResponseWriter, err error) {
	de := channel.AsDomainError(err)
	if de != nil {
		switch {
		case de.Message == channel.CapabilityRequiredMessage:
			writeError(w, http.StatusForbidden, "You do not have permission to update channels")
			return
		case de.Message == channel.VisibilityMembershipRequiredMessage:
			writeErrorCode(w, http.StatusForbidden, "channel_membership_required", de.Message)
			return
		case de.Message == "This channel is archived":
			writeErrorCode(w, http.StatusConflict, "channel_archived", de.Message)
			return
		case de.Message == "Channel not found":
			writeError(w, http.StatusNotFound, de.Message)
			return
		case strings.Contains(de.Message, "already taken"):
			writeError(w, http.StatusConflict, de.Message)
			return
		case strings.Contains(de.Message, "Cannot rename"),
			strings.Contains(de.Message, "Cannot edit"),
			strings.Contains(de.Message, "Cannot change visibility"),
			strings.Contains(de.Message, "reserved"):
			writeError(w, http.StatusForbidden, de.Message)
			return
		case strings.Contains(de.Message, "Guest-joinable"),
			strings.Contains(de.Message, "Guest access"),
			strings.Contains(de.Message, "Guest joining"):
			writeError(w, http.StatusBadRequest, de.Message)
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "Failed to update channel")
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
		writeError(w, http.StatusBadRequest, "Only regular channels can be "+verb)
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	var allowed bool
	if regular {
		ac, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", userID(r))
		allowed = err == nil && ac != nil && channel.ChannelActorHasCapability(ac, channel.CapArchiveChannels)
	} else {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, userID(r))
		allowed = err == nil && channel.HasServerCapability(role, channel.CapArchiveChannels)
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "Only admins can "+verb+" channels")
		return
	}
	var (
		updated *channel.Channel
		err     error
	)
	if archive {
		updated, err = h.Store.ArchiveChannel(r.Context(), c.WorkspaceID, c.ID, userID(r))
	} else {
		updated, err = h.Store.UnarchiveChannel(r.Context(), c.WorkspaceID, c.ID, userID(r))
	}
	if err != nil {
		de := channel.AsDomainError(err)
		if de != nil {
			switch {
			case de.Message == channel.CapabilityRequiredMessage:
				writeError(w, http.StatusForbidden, "Only admins can "+verb+" channels")
			case strings.Contains(de.Message, "#all"), strings.Contains(de.Message, "#announcement"),
				strings.Contains(de.Message, "Only regular"):
				writeError(w, http.StatusBadRequest, de.Message)
			case de.Message == "Channel not found":
				writeError(w, http.StatusNotFound, de.Message)
			default:
				writeError(w, http.StatusInternalServerError, "Failed to "+verb+" channel")
			}
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to "+verb+" channel")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// Delete handles DELETE /api/channels/{id}.
func (h *ChannelHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.Type == channel.TypeJoint {
		writeError(w, http.StatusBadRequest, "Joint channels cannot be deleted; disconnect this server instead")
		return
	}
	if c.Type != channel.TypeDM {
		role, err := h.Store.HumanServerRole(r.Context(), c.WorkspaceID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to delete channel")
			return
		}
		if !channel.HasServerCapability(role, channel.CapDeleteChannels) {
			writeError(w, http.StatusForbidden, "Only admins can delete channels")
			return
		}
	}
	if err := h.Store.DeleteChannel(r.Context(), c.WorkspaceID, c.ID, userID(r)); err != nil {
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to delete channel")
		}
		return
	}
	okTrue(w)
}

// Join handles POST /api/channels/{id}/join.
func (h *ChannelHandlers) Join(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.JoinChannel(r.Context(), channelServerID(r), r.PathValue("id"), userID(r)); err != nil {
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to join channel")
		}
		return
	}
	okTrue(w)
}

// Leave handles POST /api/channels/{id}/leave. Both system-channel refusals
// are typed forbidden errors, so they answer 403 with the original sentence
// (the #all wording does not contain the TS catch's "Cannot remove" substring,
// which would otherwise collapse that refusal into a generic 500).
func (h *ChannelHandlers) Leave(w http.ResponseWriter, r *http.Request) {
	err := h.Store.LeaveChannel(r.Context(), channelServerID(r), r.PathValue("id"), userID(r))
	if err != nil {
		if de := channel.AsDomainError(err); de != nil {
			if strings.Contains(de.Message, "Cannot remove") {
				writeError(w, http.StatusForbidden, de.Message)
				return
			}
			if !writeChannelDomainError(w, err) {
				writeError(w, http.StatusInternalServerError, "Failed to leave channel")
			}
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to leave channel")
		return
	}
	okTrue(w)
}

// Members handles GET /api/channels/{id}/members.
func (h *ChannelHandlers) Members(w http.ResponseWriter, r *http.Request) {
	c, ok := h.scopedChannel(w, r)
	if !ok {
		return
	}
	if !h.canSeeChannel(r, c) {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	roster, err := h.Store.GetChannelMembers(r.Context(), c.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get members")
		return
	}
	viewerContext, err := h.Store.ResolveChannelActorContext(r.Context(), c.WorkspaceID, c.ID, "user", userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get members")
		return
	}
	viewerCanChangeRoles := viewerContext != nil && channel.ChannelActorHasCapability(viewerContext, channel.CapChangeChannelRoles)

	// Hidden human directory: only the #all family is filtered, and only for
	// member-viewers of a hideHumansFromMembers workspace.
	hideHumans := false
	if c.Type == channel.TypeChannel && channel.IsAllSystemChannel(c) {
		hideHumans, err = h.Store.ShouldHideHumanDirectory(r.Context(), c.WorkspaceID, userID(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Failed to get members")
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
		writeJSON(w, http.StatusOK, map[string]any{
			"agents": agents, "humans": humans,
		})
		return
	}

	roster.Project(viewerCanChangeRoles, userID(r))
	agents := make([]rosterAgentWire, 0, len(roster.Agents))
	for _, a := range roster.Agents {
		agents = append(agents, rosterAgentWireFrom(a))
	}
	humans := make([]rosterHumanWire, 0, len(roster.Humans))
	for _, hm := range roster.Humans {
		if hideHumans && !channel.ExposeHumanInHiddenDirectory(hm, userID(r)) {
			continue
		}
		humans = append(humans, rosterHumanWireFrom(hm))
	}
	writeJSON(w, http.StatusOK, map[string]any{
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
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	agents, err := h.Store.GetChannelAgents(r.Context(), c.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get agents")
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
		writeJSON(w, http.StatusOK, raw)
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
	writeJSON(w, http.StatusOK, raw)
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
	role, err := h.Store.HumanServerRole(r.Context(), serverID, userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	if !channel.HasServerCapability(role, channel.CapChangeChannelVis) {
		writeError(w, http.StatusForbidden, "Only admins can "+verb+" #all")
		return
	}
	c, err := h.Store.GetSystemAllChannel(r.Context(), serverID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	if c == nil {
		writeError(w, http.StatusNotFound, "Channel not found")
		return
	}
	if c.ArchivedAt != nil {
		writeErrorCode(w, http.StatusConflict, "channel_archived", "This channel is archived")
		return
	}
	if channel.IsEnabledAllChannel(c) == restore {
		// Already in the requested state — idempotent, return the row.
		writeJSON(w, http.StatusOK, c)
		return
	}
	nextType := channel.TypePrivate
	if restore {
		nextType = channel.TypeChannel
	}
	updated, err := h.Store.UpdateChannel(r.Context(), serverID, userID(r), c.ID, channel.ChannelUpdates{Type: &nextType})
	if err != nil {
		if de := channel.AsDomainError(err); de != nil && de.Message == channel.CapabilityRequiredMessage {
			writeError(w, http.StatusForbidden, "Only admins can "+verb+" #all")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to "+verb+" #all")
		return
	}
	writeJSON(w, http.StatusOK, updated)
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
