package legacyweb

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/message"
)

// ---- context ----

// MessageContext renders the context DTO: the target with its surrounding
// window, thread summaries, historyLimited and channelArchived. A messageId
// that does not live in the requested channel is an ordinary 404.
func (h *M4MessageHandlers) MessageContext(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")
	channelID := r.URL.Query().Get("channelId")
	workspaceID := channelServerID(r)
	if channelID == "" {
		writeError(w, http.StatusNotFound, "Message not found")
		return
	}
	claims := message.NewClaims(accessClaims(r))
	result, err := h.Store.GetMessageContext(r.Context(), claims, workspaceID, channelID, messageID, 15, 15)
	if err != nil {
		h.writeContextError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, messageContextResponse{
		ChannelID:                        channelID,
		TargetMessageID:                  result.TargetMessageID,
		HasOlder:                         result.HasOlder,
		HasNewer:                         result.HasNewer,
		Messages:                         result.DTOs,
		ThreadSummariesByParentMessageID: result.ThreadSummaries,
		HistoryLimited:                   false,
		ChannelArchived:                  result.ChannelArchived,
	})
}

type messageContextResponse struct {
	ChannelID                        string                           `json:"channelId"`
	TargetMessageID                  string                           `json:"targetMessageId"`
	HasOlder                         bool                             `json:"hasOlder"`
	HasNewer                         bool                             `json:"hasNewer"`
	Messages                         []*message.MessageDTO            `json:"messages"`
	ThreadSummariesByParentMessageID map[string]message.ThreadSummary `json:"threadSummariesByParentMessageId"`
	HistoryLimited                   bool                             `json:"historyLimited"`
	ChannelArchived                  bool                             `json:"channelArchived"`
}

// ---- sync ----

// SyncMessages renders the bare Message[] array (never an envelope): the web
// client loops on the last message seq while pages come back full.
func (h *M4MessageHandlers) SyncMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sinceSeq := int64(0)
	if raw := q.Get("since_seq"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err == nil {
			sinceSeq = n
		}
		// Non-numeric values fall back to 0 exactly like Number(x) || 0.
	}
	limit := message.SyncDefaultLimit
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	channelID := q.Get("channel_id")
	workspaceID := channelServerID(r)
	claims := message.NewClaims(accessClaims(r))

	result, err := h.Store.SyncHTTP(r.Context(), claims, workspaceID, sinceSeq, channelID, limit)
	if err != nil {
		if errors.Is(err, message.ErrSyncDeadlineExceeded) {
			// Deadline-bounded pass that did not finish: a transient,
			// retryable failure. Never a fixed quota: a large but legal
			// sparse history remains fully readable on retry.
			writeJSON(w, http.StatusServiceUnavailable, errorBody{
				"error": "Sync scan exceeded its deadline; retry to continue",
				"code":  "sync_scan_deadline_exceeded",
			})
			return
		}
		h.writeReadError(w, r, err, "Access denied", "Failed to sync messages")
		return
	}
	writeJSON(w, http.StatusOK, result.DTOs)
}

// ---- reactions ----

// ReactionActors renders the discussion-shaped actors page with its guarded
// cursor contract.
func (h *M4MessageHandlers) ReactionActors(w http.ResponseWriter, r *http.Request) {
	emoji, ok := parseReactionEmojiQuery(w, r)
	if !ok {
		return
	}
	limit, ok := parseReactionActorLimit(w, r)
	if !ok {
		return
	}
	cursor := r.URL.Query().Get("cursor")
	page, err := h.Store.ListReactionActors(r.Context(), message.NewClaims(accessClaims(r)),
		channelServerID(r), r.PathValue("messageId"), emoji, limit, cursor)
	if err != nil {
		h.writeReactionError(w, r, err, "Failed to list reaction actors")
		return
	}
	actors := make([]reactionActorDTO, 0, len(page.Actors))
	for _, a := range page.Actors {
		actors = append(actors, reactionActorDTO{
			ActorRef:    reactionActorRef{Kind: a.ActorKind, ID: a.ActorID},
			Name:        a.Name,
			DisplayName: a.DisplayName,
		})
	}
	scopeKind := "channel"
	if page.ChannelType == "thread" {
		scopeKind = "thread"
	}
	nextCursor := any(nil)
	if page.NextCursor != nil {
		nextCursor = *page.NextCursor
	}
	writeJSON(w, http.StatusOK, reactionActorsResponse{
		Discussion: reactionDiscussion{
			Root:     reactionRoot{Kind: "message", ServerID: channelServerID(r), ID: pageMessageID(r)},
			Relation: reactionRelation{Kind: "reactionActors", Emoji: emoji},
			ParentScope: reactionParentScope{
				ServerID:  channelServerID(r),
				ScopeKind: scopeKind,
				ScopeID:   page.ChannelID,
			},
		},
		DiscussionVersion: page.DiscussionVersion,
		Actors:            actors,
		NextCursor:        nextCursor,
	})
}

func pageMessageID(r *http.Request) string { return r.PathValue("messageId") }

type reactionActorsResponse struct {
	Discussion        reactionDiscussion `json:"discussion"`
	DiscussionVersion int64              `json:"discussionVersion"`
	Actors            []reactionActorDTO `json:"actors"`
	NextCursor        any                `json:"nextCursor"`
}

type reactionDiscussion struct {
	Root        reactionRoot        `json:"root"`
	Relation    reactionRelation    `json:"relation"`
	ParentScope reactionParentScope `json:"parentScope"`
}

type reactionRoot struct {
	Kind     string `json:"kind"`
	ServerID string `json:"serverId"`
	ID       string `json:"id"`
}

type reactionRelation struct {
	Kind  string `json:"kind"`
	Emoji string `json:"emoji"`
}

type reactionParentScope struct {
	ServerID  string `json:"serverId"`
	ScopeKind string `json:"scopeKind"`
	ScopeID   string `json:"scopeId"`
}

type reactionActorDTO struct {
	ActorRef    reactionActorRef `json:"actorRef"`
	Name        string           `json:"name"`
	DisplayName string           `json:"displayName"`
}

type reactionActorRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// ReactionViewer renders the private snapshot {serverId,messageId,
// viewerVersion,reactedEmojis}.
func (h *M4MessageHandlers) ReactionViewer(w http.ResponseWriter, r *http.Request) {
	state, _, err := h.Store.ViewerSnapshot(r.Context(), message.NewClaims(accessClaims(r)),
		channelServerID(r), r.PathValue("messageId"))
	if err != nil {
		h.writeReactionError(w, r, err, "Failed to hydrate reaction viewer state")
		return
	}
	emojis := state.ReactedEmojis
	if emojis == nil {
		emojis = []string{}
	}
	writeJSON(w, http.StatusOK, message.ReactionViewerSnapshotDTO{
		ServerID:      channelServerID(r),
		MessageID:     r.PathValue("messageId"),
		ViewerVersion: state.ViewerVersion,
		ReactedEmojis: emojis,
	})
}

// AddReaction commits one reaction and answers the enriched message plus the
// private viewer snapshot.
func (h *M4MessageHandlers) AddReaction(w http.ResponseWriter, r *http.Request) {
	h.mutateReaction(w, r, true)
}

// RemoveReaction removes one reaction with the same response contract.
func (h *M4MessageHandlers) RemoveReaction(w http.ResponseWriter, r *http.Request) {
	h.mutateReaction(w, r, false)
}

func (h *M4MessageHandlers) mutateReaction(w http.ResponseWriter, r *http.Request, add bool) {
	emojiRaw, ok := readReactionEmoji(w, r)
	if !ok {
		return
	}
	workspaceID := channelServerID(r)
	claims := message.NewClaims(accessClaims(r))
	var mutation *message.ReactionMutation
	var err error
	if add {
		mutation, err = h.Store.AddReaction(r.Context(), claims, workspaceID, r.PathValue("messageId"), emojiRaw)
	} else {
		mutation, err = h.Store.RemoveReaction(r.Context(), claims, workspaceID, r.PathValue("messageId"), emojiRaw)
	}
	if err != nil {
		if invalid := message.AsInvalidInput(err); invalid != nil {
			writeError(w, http.StatusBadRequest, invalid.Reason)
			return
		}
		fallback := "Failed to add reaction"
		if !add {
			fallback = "Failed to remove reaction"
		}
		h.writeReactionError(w, r, err, fallback)
		return
	}
	dto, err := h.projectOne(r.Context(), workspaceID, mutation.Message)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to reload updated message")
		return
	}
	_ = workspaceID
	emojis := mutation.Viewer.ReactedEmojis
	if emojis == nil {
		emojis = []string{}
	}
	writeJSON(w, http.StatusOK, reactionMutationResponse{
		MessageDTO: dto,
		ReactionViewer: message.ReactionViewerSnapshotDTO{
			ServerID:      workspaceID,
			MessageID:     mutation.Message.ID,
			ViewerVersion: mutation.Viewer.ViewerVersion,
			ReactedEmojis: emojis,
		},
	})
}

// reactionMutationResponse flattens the message DTO with reactionViewer, the
// exact TS `res.json({...enriched, reactionViewer})` shape.
type reactionMutationResponse struct {
	*message.MessageDTO
	ReactionViewer message.ReactionViewerSnapshotDTO `json:"reactionViewer"`
}

func (h *M4MessageHandlers) projectOne(ctx context.Context, workspaceID string, msg *message.Message) (*message.MessageDTO, error) {
	dtos, err := h.Store.ProjectSnapshot(ctx, workspaceID, []*message.Message{msg})
	if err != nil {
		return nil, err
	}
	if len(dtos) != 1 {
		return nil, errors.New("projection lost the message")
	}
	return dtos[0], nil
}

// writeReactionError maps the reaction domain failures to their exact legacy
// bodies; fallback is the endpoint-specific 500 sentence.
func (h *M4MessageHandlers) writeReactionError(w http.ResponseWriter, r *http.Request, err error, fallback string) {
	var discussion *message.ReactionDiscussionChanged
	if errors.As(err, &discussion) {
		writeJSON(w, http.StatusConflict, errorBody{
			"error":                    discussion.Error(),
			"code":                     "reaction_discussion_version_changed",
			"currentDiscussionVersion": discussion.CurrentVersion,
			"rebaselineRequired":       true,
		})
		return
	}
	var visibility *message.ReactionVisibilityChanged
	if errors.As(err, &visibility) {
		writeJSON(w, http.StatusConflict, errorBody{
			"error":              visibility.Error(),
			"code":               "reaction_actor_visibility_changed",
			"rebaselineRequired": true,
		})
		return
	}
	if _, ok := err.(message.ReactionActorsCursorError); ok {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "Invalid reaction actors cursor", "code": "invalid_reaction_actors_cursor"})
		return
	}
	switch {
	case errors.Is(err, message.ErrConversationDenied), errors.Is(err, message.ErrMessageNotFound):
		writeError(w, http.StatusNotFound, "Message not found")
	case errors.Is(err, message.ErrSystemMessage):
		writeError(w, http.StatusBadRequest, "System messages cannot receive reactions")
	case errors.Is(err, message.ErrChannelArchived):
		writeJSON(w, http.StatusConflict, errorBody{"error": "This channel is archived", "code": "channel_archived"})
	case isJoinRequired(err):
		var member *message.ErrNotChannelMember
		errors.As(err, &member)
		writeError(w, http.StatusForbidden, member.Error())
	case errors.Is(err, message.ErrNotServerMember):
		writeError(w, http.StatusForbidden, "Not a member of this server")
	case errors.Is(err, auth.ErrTokenInvalid):
		writeErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
	default:
		writeError(w, http.StatusInternalServerError, fallback)
	}
}

// parseReactionEmojiQuery validates the actors-listing emoji parameter.
func parseReactionEmojiQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	emoji, ok := message.ValidateEmoji(r.URL.Query().Get("emoji"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "A valid emoji is required", "code": "invalid_reaction_emoji"})
		return "", false
	}
	return emoji, true
}

// parseReactionActorLimit ports parseReactionActorPageLimit (default 50,
// 1..100, digits only).
func parseReactionActorLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return 50, true
	}
	if !isASCIIDigits(raw) {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "limit must be an integer between 1 and 100", "code": "invalid_reaction_actor_limit"})
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 100 {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "limit must be an integer between 1 and 100", "code": "invalid_reaction_actor_limit"})
		return 0, false
	}
	return n, true
}

// readReactionEmoji parses the emoji from the JSON body of a mutation.
func readReactionEmoji(w http.ResponseWriter, r *http.Request) (string, bool) {
	fields, err := readJSONObject(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "A valid emoji is required")
		return "", false
	}
	raw, present := fields["emoji"]
	if !present {
		writeError(w, http.StatusBadRequest, "A valid emoji is required")
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		writeError(w, http.StatusBadRequest, "A valid emoji is required")
		return "", false
	}
	return value, true
}
