// GET /internal/agent-api/events (legacy destructive drain),
// GET /internal/agent-api/events/claim and POST /internal/agent-api/events/ack:
// the original claim-then-ack inbox contract. The ack batch on the wire is
// exactly {seqs, message_ids, third_party_event_ids} — the full content of the
// CLI's Claim-Ack token (base64url JSON {v:1,s,m,t}); there is no server
// secret, lease generation or signature to require (m5-claim-wire-correction).
// The port owns delivery facts, leases and receipts; this layer only parses,
// bounds and renders.
package agentapi

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/transport/presenter"
)

// eventsMaxBatch is the drain/claim clamp: Number(limit)||50 bounded to
// [1,200], exactly like the TS handler.
const (
	eventsDefaultBatch = 50
	eventsMaxBatch     = 200
	eventsAckMaxIDs    = 500
)

// parseEventsQuery validates since/limit with the original semantics:
// since="latest" or a non-negative integer (else the since_invalid 400),
// limit any parseable number clamped into [1,200] (non-numeric -> 50).
func parseEventsQuery(r *http.Request) (*AgentEventQuery, bool, int) {
	q := r.URL.Query()
	sinceSeq := (*int64)(nil)
	if raw := strings.TrimSpace(q.Get("since")); raw != "" && raw != "latest" {
		parsed, err := parseNonNegativeInt(raw)
		if err != nil {
			return nil, false, http.StatusBadRequest
		}
		sinceSeq = &parsed
	}
	// Number(limit) || 50: NaN and 0 both fall back to the default (the JS
	// truthiness of 0), then the [1,200] clamp bounds the batch. The lower
	// bound deliberately does NOT reproduce the original's negative-limit
	// passthrough (SQLite LIMIT -N means unlimited there) — a nonsense limit
	// fails safe as a single-item batch instead of an unbounded one.
	limit := boundedQueryLimit(q.Get("limit"), eventsDefaultBatch, eventsMaxBatch)
	return &AgentEventQuery{SinceSeq: sinceSeq, Limit: limit}, true, 0
}

// Clamp before converting a client-supplied float to an integer. Converting
// a huge finite value or infinity first can overflow into a negative limit.
// Number(limit)||default semantics remain intact, including exponent values
// that overflow to infinity in JavaScript and are then bounded by the cap.
func boundedQueryLimit(raw string, fallback, maximum int) int {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if (err != nil && !errors.Is(err, strconv.ErrRange)) || math.IsNaN(parsed) || parsed == 0 {
		return fallback
	}
	if parsed <= 1 {
		return 1
	}
	if parsed >= float64(maximum) {
		return maximum
	}
	return int(math.Floor(parsed))
}

func parseNonNegativeInt(raw string) (int64, error) {
	parsed, err := strconv.ParseFloat(raw, 64)
	// float64(math.MaxInt64) rounds UP to 2^63, which itself cannot be
	// represented by int64. Reject that boundary before converting.
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed >= float64(math.MaxInt64) {
		return 0, strconv.ErrSyntax
	}
	return int64(parsed), nil
}

// Events handles GET /internal/agent-api/events: the legacy destructive
// drain. The returned batch is acknowledged server-side as part of this
// request (response loss is the documented weak window); the client performs
// no separate acknowledgement.
func (h *Handlers) Events(w http.ResponseWriter, r *http.Request) {
	h.handleEvents(w, r, "drain")
}

// EventsClaim handles GET /internal/agent-api/events/claim: the same
// selection, nothing acknowledged; the ack receipt of the returned batch is
// handed back for a later POST /events/ack.
func (h *Handlers) EventsClaim(w http.ResponseWriter, r *http.Request) {
	h.handleEvents(w, r, "claim")
}

func (h *Handlers) handleEvents(w http.ResponseWriter, r *http.Request, mode string) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "read") {
		return
	}
	// Go's GET patterns also match HEAD. A bodyless probe must never
	// consume the legacy inbox or reserve a claim that it cannot receive.
	// Keep proof/capability checks ahead of the method denial.
	if r.Method == http.MethodHead {
		w.Header().Set("Allow", http.MethodGet)
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSON(w, http.StatusMethodNotAllowed, httpx.ErrorBody{
			"error": "Method not allowed", "code": "method_not_allowed", "allow": http.MethodGet,
		})
		return
	}
	query, valid, status := parseEventsQuery(r)
	if !valid {
		httpx.WriteJSON(w, status, httpx.ErrorBody{
			"error": "since must be a non-negative integer (messageSeq) or 'latest'",
			"code":  "since_invalid",
		})
		return
	}

	var batch *AgentEventBatch
	var err error
	if mode == "claim" {
		batch, err = h.events.ClaimEvents(r.Context(), *lookup, *query)
	} else {
		batch, err = h.events.DrainEvents(r.Context(), *lookup, *query)
	}
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to load events")
		return
	}
	if batch == nil {
		// An empty-success port result still renders the full envelope shape.
		batch = &AgentEventBatch{}
	}

	envelopes := presenter.AgentMessageWireList(batch.Events)
	response := client.AgentEventsResponse{
		Events:           envelopes,
		LastSeenMsgID:    lastSeenMessageID(batch),
		LastSeenSeq:      lastSeenSeq(batch, query.SinceSeq),
		ReplyTarget:      replyTarget(batch),
		PendingNoticeIDs: []string{},
		WakeReason:       nil,
		HasMore:          batch.HasMore,
	}
	w.Header().Set("Cache-Control", "no-store")
	if mode == "claim" {
		httpx.WriteJSON(w, http.StatusOK, client.AgentEventsClaimResponse{
			AgentEventsResponse: response,
			Ack: client.AgentEventsAckBatch{
				Seqs:               nonEmptyInt64s(batch.AckSeqs),
				MessageIDs:         nonEmptyStrings(batch.AckMessageIDs),
				ThirdPartyEventIDs: []string{},
			},
		})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, response)
}

// lastSeenMessageID echoes the newest returned event's id (null on an empty
// batch) — a delivery cursor echo, never a model-seen boundary.
func lastSeenMessageID(batch *AgentEventBatch) *string {
	if len(batch.Events) == 0 {
		return nil
	}
	id := batch.Events[len(batch.Events)-1].MessageID
	return &id
}

// lastSeenSeq mirrors `newestEvent?.seq ?? sinceSeq`: the newest event's seq
// when it has one, otherwise the caller's since anchor (still null for
// "latest").
func lastSeenSeq(batch *AgentEventBatch, since *int64) *int64 {
	if len(batch.Events) > 0 {
		if seq := batch.Events[len(batch.Events)-1].Seq; seq > 0 {
			return &seq
		}
	}
	return since
}

// replyTarget renders the channelId:<uuid> default-reply hint of the newest
// event, null on an empty batch.
func replyTarget(batch *AgentEventBatch) *string {
	if len(batch.Events) == 0 {
		return nil
	}
	channelID := batch.Events[len(batch.Events)-1].ChannelID
	if channelID == "" {
		return nil
	}
	hint := "channelId:" + channelID
	return &hint
}

func nonEmptyInt64s(values []int64) []int64 {
	if len(values) == 0 {
		return []int64{}
	}
	return values
}

func nonEmptyStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return values
}

// EventsAck handles POST /internal/agent-api/events/ack: acknowledge a batch
// previously returned by /events/claim. Idempotent — a replay removes nothing
// and reports removed_count 0; ids never claimed by (or foreign to) this
// authenticated credential contribute 0 and are never treated as a
// cumulative watermark. third_party_event_ids is accepted (the CLI always
// sends the full triple) but no third-party events exist in this stage, so
// none are ever counted as removed.
func (h *Handlers) EventsAck(w http.ResponseWriter, r *http.Request) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "read") {
		return
	}
	fields, err := httpx.ReadJSONObject(r)
	if err != nil {
		writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: "", Message: "Invalid JSON body"}})
		return
	}
	seqs, messageIDs, thirdPartyIDs, ok2 := parseAckBatch(w, fields)
	if !ok2 {
		return
	}
	_ = thirdPartyIDs // accepted on the wire, intentionally not forwarded

	removed, err := h.events.AckEvents(r.Context(), *lookup, seqs, messageIDs)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to acknowledge events")
		return
	}
	if removed < 0 {
		removed = 0
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, client.AgentEventsAckResponse{OK: true, RemovedCount: removed})
}

// parseAckBatch validates the shared ack schema: three optional arrays, each
// capped at 500, seqs positive integers, ids non-empty strings.
func parseAckBatch(w http.ResponseWriter, fields map[string]json.RawMessage) ([]int64, []string, []string, bool) {
	var seqs []int64
	var messageIDs, thirdPartyIDs []string
	if raw, ok := fields["seqs"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &seqs); err != nil {
			writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: "seqs", Message: "Expected array of numbers"}})
			return nil, nil, nil, false
		}
		if len(seqs) > eventsAckMaxIDs {
			writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: "seqs", Message: "Array must contain at most 500 element(s)"}})
			return nil, nil, nil, false
		}
		for _, seq := range seqs {
			if seq <= 0 {
				writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: "seqs", Message: "Number must be greater than 0"}})
				return nil, nil, nil, false
			}
		}
	}
	for _, field := range []struct {
		name string
		dest *[]string
	}{{"message_ids", &messageIDs}, {"third_party_event_ids", &thirdPartyIDs}} {
		raw, ok := fields[field.name]
		if !ok || string(raw) == "null" {
			continue
		}
		if err := json.Unmarshal(raw, field.dest); err != nil {
			writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: field.name, Message: "Expected array of strings"}})
			return nil, nil, nil, false
		}
		if len(*field.dest) > eventsAckMaxIDs {
			writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: field.name, Message: "Array must contain at most 500 element(s)"}})
			return nil, nil, nil, false
		}
		for _, id := range *field.dest {
			if strings.TrimSpace(id) == "" {
				writeContractInvalid(w, "eventsAck", "body", []httpx.Issue{{Path: field.name, Message: "String must contain at least 1 character(s)"}})
				return nil, nil, nil, false
			}
		}
	}
	if seqs == nil {
		seqs = []int64{}
	}
	if messageIDs == nil {
		messageIDs = []string{}
	}
	if thirdPartyIDs == nil {
		thirdPartyIDs = []string{}
	}
	return seqs, messageIDs, thirdPartyIDs, true
}
