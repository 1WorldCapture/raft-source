// Handlers for the human-conversation surface: human DM list/create, thread
// ensure (+ optional first reply), thread summaries/info and thread follow
// interest. The cross-module transaction orchestration lives in
// application/messaging; this file only parses requests, calls exactly one
// use case per request and maps results/errors onto the original wire
// sentences, status codes and check order (channels.ts) — deviations are
// recorded in docs/m4-channel-worker-report.md.
package humanapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/transport/presenter"
	"strings"

	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/workspace"
)

// ConversationHandlers carries its own channel fact owner, the workspace
// membership fact owner for the shared RequireChannelServer middleware, and
// the messaging use cases — it borrows no other handler type.
type ConversationHandlers struct {
	Channels   *channel.Store
	Workspaces *workspace.Store
	Messaging  *messaging.Service
}

func (h *ConversationHandlers) store() *channel.Store { return h.Channels }

// channelNotFoundBody is the byte-stable missing/invisible channel body
// (CHANNEL_NOT_FOUND_BODY) — identical for both cases by construction.
func channelNotFoundBody(w http.ResponseWriter) {
	httpx.WriteError(w, http.StatusNotFound, "Channel not found or not visible")
}

// denyChannelAccess ports the 403/404 split: a caller with a prior
// relationship keeps the honest 403 sentence; a stranger gets the
// byte-identical missing body.
func (h *ConversationHandlers) denyChannelAccess(w http.ResponseWriter, r *http.Request, channelID, forbiddenError string) {
	prior, err := h.Messaging.PriorChannelRelationship(r.Context(), authn.UserID(r), channelID)
	if err != nil {
		httpx.WriteErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
		return
	}
	if prior {
		httpx.WriteError(w, http.StatusForbidden, forbiddenError)
		return
	}
	channelNotFoundBody(w)
}

// writeHumanTxError maps the in-transaction identity revalidation failure.
func writeHumanTxError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, auth.ErrTokenInvalid) {
		httpx.WriteInvalidToken(w)
		return true
	}
	return false
}

// conversationError maps one messaging use-case failure onto the frozen
// HTTP contract. Handled reports whether the response was written.
func (h *ConversationHandlers) conversationError(w http.ResponseWriter, r *http.Request, err error, channelID, forbiddenError, internalSentence string) bool {
	var denied *messaging.AccessDenied
	switch {
	case writeHumanTxError(w, err):
		return true
	case errors.Is(err, messaging.ErrChannelMissingOrForeign):
		channelNotFoundBody(w)
		return true
	case errors.As(err, &denied):
		h.denyChannelAccess(w, r, channelID, forbiddenError)
		return true
	case isAnnouncementNoThreads(err):
		httpx.WriteErrorCode(w, http.StatusBadRequest, channel.AnnouncementNoThreadsCode, channel.AnnouncementNoThreadsMsg)
		return true
	}
	return false
}

func isAnnouncementNoThreads(err error) bool {
	de := channel.AsDomainError(err)
	return de != nil && de.Code == channel.CodeInvalidInput && de.Message == channel.AnnouncementNoThreadsMsg
}

// ListDMs handles GET /api/channels/dm.
func (h *ConversationHandlers) ListDMs(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	rows, err := h.Messaging.ListDMs(r.Context(), authn.AccessClaims(r), serverID, actor)
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to list DM channels")
		return
	}
	out := make([]dmChannelWire, 0, len(rows))
	for _, row := range rows {
		out = append(out, dmChannelWireView(serverID, row.View, frontierWire(row.ReadState)))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// frontierWire renders the use case's frontier facts onto the embedded
// #632 union; a nil frontier omits the field (older-server tolerance).
func frontierWire(f *readstate.ReadFrontier) json.RawMessage {
	if f == nil {
		return nil
	}
	return presenter.ReadFrontierUnion(f)
}

// CreateDM handles POST /api/channels/dm ({userId} human / self-DM; the
// {agentId} branch is validated then refused 501 before any mutation).
func (h *ConversationHandlers) CreateDM(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	strField := func(key string) (string, bool) {
		v, _ := body[key].(string)
		return v, strings.TrimSpace(v) != ""
	}
	agentID, hasAgent := strField("agentId")
	targetID, hasUser := strField("userId")
	// Non-string values count as absent (the original crashed on them; a
	// shape error must not masquerade as 501 or success).
	if !hasAgent && !hasUser {
		httpx.WriteError(w, http.StatusBadRequest, "Either agentId or userId is required")
		return
	}
	if hasAgent && hasUser {
		httpx.WriteError(w, http.StatusBadRequest, "Cannot provide both agentId and userId")
		return
	}

	row, err := h.Messaging.CreateDM(r.Context(), authn.AccessClaims(r), serverID, actor, targetID, agentID, hasAgent, hasUser)
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.Is(err, messaging.ErrAgentDMTargetNotFound):
			httpx.WriteError(w, http.StatusNotFound, "Agent not found in this server")
			return
		case errors.Is(err, messaging.ErrAgentDMNotImplemented):
			httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
				"Agent direct messages are not enabled in this server stage")
			return
		case errors.Is(err, messaging.ErrDMTargetNotFound):
			httpx.WriteError(w, http.StatusNotFound, "DM target not found")
			return
		}
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to create DM")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, dmChannelWireView(serverID, row.View, frontierWire(row.ReadState)))
}

// CreateThread handles POST /api/channels/{id}/threads: ensure the unique
// thread of one parent message and optionally post the first reply in the
// SAME transaction (the reply runs through the messaging use case's
// in-transaction send step; no nested complete use case).
func (h *ConversationHandlers) CreateThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	channelID := r.PathValue("id")
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	parentMessageID, hasParent := "", false
	if raw, ok := body["parentMessageId"].(string); ok {
		parentMessageID = raw
	}
	if strings.TrimSpace(parentMessageID) == "" {
		hasParent = false
	} else {
		hasParent = true
	}
	if !hasParent {
		httpx.WriteError(w, http.StatusBadRequest, "parentMessageId is required")
		return
	}
	content, wantsReply := "", false
	if raw, ok := body["content"].(string); ok && strings.TrimSpace(raw) != "" {
		content = raw
		wantsReply = true
	}

	result, err := h.Messaging.CreateThread(r.Context(), authn.AccessClaims(r), serverID, actor, channelID, parentMessageID, wantsReply, content)
	if err != nil {
		if h.conversationError(w, r, err, channelID, "Access denied", "Failed to create thread") {
			return
		}
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to create thread")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, threadInfoWireView(result.Info))
}

// parseThreadSummaryParentIDs ports parseThreadSummaryParentMessageIds:
// absent → nil (compat recent window), invalid → ok=false, bounded ≤500.
func parseThreadSummaryParentIDs(raw string) ([]string, bool) {
	if raw == "" {
		return nil, true
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !httpx.UUIDPattern.MatchString(part) {
			return nil, false
		}
		if !seen[part] {
			seen[part] = true
			ids = append(ids, part)
		}
	}
	if len(ids) > 500 {
		return nil, false
	}
	return ids, true
}

// ThreadSummaries handles GET /api/channels/{id}/threads.
func (h *ConversationHandlers) ThreadSummaries(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	channelID := r.PathValue("id")
	parentIDs, ok := parseThreadSummaryParentIDs(r.URL.Query().Get("parentMessageIds"))
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "Invalid parentMessageIds")
		return
	}
	summaries, err := h.Messaging.ThreadSummaries(r.Context(), authn.AccessClaims(r), serverID, actor, channelID, parentIDs)
	if err != nil {
		if h.conversationError(w, r, err, channelID, "Access denied", "Failed to get thread summaries") {
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get thread summaries")
		return
	}
	if summaries == nil {
		summaries = map[string]channel.ThreadSummary{}
	}
	out := make(map[string]threadSummaryWire, len(summaries))
	for parentID, s := range summaries {
		out[parentID] = threadSummaryWireView(s)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// ThreadInfo handles GET /api/channels/{id}/threads/{messageId}.
func (h *ConversationHandlers) ThreadInfo(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	channelID := r.PathValue("id")
	parentMessageID := r.PathValue("messageId")
	info, err := h.Messaging.ThreadInfo(r.Context(), authn.AccessClaims(r), serverID, actor, channelID, parentMessageID)
	if err != nil {
		if h.conversationError(w, r, err, channelID, "Access denied", "Failed to get thread info") {
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get thread info")
		return
	}
	if info == nil {
		httpx.WriteError(w, http.StatusNotFound, "No thread found for this message")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, threadInfoWireView(info))
}

// FollowedThreads handles GET /api/channels/threads/followed.
func (h *ConversationHandlers) FollowedThreads(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	threads, err := h.Messaging.FollowedThreads(r.Context(), authn.AccessClaims(r), serverID, actor)
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get followed threads")
		return
	}
	out := make([]followedThreadWire, 0, len(threads))
	for _, t := range threads {
		out = append(out, followedThreadWireView(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"threads": out})
}

// FollowThread handles POST /api/channels/threads/follow.
func (h *ConversationHandlers) FollowThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	parentMessageID, ok := body["parentMessageId"].(string)
	if !ok || parentMessageID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "parentMessageId is required")
		return
	}
	threadChannelID, err := h.Messaging.FollowThread(r.Context(), authn.AccessClaims(r), serverID, actor, parentMessageID)
	if err != nil {
		if h.conversationError(w, r, err, "", "Access denied", "Failed to follow thread") {
			return
		}
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to follow thread")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "threadChannelId": threadChannelID})
}

// UnfollowThread handles POST /api/channels/threads/unfollow.
func (h *ConversationHandlers) UnfollowThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), authn.UserID(r)
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	threadChannelID, ok := body["threadChannelId"].(string)
	if !ok || threadChannelID == "" {
		httpx.WriteError(w, http.StatusBadRequest, "threadChannelId is required")
		return
	}
	if err := h.Messaging.UnfollowThread(r.Context(), authn.AccessClaims(r), serverID, actor, threadChannelID); err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.Is(err, messaging.ErrThreadNotFound):
			httpx.WriteError(w, http.StatusNotFound, channel.ThreadNotFoundMessage)
			return
		}
		if !writeChannelDomainError(w, err) {
			httpx.WriteError(w, http.StatusInternalServerError, "Failed to unfollow thread")
		}
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
