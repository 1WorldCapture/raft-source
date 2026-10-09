package humanapi_test

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"raft.local/server-go/internal/application/onboarding"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/delivery"
	"raft.local/server-go/internal/workspace"
	"raft.local/server-go/tests/testkit"
)

// Real app composition: claim and legacy drain project inside the delivery
// write transaction. A projection failure must not acknowledge the input.
func TestM5ProjectionAtomicityFailureReissuesAndRendersNotice(t *testing.T) {
	h := newAgentChatHarness(t)
	agentID, key := h.external("projatomic")
	allID := h.channelID("all")
	h.prepareBriefing(agentID)

	beforeMessages := h.count(`SELECT COUNT(*) FROM messages`)
	beforeUnread := h.human(http.MethodGet, "/api/channels/unread", nil)
	if beforeUnread.Status != http.StatusOK {
		t.Fatalf("unread: %d %s", beforeUnread.Status, beforeUnread.Raw)
	}

	noticeOnly := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=10", nil, testkit.Bearer(key))
	if noticeOnly.Status != http.StatusOK {
		t.Fatalf("notice claim: %d %s", noticeOnly.Status, noticeOnly.Raw)
	}
	noticeEvents := eventMaps(t, noticeOnly.Body)
	if len(noticeEvents) != 1 {
		t.Fatalf("notice-only batch: %s", noticeOnly.Raw)
	}
	notice := noticeEvents[0]
	if notice["sender_type"] != "system" || !strings.Contains(stringField(notice["content"]), "Private onboarding handoff") {
		t.Fatalf("briefing body was not rendered: %s", noticeOnly.Raw)
	}
	noticeID := stringField(notice["message_id"])
	if noticeID == "" || stringField(notice["id"]) != noticeID {
		t.Fatalf("notice id: %s", noticeOnly.Raw)
	}
	if _, ok := notice["seq"]; ok {
		t.Fatalf("seq 0 notice must not carry a positive seq: %s", noticeOnly.Raw)
	}
	ack := ackMap(t, noticeOnly.Body)
	if len(numberList(ack["seqs"])) != 0 || !containsString(stringList(ack["message_ids"]), noticeID) {
		t.Fatalf("notice receipt: %s", noticeOnly.Raw)
	}
	for _, seq := range numberList(ack["seqs"]) {
		if seq == 0 {
			t.Fatal("notice ack listed seq 0")
		}
	}
	if h.count(`SELECT COUNT(*) FROM messages WHERE id = ? OR content LIKE '%Private onboarding handoff%'`, noticeID) != 0 {
		t.Fatal("briefing became a public messages row")
	}
	if h.count(`SELECT COUNT(*) FROM messages`) != beforeMessages {
		t.Fatal("notice claim inserted a chat row")
	}
	afterUnread := h.human(http.MethodGet, "/api/channels/unread", nil)
	if afterUnread.Status != http.StatusOK || string(afterUnread.Raw) != string(beforeUnread.Raw) {
		t.Fatalf("notice claim changed unread: before %s after %s", beforeUnread.Raw, afterUnread.Raw)
	}
	history := h.human(http.MethodGet, "/api/messages/channel/"+allID, nil)
	if history.Status != http.StatusOK || strings.Contains(string(history.Raw), "Private onboarding handoff") {
		t.Fatalf("human history exposed the briefing: %d %s", history.Status, history.Raw)
	}
	noticeAck := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(key))
	if noticeAck.Status != http.StatusOK || noticeAck.Body["removed_count"] != float64(1) {
		t.Fatalf("notice ack: %d %s", noticeAck.Status, noticeAck.Raw)
	}
	if h.count(`SELECT COUNT(*) FROM messages WHERE content LIKE '%Private onboarding handoff%'`) != 0 {
		t.Fatal("notice acknowledgement created a public messages row")
	}

	sent := h.human(http.MethodPost, "/api/messages", map[string]any{
		"channelId": allID, "content": "Projection must survive a failed drain.", "randomId": "proj-atomic-message",
		"mentions": []map[string]any{{"type": "agent", "id": agentID, "name": "projatomic"}},
	})
	if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
		t.Fatalf("send: %d %s", sent.Status, sent.Raw)
	}
	var messageID string
	var messageSeq int64
	var messageChannel string
	if err := h.e.App.DB.QueryRow(
		`SELECT id, seq, channel_id FROM messages WHERE channel_id = ? AND content = ?`,
		allID, "Projection must survive a failed drain.").Scan(&messageID, &messageSeq, &messageChannel); err != nil {
		t.Fatal(err)
	}
	messagesBeforeClaim := h.count(`SELECT COUNT(*) FROM messages`)

	mixed := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=10", nil, testkit.Bearer(key))
	if mixed.Status != http.StatusOK {
		t.Fatalf("message claim: %d %s", mixed.Status, mixed.Raw)
	}
	mixedEvents := eventMaps(t, mixed.Body)
	if len(mixedEvents) != 1 || stringField(mixedEvents[0]["message_id"]) != messageID || mixedEvents[0]["content"] != "Projection must survive a failed drain." || numberField(mixedEvents[0]["seq"]) != float64(messageSeq) {
		t.Fatalf("message projection: %s", mixed.Raw)
	}
	mixedAck := ackMap(t, mixed.Body)
	if !containsNumber(numberList(mixedAck["seqs"]), messageSeq) || len(stringList(mixedAck["message_ids"])) != 0 {
		t.Fatalf("positive seq must ack by seq only: %s", mixed.Raw)
	}
	if h.count(`SELECT COUNT(*) FROM messages`) != messagesBeforeClaim {
		t.Fatal("claim inserted a messages row")
	}

	var claimID string
	var ackedAt sql.NullInt64
	if err := h.e.App.DB.QueryRow(
		`SELECT id, acked_at FROM agent_delivery_claims WHERE agent_id = ? AND acked_at IS NULL`, agentID).Scan(&claimID, &ackedAt); err != nil {
		t.Fatal(err)
	}
	if ackedAt.Valid || claimID == "" {
		t.Fatal("claim was acknowledged before the caller asked")
	}

	var otherChannel string
	if err := h.e.App.DB.QueryRow(
		`SELECT id FROM channels WHERE workspace_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`,
		h.workspace, messageChannel).Scan(&otherChannel); err != nil {
		t.Fatal(err)
	}
	if _, err := h.e.App.DB.Exec(`UPDATE messages SET channel_id = ? WHERE id = ?`, otherChannel, messageID); err != nil {
		t.Fatal(err)
	}
	failed := h.e.Serve(http.MethodGet, "/internal/agent-api/events?limit=10", nil, testkit.Bearer(key))
	if failed.Status != http.StatusInternalServerError {
		t.Fatalf("unreadable projection returned %d %s", failed.Status, failed.Raw)
	}
	var state string
	var acknowledged sql.NullInt64
	if err := h.e.App.DB.QueryRow(
		`SELECT scheduling_state, acknowledged_at FROM agent_deliveries WHERE message_id = ? AND agent_id = ?`,
		messageID, agentID).Scan(&state, &acknowledged); err != nil {
		t.Fatal(err)
	}
	if state != "leased" || acknowledged.Valid {
		t.Fatalf("failed drain consumed the message: state=%s acked=%v", state, acknowledged.Valid)
	}
	var attemptState string
	var terminal sql.NullString
	if err := h.e.App.DB.QueryRow(
		`SELECT state, terminal_code FROM agent_delivery_attempts WHERE delivery_id = (
			SELECT id FROM agent_deliveries WHERE message_id = ? AND agent_id = ?)
		 ORDER BY attempt_number DESC LIMIT 1`, messageID, agentID).Scan(&attemptState, &terminal); err != nil {
		t.Fatal(err)
	}
	if attemptState != "in_flight" || (terminal.Valid && terminal.String == "ACKED") {
		t.Fatalf("attempt after failed drain: %s %v", attemptState, terminal)
	}
	if err := h.e.App.DB.QueryRow(`SELECT scheduling_state FROM agent_deliveries WHERE id = ?`, noticeID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "acknowledged" {
		t.Fatalf("failed drain rewrote the already acknowledged notice: %s", state)
	}
	if _, err := h.e.App.DB.Exec(`UPDATE messages SET channel_id = ? WHERE id = ?`, messageChannel, messageID); err != nil {
		t.Fatal(err)
	}

	reissued := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=10", nil, testkit.Bearer(key))
	if reissued.Status != http.StatusOK || !strings.Contains(string(reissued.Raw), "Projection must survive a failed drain.") {
		t.Fatalf("stable reissue: %d %s", reissued.Status, reissued.Raw)
	}
	var reissueID string
	if err := h.e.App.DB.QueryRow(
		`SELECT id FROM agent_delivery_claims WHERE agent_id = ? AND acked_at IS NULL`, agentID).Scan(&reissueID); err != nil {
		t.Fatal(err)
	}
	if reissueID != claimID {
		t.Fatalf("reissue minted a new claim: %s vs %s", reissueID, claimID)
	}
	if err := h.e.App.DB.QueryRow(
		`SELECT scheduling_state, acknowledged_at FROM agent_deliveries WHERE message_id = ? AND agent_id = ?`,
		messageID, agentID).Scan(&state, &acknowledged); err != nil {
		t.Fatal(err)
	}
	if state != "leased" || acknowledged.Valid {
		t.Fatalf("reissue acknowledged the message: %s %v", state, acknowledged)
	}
}

func TestM5ProjectionAtomicityHasMoreAndSince(t *testing.T) {
	h := newAgentChatHarness(t)
	agentID, key := h.external("projpage")
	allID := h.channelID("all")
	contents := []string{"page-one", "page-two", "page-three"}
	seqs := make([]int64, 0, len(contents))
	for i, content := range contents {
		sent := h.human(http.MethodPost, "/api/messages", map[string]any{
			"channelId": allID, "content": content, "randomId": content,
			"mentions": []map[string]any{{"type": "agent", "id": agentID, "name": "projpage"}},
		})
		if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
			t.Fatalf("send %d: %d %s", i, sent.Status, sent.Raw)
		}
		var seq int64
		if err := h.e.App.DB.QueryRow(`SELECT seq FROM messages WHERE channel_id = ? AND content = ?`, allID, content).Scan(&seq); err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, seq)
	}

	exact := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=2", nil, testkit.Bearer(key))
	if exact.Status != http.StatusOK || exact.Body["has_more"] != true {
		t.Fatalf("two of three must report has_more: %d %s", exact.Status, exact.Raw)
	}
	exactEvents := eventMaps(t, exact.Body)
	if len(exactEvents) != 2 || numberField(exactEvents[0]["seq"]) != float64(seqs[0]) || numberField(exactEvents[1]["seq"]) != float64(seqs[1]) {
		t.Fatalf("page = %s", exact.Raw)
	}
	var thirdState string
	if err := h.e.App.DB.QueryRow(
		`SELECT d.scheduling_state FROM agent_deliveries d JOIN messages m ON m.id = d.message_id WHERE m.content = ? AND d.agent_id = ?`,
		"page-three", agentID).Scan(&thirdState); err != nil {
		t.Fatal(err)
	}
	if thirdState != "pending" {
		t.Fatalf("omitted row was leased or acknowledged: %s", thirdState)
	}

	pageAck := ackMap(t, exact.Body)
	confirmed := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", pageAck, testkit.Bearer(key))
	if confirmed.Status != http.StatusOK || confirmed.Body["removed_count"] != float64(2) {
		t.Fatalf("page ack: %d %s", confirmed.Status, confirmed.Raw)
	}
	if err := h.e.App.DB.QueryRow(
		`SELECT d.scheduling_state FROM agent_deliveries d JOIN messages m ON m.id = d.message_id WHERE m.content = ? AND d.agent_id = ?`,
		"page-three", agentID).Scan(&thirdState); err != nil {
		t.Fatal(err)
	}
	if thirdState != "pending" {
		t.Fatal("acking the page confirmed the omitted row")
	}
	finalPage := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=2", nil, testkit.Bearer(key))
	if finalPage.Status != http.StatusOK || finalPage.Body["has_more"] != false {
		t.Fatalf("exact final page: %d %s", finalPage.Status, finalPage.Raw)
	}
	finalEvents := eventMaps(t, finalPage.Body)
	if len(finalEvents) != 1 || numberField(finalEvents[0]["seq"]) != float64(seqs[2]) {
		t.Fatalf("final page = %s", finalPage.Raw)
	}

	h2 := newAgentChatHarness(t)
	agent2, key2 := h2.external("projsince")
	all2 := h2.channelID("all")
	h2.prepareBriefing(agent2)
	for _, content := range []string{"older-unseen", "newer-visible"} {
		sent := h2.human(http.MethodPost, "/api/messages", map[string]any{
			"channelId": all2, "content": content, "randomId": content,
			"mentions": []map[string]any{{"type": "agent", "id": agent2, "name": "projsince"}},
		})
		if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
			t.Fatalf("send %s: %d %s", content, sent.Status, sent.Raw)
		}
	}
	var olderSeq, newerSeq int64
	if err := h2.e.App.DB.QueryRow(`SELECT seq FROM messages WHERE content = ?`, "older-unseen").Scan(&olderSeq); err != nil {
		t.Fatal(err)
	}
	if err := h2.e.App.DB.QueryRow(`SELECT seq FROM messages WHERE content = ?`, "newer-visible").Scan(&newerSeq); err != nil {
		t.Fatal(err)
	}
	filtered := h2.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=10&since="+itoa(olderSeq), nil, testkit.Bearer(key2))
	if filtered.Status != http.StatusOK {
		t.Fatalf("since claim: %d %s", filtered.Status, filtered.Raw)
	}
	filteredRaw := string(filtered.Raw)
	if strings.Contains(filteredRaw, "older-unseen") || strings.Contains(filteredRaw, "Private onboarding handoff") || !strings.Contains(filteredRaw, "newer-visible") {
		t.Fatalf("since filtered the wrong rows: %s", filtered.Raw)
	}
	filteredAck := ackMap(t, filtered.Body)
	if containsNumber(numberList(filteredAck["seqs"]), olderSeq) || len(stringList(filteredAck["message_ids"])) != 0 || !containsNumber(numberList(filteredAck["seqs"]), newerSeq) {
		t.Fatalf("since receipt: %s", filtered.Raw)
	}
	var olderState, noticeState string
	if err := h2.e.App.DB.QueryRow(
		`SELECT d.scheduling_state FROM agent_deliveries d JOIN messages m ON m.id = d.message_id WHERE m.content = 'older-unseen' AND d.agent_id = ?`,
		agent2).Scan(&olderState); err != nil {
		t.Fatal(err)
	}
	if err := h2.e.App.DB.QueryRow(
		`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ? AND source_kind = 'briefing'`, agent2).Scan(&noticeState); err != nil {
		t.Fatal(err)
	}
	if olderState != "pending" || noticeState != "pending" {
		t.Fatalf("since consumed unseen rows: message=%s notice=%s", olderState, noticeState)
	}
	acked := h2.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", filteredAck, testkit.Bearer(key2))
	if acked.Status != http.StatusOK || acked.Body["removed_count"] != float64(1) {
		t.Fatalf("since ack: %d %s", acked.Status, acked.Raw)
	}
	restored := h2.e.Serve(http.MethodGet, "/internal/agent-api/events/claim?limit=10", nil, testkit.Bearer(key2))
	if restored.Status != http.StatusOK || !strings.Contains(string(restored.Raw), "older-unseen") || !strings.Contains(string(restored.Raw), "Private onboarding handoff") || strings.Contains(string(restored.Raw), "newer-visible") {
		t.Fatalf("since lost older input: %d %s", restored.Status, restored.Raw)
	}
	restoredAck := ackMap(t, restored.Body)
	if !containsNumber(numberList(restoredAck["seqs"]), olderSeq) || containsNumber(numberList(restoredAck["seqs"]), 0) || len(stringList(restoredAck["message_ids"])) != 1 {
		t.Fatalf("restored mixed receipt: %s", restored.Raw)
	}
	if h2.count(`SELECT COUNT(*) FROM messages WHERE content LIKE '%Private onboarding handoff%'`) != 0 {
		t.Fatal("restored notice became a messages row")
	}
}

func (h *agentChatHarness) prepareBriefing(agentID string) {
	h.t.Helper()
	handoff := h.human(http.MethodPost, "/api/servers/"+h.workspace+"/setup-handoff", nil)
	if handoff.Status != http.StatusOK {
		h.t.Fatalf("handoff: %d %s", handoff.Status, handoff.Raw)
	}
	if _, err := h.e.App.DB.Exec(`UPDATE workspaces SET onboarding_agent_id = ? WHERE id = ?`, agentID, h.workspace); err != nil {
		h.t.Fatal(err)
	}
	briefings, err := onboarding.NewService(workspace.NewStore(h.e.App.DB), channel.NewStore(h.e.App.DB), delivery.NewStore(h.e.App.DB))
	if err != nil {
		h.t.Fatal(err)
	}
	if err := briefings.Reconcile(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	var id string
	if err := h.e.App.DB.QueryRow(
		`SELECT id FROM agent_deliveries WHERE workspace_id = ? AND agent_id = ? AND source_kind = 'briefing'`,
		h.workspace, agentID).Scan(&id); err != nil {
		h.t.Fatalf("briefing was not planned: %v", err)
	}
}

func eventMaps(t *testing.T, body map[string]any) []map[string]any {
	t.Helper()
	raw, ok := body["events"].([]any)
	if !ok {
		t.Fatalf("events missing: %#v", body["events"])
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		row, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("event: %#v", item)
		}
		out = append(out, row)
	}
	return out
}

func ackMap(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	ack, ok := body["ack"].(map[string]any)
	if !ok {
		t.Fatalf("ack missing: %s", mustJSON(body))
	}
	return ack
}

func stringField(v any) string {
	s, _ := v.(string)
	return s
}

func numberField(v any) float64 {
	n, _ := v.(float64)
	return n
}

func numberList(v any) []int64 {
	raw, _ := v.([]any)
	out := make([]int64, 0, len(raw))
	for _, item := range raw {
		n, ok := item.(float64)
		if ok {
			out = append(out, int64(n))
		}
	}
	return out
}

func stringList(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func containsNumber(values []int64, want int64) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func itoa(v int64) string {
	return strconv.FormatInt(v, 10)
}
