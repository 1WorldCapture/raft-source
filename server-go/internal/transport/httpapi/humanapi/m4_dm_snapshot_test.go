package humanapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// The cross-module DM frontier is rendered by application/messaging on the
// SAME pinned executor as the conversation rows (a create reads its own
// uncommitted channel row through the transaction). This regression keeps
// proving that at the HTTP level: a create must return the readstate-owned
// frontier for a channel that does not exist outside its own transaction
// yet — a projection that escaped the caller's executor could not see the
// row at all and the create would fail instead of returning the frontier.
func TestM4DMFrontierSharesCallerSnapshotAndCreationTransaction(t *testing.T) {
	m := newM4Env(t)
	ws, _, token, peer, _ := m.seedWorkspace(t)

	created := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": peer}, token, ws)
	if created.Status != http.StatusOK {
		t.Fatalf("create: status=%d %s", created.Status, created.Raw)
	}
	if _, has := created.Body["readState"]; !has {
		t.Fatalf("create rec missing the readstate-owned frontier: %v", created.Body)
	}
	var frontier struct {
		Kind string `json:"kind"`
	}
	if raw, err := json.Marshal(created.Body["readState"]); err != nil {
		t.Fatal(err)
	} else if err := json.Unmarshal(raw, &frontier); err != nil {
		t.Fatalf("frontier bytes not the #632 union: %v", err)
	}

	listed := m.Serve("GET", "/api/channels/dm", nil, token, ws)
	if listed.Status != http.StatusOK {
		t.Fatalf("list: status=%d %s", listed.Status, listed.Raw)
	}
	var rows []map[string]any
	if err := json.Unmarshal(listed.Raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows: %d", len(rows))
	}
	if _, has := rows[0]["readState"]; !has {
		t.Fatalf("list row missing the readstate-owned frontier: %v", rows[0])
	}
}
