// GET /internal/agent-api/history: the read surface `raft message read`
// consumes (channel ref + before/after/around anchors + limit). The anchor
// shapes are validated here (decimal seq / 8-hex short id / full UUID) and
// the authorized window itself comes from the history port. Read-only: this
// path never advances a delivery ACK and never fabricates cursors.
package agentapi

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/transport/presenter"
)

const (
	historyDefaultLimit = 50
	historyMaxLimit     = 100
)

var (
	historySeqAnchor   = regexp.MustCompile(`^[0-9]+$`)
	historyShortAnchor = regexp.MustCompile(`^[0-9a-fA-F]{8}$`)
	historyUUIDAnchor  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// isHistoryAnchorShape mirrors isHistoryAnchorShape: pure decimal, 8-hex
// short id or full UUID.
func isHistoryAnchorShape(value string) bool {
	return historySeqAnchor.MatchString(value) || historyShortAnchor.MatchString(value) || historyUUIDAnchor.MatchString(value)
}

// History handles GET /internal/agent-api/history.
func (h *Handlers) History(w http.ResponseWriter, r *http.Request) {
	lookup, _, _, ok := h.bindAgentCredential(w, r)
	if !ok {
		return
	}
	if !h.requireAgentCapability(w, r, lookup.Scopes, "read") {
		return
	}
	q := r.URL.Query()
	channelRef := strings.TrimSpace(q.Get("channel"))
	if channelRef == "" {
		writeContractInvalid(w, "historyRead", "query", []httpx.Issue{{Path: "channel", Message: "Required"}})
		return
	}
	// Number(limit) || 50 with a 100 cap; NaN and 0 fall back to the default.
	// Like the events batch, the lower bound clamps to 1 instead of
	// reproducing the original's negative-limit passthrough.
	limit := int64(boundedQueryLimit(q.Get("limit"), historyDefaultLimit, historyMaxLimit))
	query := AgentHistoryQuery{ChannelRef: channelRef, Limit: limit}
	for _, anchor := range []struct {
		param string
		dest  *string
	}{{"before", &query.Before}, {"after", &query.After}, {"around", &query.Around}} {
		raw := strings.TrimSpace(q.Get(anchor.param))
		if raw == "" {
			continue
		}
		if !isHistoryAnchorShape(raw) {
			writeHistoryAnchorError(w, HistoryAnchorInvalid, channelRef, raw)
			return
		}
		*anchor.dest = raw
	}

	facts, err := h.history.ReadAgentHistory(r.Context(), *lookup, query)
	if err != nil {
		h.writeHistoryError(w, channelRef, err)
		return
	}
	if facts == nil {
		facts = &presenter.AgentHistoryFacts{}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, client.AgentHistoryResponse{
		Messages:    presenter.AgentMessageWireList(facts.Messages),
		HasMore:     facts.HasOlder || facts.HasNewer,
		HasOlder:    facts.HasOlder,
		HasNewer:    facts.HasNewer,
		LastReadSeq: facts.LastReadSeq,
	})
}

// writeHistoryAnchorError renders the frozen anchor bodies. Note the key is
// errorCode (not code) — the CLI's mapReadFailure branches on it.
func writeHistoryAnchorError(w http.ResponseWriter, reason, channelRef, anchor string) {
	switch reason {
	case HistoryAnchorInvalid:
		httpx.WriteJSON(w, http.StatusBadRequest, httpx.ErrorBody{
			"error":     "Message anchor must be a seq, full UUID, or 8-character short id in " + channelRef + ": " + anchor,
			"errorCode": "INVALID_ARG",
		})
	case HistoryAnchorAmbiguous:
		httpx.WriteJSON(w, http.StatusBadRequest, httpx.ErrorBody{
			"error":               "Message anchor is ambiguous in " + channelRef + ": " + anchor,
			"errorCode":           "AMBIGUOUS_ID",
			"suggestedNextAction": "Use the full message UUID instead of the 8-character short id.",
		})
	default:
		httpx.WriteJSON(w, http.StatusNotFound, httpx.ErrorBody{
			"error":     "Message not found in " + channelRef + ": " + anchor,
			"errorCode": "NOT_FOUND",
		})
	}
}

// writeHistoryError maps the history port failures: the neutral hidden-
// channel 404 (anti-oracle), the 403 access denial, anchor resolutions and
// the typed not-found sentences (thread-without-replies and friends).
func (h *Handlers) writeHistoryError(w http.ResponseWriter, channelRef string, err error) {
	var anchor *HistoryAnchorError
	var notFound *HistoryNotFoundError
	switch {
	case errors.As(err, &anchor):
		writeHistoryAnchorError(w, anchor.Reason, anchor.ChannelRef, anchor.Anchor)
	case errors.Is(err, HistoryChannelHiddenError):
		httpx.WriteError(w, http.StatusNotFound, "Channel not found or not visible")
	case errors.Is(err, HistoryForbiddenError):
		httpx.WriteError(w, http.StatusForbidden, "You do not have access to this history")
	case errors.As(err, &notFound):
		body := httpx.ErrorBody{"error": notFound.Message, "errorCode": notFound.Code}
		if notFound.SuggestedNextAction != "" {
			body["suggestedNextAction"] = notFound.SuggestedNextAction
		}
		httpx.WriteJSON(w, http.StatusNotFound, body)
	default:
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to read history")
	}
}
