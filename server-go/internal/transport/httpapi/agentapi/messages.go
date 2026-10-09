// POST /internal/agent-api/send and /internal/agent-api/v2/send plus
// POST /internal/agent-api/resolve-channel: the original Agent CLI send
// contract. Both send entries normalize onto the transactional SendAgent use
// case and keep the single sent envelope; the handler only parses, validates
// in the original order and maps typed domain failures onto the frozen
// bodies. The original send routes carry NO zod request middleware — every
// check below is the TS handler's own, in its order. resolve-channel DOES
// validate its body against the shared contract schema. No SQL and no
// authorization decisions live here: the use case revalidates everything
// inside its own transaction.
package agentapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

// sendBody keeps the raw JSON fields so every legacy distinction (missing vs
// null vs wrong type) survives until the original handler checks run.
type sendBody struct {
	fields map[string]json.RawMessage
}

// stringField reports the raw (untrimmed) string value; valid=false means the
// field is present but is not a JSON string — the TS handler's typeof checks.
func (b *sendBody) stringField(field string) (value string, present, valid bool) {
	raw, ok := b.fields[field]
	if !ok || string(raw) == "null" {
		return "", false, true
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		return "", true, false
	}
	return v, true, true
}

// boolean reports ===true semantics: only a real JSON true is true; anything
// else (including non-booleans, which the unvalidated body may carry) is not.
func (b *sendBody) boolean(field string) bool {
	raw, ok := b.fields[field]
	if !ok || string(raw) == "null" {
		return false
	}
	var v bool
	if json.Unmarshal(raw, &v) != nil {
		return false
	}
	return v
}

// parseSendBody reads the bounded JSON object; a malformed body is the 400
// plain sentence the express json parser era produced for this surface.
func parseSendBody(w http.ResponseWriter, r *http.Request) *sendBody {
	fields, err := httpx.ReadJSONObject(r)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "Invalid JSON body")
		return nil
	}
	return &sendBody{fields: fields}
}

// structuredMention mirrors the CLI's typed mention selector.
type structuredMention struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

var mentionTypeValues = map[string]bool{"user": true, "agent": true}

// parseV2Mentions converts the v2 typed mention list onto the locked
// message.Mention input. The original validates downstream in the message
// service; malformed rows therefore get that same sentence here ("Invalid
// mentions payload") instead of a silently altered write.
func parseV2Mentions(b *sendBody) ([]message.Mention, bool) {
	raw, ok := b.fields["mentions"]
	if !ok || string(raw) == "null" {
		return nil, true
	}
	var rows []structuredMention
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, false
	}
	out := make([]message.Mention, 0, len(rows))
	for _, m := range rows {
		name := strings.TrimSpace(m.Name)
		if !mentionTypeValues[m.Type] || !isAgentAPIUUID(m.ID) || name == "" ||
			utf16Length(name) > maxMentionNameUnits {
			return nil, false
		}
		out = append(out, message.Mention{Type: m.Type, ID: m.ID, Name: name})
	}
	return out, true
}

// maxIdempotencyKeyUnits is the CLI contract bound for --idempotency-key,
// measured in UTF-16 code units exactly like the client's string length.
const maxIdempotencyKeyUnits = 256

// maxMentionNameUnits mirrors the shared mention schema bound (and the
// message domain's validateMentionShapes): 128 UTF-16 code units.
const maxMentionNameUnits = 128

// utf16Length counts JavaScript string length (UTF-16 code units), not runes:
// an astral-plane character counts as two, matching the client-side length
// checks the original contract freezes.
func utf16Length(s string) int {
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

// parseAttachmentIDs validates the attachmentIds shape without ever losing a
// requested element: ok=false marks a non-array value or a non-string/empty
// element; ok=true with len>0 is a well-formed unsupported attachment list.
func parseAttachmentIDs(raw json.RawMessage) (ids []string, ok bool) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	ids = make([]string, 0, len(items))
	for _, item := range items {
		var id string
		if err := json.Unmarshal(item, &id); err != nil || id == "" {
			return nil, false
		}
		ids = append(ids, id)
	}
	return ids, true
}

// isAgentAPIUUID accepts the canonical 8-4-4-4-12 hex form.
func isAgentAPIUUID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i, c := range v {
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

// MessageSend handles POST /internal/agent-api/send (v1).
func (h *Handlers) MessageSend(w http.ResponseWriter, r *http.Request) {
	h.handleSend(w, r, "messageSend")
}

// MessageSendV2 handles POST /internal/agent-api/v2/send.
func (h *Handlers) MessageSendV2(w http.ResponseWriter, r *http.Request) {
	h.handleSend(w, r, "messageSendV2")
}

// handleSend runs the frozen validation order of the TS handler, resolves the
// target DSL through the port and commits through the SendAgent use case.
// Freshness fields (sendDraft/continueAnyway/draftReholdCount/
// draftReplacedExisting/seenUpToSeq/freshnessContextMode) are accepted and
// ignored: this server implements no freshness gate, so it must never emit
// the TS "not enabled" 403 nor a held state.
func (h *Handlers) handleSend(w http.ResponseWriter, r *http.Request, routeKey string) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "send") {
		return
	}
	body := parseSendBody(w, r)
	if body == nil {
		return
	}

	// Original order: target, content, deprecated continue, any-way without
	// a draft — each with the frozen sentence.
	target, present, valid := body.stringField("target")
	if !present || !valid || target == "" {
		httpx.WriteError(w, http.StatusBadRequest, "target is required")
		return
	}
	content, cPresent, cValid := body.stringField("content")
	if !cPresent || !cValid || content == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Content is required")
		return
	}
	if body.boolean("continue") {
		httpx.WriteError(w, http.StatusBadRequest, "--continue is no longer supported. Use normal message send to update a draft, or --send-draft to send the current saved draft.")
		return
	}
	if body.boolean("continueAnyway") && !body.boolean("sendDraft") {
		httpx.WriteError(w, http.StatusBadRequest, "--send-draft --anyway requires a saved draft")
		return
	}
	// Stateful saved-draft actions (sendDraft, and the --anyway escape hatch
	// that only ever accompanies it) require the server-side draft store and
	// freshness gate this stage does not implement; committing the "draft"
	// body as ordinary content would fake the effect. The always-present CLI
	// metadata (draftReholdCount/draftReplacedExisting/seenUpToSeq/freshness
	// hints) stays accepted and ignored — only the action is refused.
	if body.boolean("sendDraft") {
		httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", "Saved drafts are not enabled in this server stage")
		return
	}

	// Attachments are not enabled in this stage: a non-empty array is the
	// honest 501 before any write. The array shape is validated first so a
	// REQUESTED attachment can never silently disappear from a commit: a
	// non-array value or any non-string (or empty) element is the contract
	// 400, and only a well-formed non-empty array reaches the 501.
	if raw, ok := body.fields["attachmentIds"]; ok && string(raw) != "null" {
		ids, shape := parseAttachmentIDs(raw)
		if !shape {
			writeContractInvalid(w, routeKey, "body", []httpx.Issue{{Path: "attachmentIds", Message: "Expected array of non-empty strings"}})
			return
		}
		if len(ids) > 0 {
			httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", "Attachments are not enabled in this server stage")
			return
		}
	}

	// Idempotency key: the CLI contract is 1..256 characters after the zod
	// trim. A longer key, or a non-string value that would silently drop the
	// caller's dedupe identity, is rejected with the contract 400 instead of
	// committing without idempotency; an empty/absent key stays absent.
	idempotencyKey := ""
	if raw, ok := body.fields["idempotencyKey"]; ok && string(raw) != "null" {
		var key string
		if err := json.Unmarshal(raw, &key); err != nil {
			writeContractInvalid(w, routeKey, "body", []httpx.Issue{{Path: "idempotencyKey", Message: "Expected string"}})
			return
		}
		key = strings.TrimSpace(key)
		if utf16Length(key) > maxIdempotencyKeyUnits {
			writeContractInvalid(w, routeKey, "body", []httpx.Issue{{Path: "idempotencyKey", Message: "String must contain at most 256 character(s)"}})
			return
		}
		idempotencyKey = key
	}

	var mentions []message.Mention
	if routeKey == "messageSendV2" {
		parsed, ok2 := parseV2Mentions(body)
		if !ok2 {
			httpx.WriteError(w, http.StatusBadRequest, "Invalid mentions payload")
			return
		}
		mentions = parsed
	}

	resolution, err := h.targets.ResolveWritableAgentTarget(r.Context(), *lookup, target)
	if err != nil {
		h.writeTargetError(w, target, err, "Failed to send message")
		return
	}

	result, err := h.send.SendAgent(r.Context(), *lookup, AgentSendInput{
		CreateInput: message.CreateInput{
			ChannelID: resolution.ChannelID,
			Content:   content,
			Mentions:  mentions,
		},
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		h.writeSendError(w, err, routeKey)
		return
	}
	if result == nil || result.Message == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to send message")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, client.AgentSendSentResponse{
		OK:         true,
		State:      "sent",
		MessageID:  result.Message.ID,
		MessageSeq: result.Message.Seq,
	})
}

// ResolveChannel handles POST /internal/agent-api/resolve-channel: the same
// writable-target resolution the send path performs, surfaced for callers
// that only need the stable channel UUID. Unlike send, this route validates
// its body against the shared contract schema (zod: target trimmed, >=1).
func (h *Handlers) ResolveChannel(w http.ResponseWriter, r *http.Request) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "send") {
		return
	}
	fields, err := httpx.ReadJSONObject(r)
	if err != nil {
		writeContractInvalid(w, "resolveChannel", "body", []httpx.Issue{{Path: "", Message: "Invalid JSON body"}})
		return
	}
	target := ""
	if raw, ok := fields["target"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &target); err != nil {
			writeContractInvalid(w, "resolveChannel", "body", []httpx.Issue{{Path: "target", Message: "Expected string"}})
			return
		}
	}
	if strings.TrimSpace(target) == "" {
		writeContractInvalid(w, "resolveChannel", "body", []httpx.Issue{{Path: "target", Message: "Required"}})
		return
	}
	resolution, err := h.targets.ResolveWritableAgentTarget(r.Context(), *lookup, strings.TrimSpace(target))
	if err != nil {
		h.writeTargetError(w, strings.TrimSpace(target), err, "Failed to resolve channel")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, client.AgentResolveChannelResponse{ChannelID: resolution.ChannelID})
}

func writeContractInvalid(w http.ResponseWriter, routeKey, part string, issues []httpx.Issue) {
	httpx.WriteErrorIssues(w, http.StatusBadRequest,
		"Invalid agent-api "+routeKey+" "+part, "agent_api_contract_invalid", issues)
}

// writeTargetError maps the writable-target port failures onto the original
// bodies (sentences from routes/agentWritableTarget.ts); unknown failures use
// the calling route's own 500 sentence.
func (h *Handlers) writeTargetError(w http.ResponseWriter, target string, err error, unknownMessage string) {
	var forbidden *TargetForbiddenError
	var notFound *TargetNotFoundError
	var dmNotEnabled *AgentDMNotEnabledError
	switch {
	case errors.As(err, &forbidden):
		httpx.WriteError(w, http.StatusForbidden, forbidden.Message)
	case errors.As(err, &notFound):
		httpx.WriteError(w, http.StatusNotFound, notFound.Message)
	case errors.Is(err, ErrAgentTargetPeerNotFound):
		peer := target
		if len(peer) >= 4 {
			peer = peer[4:]
		}
		httpx.WriteError(w, http.StatusNotFound, "User or agent not found: @"+peer)
	case errors.Is(err, ErrAgentTargetSelfDM):
		httpx.WriteError(w, http.StatusBadRequest, "Cannot create a DM with yourself")
	case errors.As(err, &dmNotEnabled):
		httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", dmNotEnabled.Message)
	default:
		if domain := agent.AsError(err); domain != nil {
			httpx.WriteError(w, domain.Status, domain.Message)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, unknownMessage)
	}
}

// writeSendError maps the SendAgent domain failures onto the frozen bodies,
// matching the human send mapping plus the v2 mention-binding code.
func (h *Handlers) writeSendError(w http.ResponseWriter, err error, routeKey string) {
	if unsupported := message.AsUnsupportedEffect(err); unsupported != nil {
		httpx.WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", unsupported.Reason)
		return
	}
	if invalid := message.AsInvalidInput(err); invalid != nil {
		httpx.WriteError(w, http.StatusBadRequest, invalid.Reason)
		return
	}
	var binding *message.MentionBindingConflict
	if errors.As(err, &binding) {
		if routeKey == "messageSendV2" {
			httpx.WriteJSON(w, http.StatusBadRequest, httpx.ErrorBody{"error": binding.Error(), "code": "mention_binding_conflict"})
		} else {
			httpx.WriteError(w, http.StatusBadRequest, binding.Error())
		}
		return
	}
	if conflict := message.AsRandomIDConflict(err); conflict != nil {
		httpx.WriteJSON(w, http.StatusConflict, httpx.ErrorBody{"error": conflict.Reason, "code": "random_id_conflict"})
		return
	}
	switch {
	case errors.Is(err, message.ErrChannelArchived):
		httpx.WriteJSON(w, http.StatusConflict, httpx.ErrorBody{"error": "This channel is archived", "code": "channel_archived"})
	case errors.Is(err, message.ErrNoChannelAccess):
		httpx.WriteError(w, http.StatusNotFound, "Channel not found")
	case errors.Is(err, message.ErrNotServerMember):
		httpx.WriteError(w, http.StatusForbidden, "Not a member of this server")
	default:
		if domain := agent.AsError(err); domain != nil {
			httpx.WriteError(w, domain.Status, domain.Message)
			return
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to send message")
	}
}
