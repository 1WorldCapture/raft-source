// M4 message transport: send (v1/v2), channel history with coverage, message
// context, visibility-correct sync, and the human reaction surface (shared
// actors + private viewer). Domain policy lives in internal/message; this
// file only parses requests, renders the exact legacy bodies and applies the
// shared write rate bucket.
package legacyweb

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/message"
)

// M4MessageHandlers carries the message transport dependencies.
type M4MessageHandlers struct {
	Store    *message.Store
	Channels *ChannelHandlers // reuses RequireChannelServer + channel store reads
	limiter  *messageLimiter
}

// NewMessageHandlers builds the handler set with the production rate bucket.
func NewMessageHandlers(store *message.Store, channels *ChannelHandlers) *M4MessageHandlers {
	return &M4MessageHandlers{Store: store, Channels: channels, limiter: newMessageLimiter()}
}

// SetMessageRateClock swaps the shared bucket clock (tests). The bucket is
// never disabled in production wiring.
func (h *M4MessageHandlers) SetMessageRateClock(now func() time.Time) {
	if now != nil {
		h.limiter.now = now
	}
}

// ---- send ----

// createMessageBody mirrors parseHumanMessageCreateBody field-for-field; the
// raw JSON keeps every legacy type distinction (missing vs null vs wrong
// type) so the error precedence matches the TS parsers.
type createMessageBody struct {
	fields map[string]json.RawMessage
}

func (b *createMessageBody) has(field string) bool {
	raw, ok := b.fields[field]
	return ok && string(raw) != "null"
}

// parseCreateBody validates the closed shape the TS parser accepts. ok=false
// writes the 400 "Invalid message request body".
func parseCreateBody(w http.ResponseWriter, r *http.Request) *createMessageBody {
	fields, err := readJSONObject(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid message request body")
		return nil
	}
	b := &createMessageBody{fields: fields}
	if raw, ok := fields["channelId"]; ok {
		if !jsonStringMatches(raw, isLegacyUUID) {
			writeError(w, http.StatusBadRequest, "Invalid message request body")
			return nil
		}
	} else {
		writeError(w, http.StatusBadRequest, "Invalid message request body")
		return nil
	}
	if raw, ok := fields["attachmentIds"]; ok && string(raw) != "null" {
		var ids []string
		if json.Unmarshal(raw, &ids) != nil {
			writeError(w, http.StatusBadRequest, "Invalid message request body")
			return nil
		}
		for _, id := range ids {
			if !isLegacyUUID(id) {
				writeError(w, http.StatusBadRequest, "Invalid message request body")
				return nil
			}
		}
	}
	if raw, ok := fields["asTask"]; ok && string(raw) != "null" {
		var v bool
		if json.Unmarshal(raw, &v) != nil {
			writeError(w, http.StatusBadRequest, "Invalid message request body")
			return nil
		}
	}
	return b
}

// jsonStringMatches reports a present JSON string field satisfying pred.
func jsonStringMatches(raw json.RawMessage, pred func(string) bool) bool {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return false
	}
	return pred(s)
}

// buildCreateInput applies the remaining TS validation order: randomId,
// mentions payload, required fields, content type/trim/length.
func buildCreateInput(w http.ResponseWriter, b *createMessageBody) *message.CreateInput {
	input := &message.CreateInput{}
	if raw, ok := b.fields["channelId"]; ok {
		_ = json.Unmarshal(raw, &input.ChannelID)
	}
	contentNotString := false
	if raw, ok := b.fields["content"]; ok {
		if err := json.Unmarshal(raw, &input.Content); err != nil {
			// A present non-string content passes the required-field check
			// (truthy) and then fails the type check, exactly like TS.
			contentNotString = true
		}
	}
	if raw, ok := b.fields["randomId"]; ok && string(raw) != "null" {
		var rid string
		if json.Unmarshal(raw, &rid) != nil {
			writeError(w, http.StatusBadRequest, "randomId must be a non-empty string with at most 128 characters")
			return nil
		}
		input.RandomID = &rid
	}
	if raw, ok := b.fields["mentions"]; ok && string(raw) != "null" {
		var raws []struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &raws) != nil {
			writeError(w, http.StatusBadRequest, "Invalid mentions payload")
			return nil
		}
		seen := map[string]bool{}
		for _, item := range raws {
			if (item.Type != "user" && item.Type != "agent") || !isLegacyUUID(item.ID) {
				writeError(w, http.StatusBadRequest, "Invalid mentions payload")
				return nil
			}
			name := strings.TrimFunc(item.Name, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' })
			if name == "" || len([]rune(item.Name)) > 128 {
				writeError(w, http.StatusBadRequest, "Invalid mentions payload")
				return nil
			}
			key := item.Type + ":" + item.ID + ":" + name
			if seen[key] {
				continue
			}
			seen[key] = true
			input.Mentions = append(input.Mentions, message.Mention{Type: item.Type, ID: item.ID, Name: name})
		}
	}
	if input.ChannelID == "" || (input.Content == "" && !contentNotString) {
		writeError(w, http.StatusBadRequest, "Channel ID and content are required")
		return nil
	}
	if contentNotString {
		writeError(w, http.StatusBadRequest, "Message content cannot be empty")
		return nil
	}
	if raw, ok := b.fields["attachmentIds"]; ok && string(raw) != "null" {
		_ = json.Unmarshal(raw, &input.AttachmentIDs)
	}
	if raw, ok := b.fields["asTask"]; ok && string(raw) != "null" {
		var v bool
		_ = json.Unmarshal(raw, &v)
		input.AsTask = &v
	}
	return input
}

// CreateMessageV2 renders {message, pendingMentionActions?, unresolvedMentionHandles?}.
func (h *M4MessageHandlers) CreateMessageV2(w http.ResponseWriter, r *http.Request) {
	h.createMessage(w, r, "v2")
}

// CreateMessageV1 renders the bare message (envelope only with pending
// actions, which human-only M4 never produces).
func (h *M4MessageHandlers) CreateMessageV1(w http.ResponseWriter, r *http.Request) {
	h.createMessage(w, r, "v1")
}

func (h *M4MessageHandlers) createMessage(w http.ResponseWriter, r *http.Request, contract string) {
	body := parseCreateBody(w, r)
	if body == nil {
		return
	}
	input := buildCreateInput(w, body)
	if input == nil {
		return
	}
	result, err := h.Store.Create(r.Context(), accessClaims(r), channelServerID(r), *input)
	if err != nil {
		h.writeSendError(w, r, err, contract)
		return
	}
	dto, err := h.Store.BuildSendResponse(r.Context(), result)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to send message")
		return
	}
	if contract == "v2" {
		writeJSON(w, http.StatusOK, map[string]any{"message": dto})
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

// writeSendError maps the domain failures to the exact legacy TS bodies.
func (h *M4MessageHandlers) writeSendError(w http.ResponseWriter, r *http.Request, err error, contract string) {
	if unsupported := message.AsUnsupportedEffect(err); unsupported != nil {
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", unsupported.Reason)
		return
	}
	if invalid := message.AsInvalidInput(err); invalid != nil {
		writeError(w, http.StatusBadRequest, invalid.Reason)
		return
	}
	var binding *message.MentionBindingConflict
	if errors.As(err, &binding) {
		if contract == "v2" {
			writeJSON(w, http.StatusBadRequest, errorBody{"error": binding.Error(), "code": "mention_binding_conflict"})
		} else {
			writeError(w, http.StatusBadRequest, binding.Error())
		}
		return
	}
	if conflict := message.AsRandomIDConflict(err); conflict != nil {
		writeJSON(w, http.StatusConflict, errorBody{"error": conflict.Reason, "code": "random_id_conflict"})
		return
	}
	switch {
	case errors.Is(err, message.ErrChannelNotFound):
		writeError(w, http.StatusNotFound, "Channel not found")
	case isJoinRequired(err):
		writeError(w, http.StatusForbidden, (&message.ErrNotChannelMember{Action: "send messages"}).Error())
	case errors.Is(err, message.ErrChannelArchived):
		writeJSON(w, http.StatusConflict, errorBody{"error": "This channel is archived", "code": "channel_archived"})
	case errors.Is(err, message.ErrNotServerMember):
		writeError(w, http.StatusForbidden, "Not a member of this server")
	case errors.Is(err, auth.ErrTokenInvalid):
		writeErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
	default:
		writeError(w, http.StatusInternalServerError, "Failed to send message")
	}
}

func isJoinRequired(err error) bool {
	var member *message.ErrNotChannelMember
	return errors.As(err, &member)
}

// ---- history ----

// ChannelHistory renders the MessagePage: messages, thread summaries,
// historyLimited and the receiver-visible message window.
func (h *M4MessageHandlers) ChannelHistory(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	limit, ok := parseHistoryLimit(w, r)
	if !ok {
		return
	}
	before, after, ok := parseHistoryCursors(w, r)
	if !ok {
		return
	}
	claims := message.NewClaims(accessClaims(r))
	workspaceID := channelServerID(r)
	page, err := h.Store.ListChannelPage(r.Context(), claims, workspaceID, channelID, message.PageQuery{
		Limit: limit, Before: before, After: after,
	})
	if err != nil {
		h.writeReadError(w, r, err, "You do not have access to this channel", "Failed to list messages")
		return
	}
	writeJSON(w, http.StatusOK, messagePageResponse{
		Messages:                         page.DTOs,
		ThreadSummariesByParentMessageID: page.ThreadSummaries,
		HistoryLimited:                   false,
		MessageWindow: message.MessageWindowDTO{
			SchemaVersion:         1,
			Domain:                "receiver_visible_messages_v1",
			ServerID:              workspaceID,
			ReceiverKind:          "user",
			ReceiverID:            claims.SubjectID(),
			ScopeID:               channelID,
			CoveredAfterSeq:       page.Coverage.CoveredAfterSeq,
			CoveredFromSeq:        page.Coverage.CoveredFromSeq,
			CoveredThroughSeq:     page.Coverage.CoveredThroughSeq,
			RemoteHighWaterSeq:    page.Coverage.RemoteHighWaterSeq,
			HasGap:                page.Coverage.HasGap,
			HasNewer:              page.Coverage.HasNewer,
			CompleteThroughLatest: page.Coverage.CompleteThroughLatest,
		},
	})
}

// projectFromSnapshot reprojects the page rows on one fresh snapshot. The
// rows and coverage came from the authoritative snapshot; enrichment fields
// are directory/aggregates that the response contract allows reading a hair
// later without breaking the window guarantees.
func (h *M4MessageHandlers) projectFromSnapshot(ctx context.Context, workspaceID string, msgs []*message.Message) ([]*message.MessageDTO, error) {
	return h.Store.ProjectSnapshot(ctx, workspaceID, msgs)
}

type messagePageResponse struct {
	Messages                         []*message.MessageDTO            `json:"messages"`
	ThreadSummariesByParentMessageID map[string]message.ThreadSummary `json:"threadSummariesByParentMessageId"`
	HistoryLimited                   bool                             `json:"historyLimited"`
	MessageWindow                    message.MessageWindowDTO         `json:"messageWindow"`
}

// parseHistoryLimit ports Math.min(Number(q.limit) || 50, 200) including the
// NaN→50 and 0→50 fallbacks; strictly numeric negatives mirror the legacy 500.
func parseHistoryLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return 50, true
	}
	if !isASCIIDigits(raw) {
		// Number("abc") → NaN → 50
		return 50, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		writeError(w, http.StatusInternalServerError, "Failed to list messages")
		return 0, false
	}
	if n == 0 {
		return 50, true
	}
	if n > 200 {
		return 200, true
	}
	return n, true
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// parseHistoryCursor ports parseMessagePageCursor: ^\d+$, safe integer >=0;
// before and after are mutually exclusive.
func parseHistoryCursors(w http.ResponseWriter, r *http.Request) (before, after *int64, ok bool) {
	q := r.URL.Query()
	beforeRaw, beforeSet := q["before"]
	afterRaw, afterSet := q["after"]
	parse := func(values []string, present bool) (*int64, bool) {
		if !present || len(values) == 0 || values[0] == "" {
			return nil, true
		}
		raw := values[0]
		if !isASCIIDigits(raw) {
			return nil, false
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 || n > 9_007_199_254_740_991 {
			return nil, false
		}
		return &n, true
	}
	before, ok = parse(beforeRaw, beforeSet)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "Invalid message page cursor", "code": "invalid_message_page_cursor"})
		return nil, nil, false
	}
	after, ok = parse(afterRaw, afterSet)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "Invalid message page cursor", "code": "invalid_message_page_cursor"})
		return nil, nil, false
	}
	if before != nil && after != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"error": "Invalid message page cursor", "code": "invalid_message_page_cursor"})
		return nil, nil, false
	}
	return before, after, true
}

// writeReadError renders the legacy deny split for base-read refusals: a
// caller with a prior relationship keeps the honest 403 sentence; strangers
// get the byte-identical 404 CHANNEL_NOT_FOUND_BODY.
func (h *M4MessageHandlers) writeReadError(w http.ResponseWriter, r *http.Request, err error, forbiddenSentence, fallback string) {
	switch {
	case errors.Is(err, message.ErrConversationDenied):
		h.denyChannelAccess(w, r, channelIDForRequest(r), forbiddenSentence)
	case errors.Is(err, message.ErrNotServerMember):
		writeError(w, http.StatusForbidden, "Not a member of this server")
	case errors.Is(err, message.ErrChannelArchived):
		writeJSON(w, http.StatusConflict, errorBody{"error": "This channel is archived", "code": "channel_archived"})
	case errors.Is(err, message.ErrSystemMessage):
		writeError(w, http.StatusBadRequest, "System messages cannot receive reactions")
	case errors.Is(err, message.ErrMessageNotFound):
		writeError(w, http.StatusNotFound, "Message not found")
	case isJoinRequired(err):
		var member *message.ErrNotChannelMember
		errors.As(err, &member)
		writeError(w, http.StatusForbidden, member.Error())
	case errors.Is(err, auth.ErrTokenInvalid):
		writeErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
	default:
		writeError(w, http.StatusInternalServerError, fallback)
	}
}

// denyChannelAccess ports denyChannelAccess over the channel worker's
// trusted prior-relationship witnesses. A channelID of "" never matches a
// witness, mirroring the legacy miss.
func (h *M4MessageHandlers) denyChannelAccess(w http.ResponseWriter, r *http.Request, channelID, forbiddenSentence string) {
	if channelID == "" {
		writeError(w, http.StatusNotFound, "Channel not found or not visible")
		return
	}
	prior, err := h.Store.HasPriorRelationship(r.Context(), userID(r), channelID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if prior {
		writeError(w, http.StatusForbidden, forbiddenSentence)
		return
	}
	writeError(w, http.StatusNotFound, "Channel not found or not visible")
}

// isLegacyUUID is the shared transport UUID predicate.
func isLegacyUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// channelIDForRequest picks the conversation id from the path value or the
// channel_id query (sync), whichever the surface carries.
func channelIDForRequest(r *http.Request) string {
	if id := r.PathValue("channelId"); id != "" {
		return id
	}
	return r.URL.Query().Get("channel_id")
}

// writeContextError maps context-path failures: the legacy route answers an
// inaccessible channel or mismatched message with the plain 404, never a
// channel-existence split.
func (h *M4MessageHandlers) writeContextError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, message.ErrConversationDenied), errors.Is(err, message.ErrMessageNotFound):
		writeError(w, http.StatusNotFound, "Message not found")
	default:
		h.writeReadError(w, r, err, "You do not have access to this channel", "Failed to load message context")
	}
}
