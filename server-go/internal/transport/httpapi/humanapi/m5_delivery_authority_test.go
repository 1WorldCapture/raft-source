package humanapi_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"raft.local/server-go/tests/testkit"
)

// A planned mention requires continuing read AND reply authority. Ordinary
// public history remains readable after a roster removal/archive, but that
// does not authorize consuming (or acknowledging) a new delivery.
func TestM5DeliveryRechecksReplyAuthority(t *testing.T) {
	for _, change := range []string{"archive", "remove-agent"} {
		for _, exit := range []string{"claim", "legacy-drain", "ack"} {
			t.Run(change+"/"+exit, func(t *testing.T) {
				h := newAgentChatHarness(t)
				agentID, key := h.external("replyguard")
				created := h.human(http.MethodPost, "/api/channels", map[string]any{
					"name": "reply-guard", "visibility": "public", "agentIds": []string{agentID},
				})
				if created.Status != http.StatusOK {
					t.Fatalf("create channel: %d %s", created.Status, created.Raw)
				}
				channelID, _ := created.Body["id"].(string)
				const marker = "reply authority must still exist at delivery time"
				sent := h.human(http.MethodPost, "/api/messages", map[string]any{
					"channelId": channelID, "content": marker, "randomId": "reply-authority-request",
					"mentions": []any{map[string]any{"type": "agent", "id": agentID, "name": "replyguard"}},
				})
				if sent.Status != http.StatusOK && sent.Status != http.StatusCreated {
					t.Fatalf("plan mention: %d %s", sent.Status, sent.Raw)
				}
				if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE agent_id = ? AND conversation_id = ?`, agentID, channelID); got != 1 {
					t.Fatalf("expected one committed delivery, got %d", got)
				}

				var ack any
				if exit == "ack" {
					claimed := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim", nil, testkit.Bearer(key))
					if claimed.Status != http.StatusOK || !strings.Contains(string(claimed.Raw), marker) {
						t.Fatalf("claim before revocation: %d %s", claimed.Status, claimed.Raw)
					}
					ack = claimed.Body["ack"]
				}

				var revoked testkit.Response
				if change == "archive" {
					revoked = h.human(http.MethodPost, "/api/channels/"+channelID+"/archive", map[string]any{})
				} else {
					revoked = h.human(http.MethodDelete, "/api/channels/"+channelID+"/members/agent/"+agentID, nil)
				}
				if revoked.Status != http.StatusOK {
					t.Fatalf("revoke reply authority: %d %s", revoked.Status, revoked.Raw)
				}

				// Keep historical public reads independent from delivery authority.
				history := h.e.Serve(http.MethodGet, "/internal/agent-api/history?channel="+url.QueryEscape("channelId:"+channelID), nil, testkit.Bearer(key))
				if history.Status != http.StatusOK || !strings.Contains(string(history.Raw), marker) {
					t.Fatalf("readable public history must remain readable: %d %s", history.Status, history.Raw)
				}

				var response testkit.Response
				switch exit {
				case "claim":
					response = h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim", nil, testkit.Bearer(key))
				case "legacy-drain":
					response = h.e.Serve(http.MethodGet, "/internal/agent-api/events", nil, testkit.Bearer(key))
				case "ack":
					response = h.e.Serve(http.MethodPost, "/internal/agent-api/events/ack", ack, testkit.Bearer(key))
				}
				if response.Status != http.StatusOK || strings.Contains(string(response.Raw), marker) {
					t.Fatalf("revoked delivery must not be consumed: %d %s", response.Status, response.Raw)
				}
				if exit == "ack" && response.Body["removed_count"] != float64(0) {
					t.Fatalf("revoked delivery must not be acknowledged: %s", response.Raw)
				}
				if got := h.count(`SELECT COUNT(*) FROM agent_deliveries WHERE agent_id = ? AND conversation_id = ? AND scheduling_state = 'cancelled' AND acknowledged_at IS NULL`, agentID, channelID); got != 1 {
					t.Fatalf("revocation must cancel, never acknowledge, the pending intent: count=%d", got)
				}
			})
		}
	}
}
