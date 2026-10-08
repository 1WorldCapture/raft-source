// Legacy-web handlers for the M4 P4 human-conversation surface: human DM
// list/create, thread ensure (+ optional first reply), thread summaries/info
// and thread follow interest. Every mutation runs in one db.WithWriteTx with
// the verified identity revalidated inside (auth.ValidateHumanTx on the
// gate-verified claims, never a body-supplied sender); every authenticated
// read runs in one db.WithReadSnapshot. Wire sentences, status codes and
// check order follow the original routes (channels.ts) — deviations are
// recorded in docs/m4-channel-worker-report.md.
package legacyweb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// InitialReplyPoster is the exact seam onto the frozen
// message.Store.CreateTx(ctx, tx, claims, workspaceID, CreateInput) — the
// parent wires it once the message slice lands; until then a content-bearing
// thread create is refused with an honest 501 before any mutation.
type InitialReplyPoster func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, channelID, content string) error

// M4ConversationHandlers carries the channel store and the optional
// cross-module seams. Channels provides RequireChannelServer (scope) and the
// store handle, so no parallel middleware exists.
// MarkReadLatestTx advances the follower's own read boundary inside the SAME
// transaction as an explicit thread follow — the original followThread called
// markReadLatest right after recordThreadFollow (channelService.ts:14464+).
// The parent wires it to the readstate use case; nil keeps M4 honest (no
// fabricated read). An error aborts the whole follow transaction.
type MarkReadLatestTx func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, userID, threadChannelID string) error

// DMReadState renders the #632 per-scope read-frontier wire object for one DM
// row on the caller's snapshot. The readstate slice owns the exact JSON shape
// (kind/version/maxReadSeq/latestActivity) and serializes it here; channel
// embeds the bytes verbatim with no second rendering. Returning nil without
// error omits the field (older-server tolerance in the web client).
type DMReadState func(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (json.RawMessage, error)

type M4ConversationHandlers struct {
	Channels         *ChannelHandlers
	PostInitialReply InitialReplyPoster
	// ReadCursor resolves the viewer's read-through seq inside the caller's
	// snapshot (readstate-owned rows). nil = no read recorded yet.
	ReadCursor channel.ReadCursorFunc
	// MarkReadLatest runs inside the follow transaction (see its type).
	MarkReadLatest MarkReadLatestTx
	// DMReadState enriches DM list/create rows with the readstate frontier.
	DMReadState DMReadState
}

func (h *M4ConversationHandlers) store() *channel.Store { return h.Channels.Store }
func (h *M4ConversationHandlers) now() time.Time        { return time.Now() }

// channelNotFoundBody is the byte-stable missing/invisible channel body
// (CHANNEL_NOT_FOUND_BODY) — identical for both cases by construction.
func channelNotFoundBody(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "Channel not found or not visible")
}

// denyChannelAccess ports the 403/404 split: a caller with a prior
// relationship keeps the honest 403 sentence; a stranger gets the
// byte-identical missing body.
func (h *M4ConversationHandlers) denyChannelAccess(w http.ResponseWriter, r *http.Request, channelID, forbiddenError string) {
	ctx := r.Context()
	prior, err := h.store().HasPriorChannelRelationshipTx(ctx, h.store().DB(), userID(r), channelID)
	if err != nil {
		writeErrorCode(w, http.StatusInternalServerError, "internal_server_error", "Internal server error")
		return
	}
	if prior {
		writeError(w, http.StatusForbidden, forbiddenError)
		return
	}
	channelNotFoundBody(w)
}

// writeHumanTxError maps the in-transaction identity revalidation failure.
func writeHumanTxError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, auth.ErrTokenInvalid) {
		writeInvalidToken(w)
		return true
	}
	return false
}

// ListDMs handles GET /api/channels/dm.
func (h *M4ConversationHandlers) ListDMs(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	out := make([]m4DMChannel, 0)
	err := platformdb.WithReadSnapshot(r.Context(), h.store().DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(r.Context(), ex, accessClaims(r), h.now()); err != nil {
			return err
		}
		views, err := h.store().ListDMsTx(r.Context(), ex, serverID, actor)
		if err != nil {
			return err
		}
		// The conversation rows and viewer frontiers share one pinned view;
		// a later naked DB read could mix membership/read-state generations.
		for _, v := range views {
			readState, err := h.dmReadState(r.Context(), ex, serverID, actor, v.Channel.ID)
			if err != nil {
				return err
			}
			out = append(out, m4DMChannelView(serverID, v, readState))
		}
		return nil
	})
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to list DM channels")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// dmReadState resolves one DM row's #632 frontier through the readstate
// seam on the caller's executor; nil seam or nil result omits the field.
func (h *M4ConversationHandlers) dmReadState(ctx context.Context, ex platformdb.Executor, serverID, actor, channelID string) (json.RawMessage, error) {
	if h.DMReadState == nil {
		return nil, nil
	}
	return h.DMReadState(ctx, ex, serverID, actor, channelID)
}

// CreateDM handles POST /api/channels/dm ({userId} human / self-DM; the
// {agentId} branch is validated then refused 501 before any mutation).
func (h *M4ConversationHandlers) CreateDM(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
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
		writeError(w, http.StatusBadRequest, "Either agentId or userId is required")
		return
	}
	if hasAgent && hasUser {
		writeError(w, http.StatusBadRequest, "Cannot provide both agentId and userId")
		return
	}

	var result m4DMChannel
	err := platformdb.WithWriteTx(r.Context(), h.store().DB(), func(tx *sql.Tx) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, tx, accessClaims(r), h.now()); err != nil {
			return err
		}
		if hasAgent {
			// Shape and identity are validated; verify the target exists in
			// this workspace, then refuse honestly without creating anything.
			exists, err := h.store().AgentExistsInWorkspace(ctx, tx, agentID, serverID)
			if err != nil {
				return err
			}
			if !exists {
				return m4agentNotFound
			}
			return m4agentNotImplemented
		}
		// Hidden human directory: unknown targets read as absent, but an
		// existing conversation still resolves (route order).
		if targetID != actor {
			hidden, err := h.store().ShouldHideHumanDirectoryTx(ctx, tx, serverID, actor)
			if err != nil {
				return err
			}
			if hidden {
				existing, err := h.store().LookupDMTx(ctx, tx, serverID, actor, targetID)
				if err != nil {
					return err
				}
				if existing == nil {
					return m4dmTargetNotFound
				}
			}
		}
		channelRow, err := h.store().EnsureDMTx(ctx, tx, serverID, actor, targetID)
		if err != nil {
			return err
		}
		// dm:new intents for real creation/revive are emitted by EnsureDMTx
		// (transition-keyed revisions) on this same transaction.
		view, err := h.dmViewFor(ctx, tx, serverID, actor, channelRow.ID)
		if err != nil {
			return err
		}
		readState, err := h.dmReadState(ctx, tx, serverID, actor, view.Channel.ID)
		if err != nil {
			return err
		}
		result = m4DMChannelView(serverID, *view, readState)
		return nil
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4agentNotFound):
			writeError(w, http.StatusNotFound, "Agent not found in this server")
			return
		case errors.As(err, &m4agentNotImplemented):
			writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
				"Agent direct messages are not enabled in this server stage")
			return
		case errors.As(err, &m4dmTargetNotFound):
			writeError(w, http.StatusNotFound, "DM target not found")
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to create DM")
		}
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type m4AgentDMNotFound struct{}
type m4AgentDMNotImplemented struct{}
type m4DMTargetNotFound struct{}

func (m4AgentDMNotFound) Error() string       { return "agent dm target missing" }
func (m4AgentDMNotImplemented) Error() string { return "agent dm not implemented" }
func (m4DMTargetNotFound) Error() string      { return "dm target missing" }

var (
	m4agentNotFound       = &m4AgentDMNotFound{}
	m4agentNotImplemented = &m4AgentDMNotImplemented{}
	m4dmTargetNotFound    = &m4DMTargetNotFound{}
)

// dmViewFor resolves the peer projection of one DM channel inside the
// caller's transaction (listDMChannels' single-row shape).
func (h *M4ConversationHandlers) dmViewFor(ctx context.Context, ex platformdb.Executor, serverID, actor, channelID string) (*channel.DMView, error) {
	views, err := h.store().ListDMsTx(ctx, ex, serverID, actor)
	if err != nil {
		return nil, err
	}
	for _, v := range views {
		if v.Channel.ID == channelID {
			view := v
			return &view, nil
		}
	}
	return nil, errors.New("dm channel missing from own list")
}

// CreateThread handles POST /api/channels/{id}/threads: ensure the unique
// thread of one parent message and optionally post the first reply in the
// SAME transaction (the seam calls message.Store.CreateTx; no nested create).
func (h *M4ConversationHandlers) CreateThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	channelID := r.PathValue("id")
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
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
		writeError(w, http.StatusBadRequest, "parentMessageId is required")
		return
	}
	content, wantsReply := "", false
	if raw, ok := body["content"].(string); ok && strings.TrimSpace(raw) != "" {
		content = raw
		wantsReply = true
	}
	// The first-reply slice must be honestly unavailable, not silently
	// dropped — refuse before any mutation.
	if wantsReply && h.PostInitialReply == nil {
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
			"Thread first replies are not enabled in this server stage")
		return
	}

	var info m4ThreadInfo
	err := platformdb.WithWriteTx(r.Context(), h.store().DB(), func(tx *sql.Tx) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, tx, accessClaims(r), h.now()); err != nil {
			return err
		}
		channelRow, err := h.store().GetChannel(ctx, channelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != serverID {
			return m4channelNotFoundSentinel
		}
		if _, err := h.store().AuthorizeConversationTx(ctx, tx, serverID, channelID, actor, false); err != nil {
			return &m4AccessDenied{cause: err}
		}
		if channelRow.Type == channel.TypeThread {
			return &channel.DomainError{Code: channel.CodeInvalidInput, Message: channel.ThreadNestedMessage}
		}
		if channelRow.ArchivedAt != nil {
			return &channel.DomainError{Code: channel.CodeConflict, Message: "This channel is archived"}
		}
		thread, err := h.store().EnsureThreadTx(ctx, tx, serverID, channelID, parentMessageID, actor)
		if err != nil {
			return err
		}
		// The thread:updated appearance intent is emitted by EnsureThreadTx on
		// real creation only; re-ensures stay silent.
		if wantsReply {
			if err := h.PostInitialReply(ctx, tx, accessClaims(r), serverID, thread.ID, content); err != nil {
				return err
			}
		}
		threadInfo, err := h.store().ThreadInfoTx(ctx, tx, channelID, parentMessageID)
		if err != nil {
			return err
		}
		if threadInfo == nil {
			return errors.New("thread missing immediately after ensure")
		}
		info = m4ThreadInfoView(threadInfo)
		return nil
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4channelNotFoundSentinel):
			channelNotFoundBody(w)
			return
		case errors.As(err, &m4accessDenied):
			h.denyChannelAccess(w, r, channelID, "Access denied")
			return
		case isAnnouncementNoThreads(err):
			writeErrorCode(w, http.StatusBadRequest, channel.AnnouncementNoThreadsCode, channel.AnnouncementNoThreadsMsg)
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to create thread")
		}
		return
	}
	writeJSON(w, http.StatusOK, info)
}

type m4ChannelNotFoundSentinel struct{}
type m4AccessDenied struct{ cause error }

func (m4ChannelNotFoundSentinel) Error() string { return "channel missing or foreign" }
func (e *m4AccessDenied) Error() string         { return "channel access denied" }
func (e *m4AccessDenied) Unwrap() error         { return e.cause }

// Shared sentinel values so transaction callbacks and HTTP mapping stay in
// one place; the cause of an m4AccessDenied keeps the domain error for tests.
var (
	m4channelNotFoundSentinel = &m4ChannelNotFoundSentinel{}
	m4accessDenied            = &m4AccessDenied{}
)

func isAnnouncementNoThreads(err error) bool {
	de := channel.AsDomainError(err)
	return de != nil && de.Code == channel.CodeInvalidInput && de.Message == channel.AnnouncementNoThreadsMsg
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
		if !uuidPattern.MatchString(part) {
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
func (h *M4ConversationHandlers) ThreadSummaries(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	channelID := r.PathValue("id")
	parentIDs, ok := parseThreadSummaryParentIDs(r.URL.Query().Get("parentMessageIds"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid parentMessageIds")
		return
	}
	channelRow, err := h.store().GetChannel(r.Context(), channelID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get thread summaries")
		return
	}
	if channelRow == nil || channelRow.WorkspaceID != serverID {
		channelNotFoundBody(w)
		return
	}

	var summaries map[string]channel.ThreadSummary
	err = platformdb.WithReadSnapshot(r.Context(), h.store().DB(), func(ex platformdb.Executor) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, ex, accessClaims(r), h.now()); err != nil {
			return err
		}
		if _, err := h.store().AuthorizeConversationTx(ctx, ex, serverID, channelID, actor, false); err != nil {
			return &m4AccessDenied{cause: err}
		}
		if parentIDs == nil {
			// Legacy no-parameter compatibility: bounded recent-parent window.
			recent, err := h.store().RecentThreadParentIDsTx(ctx, ex, channelID, channel.ThreadSummaryCompatParentsLimit)
			if err != nil {
				return err
			}
			parentIDs = recent
		}
		summaries, err = h.store().ThreadSummariesTx(ctx, ex, serverID, channelID, parentIDs, actor, h.ReadCursor)
		return err
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4accessDenied):
			h.denyChannelAccess(w, r, channelID, "Access denied")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get thread summaries")
		return
	}
	if summaries == nil {
		summaries = map[string]channel.ThreadSummary{}
	}
	out := make(map[string]m4ThreadSummary, len(summaries))
	for parentID, s := range summaries {
		out[parentID] = m4ThreadSummaryView(s)
	}
	writeJSON(w, http.StatusOK, out)
}

// ThreadInfo handles GET /api/channels/{id}/threads/{messageId}.
func (h *M4ConversationHandlers) ThreadInfo(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	channelID := r.PathValue("id")
	parentMessageID := r.PathValue("messageId")
	channelRow, err := h.store().GetChannel(r.Context(), channelID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get thread info")
		return
	}
	if channelRow == nil || channelRow.WorkspaceID != serverID {
		channelNotFoundBody(w)
		return
	}
	var info *channel.ThreadInfo
	err = platformdb.WithReadSnapshot(r.Context(), h.store().DB(), func(ex platformdb.Executor) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, ex, accessClaims(r), h.now()); err != nil {
			return err
		}
		if _, err := h.store().AuthorizeConversationTx(ctx, ex, serverID, channelID, actor, false); err != nil {
			return &m4AccessDenied{cause: err}
		}
		var err error
		info, err = h.store().ThreadInfoTx(ctx, ex, channelID, parentMessageID)
		return err
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4accessDenied):
			h.denyChannelAccess(w, r, channelID, "Access denied")
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get thread info")
		return
	}
	if info == nil {
		writeError(w, http.StatusNotFound, "No thread found for this message")
		return
	}
	writeJSON(w, http.StatusOK, m4ThreadInfoView(info))
}

// FollowedThreads handles GET /api/channels/threads/followed.
func (h *M4ConversationHandlers) FollowedThreads(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	var threads []channel.FollowedThread
	err := platformdb.WithReadSnapshot(r.Context(), h.store().DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(r.Context(), ex, accessClaims(r), h.now()); err != nil {
			return err
		}
		var err error
		threads, err = h.store().FollowedThreadsTx(r.Context(), ex, serverID, actor, h.ReadCursor)
		return err
	})
	if err != nil {
		if writeHumanTxError(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "Failed to get followed threads")
		return
	}
	out := make([]m4FollowedThread, 0, len(threads))
	for _, t := range threads {
		out = append(out, m4FollowedThreadView(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": out})
}

// FollowThread handles POST /api/channels/threads/follow.
func (h *M4ConversationHandlers) FollowThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	parentMessageID, ok := body["parentMessageId"].(string)
	if !ok || parentMessageID == "" {
		writeError(w, http.StatusBadRequest, "parentMessageId is required")
		return
	}
	var threadChannelID string
	err := platformdb.WithWriteTx(r.Context(), h.store().DB(), func(tx *sql.Tx) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, tx, accessClaims(r), h.now()); err != nil {
			return err
		}
		parent, err := h.store().AuthorizeParentMessageTx(ctx, tx, serverID, parentMessageID, actor)
		if err != nil {
			return err
		}
		thread, err := h.store().EnsureThreadTx(ctx, tx, serverID, parent.ID, parentMessageID, actor)
		if err != nil {
			return err
		}
		// Explicit manual follow (reactivates an unfollowed row) and, when
		// the readstate seam is wired, the follower's own read advance — ONE
		// transaction, exactly the original followThread pairing. The
		// followers-updated intent is emitted by the owning domain mutation.
		if err := h.store().SetThreadFollowTx(ctx, tx, serverID, thread.ID, actor, true, false); err != nil {
			return err
		}
		if h.MarkReadLatest != nil {
			if err := h.MarkReadLatest(ctx, tx, accessClaims(r), serverID, actor, thread.ID); err != nil {
				return err
			}
		}
		threadChannelID = thread.ID
		return nil
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case isAnnouncementNoThreads(err):
			writeErrorCode(w, http.StatusBadRequest, channel.AnnouncementNoThreadsCode, channel.AnnouncementNoThreadsMsg)
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to follow thread")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "threadChannelId": threadChannelID})
}

// UnfollowThread handles POST /api/channels/threads/unfollow.
func (h *M4ConversationHandlers) UnfollowThread(w http.ResponseWriter, r *http.Request) {
	serverID, actor := channelServerID(r), userID(r)
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	threadChannelID, ok := body["threadChannelId"].(string)
	if !ok || threadChannelID == "" {
		writeError(w, http.StatusBadRequest, "threadChannelId is required")
		return
	}
	threadNotFound := func() {
		writeError(w, http.StatusNotFound, channel.ThreadNotFoundMessage)
	}
	err := platformdb.WithWriteTx(r.Context(), h.store().DB(), func(tx *sql.Tx) error {
		ctx := r.Context()
		if err := auth.ValidateHumanTx(ctx, tx, accessClaims(r), h.now()); err != nil {
			return err
		}
		channelRow, err := h.store().GetChannel(ctx, threadChannelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != serverID || channelRow.Type != channel.TypeThread {
			return &m4ThreadNotFound{}
		}
		if _, err := h.store().AuthorizeConversationTx(ctx, tx, serverID, threadChannelID, actor, false); err != nil {
			return &m4ThreadNotFound{}
		}
		// Explicit unfollow keeps the row as history; content access is not
		// revoked by losing interest. The domain mutation emits the intent.
		return h.store().SetThreadFollowTx(ctx, tx, serverID, threadChannelID, actor, false, false)
	})
	if err != nil {
		switch {
		case writeHumanTxError(w, err):
			return
		case errors.As(err, &m4threadNotFound):
			threadNotFound()
			return
		}
		if !writeChannelDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to unfollow thread")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type m4ThreadNotFound struct{}

func (m4ThreadNotFound) Error() string { return "thread not found" }

var m4threadNotFound = &m4ThreadNotFound{}
