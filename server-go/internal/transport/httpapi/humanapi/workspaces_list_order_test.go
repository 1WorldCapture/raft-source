package humanapi_test

// T08/T09: GET /api/servers (eligibility, ordering, version, history window)
// and GET/PATCH /api/servers/order (account-level switcher order contract).

import (
	"encoding/json"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func listIDs(t *testing.T, e *testkit.TestEnv, token string) []string {
	t.Helper()
	res := e.Serve("GET", "/api/servers", nil, testkit.Bearer(token))
	if res.Status != http.StatusOK {
		t.Fatalf("list: %d %s", res.Status, res.Raw)
	}
	var items []map[string]any
	if err := json.Unmarshal(res.Raw, &items); err != nil {
		t.Fatalf("list not an array: %s", res.Raw)
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item["id"].(string))
	}
	return ids
}

// pinJoinTimes makes the join order explicit for ordering fixtures.
func pinJoinTimes(t *testing.T, e *testkit.TestEnv, at map[string]int64) {
	t.Helper()
	for id, when := range at {
		if _, err := e.App.DB.Exec(`UPDATE workspace_memberships SET joined_at = ? WHERE workspace_id = ?`, when, id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestServerListEligibilityAndProjection(t *testing.T) {
	e := testkit.NewTestEnv(t)
	userID, access, _ := e.FullAccount("list-owner@example.test", "listowner")

	if got := listIDs(t, e, access); len(got) != 0 {
		t.Fatalf("empty membership must be [], got %v", got)
	}

	live := e.CreateServer(t, access, "Live", "list-live-lab")
	deleted := e.CreateServer(t, access, "Deleted", "list-deleted-lab")
	joint := e.CreateServer(t, access, "Joint", "list-joint-lab")
	e.SoftDeleteWorkspace(t, deleted)
	e.MarkJointStorage(t, joint)

	ids := listIDs(t, e, access)
	if len(ids) != 1 || ids[0] != live {
		t.Fatalf("deleted/joint_storage must be excluded, got %v", ids)
	}

	// Field projection on the list item (T24 shape).
	res := e.Serve("GET", "/api/servers", nil, testkit.Bearer(access))
	var items []map[string]any
	if err := json.Unmarshal(res.Raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("list not a one-item array: %s", res.Raw)
	}
	item := items[0]
	for _, key := range []string{"id", "name", "avatarUrl", "slug", "ownerId", "onboardingAgentId",
		"hideHumansFromMembers", "plan", "planDowngradedAt", "role", "serverPushMuted",
		"createdAt", "serverOrderVersion", "messageHistoryDays", "historyCutoff"} {
		if _, present := item[key]; !present {
			t.Errorf("list item missing %q: %s", key, res.Raw)
		}
	}
	if item["messageHistoryDays"] != float64(30) || item["historyCutoff"] == nil {
		t.Errorf("free plan history window after the trial: %s", res.Raw)
	}

	// Another user never sees this workspace.
	_, other, _ := e.FullAccount("list-other@example.test", "listother")
	if got := listIDs(t, e, other); len(got) != 0 {
		t.Fatalf("isolation broken: %v", got)
	}
	_ = userID
}

func TestServerListUnlimitedPlansHaveNoCutoff(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("list-pro@example.test", "prouser")
	id := e.CreateServer(t, access, "Pro Lab", "list-pro-lab")
	if _, err := e.App.DB.Exec(`UPDATE workspaces SET plan = 'pro' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	res := e.Serve("GET", "/api/servers", nil, testkit.Bearer(access))
	var items []map[string]any
	if err := json.Unmarshal(res.Raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("list not a one-item array: %s", res.Raw)
	}
	if items[0]["messageHistoryDays"] != float64(-1) || items[0]["historyCutoff"] != nil {
		t.Fatalf("pro plan must be unlimited with null cutoff: %s", res.Raw)
	}
}

func TestServerOrderContract(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("order@example.test", "orderer")
	first := e.CreateServer(t, access, "First", "order-first-lab")
	second := e.CreateServer(t, access, "Second", "order-second-lab")
	third := e.CreateServer(t, access, "Third", "order-third-lab")
	// Pin join times: same-millisecond creations would fall to the
	// non-semantic id tie-breaker (design §8.1 registers that drift).
	pinJoinTimes(t, e, map[string]int64{first: 1000, second: 2000, third: 3000})

	// Initial: join order, version 0.
	res := e.Serve("GET", "/api/servers/order", nil, testkit.Bearer(access))
	if res.Status != http.StatusOK {
		t.Fatalf("get order: %d %s", res.Status, res.Raw)
	}
	if res.Body["serverOrderVersion"] != float64(0) {
		t.Fatalf("initial version: %s", res.Raw)
	}
	if order, _ := res.Body["serverOrder"].([]any); len(order) != 3 || order[0] != first {
		t.Fatalf("initial order (join order): %s", res.Raw)
	}

	// Reorder: foreign/unknown/duplicate IDs are silently filtered; the
	// effective order is persisted and the version bumps exactly once.
	res = e.Serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{third, "not-a-server", second, third, first},
	}, testkit.Bearer(access))
	if res.Status != http.StatusOK {
		t.Fatalf("patch order: %d %s", res.Status, res.Raw)
	}
	if res.Body["serverOrderVersion"] != float64(1) {
		t.Fatalf("version must bump once: %s", res.Raw)
	}
	if got := listIDs(t, e, access); got[0] != third || got[1] != second || got[2] != first {
		t.Fatalf("list must follow the saved order: %v", got)
	}

	// No-op (same effective order, different garbage) does not bump.
	res = e.Serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{third, second, first, "still-not-a-server"},
	}, testkit.Bearer(access))
	if res.Body["serverOrderVersion"] != float64(1) {
		t.Fatalf("no-op must not bump version: %s", res.Raw)
	}

	// A genuinely new order bumps again.
	res = e.Serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{first, third, second},
	}, testkit.Bearer(access))
	if res.Body["serverOrderVersion"] != float64(2) {
		t.Fatalf("second change must bump: %s", res.Raw)
	}

	// Missing memberships are appended (never 403 for foreign IDs).
	res = e.Serve("PATCH", "/api/servers/order", map[string]any{
		"serverOrder": []any{second},
	}, testkit.Bearer(access))
	order, _ := res.Body["serverOrder"].([]any)
	if len(order) != 3 || order[0] != second {
		t.Fatalf("missing memberships must be appended: %s", res.Raw)
	}

	// Validation: non-array and non-string entries.
	for _, bad := range []any{"not-an-array", []any{1, 2}, []any{first, 42}, 42} {
		res = e.Serve("PATCH", "/api/servers/order", map[string]any{"serverOrder": bad}, testkit.Bearer(access))
		if res.Status != http.StatusBadRequest || res.Body["error"] != "serverOrder must be an array of string IDs" {
			t.Fatalf("invalid serverOrder %v: %d %s", bad, res.Status, res.Raw)
		}
	}

	// Restart persistence: the saved order and version survive a rebuild.
	reopened := e.Reopen()
	res = reopened.Serve("GET", "/api/servers/order", nil, testkit.Bearer(access))
	if res.Status != http.StatusOK || res.Body["serverOrderVersion"] != float64(3) {
		t.Fatalf("order after restart: %d %s", res.Status, res.Raw)
	}
	if got := listIDs(t, reopened, access); got[0] != second {
		t.Fatalf("order content after restart: %v", got)
	}
}
