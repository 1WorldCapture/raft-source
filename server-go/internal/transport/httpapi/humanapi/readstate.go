// M4 P5 readstate HTTP surface: versioned read/unread/read-all, conversation
// Done/undone (channel + thread) with the strict storage frontier matrix,
// notification (mute) and message-display preferences, the unified human
// Inbox plus its Done/unfollowed histories, unread counts/summaries and the
// server-authoritative Activity snapshot/difference reads.
//
// Every handler mirrors the TS routes in packages/server/src/routes/channels.ts
// (validation order, error sentences, status codes) and mounts behind the
// verified-profile gate plus the X-Server-Id scope middleware; the store
// revalidates session and membership inside each transaction. Registration
// lives in m4_readstate_routes.go — the parent integrates both; this file
// never edits routes.go or the channel dispatcher.
package humanapi

import (
	"context"
	"errors"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strconv"
	"strings"

	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/transport/presenter"
	"raft.local/server-go/internal/workspace"
)

// ReadstateHandlers carries the readstate store for the whole surface.
type ReadstateHandlers struct {
	Store     *readstate.Store
	Workspace *workspace.Store
}

type ctxReadstateServerKeyType struct{}

var ctxReadstateServer ctxReadstateServerKeyType

// readstateServerID returns the workspace id resolved by RequireServerScope.
func readstateServerID(r *http.Request) string {
	v, _ := r.Context().Value(ctxReadstateServer).(string)
	return v
}

// The parent's authn.AccessClaims(r) (verified JWT claims saved in the request
// context by the auth gate) is reused directly: every store operation
// receives the full claims and revalidates them inside its transaction.

// RequireServerScope ports the legacy requireServer middleware for the
// readstate surface: the X-Server-Id header names the acting workspace and
// the caller must hold an eligible membership.
func (h *ReadstateHandlers) RequireServerScope(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := r.Header.Get("X-Server-Id")
		if serverID == "" {
			httpx.WriteError(w, http.StatusBadRequest, "Missing X-Server-Id header")
			return
		}
		// The eligibility fact is owned by the workspace domain; transport
		// never queries membership tables itself.
		_, err := h.Workspace.GetMembership(r.Context(), serverID, authn.UserID(r))
		if errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			if workspace.AsDomainError(err) != nil {
				httpx.WriteError(w, http.StatusForbidden, "Not a member of this server")
				return
			}
			httpx.WriteErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
			return
		}
		ctx := context.WithValue(r.Context(), ctxReadstateServer, serverID)
		next(w, r.WithContext(ctx))
	}
}

// writeDomain maps a readstate domain error onto the legacy HTTP shapes;
// infrastructure failures stay 500 and a session failure stays 401.
func writeReadstateError(w http.ResponseWriter, err error, fallback string) {
	var re *readstate.Error
	if errors.As(err, &re) {
		if re.Code == "" {
			httpx.WriteError(w, re.Status, re.Message)
			return
		}
		httpx.WriteErrorCode(w, re.Status, re.Code, re.Message)
		return
	}
	if errors.Is(err, readstate.ErrTokenInvalid) {
		httpx.WriteErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
		return
	}
	httpx.WriteError(w, http.StatusInternalServerError, fallback)
}

// readstateBody decodes a JSON object body (absent body = empty map).
func readstateBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body := map[string]any{}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return nil, false
	}
	return body, true
}

// doneInputFromBody applies the adjudicated four-way frontier matrix shared
// by /inbox/done and /threads/done: omitted value => canonical snapshot
// (with or without storage identity); value without identity => 412 refresh;
// unsupported identity => 400; only explicit storage values enter the strict
// guard (inside the store).
func doneInputFromBody(w http.ResponseWriter, body map[string]any) (readstate.DoneInput, bool) {
	rawFrontierSpace, frontierSpacePresent := body["frontierSpace"]
	rawThrough, throughPresent := body["throughActivitySeq"]
	if !frontierSpacePresent && throughPresent {
		httpx.WriteErrorCode(w, http.StatusPreconditionFailed, "DONE_FRONTIER_SPACE_REQUIRED",
			"frontierSpace is required; refresh and retry")
		return readstate.DoneInput{}, false
	}
	if frontierSpacePresent && rawFrontierSpace != "storage" {
		httpx.WriteErrorCode(w, http.StatusBadRequest, "DONE_FRONTIER_UNMAPPABLE",
			"frontierSpace must be storage")
		return readstate.DoneInput{}, false
	}
	input := readstate.DoneInput{ThroughPresent: throughPresent}
	if through, ok := rawThrough.(string); ok {
		input.Through = &through
	}
	return input, true
}

// Inbox handles GET /api/channels/inbox.
func (h *ReadstateHandlers) Inbox(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	filter := query.Get("filter")
	switch filter {
	case "", "all":
		filter = "all"
	case "unread", "mentions", "unread_mentions":
	default:
		filter = "all"
	}
	limit := inboxLimit(query.Get("limit"))
	offset := inboxOffset(query.Get("offset"))
	channelID := query.Get("channelId")
	if channelID != "" && !httpx.UUIDPattern.MatchString(channelID) {
		channelID = ""
	}
	q := strings.TrimSpace(query.Get("q"))
	if len(q) > 200 {
		q = q[:200]
	}
	sortDir := "desc"
	if query.Get("sort") == "asc" {
		sortDir = "asc"
	}
	page, err := h.Store.InboxItems(r.Context(), authn.AccessClaims(r), readstateServerID(r), readstate.InboxQuery{
		Filter:    filter,
		Limit:     limit,
		Offset:    offset,
		ChannelID: channelID,
		Q:         q,
		Sort:      sortDir,
	})
	if err != nil {
		writeReadstateError(w, err, "Failed to get inbox")
		return
	}
	items := make([]map[string]any, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, presenter.InboxItemWire(item))
	}
	groups := make([]map[string]any, 0, len(page.Groups))
	for _, group := range page.Groups {
		groups = append(groups, map[string]any{
			"channelId":      group.ChannelID,
			"channelName":    group.ChannelName,
			"channelType":    group.ChannelType,
			"count":          group.Count,
			"lastActivityAt": group.LastActivityAt,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"items":             items,
		"groups":            groups,
		"hasMore":           page.HasMore,
		"totalCount":        page.TotalCount,
		"totalUnreadCount":  page.TotalUnreadCount,
		"activeUnreadCount": page.ActiveUnreadCount,
	})
}

// inboxLimit ports the legacy limit arithmetic: Number(x)||30, cap 100,
// floor 1 in the service.
func inboxLimit(raw string) int {
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed == 0 {
		return readstate.InboxDefaultLimit
	}
	if parsed > readstate.InboxMaxLimit {
		return readstate.InboxMaxLimit
	}
	return parsed
}

func inboxOffset(raw string) int {
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

// InboxDone handles GET /api/channels/inbox/done.
func (h *ReadstateHandlers) InboxDone(w http.ResponseWriter, r *http.Request) {
	page, err := h.Store.DoneInboxItems(r.Context(), authn.AccessClaims(r), readstateServerID(r), inboxHistoryQuery(r))
	if err != nil {
		writeReadstateError(w, err, "Failed to get Done history")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      wireItems(page.Items),
		"hasMore":    page.HasMore,
		"totalCount": nil,
	})
}

// InboxUnfollowed handles GET /api/channels/inbox/unfollowed.
func (h *ReadstateHandlers) InboxUnfollowed(w http.ResponseWriter, r *http.Request) {
	page, err := h.Store.UnfollowedInboxItems(r.Context(), authn.AccessClaims(r), readstateServerID(r), inboxHistoryQuery(r))
	if err != nil {
		writeReadstateError(w, err, "Failed to get unfollowed Activity history")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      wireItems(page.Items),
		"hasMore":    page.HasMore,
		"totalCount": nil,
	})
}

func inboxHistoryQuery(r *http.Request) readstate.InboxQuery {
	query := r.URL.Query()
	channelID := query.Get("channelId")
	if channelID != "" && !httpx.UUIDPattern.MatchString(channelID) {
		channelID = ""
	}
	q := strings.TrimSpace(query.Get("q"))
	if len(q) > 200 {
		q = q[:200]
	}
	sortDir := "desc"
	if query.Get("sort") == "asc" {
		sortDir = "asc"
	}
	return readstate.InboxQuery{
		Limit:     inboxLimit(query.Get("limit")),
		Offset:    inboxOffset(query.Get("offset")),
		ChannelID: channelID,
		Q:         q,
		Sort:      sortDir,
	}
}

func wireItems(items []readstate.InboxItem) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, presenter.InboxItemWire(item))
	}
	return out
}

// InboxDonePost handles POST /api/channels/inbox/done.
func (h *ReadstateHandlers) InboxDonePost(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	channelID, _ := body["channelId"].(string)
	if channelID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "channelId is required")
		return
	}
	input, ok := doneInputFromBody(w, body)
	if !ok {
		return
	}
	if _, err := h.Store.DoneChannel(r.Context(), authn.AccessClaims(r), readstateServerID(r), channelID, input); err != nil {
		writeDoneError(w, err, "Failed to mark chat as done")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// InboxUndone handles POST /api/channels/inbox/undone.
func (h *ReadstateHandlers) InboxUndone(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	channelID, _ := body["channelId"].(string)
	if channelID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "channelId is required")
		return
	}
	if err := h.Store.UndoneChannel(r.Context(), authn.AccessClaims(r), readstateServerID(r), channelID); err != nil {
		writeReadstateError(w, err, "Failed to restore chat from Done")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// InboxReadAll handles POST /api/channels/inbox/read-all.
func (h *ReadstateHandlers) InboxReadAll(w http.ResponseWriter, r *http.Request) {
	result, err := h.Store.MarkInboxReadLatest(r.Context(), authn.AccessClaims(r), readstateServerID(r))
	if err != nil {
		writeReadstateError(w, err, "Failed to mark inbox as read")
		return
	}
	scopes := make([]map[string]any, 0, len(result.Scopes))
	for _, scope := range result.Scopes {
		scopes = append(scopes, map[string]any{
			"scopeId":          scope.ChannelID,
			"maxReadSeq":       scope.MaxReadSeq,
			"readStateVersion": scope.ReadStateVersion,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"markedCount": result.MarkedCount,
		"scopes":      scopes,
	})
}

// ThreadDone handles POST /api/channels/threads/done.
func (h *ReadstateHandlers) ThreadDone(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	threadChannelID, _ := body["threadChannelId"].(string)
	if threadChannelID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "threadChannelId is required")
		return
	}
	input, ok := doneInputFromBody(w, body)
	if !ok {
		return
	}
	result, err := h.Store.DoneThread(r.Context(), authn.AccessClaims(r), readstateServerID(r), threadChannelID, input)
	if err != nil {
		writeDoneError(w, err, "Failed to mark thread as done")
		return
	}
	response := map[string]any{"ok": true}
	if result.LegacyNoop {
		response["terminalReason"] = result.TerminalReason
		response["legacyNoop"] = true
		response["retiredThroughActivitySeq"] = result.RetiredThroughActivitySeq
		response["readStateVersion"] = result.ReadStateVersion
		response["changed"] = result.Changed
	}
	httpx.WriteJSON(w, http.StatusOK, response)
}

// ThreadUndone handles POST /api/channels/threads/undone.
func (h *ReadstateHandlers) ThreadUndone(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	threadChannelID, _ := body["threadChannelId"].(string)
	if threadChannelID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "threadChannelId is required")
		return
	}
	if err := h.Store.UndoneThread(r.Context(), authn.AccessClaims(r), readstateServerID(r), threadChannelID); err != nil {
		writeReadstateError(w, err, "Failed to undone thread")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeDoneError(w http.ResponseWriter, err error, fallback string) {
	var re *readstate.Error
	if errors.As(err, &re) {
		switch re.Code {
		case readstate.CodeDoneFrontierRequired:
			httpx.WriteErrorCode(w, http.StatusBadRequest, re.Code, re.Message)
		case readstate.CodeDoneFrontierBeyondLatest, readstate.CodeDoneFrontierAboveInt4:
			httpx.WriteErrorCode(w, http.StatusConflict, re.Code, re.Message)
		default:
			httpx.WriteErrorCode(w, re.Status, re.Code, re.Message)
		}
		return
	}
	writeReadstateError(w, err, fallback)
}

// ChannelRead handles POST /api/channels/{id}/read.
func (h *ReadstateHandlers) ChannelRead(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	seq := 0
	switch v := body["seq"].(type) {
	case float64:
		seq = int(v)
	case string:
		parsed, err := strconv.Atoi(v)
		if err == nil {
			seq = parsed
		}
	}
	if seq == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "seq is required")
		return
	}
	state, err := h.Store.MarkRead(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"), int64(seq))
	if err != nil {
		writeReadstateError(w, err, "Failed to mark as read")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"maxReadSeq":       state.MaxReadSeq,
		"readStateVersion": state.ReadStateVersion,
	})
}

// parseReadAllReceiver ports the TS receiver parser: absent body receiver
// means the caller themself; an explicit receiver must be a shape-exact
// {kind,id}; human-for-another and every agent receiver are refused (M4 has
// no agent read state to delegate over).
func parseReadAllReceiver(body map[string]any, callerUserID string) (string, int, bool) {
	receiver, present := body["receiver"]
	if !present || receiver == nil {
		return callerUserID, 0, true
	}
	receiverMap, ok := receiver.(map[string]any)
	if !ok {
		return "", http.StatusBadRequest, false
	}
	if len(receiverMap) != 2 {
		return "", http.StatusBadRequest, false
	}
	kind, kindOK := receiverMap["kind"].(string)
	id, idOK := receiverMap["id"].(string)
	if !kindOK || !idOK {
		return "", http.StatusBadRequest, false
	}
	if (kind != "human" && kind != "agent") || !httpx.UUIDPattern.MatchString(id) {
		return "", http.StatusBadRequest, false
	}
	if kind == "human" && id != callerUserID {
		return "", http.StatusForbidden, false
	}
	if kind == "agent" {
		// No agent read receiver exists in M4; the delegation check cannot
		// pass, so this is the honest authorization refusal.
		return "", http.StatusForbidden, false
	}
	return id, 0, true
}

// ChannelReadAll handles POST /api/channels/{id}/read-all.
func (h *ReadstateHandlers) ChannelReadAll(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	receiver, status, ok := parseReadAllReceiver(body, authn.UserID(r))
	if !ok {
		if status == http.StatusForbidden {
			httpx.WriteError(w, http.StatusForbidden, "Read receiver is not authorized")
			return
		}
		httpx.WriteError(w, http.StatusBadRequest, "Invalid read receiver")
		return
	}
	_ = receiver // human receivers are always the caller in this phase
	result, err := h.Store.MarkReadLatest(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"))
	if err != nil {
		writeReadstateError(w, err, "Failed to mark as read")
		return
	}
	if result.ResidueOnly {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":               true,
			"readStateVersion": result.State.ReadStateVersion,
			"changed":          result.State.Changed,
		})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"seq":              result.State.MaxReadSeq,
		"readStateVersion": result.State.ReadStateVersion,
	})
}

// ChannelUnread handles POST /api/channels/{id}/unread.
func (h *ReadstateHandlers) ChannelUnread(w http.ResponseWriter, r *http.Request) {
	result, err := h.Store.MarkUnread(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"))
	if err != nil {
		writeReadstateError(w, err, "Failed to mark as unread")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"unreadCount":      result.UnreadCount,
		"maxReadSeq":       result.State.MaxReadSeq,
		"readStateVersion": result.State.ReadStateVersion,
	})
}

// ChannelsUnread handles GET /api/channels/unread (?summary=1).
func (h *ReadstateHandlers) ChannelsUnread(w http.ResponseWriter, r *http.Request) {
	claims := authn.AccessClaims(r)
	workspaceID := readstateServerID(r)
	if r.URL.Query().Get("summary") == "1" {
		summary, err := h.Store.UnreadSummary(r.Context(), claims, workspaceID)
		if err != nil {
			writeReadstateError(w, err, "Failed to get unread counts")
			return
		}
		channels := map[string]map[string]any{}
		for scopeID, entry := range summary {
			channels[scopeID] = map[string]any{
				"unreadCount":   entry.UnreadCount,
				"hasMention":    entry.HasMention,
				"hasAnyMention": entry.HasAnyMention,
				"readState":     wireReadFrontier(entry.ReadState),
			}
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"channels": channels})
		return
	}
	counts, err := h.Store.UnreadCounts(r.Context(), claims, workspaceID)
	if err != nil {
		writeReadstateError(w, err, "Failed to get unread counts")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, counts)
}

func wireReadFrontier(frontier *readstate.ReadFrontier) map[string]any {
	if frontier == nil || frontier.Kind == "absent" {
		return map[string]any{"kind": "absent"}
	}
	if frontier.Kind != "present" {
		return map[string]any{"kind": frontier.Kind}
	}
	present := map[string]any{
		"kind":             "present",
		"readStateVersion": frontier.Version,
		"maxReadSeq":       strconv.FormatInt(frontier.MaxReadSeq, 10),
	}
	if frontier.LatestValid {
		present["latestActivity"] = map[string]any{
			"messageId": frontier.LatestID,
			"seq":       strconv.FormatInt(frontier.LatestSeq, 10),
		}
	} else {
		present["latestActivity"] = nil
	}
	return present
}

// ServersUnreadSummary handles GET /api/servers/unread-summary (user-scoped
// literal route; no X-Server-Id scope).
func (h *ReadstateHandlers) ServersUnreadSummary(w http.ResponseWriter, r *http.Request) {
	entries, err := h.Store.ServerUnreadSummary(r.Context(), authn.AccessClaims(r))
	if err != nil {
		writeReadstateError(w, err, "Failed to get unread summary")
		return
	}
	out := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		row := map[string]any{
			"serverId":        entry.ServerID,
			"unreadCount":     entry.UnreadCount,
			"serverPushMuted": entry.ServerPushMuted,
		}
		if entry.ActivityKnown {
			row["activityUnreadCount"] = entry.ActivityUnreadCount
		}
		out = append(out, row)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// NotificationSettings handles GET /api/channels/{id}/notification-settings.
func (h *ReadstateHandlers) NotificationSettings(w http.ResponseWriter, r *http.Request) {
	state, err := h.Store.NotificationSettings(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"))
	if err != nil {
		writeReadstateError(w, err, "Failed to get channel notification settings")
		return
	}
	writeNotificationSettings(w, state)
}

// SetNotificationSettings handles PATCH /api/channels/{id}/notification-settings.
func (h *ReadstateHandlers) SetNotificationSettings(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	muted, ok := body["activityMuted"].(bool)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "activityMuted must be a boolean")
		return
	}
	state, err := h.Store.SetNotificationSettings(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"), muted)
	if err != nil {
		writeReadstateError(w, err, "Failed to update channel notification settings")
		return
	}
	writeNotificationSettings(w, state)
}

func writeNotificationSettings(w http.ResponseWriter, state readstate.MuteState) {
	var muteFromSeq any
	if state.MuteFromSeq != nil {
		muteFromSeq = *state.MuteFromSeq
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"activityMuted":         state.ActivityMuted,
		"muteFromSeq":           muteFromSeq,
		"prefsVersion":          state.PrefsVersion,
		"activityMuteSupported": state.ActivityMuteSupported,
	})
}

// DisplaySettings handles GET /api/channels/{id}/message-display-settings.
func (h *ReadstateHandlers) DisplaySettings(w http.ResponseWriter, r *http.Request) {
	prefs, err := h.Store.DisplaySettings(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"))
	if err != nil {
		writeReadstateError(w, err, "Failed to get channel message display settings")
		return
	}
	writeDisplaySettings(w, prefs)
}

// SetDisplaySettings handles PATCH /api/channels/{id}/message-display-settings.
func (h *ReadstateHandlers) SetDisplaySettings(w http.ResponseWriter, r *http.Request) {
	body, ok := readstateBody(w, r)
	if !ok {
		return
	}
	collapse, ok := body["collapseLongMessages"].(bool)
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "collapseLongMessages must be a boolean")
		return
	}
	prefs, err := h.Store.SetDisplaySettings(r.Context(), authn.AccessClaims(r), readstateServerID(r), r.PathValue("id"), collapse)
	if err != nil {
		writeReadstateError(w, err, "Failed to update channel message display settings")
		return
	}
	writeDisplaySettings(w, prefs)
}

func writeDisplaySettings(w http.ResponseWriter, prefs readstate.DisplayPrefs) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"collapseLongMessages": prefs.CollapseLongMessages,
		"prefsVersion":         prefs.PrefsVersion,
	})
}

// ActivitySnapshot handles GET /api/channels/activity/snapshot.
func (h *ReadstateHandlers) ActivitySnapshot(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	requestID := strings.TrimSpace(query.Get("requestId"))
	windowID := query.Get("windowId")
	if requestID == "" && windowID == "" && query.Get("filter") == "" {
		httpx.WriteError(w, http.StatusBadRequest, "requestId is required and windowId must be main")
		return
	}
	if requestID == "" || (windowID != "" && windowID != "main") {
		httpx.WriteError(w, http.StatusBadRequest, "requestId is required and windowId must be main")
		return
	}
	filter, ok := activityFilter(query.Get("filter"))
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "filter must be all, unread, or mentions")
		return
	}
	snapshot, err := h.Store.ActivitySnapshot(r.Context(), authn.AccessClaims(r), readstateServerID(r), readstate.SnapshotQuery{
		RequestID: requestID,
		Filter:    filter,
	})
	if err != nil {
		writeReadstateError(w, err, "Failed to get Activity snapshot")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"type":            "snapshot",
		"requestId":       snapshot.RequestID,
		"scope":           snapshot.Scope,
		"epoch":           snapshot.Epoch,
		"watermark":       snapshot.Watermark,
		"activityVersion": snapshot.ActivityVersion,
		"window":          wireActivityWindow(snapshot.Window),
	})
}

// ActivityDifference handles GET /api/channels/activity/difference.
func (h *ReadstateHandlers) ActivityDifference(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	requestID := strings.TrimSpace(query.Get("requestId"))
	epoch := query.Get("epoch")
	afterWatermark := query.Get("afterWatermark")
	windowID := query.Get("windowId")
	if requestID == "" || !httpx.Uint64Pattern.MatchString(epoch) || !httpx.Uint64Pattern.MatchString(afterWatermark) ||
		(windowID != "" && windowID != "main") {
		httpx.WriteError(w, http.StatusBadRequest, "requestId, canonical uint64 epoch/afterWatermark, and windowId=main are required")
		return
	}
	filter, ok := activityFilter(query.Get("filter"))
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "filter must be all, unread, or mentions")
		return
	}
	result, err := h.Store.ActivityDifference(r.Context(), authn.AccessClaims(r), readstateServerID(r), readstate.DifferenceQuery{
		RequestID:      requestID,
		Filter:         filter,
		Epoch:          epoch,
		AfterWatermark: afterWatermark,
	})
	if err != nil {
		writeReadstateError(w, err, "Failed to get Activity difference")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch result.Status {
	case http.StatusConflict:
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"snapshotRequired": true,
			"requestId":        requestID,
			"scope":            result.SnapshotRequired.Scope,
			"epoch":            result.SnapshotRequired.Epoch,
			"watermark":        result.SnapshotRequired.Watermark,
			"activityVersion":  result.SnapshotRequired.ActivityVersion,
		})
	case http.StatusOK:
		if result.NotModified != nil {
			httpx.WriteJSON(w, http.StatusOK, map[string]any{
				"type":            "notModified",
				"requestId":       result.NotModified.RequestID,
				"scope":           result.NotModified.Scope,
				"epoch":           result.NotModified.Epoch,
				"watermark":       result.NotModified.Watermark,
				"activityVersion": result.NotModified.ActivityVersion,
			})
			return
		}
		d := result.Difference
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"type":             "difference",
			"requestId":        d.RequestID,
			"scope":            d.Scope,
			"epoch":            d.Epoch,
			"fromSeq":          d.FromSeq,
			"toSeq":            d.ToSeq,
			"activityVersion":  d.ActivityVersion,
			"rows":             d.Rows,
			"tombstones":       d.Tombstones,
			"nextCursor":       d.NextCursor,
			"hasMore":          d.HasMore,
			"complete":         d.Complete,
			"totalCount":       d.TotalCount,
			"totalUnreadCount": d.TotalUnreadCount,
			"nextFromSeq":      nil,
		})
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get Activity difference")
	}
}

func activityFilter(raw string) (string, bool) {
	switch raw {
	case "unread", "mentions":
		return raw, true
	case "", "all":
		return "all", true
	default:
		return "", false
	}
}

func wireActivityWindow(window readstate.ActivityWindowResult) map[string]any {
	var nextCursor any
	if window.NextCursor != nil {
		nextCursor = *window.NextCursor
	}
	return map[string]any{
		"rows":             window.Rows,
		"tombstones":       window.Tombstones,
		"nextCursor":       nextCursor,
		"hasMore":          window.HasMore,
		"complete":         window.Complete,
		"totalCount":       window.TotalCount,
		"totalUnreadCount": window.TotalUnreadCount,
	}
}

// ReadMutationsNotOpen answers the cross-system sequencer domain with the
// honest not-implemented response for authorized callers.
func ReadMutationsNotOpen(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
		"This read mutation capability is not implemented in this phase")
}
