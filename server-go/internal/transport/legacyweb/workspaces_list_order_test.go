package legacyweb_test

// T08/T09: GET /api/servers (eligibility, ordering, version, history window)
// and GET/PATCH /api/servers/order (account-level switcher order contract).

import (
	"encoding/json"
	"net/http"
	"testing"
)

func listIDs(t *testing.T, e *testEnv, token string) []string {
	t.Helper()
	res := e.serve("GET", "/api/servers", nil, bearer(token))
	if res.status != http.StatusOK {
		t.Fatalf("list: %d %s", res.status, res.raw)
	}
	var items []map[string]any
	if err := json.Unmarshal(res.raw, &items); err != nil {
		t.Fatalf("list not an array: %s", res.raw)
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item["id"].(string))
	}
	return ids
}

// pinJoinTimes makes the join order explicit for ordering fixtures.
func pinJoinTimes(t *testing.T, e *testEnv, at map[string]int64) {
	t.Helper()
	for id, when := range at {
		if _, err := e.app.DB.Exec(`UPDATE workspace_memberships SET joined_at = ? WHERE workspace_id = ?`, when, id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestServerListEligibilityAndProjection(t *testing.T) {
	e := newTestEnv(t)
	userID, access, _ := e.fullAccount("list-owner@example.test", "listowner")

	if got := listIDs(t, e, access); len(got) != 0 {
		t.Fatalf("empty membership must be [], got %v", got)
	}

	live := e.createServer(t, access, "Live", "list-live-lab")
	deleted := e.createServer(t, access, "Deleted", "list-deleted-lab")
	joint := e.createServer(t, access, "Joint", "list-joint-lab")
	e.softDeleteWorkspace(t, deleted)
	e.markJointStorage(t, joint)

	ids := listIDs(t, e, access)
	if len(ids) != 1 || ids[0] != live {
		t.Fatalf("deleted/joint_storage must be excluded, got %v", ids)
	}

	// Field projection on the list item (T24 shape).
	res := e.serve("GET", "/api/servers", nil, bearer(access))
	var items []map[string]any
	if err := json.Unmarshal(res.raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("list not a one-item array: %s", res.raw)
	}
	item := items[0]
	for _, key := range []string{"id", "name", "avatarUrl", "slug", "ownerId", "onboardingAgentId",
		"hideHumansFromMembers", "plan", "planDowngradedAt", "role", "serverPushMuted",
		"createdAt", "serverOrderVersion", "messageHistoryDays", "historyCutoff"} {
		if _, present := item[key]; !present {
			t.Errorf("list item missing %q: %s", key, res.raw)
		}
	}
	if item["messageHistoryDays"] != float64(30) || item["historyCutoff"] == nil {
		t.Errorf("free plan history window after the trial: %s", res.raw)
	}

	// Another user never sees this workspace.
	_, other, _ := e.fullAccount("list-other@example.test", "listother")
	if got := listIDs(t, e, other); len(got) != 0 {
		t.Fatalf("isolation broken: %v", got)
	}
	_ = userID
}

func TestServerListUnlimitedPlansHaveNoCutoff(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("list-pro@example.test", "prouser")
	id := e.createServer(t, access, "Pro Lab", "list-pro-lab")
	if _, err := e.app.DB.Exec(`UPDATE workspaces SET plan = 'pro' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	res := e.serve("GET", "/api/servers", nil, bearer(access))
	var items []map[string]any
	if err := json.Unmarshal(res.raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("list not a one-item array: %s", res.raw)
	}
	if items[0]["messageHistoryDays"] != float64(-1) || items[0]["historyCutoff"] != nil {
		t.Fatalf("pro plan must be unlimited with null cutoff: %s", res.raw)
	}
}

func TestServerOrderContract(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("order@example.test", "orderer")
	first := e.createServer(t, access, "First", "order-first-lab")
	second := e.createServer(t, access, "Second", "order-second-lab")
	third := e.createServer(t, access, "Third", "order-third-lab")
	// Pin join times: same-millisecond creations would fall to the
	// non-semantic id tie-breaker (design §8.1 registers that drift).
	pinJoinTimes(t, e, map[string]int64{first: 1000, second: 2000, third: 3000})

	// Initial: join order, version 0.
	res := e.serve("GET", "/api/servers/order", nil, bearer(access))
	if res.status != http.StatusOK {
		t.Fatalf("get order: %d %s", res.status, res.raw)
	}
	if res.body["serverOrderVersion"] != float64(0) {
		t.Fatalf("initial version: %s", res.raw)
	}
	if order, _ := res.body["serverOrder"].([]any); len(order) != 3 || order[0] != first {
		t.Fatalf("initial order (join order): %s", res.raw)
	}

	// Reorder: foreign/unknown/duplicate IDs are silently filtered; the
	// effective order is persisted and the version bumps exactly once.
	res = e.serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{third, "not-a-server", second, third, first},
	}, bearer(access))
	if res.status != http.StatusOK {
		t.Fatalf("patch order: %d %s", res.status, res.raw)
	}
	if res.body["serverOrderVersion"] != float64(1) {
		t.Fatalf("version must bump once: %s", res.raw)
	}
	if got := listIDs(t, e, access); got[0] != third || got[1] != second || got[2] != first {
		t.Fatalf("list must follow the saved order: %v", got)
	}

	// No-op (same effective order, different garbage) does not bump.
	res = e.serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{third, second, first, "still-not-a-server"},
	}, bearer(access))
	if res.body["serverOrderVersion"] != float64(1) {
		t.Fatalf("no-op must not bump version: %s", res.raw)
	}

	// A genuinely new order bumps again.
	res = e.serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{first, third, second},
	}, bearer(access))
	if res.body["serverOrderVersion"] != float64(2) {
		t.Fatalf("second change must bump: %s", res.raw)
	}

	// Missing memberships are appended (never 403 for foreign IDs).
	res = e.serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{second},
	}, bearer(access))
	order, _ := res.body["serverOrder"].([]any)
	if len(order) != 3 || order[0] != second {
		t.Fatalf("missing memberships must be appended: %s", res.raw)
	}

	// Validation: non-array and non-string entries.
	for _, bad := range []any{"not-an-array", []any{1, 2}, []any{first, 42}, 42} {
		res = e.serve("PATCH", "/api/servers/order", map[string]any{"serverOrder": bad}, bearer(access))
		if res.status != http.StatusBadRequest || res.body["error"] != "serverOrder must be an array of string IDs" {
			t.Fatalf("invalid serverOrder %v: %d %s", bad, res.status, res.raw)
		}
	}

	// Restart persistence: the saved order and version survive a rebuild.
	reopened := e.reopen()
	res = reopened.serve("GET", "/api/servers/order", nil, bearer(access))
	if res.status != http.StatusOK || res.body["serverOrderVersion"] != float64(3) {
		t.Fatalf("order after restart: %d %s", res.status, res.raw)
	}
	if got := listIDs(t, reopened, access); got[0] != second {
		t.Fatalf("order content after restart: %v", got)
	}
}
