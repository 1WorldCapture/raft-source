package humanapi_test

// T02/T04/T05/T22: POST /api/servers — the full creation contract over HTTP:
// bare ServerRecord shape, owner sourced from the session, slug rules with
// no silent normalization, conflict mapping, ignored privilege fields, the
// full transactional side effects and same-slug races.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"sync"
	"testing"
)

func TestCreateWorkspaceHappyPath(t *testing.T) {
	e := testkit.NewTestEnv(t)
	userID, access, _ := e.FullAccount("create-happy@example.test", "happycreator")

	res := e.Serve("POST", "/api/servers", map[string]any{"name": "Example team", "slug": "example-team"}, testkit.Bearer(access))
	if res.Status != http.StatusOK {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	body := res.Body
	// Bare record: every legacy field present, defaults exact, nulls null.
	testkit.WantEqualString(t, body, "name", "Example team")
	testkit.WantEqualString(t, body, "slug", "example-team")
	testkit.WantEqualString(t, body, "kind", "normal")
	testkit.WantEqualString(t, body, "ownerId", userID)
	testkit.WantEqualString(t, body, "plan", "free")
	for _, nullField := range []string{"avatarUrl", "onboardingAgentId", "planDowngradedAt", "deletedAt"} {
		if v, present := body[nullField]; !present || v != nil {
			t.Errorf("%s must be present and null, got %v", nullField, v)
		}
	}
	for _, trueField := range []string{"agentAllChannelGreetingEnabled"} {
		if body[trueField] != true {
			t.Errorf("%s must default true", trueField)
		}
	}
	for _, falseField := range []string{"hideHumansFromMembers", "publiclyVisible", "translationEnabled", "progressAnnouncementsEnabled"} {
		if body[falseField] != false {
			t.Errorf("%s must default false", falseField)
		}
	}
	for _, ts := range []string{"createdAt", "updatedAt"} {
		if v, _ := body[ts].(string); v == "" || !strings.HasSuffix(v, "Z") || !strings.Contains(v, "T") {
			t.Errorf("%s must be UTC ISO-8601, got %v", ts, body[ts])
		}
	}
	if _, wrapped := body["server"]; wrapped {
		t.Error("record must not be wrapped in {server:...}")
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatal("no id")
	}

	// The list reflects the real owner membership with role=owner and the
	// order version; the detail endpoint returns the same record re-read.
	list := e.Serve("GET", "/api/servers", nil, testkit.Bearer(access))
	if list.Status != http.StatusOK {
		t.Fatalf("list: %d %s", list.Status, list.Raw)
	}
	var items []map[string]any
	if err := json.Unmarshal(list.Raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("list after create: %s", list.Raw)
	}
	if items[0]["role"] != "owner" || items[0]["id"] != id || items[0]["ownerId"] != userID {
		t.Errorf("owner membership wrong: %s", list.Raw)
	}
	if items[0]["serverOrderVersion"] != float64(0) {
		t.Errorf("serverOrderVersion missing: %s", list.Raw)
	}

	detail := e.Serve("GET", "/api/servers/"+id, nil, testkit.Scoped(access, id))
	if detail.Status != http.StatusOK || detail.Body["id"] != id || detail.Body["slug"] != "example-team" {
		t.Fatalf("detail: %d %s", detail.Status, detail.Raw)
	}

	// Transactional side effects: system channels, audit, setup and
	// preference rows all exist for the creator (C0: no opener channel).
	for table, want := range map[string]int{
		`SELECT COUNT(*) FROM channels WHERE workspace_id = ?`:                             2,
		`SELECT COUNT(*) FROM workspace_membership_agreement_audit WHERE workspace_id = ?`: 1,
		`SELECT COUNT(*) FROM workspace_member_setup WHERE workspace_id = ?`:               1,
		`SELECT COUNT(*) FROM workspace_member_preferences WHERE workspace_id = ?`:         1,
	} {
		var n int
		if err := e.App.DB.QueryRow(table, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Errorf("side effect %q = %d, want %d", table, n, want)
		}
	}
	var allType, announcementKind string
	if err := e.App.DB.QueryRow(`SELECT type FROM channels WHERE workspace_id = ? AND system_kind = 'all'`, id).Scan(&allType); err != nil {
		t.Fatal(err)
	}
	if allType != "channel" {
		t.Errorf("C0 #all type = %q, want channel (opener off)", allType)
	}
	if err := e.App.DB.QueryRow(`SELECT system_kind FROM channels WHERE workspace_id = ? AND name = 'announcement'`, id).Scan(&announcementKind); err != nil {
		t.Fatal(err)
	}
	if announcementKind != "announcement" {
		t.Errorf("announcement system kind: %q", announcementKind)
	}
}

func TestCreateWorkspaceSlugAndNameValidation(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("create-slug@example.test", "slugcreator")

	cases := []struct {
		name   string
		body   map[string]any
		status int
		errMsg string
	}{
		{"missing name", map[string]any{"slug": "abcde"}, 400, "Name and slug are required"},
		{"empty name", map[string]any{"name": "", "slug": "abcde"}, 400, "Name and slug are required"},
		{"null name", map[string]any{"name": nil, "slug": "abcde"}, 400, "Name and slug are required"},
		{"zero name", map[string]any{"name": 0, "slug": "abcde"}, 400, "Name and slug are required"},
		{"false name", map[string]any{"name": false, "slug": "abcde"}, 400, "Name and slug are required"},
		{"missing slug", map[string]any{"name": "N"}, 400, "Name and slug are required"},
		{"empty slug", map[string]any{"name": "N", "slug": ""}, 400, "Name and slug are required"},
		{"null slug", map[string]any{"name": "N", "slug": nil}, 400, "Name and slug are required"},
		{"truthy non-string slug", map[string]any{"name": "N", "slug": 123}, 400, "Slug is required"},
		{"truthy bool slug", map[string]any{"name": "N", "slug": true}, 400, "Slug is required"},
		{"too short", map[string]any{"name": "N", "slug": "abc"}, 400, "Slug must be at least 5 characters"},
		{"uppercase not normalized", map[string]any{"name": "N", "slug": "Hello-team"}, 400,
			"Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"leading digit", map[string]any{"name": "N", "slug": "1abcdef"}, 400,
			"Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"no silent trim", map[string]any{"name": "N", "slug": "abcdef "}, 400,
			"Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"underscore rejected", map[string]any{"name": "N", "slug": "abc_def"}, 400,
			"Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"five chars ok (boundary)", map[string]any{"name": "N", "slug": "abcde"}, 200, ""},
	}
	created := 0
	for _, tc := range cases {
		res := e.Serve("POST", "/api/servers", tc.body, testkit.Bearer(access))
		if res.Status != tc.status {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, res.Status, tc.status, res.Raw)
			continue
		}
		if tc.errMsg != "" {
			testkit.WantError(t, res.Body, tc.errMsg)
		} else {
			created++
		}
	}
	if created != 1 {
		t.Errorf("boundary slug case should create exactly one server, created %d", created)
	}
}

func TestCreateWorkspaceSlugConflict(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("conflict-a@example.test", "conflicta")
	_, other, _ := e.FullAccount("conflict-b@example.test", "conflictb")
	if id := e.CreateServer(t, access, "First", "conflict-lab"); id == "" {
		t.Fatal("seed create failed")
	}

	res := e.Serve("POST", "/api/servers", map[string]any{"name": "Second", "slug": "conflict-lab"}, testkit.Bearer(other))
	if res.Status != http.StatusConflict {
		t.Fatalf("active slug conflict: %d %s", res.Status, res.Raw)
	}
	testkit.WantError(t, res.Body, `Server slug "conflict-lab" is already taken`)

	// Soft-deleted slugs stay unusable, but — faithfully to the legacy
	// failed insert (D02 pending review) — the collision is NOT the approved
	// 409: only an active winner maps to the conflict, so this stays the
	// route's generic 500 while the slug remains reserved forever.
	wsID := res0id(t, e, access)
	e.SoftDeleteWorkspace(t, wsID)
	res = e.Serve("POST", "/api/servers", map[string]any{"name": "Reuse", "slug": "conflict-lab"}, testkit.Bearer(other))
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("soft-deleted slug reuse: %d %s (D02: legacy 500 until the unified-409 repair is approved)", res.Status, res.Raw)
	}
	testkit.WantError(t, res.Body, "Failed to create server")
}

// res0id reads the caller's first listed workspace id.
func res0id(t *testing.T, e *testkit.TestEnv, token string) string {
	t.Helper()
	first := e.Serve("GET", "/api/servers", nil, testkit.Bearer(token))
	var items []map[string]any
	if err := json.Unmarshal(first.Raw, &items); err != nil || len(items) != 1 {
		t.Fatalf("seed list: %s", first.Raw)
	}
	return items[0]["id"].(string)
}

func TestCreateWorkspaceIgnoresPrivilegeFields(t *testing.T) {
	e := testkit.NewTestEnv(t)
	userID, access, _ := e.FullAccount("create-ignore@example.test", "ignorecreator")
	_, otherID, _ := userID, "", ""

	// Everything privileged in the body stays inert: owner is the caller,
	// plan/kind/setupStatus/role cannot be injected (T22).
	res := e.Serve("POST", "/api/servers", map[string]any{
		"name": "Honest", "slug": "honest-lab", "ownerId": otherID,
		"plan": "pro", "kind": "joint_storage", "setupStatus": "complete",
		"role": "member", "id": "crafted-id",
	}, testkit.Bearer(access))
	if res.Status != http.StatusOK {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	if res.Body["ownerId"] != userID {
		t.Errorf("ownerId must come from the session: %v", res.Body["ownerId"])
	}
	if res.Body["plan"] != "free" || res.Body["kind"] != "normal" {
		t.Errorf("plan/kind injection took effect: %s", res.Raw)
	}
	if res.Body["id"] == "crafted-id" {
		t.Error("crafted id accepted")
	}
	status, reason := e.SetupRow(t, res.Body["id"].(string), userID)
	if status != "not_started" || reason.Valid {
		t.Errorf("setupStatus injection: status=%q reason=%v", status, reason)
	}
}

func TestCreateWorkspaceTruthyNonStringNameCoercesLikeLegacy(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("create-coerce@example.test", "coercer")

	// The legacy route only checks truthiness at create time; a JSON number
	// name reached the text column as its JS string form.
	res := e.Serve("POST", "/api/servers", map[string]any{"name": 42, "slug": "coerced-lab"}, testkit.Bearer(access))
	if res.Status != http.StatusOK || res.Body["name"] != "42" {
		t.Fatalf("numeric name: %d %s", res.Status, res.Raw)
	}
	// Structured truthy values cannot become text; the legacy insert failed
	// and the route answered its generic 500.
	res = e.Serve("POST", "/api/servers", map[string]any{"name": []any{1}, "slug": "coerced-lab-2"}, testkit.Bearer(access))
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("array name: %d %s", res.Status, res.Raw)
	}
	testkit.WantError(t, res.Body, "Failed to create server")
}

func TestCreateWorkspaceSameSlugRaceHasOneWinner(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("race@example.test", "racer")

	const attempts = 4
	results := make([]testkit.Response, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			results[slot] = e.Serve("POST", "/api/servers",
				map[string]any{"name": fmt.Sprintf("Racer %d", slot), "slug": "race-lab"}, testkit.Bearer(access))
		}(i)
	}
	wg.Wait()

	wins, conflicts := 0, 0
	for _, res := range results {
		switch res.Status {
		case http.StatusOK:
			wins++
		case http.StatusConflict:
			conflicts++
		default:
			t.Fatalf("unexpected race result: %d %s", res.Status, res.Raw)
		}
	}
	if wins != 1 || conflicts != attempts-1 {
		t.Fatalf("race: %d winners, %d conflicts", wins, conflicts)
	}

	// Exactly one complete workspace exists, with exactly one full set of
	// transactional side effects.
	var workspaces, channels, setups int
	_ = e.App.DB.QueryRow(`SELECT COUNT(*) FROM workspaces WHERE slug = 'race-lab'`).Scan(&workspaces)
	_ = e.App.DB.QueryRow(`SELECT COUNT(*) FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE w.slug = 'race-lab'`).Scan(&channels)
	_ = e.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_member_setup s JOIN workspaces w ON w.id = s.workspace_id WHERE w.slug = 'race-lab'`).Scan(&setups)
	if workspaces != 1 || channels != 2 || setups != 1 {
		t.Fatalf("race residue: workspaces=%d channels=%d setups=%d", workspaces, channels, setups)
	}
}
