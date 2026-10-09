package humanapi_test

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/tests/testkit"
)

// A managed scanner's polling cursor must not become the external runner's
// pull eligibility. This mixes both modes in one real message transaction,
// and waits for evidence that the managed scan actually happened before the
// external original-wire claim. No five-second sleep hides a delayed inbox.
func TestM5ManagedBacklogCannotDelayExternalClaim(t *testing.T) {
	h := newAgentChatHarness(t)
	externalID, externalKey := h.external("mixedexternal")
	managedID, _ := h.external("mixedmanaged")
	// The managed machine is intentionally absent: the scanner must put this
	// Agent into waiting_machine without disturbing the independent external
	// recipient. Runtime assignment is fixture preparation, not a product API.
	if err := platformdb.WithWriteTx(context.Background(), h.e.App.DB, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE agents SET runtime = 'claude' WHERE id = ?`, managedID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	sent := h.human(http.MethodPost, "/api/v2/messages", map[string]any{
		"channelId": h.channelID("all"), "content": "Mixed delivery must be immediately claimable.", "randomId": "mixed-agent-delivery",
		"mentions": []map[string]any{
			{"type": "agent", "id": externalID, "name": "mixedexternal"},
			{"type": "agent", "id": managedID, "name": "mixedmanaged"},
		},
	})
	if sent.Status != http.StatusOK {
		t.Fatalf("mixed recipient transaction: %d %s", sent.Status, sent.Raw)
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var state string
		if err := h.e.App.DB.QueryRow(`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ?`, managedID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "waiting_machine" {
			break
		}
		select {
		case <-deadline.C:
			t.Fatalf("managed scan never reached its expected waiting state: %q", state)
		case <-tick.C:
		}
	}
	claim := h.e.Serve(http.MethodGet, "/internal/agent-api/events/claim", nil, testkit.Bearer(externalKey))
	if claim.Status != http.StatusOK || !strings.Contains(string(claim.Raw), "Mixed delivery must be immediately claimable.") {
		t.Fatalf("managed scan delayed or hid the external recipient: %d %s", claim.Status, claim.Raw)
	}
}
