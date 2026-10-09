package humanapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/tests/testkit"
)

// These are composition tests, not domain doubles: real registered accounts,
// one app mux, Agent credentials and the same SQLite transaction as the Web
// send path. UI rendering is deliberately left to the UI collaborator.
type agentChatHarness struct {
	t                   *testing.T
	e                   *testkit.TestEnv
	workspace           string
	ownerID, ownerToken string
	otherID, otherToken string
}

func newAgentChatHarness(t *testing.T) *agentChatHarness {
	t.Helper()
	e := testkit.NewTestEnv(t)
	ownerID, owner, _ := e.FullAccount("m5-chat-owner@example.test", "m5chatowner")
	otherID, other, _ := e.FullAccount("m5-chat-other@example.test", "m5chatother")
	ws := e.CreateServer(t, owner, "M5 Agent chat", "m5-agent-chat")
	e.AddMember(t, ws, otherID, "member")
	return &agentChatHarness{t: t, e: e, workspace: ws, ownerID: ownerID, ownerToken: owner, otherID: otherID, otherToken: other}
}

func (h *agentChatHarness) human(method, path string, body any) testkit.Response {
	h.t.Helper()
	return h.e.Serve(method, path, body, testkit.Scoped(h.ownerToken, h.workspace))
}

func (h *agentChatHarness) external(name string) (id, key string) {
	h.t.Helper()
	created := h.human(http.MethodPost, "/api/agents", map[string]any{"name": name, "external": true})
	if created.Status != http.StatusOK {
		h.t.Fatalf("create external Agent: %d %s", created.Status, created.Raw)
	}
	id, _ = created.Body["id"].(string)
	minted := h.e.Serve(http.MethodPost, "/api/agents/"+id+"/credentials", map[string]any{}, testkit.Bearer(h.ownerToken))
	if minted.Status != http.StatusCreated {
		h.t.Fatalf("mint Agent credential: %d %s", minted.Status, minted.Raw)
	}
	key, _ = minted.Body["apiKey"].(string)
	if id == "" || !strings.HasPrefix(key, "sk_agent_") {
		h.t.Fatal("missing actual Agent identity or credential")
	}
	return id, key
}

func (h *agentChatHarness) channelID(name string) string {
	h.t.Helper()
	listed := h.human(http.MethodGet, "/api/channels", nil)
	if listed.Status != http.StatusOK {
		h.t.Fatalf("list channels: %d %s", listed.Status, listed.Raw)
	}
	var channels []struct{ ID, Name string }
	if err := json.Unmarshal(listed.Raw, &channels); err != nil {
		h.t.Fatal(err)
	}
	for _, channel := range channels {
		if channel.Name == name {
			return channel.ID
		}
	}
	h.t.Fatalf("missing channel %s", name)
	return ""
}

func (h *agentChatHarness) count(query string, args ...any) int {
	h.t.Helper()
	var count int
	if err := h.e.App.DB.QueryRow(query, args...).Scan(&count); err != nil {
		h.t.Fatal(err)
	}
	return count
}

func TestAgentDMHTTPReplyReadstateAndClaimCompose(t *testing.T) {
	h := newAgentChatHarness(t)
	agentID, key := h.external("m5helper")
	opened := h.human(http.MethodPost, "/api/channels/dm", map[string]any{"agentId": agentID})
	if opened.Status != http.StatusOK || opened.Body["peerType"] != "agent" || opened.Body["peerId"] != agentID {
		t.Fatalf("canonical Agent DM DTO: %d %s", opened.Status, opened.Raw)
	}
	dmID, _ := opened.Body["id"].(string)
	if dmID == "" {
		t.Fatal("Agent DM has no channel ID")
	}
	again := h.human(http.MethodPost, "/api/channels/dm", map[string]any{"agentId": agentID})
	if again.Status != http.StatusOK || again.Body["id"] != dmID {
		t.Fatalf("Agent DM must be unique: %d %s", again.Status, again.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM direct_messages WHERE channel_id = ?`, dmID); got != 0 {
		t.Fatal("Agent identity was inserted into the human-only canonical pair table")
	}
	list := h.human(http.MethodGet, "/api/channels/dm", nil)
	if list.Status != http.StatusOK || !strings.Contains(string(list.Raw), dmID) || !strings.Contains(string(list.Raw), `"peerType":"agent"`) {
		t.Fatalf("Agent DM must round-trip through the normal DM list: %d %s", list.Status, list.Raw)
	}

	sent := h.human(http.MethodPost, "/api/messages", map[string]any{"channelId": dmID, "content": "Please reply in this DM.", "randomId": "human-dm-request"})
	if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
		t.Fatalf("human DM send: %d %s", sent.Status, sent.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE workspace_id = ? AND agent_id = ?`, h.workspace, agentID); got != 1 {
		t.Fatalf("a direct message needs exactly one durable Agent recipient, got %d", got)
	}

	claim := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim", nil, testkit.Bearer(key))
	if claim.Status != http.StatusOK || !strings.Contains(string(claim.Raw), "Please reply in this DM.") {
		t.Fatalf("Agent can claim its real DM input: %d %s", claim.Status, claim.Raw)
	}
	ack, ok := claim.Body["ack"].(map[string]any)
	if !ok || ack["seqs"] == nil || ack["message_ids"] == nil || ack["third_party_event_ids"] == nil {
		t.Fatalf("original CLI expects the three-array claim ACK body: %s", claim.Raw)
	}
	confirmed := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(key))
	if confirmed.Status != http.StatusOK || confirmed.Body["ok"] != true || confirmed.Body["removed_count"] != float64(1) {
		t.Fatalf("claim ACK: %d %s", confirmed.Status, confirmed.Raw)
	}
	reack := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(key))
	if reack.Status != http.StatusOK || reack.Body["removed_count"] != float64(0) {
		t.Fatalf("claim ACK replay must be a no-op: %d %s", reack.Status, reack.Raw)
	}

	body := map[string]any{"target": "dm:@m5chatowner", "content": "Agent response visible to its human peer.", "idempotencyKey": strings.Repeat("k", 256)}
	for attempt := 0; attempt < 2; attempt++ {
		reply := h.e.Serve(http.MethodPost, "/internal/agent-api/v2/send", body, testkit.Bearer(key))
		if reply.Status != http.StatusOK || reply.Body["state"] != "sent" {
			t.Fatalf("original Agent send contract attempt %d: %d %s", attempt, reply.Status, reply.Raw)
		}
	}
	if got := h.count(`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND sender_type = 'agent' AND sender_id = ?`, dmID, agentID); got != 1 {
		t.Fatalf("Agent sender identity/idempotency: got %d reply rows", got)
	}
	history := h.human(http.MethodGet, "/api/messages/channel/"+url.PathEscape(dmID), nil)
	if history.Status != http.StatusOK || !strings.Contains(string(history.Raw), "Agent response visible to its human peer.") || !strings.Contains(string(history.Raw), `"senderType":"agent"`) {
		t.Fatalf("Web history must expose the actual Agent reply: %d %s", history.Status, history.Raw)
	}
	unread := h.human(http.MethodGet, "/api/channels/unread", nil)
	if unread.Status != http.StatusOK || unread.Body[dmID] != float64(1) {
		t.Fatalf("Agent DM reply increments the human's unread exactly once: %d %s", unread.Status, unread.Raw)
	}
	inbox := h.human(http.MethodGet, "/api/channels/inbox?filter=all", nil)
	if inbox.Status != http.StatusOK || !strings.Contains(string(inbox.Raw), dmID) {
		t.Fatalf("Agent DM belongs in the human Inbox: %d %s", inbox.Status, inbox.Raw)
	}
	read := h.human(http.MethodPost, "/api/channels/"+dmID+"/read-all", map[string]any{})
	if read.Status != http.StatusOK {
		t.Fatalf("Agent DM read frontier must be supported: %d %s", read.Status, read.Raw)
	}
	after := h.human(http.MethodGet, "/api/channels/unread", nil)
	if after.Status != http.StatusOK || (after.Body[dmID] != nil && after.Body[dmID] != float64(0)) {
		t.Fatalf("Agent DM read clears only the human unread: %d %s", after.Status, after.Raw)
	}

	strangerHistory := h.e.Serve(http.MethodGet, "/api/messages/channel/"+url.PathEscape(dmID), nil, testkit.Scoped(h.otherToken, h.workspace))
	if strangerHistory.Status != http.StatusNotFound && strangerHistory.Status != http.StatusForbidden {
		t.Fatalf("same-workspace third human must not read Agent DM: %d %s", strangerHistory.Status, strangerHistory.Raw)
	}
	strangerUnread := h.e.Serve(http.MethodGet, "/api/channels/unread", nil, testkit.Scoped(h.otherToken, h.workspace))
	if strangerUnread.Status != http.StatusOK || strangerUnread.Body[dmID] != nil {
		t.Fatalf("Agent DM must not leak via another human's unread map: %d %s", strangerUnread.Status, strangerUnread.Raw)
	}
}

func TestAgentMentionsHTTPAtomicRecipientsAndReplay(t *testing.T) {
	h := newAgentChatHarness(t)
	firstID, _ := h.external("m5first")
	secondID, _ := h.external("m5second")
	channelID := h.channelID("all")
	mention := func(id, name string) map[string]any { return map[string]any{"type": "agent", "id": id, "name": name} }
	body := map[string]any{
		"channelId": channelID, "content": "@m5first @m5second please review.", "randomId": "two-agent-mentions",
		"mentions": []any{mention(firstID, "m5first"), mention(secondID, "m5second"), mention(firstID, "m5first")},
	}
	for i := 0; i < 2; i++ {
		res := h.human(http.MethodPost, "/api/messages", body)
		if res.Status != http.StatusOK && res.Status != http.StatusCreated {
			t.Fatalf("two legal Agent mentions attempt %d: %d %s", i, res.Status, res.Raw)
		}
	}
	if got := h.count(`SELECT COUNT(*) FROM messages WHERE random_id = ?`, "two-agent-mentions"); got != 1 {
		t.Fatalf("message replay created %d messages", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE workspace_id = ?`, h.workspace); got != 2 {
		t.Fatalf("deduplicated recipients require 2 logical deliveries, got %d", got)
	}

	// Fault the mandatory recipient write AFTER message insertion. A successful
	// message with a missing durable recipient is forbidden even under a DB error.
	if err := platformdb.WithWriteTx(context.Background(), h.e.App.DB, func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TRIGGER fail_delivery_for_atomic_test BEFORE INSERT ON agent_deliveries BEGIN SELECT RAISE(ABORT, 'test mandatory recipient write failed'); END`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	failed := h.human(http.MethodPost, "/api/messages", map[string]any{
		"channelId": channelID, "content": "@m5first must roll back", "randomId": "atomic-recipient-fault",
		"mentions": []any{mention(firstID, "m5first")},
	})
	if failed.Status < 500 {
		t.Fatalf("mandatory delivery storage failure cannot succeed: %d %s", failed.Status, failed.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM messages WHERE random_id = ?`, "atomic-recipient-fault"); got != 0 {
		t.Fatal("message committed without its required durable Agent recipient")
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE workspace_id = ?`, h.workspace); got != 2 {
		t.Fatalf("fault left a phantom or deleted recipient: count=%d", got)
	}
}
