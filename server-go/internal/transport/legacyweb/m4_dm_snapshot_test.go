package legacyweb_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"raft.local/server-go/internal/channel"
)

// The real app assembly tests cover readState values. This seam regression
// additionally proves that list and create never project from a later bare
// DB snapshot, and that a create projection failure rolls back its new fact.
func TestM4DMFrontierSharesCallerSnapshotAndCreationTransaction(t *testing.T) {
	m := newM4Env(t)
	ws, owner, token, peer, _ := m.seedWorkspace(t)
	calls := 0
	failProjection := false
	m.handlers.DMReadState = func(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (json.RawMessage, error) {
		calls++
		if _, bare := ex.(*sql.DB); bare {
			t.Fatal("DM frontier projection escaped the caller's pinned executor")
		}
		if workspaceID != ws || userID != owner {
			t.Fatal("DM projection changed the workspace or principal")
		}
		var visible int
		if err := ex.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE id = ? AND workspace_id = ?`, channelID, ws).Scan(&visible); err != nil {
			return nil, err
		}
		if visible != 1 {
			t.Fatal("DM row is not visible on its projection executor")
		}
		if failProjection {
			return nil, errors.New("test projection failure")
		}
		return json.RawMessage(`{"kind":"absent"}`), nil
	}
	created := m.serve("POST", "/api/channels/dm", map[string]any{"userId": peer}, token, ws)
	if created.status != http.StatusOK || calls != 1 {
		t.Fatalf("create: status=%d projection calls=%d", created.status, calls)
	}
	listed := m.serve("GET", "/api/channels/dm", nil, token, ws)
	if listed.status != http.StatusOK || calls != 2 {
		t.Fatalf("list: status=%d projection calls=%d", listed.status, calls)
	}

	countDMs := func() int {
		t.Helper()
		var count int
		if err := m.env.app.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id = ? AND type = 'dm'`, ws).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	before := countDMs()
	failProjection = true
	failed := m.serve("POST", "/api/channels/dm", map[string]any{"userId": owner}, token, ws)
	if failed.status != http.StatusInternalServerError {
		t.Fatalf("projection failure status=%d, want 500", failed.status)
	}
	if after := countDMs(); after != before {
		t.Fatalf("failed DM creation committed a partial fact: before=%d after=%d", before, after)
	}
}
