package humanapi_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"raft.local/server-go/tests/testkit"
)

func openAgentDMForSecurityTest(t *testing.T, h *agentChatHarness, agentID string) string {
	t.Helper()
	opened := h.human(http.MethodPost, "/api/channels/dm", map[string]any{"agentId": agentID})
	if opened.Status != http.StatusOK {
		t.Fatalf("open real Agent DM: %d %s", opened.Status, opened.Raw)
	}
	id, _ := opened.Body["id"].(string)
	if id == "" {
		t.Fatal("Agent DM response omitted its channel ID")
	}
	return id
}

func TestAgentDMHTTPForeignPrincipalCannotReadReplyOrAcknowledge(t *testing.T) {
	h := newAgentChatHarness(t)
	recipientID, recipientKey := h.external("privatehelper")
	_, outsiderKey := h.external("otherhelper")
	dmID := openAgentDMForSecurityTest(t, h, recipientID)
	sent := h.human(http.MethodPost, "/api/messages", map[string]any{
		"channelId": dmID, "content": "Private input only for the selected Agent.", "randomId": "private-agent-input",
	})
	if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
		t.Fatalf("send private input: %d %s", sent.Status, sent.Raw)
	}
	for _, path := range []string{"/internal/agent-api/events", "/internal/agent-api/events/claim"} {
		probe := h.e.Serve(http.MethodHead, path, nil, testkit.Bearer(recipientKey))
		if probe.Status != http.StatusMethodNotAllowed {
			t.Fatalf("HEAD must not silently consume or lease an input: %d %s", probe.Status, probe.Raw)
		}
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_delivery_claims WHERE workspace_id = ?`, h.workspace); got != 0 {
		t.Fatalf("bodyless probes created %d claims", got)
	}
	// Original Agent API targets are #name / dm:@peer / their thread suffixes,
	// not raw channelId references. The SAME peer ref must resolve relative to
	// the authenticated Agent; another Agent can legitimately open a DIFFERENT
	// DM with the same human, but cannot read or write this recipient's pair.
	peerRef := "dm:@m5chatowner"
	historyPath := "/internal/agent-api/history?channel=" + url.QueryEscape(peerRef)
	ownHistory := h.e.Serve(http.MethodGet, historyPath, nil, testkit.Bearer(recipientKey))
	if ownHistory.Status != http.StatusOK || !strings.Contains(string(ownHistory.Raw), "Private input only") {
		t.Fatalf("positive control: the real peer ref reads the recipient's input: %d %s", ownHistory.Status, ownHistory.Raw)
	}
	denied := h.e.Serve(http.MethodGet, historyPath, nil, testkit.Bearer(outsiderKey))
	if denied.Status != http.StatusForbidden && denied.Status != http.StatusNotFound {
		t.Fatalf("foreign Agent must not resolve the recipient's existing DM: %d %s", denied.Status, denied.Raw)
	}
	if strings.Contains(string(denied.Raw), "Private input only") {
		t.Fatal("denial leaked private message content")
	}
	separate := h.e.Serve(http.MethodPost, "/internal/agent-api/resolve-channel", map[string]any{"target": peerRef}, testkit.Bearer(outsiderKey))
	if separate.Status != http.StatusOK || separate.Body["channelId"] == dmID || separate.Body["channelId"] == "" || separate.Body["channelId"] == nil {
		t.Fatalf("peer ref must create a distinct canonical pair for another Agent: %d %s", separate.Status, separate.Raw)
	}
	separateReply := h.e.Serve(http.MethodPost, "/internal/agent-api/v2/send", map[string]any{
		"target": peerRef, "content": "Reply in the other Agent's separate DM.", "idempotencyKey": "separate-agent-reply",
	}, testkit.Bearer(outsiderKey))
	if separateReply.Status != http.StatusOK || separateReply.Body["channelId"] == dmID {
		t.Fatalf("another Agent's reply must stay in its own pair: %d %s", separateReply.Status, separateReply.Raw)
	}
	otherHistory := h.e.Serve(http.MethodGet, historyPath, nil, testkit.Bearer(outsiderKey))
	if otherHistory.Status != http.StatusOK || strings.Contains(string(otherHistory.Raw), "Private input only") || !strings.Contains(string(otherHistory.Raw), "separate DM.") {
		t.Fatalf("same peer name crossed Agent identity boundaries: %d %s", otherHistory.Status, otherHistory.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM messages WHERE channel_id = ?`, dmID); got != 1 {
		t.Fatalf("another Agent's send mutated the recipient's DM: %d messages", got)
	}
	claim := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim", nil, testkit.Bearer(recipientKey))
	if claim.Status != http.StatusOK || !strings.Contains(string(claim.Raw), "Private input only") {
		t.Fatalf("recipient claim: %d %s", claim.Status, claim.Raw)
	}
	ack, ok := claim.Body["ack"].(map[string]any)
	if !ok {
		t.Fatalf("missing original three-array ACK: %s", claim.Raw)
	}
	foreignAck := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(outsiderKey))
	if foreignAck.Status != http.StatusOK || foreignAck.Body["removed_count"] != float64(0) {
		t.Fatalf("copied foreign ACK must remove nothing: %d %s", foreignAck.Status, foreignAck.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE workspace_id = ? AND scheduling_state = 'acknowledged'`, h.workspace); got != 0 {
		t.Fatal("another Agent's copied ACK acknowledged the recipient's input")
	}
	var credentialID string
	if err := h.e.App.DB.QueryRow(`SELECT id FROM agent_credentials WHERE agent_id = ? AND revoked_at IS NULL`, recipientID).Scan(&credentialID); err != nil {
		t.Fatal(err)
	}
	revoked := h.human(http.MethodDelete, "/api/agents/"+recipientID+"/credentials/"+credentialID, nil)
	if revoked.Status < 200 || revoked.Status >= 300 {
		t.Fatalf("revoke actual Agent credential: %d %s", revoked.Status, revoked.Raw)
	}
	lateAck := h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(recipientKey))
	if lateAck.Status != http.StatusUnauthorized {
		t.Fatalf("revoked credential must not acknowledge its former claim: %d %s", lateAck.Status, lateAck.Raw)
	}
	if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE workspace_id = ? AND scheduling_state = 'acknowledged'`, h.workspace); got != 0 {
		t.Fatal("revoked credential changed a pending input to acknowledged")
	}
}

func TestAgentDMThreadHTTPInheritsOnlyCanonicalParticipants(t *testing.T) {
	h := newAgentChatHarness(t)
	recipientID, recipientKey := h.external("threadhelper")
	_, outsiderKey := h.external("threadoutsider")
	dmID := openAgentDMForSecurityTest(t, h, recipientID)
	sent := h.human(http.MethodPost, "/api/messages", map[string]any{
		"channelId": dmID, "content": "A private thread starts here.", "randomId": "agent-dm-thread-parent",
	})
	if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
		t.Fatalf("parent send: %d %s", sent.Status, sent.Raw)
	}
	var parentID string
	if err := h.e.App.DB.QueryRow(`SELECT id FROM messages WHERE channel_id = ? AND random_id = ?`, dmID, "agent-dm-thread-parent").Scan(&parentID); err != nil {
		t.Fatal(err)
	}
	opened := h.human(http.MethodPost, "/api/channels/"+dmID+"/threads", map[string]any{
		"parentMessageId": parentID, "content": "Please answer in this private thread.",
	})
	if opened.Status != http.StatusOK {
		t.Fatalf("open Agent DM thread: %d %s", opened.Status, opened.Raw)
	}
	threadID, _ := opened.Body["threadChannelId"].(string)
	if threadID == "" {
		t.Fatal("thread response omitted canonical threadChannelId")
	}
	threadRef := "dm:@m5chatowner:" + parentID[:8]
	reply := h.e.Serve(http.MethodPost, "/internal/agent-api/v2/send", map[string]any{
		"target": threadRef, "content": "Private Agent thread reply.", "idempotencyKey": "agent-thread-reply",
	}, testkit.Bearer(recipientKey))
	if reply.Status != http.StatusOK || reply.Body["state"] != "sent" {
		t.Fatalf("canonical Agent participant replies in its DM thread: %d %s", reply.Status, reply.Raw)
	}
	visible := h.human(http.MethodGet, "/api/messages/channel/"+url.PathEscape(threadID), nil)
	if visible.Status != http.StatusOK || !strings.Contains(string(visible.Raw), "Private Agent thread reply.") {
		t.Fatalf("human peer reads real thread reply: %d %s", visible.Status, visible.Raw)
	}
	for _, token := range []string{h.otherToken, outsiderKey} {
		var denied testkit.Response
		if token == h.otherToken {
			denied = h.e.Serve(http.MethodGet, "/api/messages/channel/"+url.PathEscape(threadID), nil, testkit.Scoped(token, h.workspace))
		} else {
			denied = h.e.Serve(http.MethodGet, "/internal/agent-api/history?channel="+url.QueryEscape(threadRef), nil, testkit.Bearer(token))
		}
		if denied.Status != http.StatusForbidden && denied.Status != http.StatusNotFound {
			t.Fatalf("non-participant reads canonical DM thread: %d %s", denied.Status, denied.Raw)
		}
		if strings.Contains(string(denied.Raw), "Private Agent thread reply.") {
			t.Fatal("DM thread denial leaked content")
		}
	}
	follow := h.e.Serve(http.MethodPost, "/api/channels/threads/follow", map[string]any{
		"parentMessageId": parentID,
	}, testkit.Scoped(h.otherToken, h.workspace))
	if follow.Status != http.StatusForbidden && follow.Status != http.StatusNotFound {
		t.Fatalf("following cannot grant a stranger DM thread membership: %d %s", follow.Status, follow.Raw)
	}
	strangerInbox := h.e.Serve(http.MethodGet, "/api/channels/inbox?filter=all", nil, testkit.Scoped(h.otherToken, h.workspace))
	if strangerInbox.Status != http.StatusOK || strings.Contains(string(strangerInbox.Raw), threadID) || strings.Contains(string(strangerInbox.Raw), dmID) {
		t.Fatalf("private conversation leaked through stranger inbox: %d %s", strangerInbox.Status, strangerInbox.Raw)
	}
}
