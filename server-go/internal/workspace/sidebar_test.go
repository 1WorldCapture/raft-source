// Behavioral tests for the M2 sidebar preference read (GET
// /api/servers/:id/sidebar-order): id sanitization by existence/visibility,
// typed/legacy pinned projection consistency, section canonicalization and
// the missing-row error contract.
package workspace_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"testing"

	"raft.local/server-go/internal/workspace"
)

// sbChannel seeds one channel row with explicit lifecycle flags.
func sbChannel(t *testing.T, handle *sql.DB, id, workspaceID, name, typ string, deleted, archived bool) {
	t.Helper()
	var del, arch any
	if deleted {
		del = 1
	}
	if archived {
		arch = 1
	}
	if _, err := handle.Exec(`
		INSERT INTO channels (id, workspace_id, name, type, created_at, deleted_at, archived_at)
		VALUES (?, ?, ?, ?, 1, ?, ?)`, id, workspaceID, name, typ, del, arch); err != nil {
		t.Fatal(err)
	}
}

// sbChannelHuman seeds an explicit channel membership row.
func sbChannelHuman(t *testing.T, handle *sql.DB, channelID, userID string) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO channel_humans (channel_id, user_id, joined_at) VALUES (?, ?, 1)`,
		channelID, userID); err != nil {
		t.Fatal(err)
	}
}

// sbSetPrefs writes stored sidebar preference columns verbatim (M2 has no
// sidebar writer; tests seed the read path directly).
func sbSetPrefs(t *testing.T, handle *sql.DB, workspaceID, userID string, columns map[string]any) {
	t.Helper()
	if len(columns) == 0 {
		return
	}
	sets := ""
	args := []any{}
	for column, value := range columns {
		if sets != "" {
			sets += ", "
		}
		sets += column + " = ?"
		args = append(args, value)
	}
	args = append(args, workspaceID, userID)
	if _, err := handle.Exec(`UPDATE workspace_member_preferences SET `+sets+`
		WHERE workspace_id = ? AND user_id = ?`, args...); err != nil {
		t.Fatal(err)
	}
}

// canonicalJSON round-trips a value through JSON so typed empty slices and
// int64 versions compare against plain Go literals.
func canonicalJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func mustSidebar(t *testing.T, store *workspace.Store, workspaceID, userID string) map[string]any {
	t.Helper()
	out, err := store.GetSidebarOrder(context.Background(), workspaceID, userID)
	if err != nil {
		t.Fatalf("GetSidebarOrder: %v", err)
	}
	return out
}

// sbFixture is the shared visibility fixture: two humans (owner + member),
// public/private channels, a two-human dm, a single-human dm, and agents in
// three states.
type sbFixture struct {
	record workspace.ServerRecord
}

func sbSeed(t *testing.T, handle *sql.DB, store *workspace.Store) sbFixture {
	t.Helper()
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	seedUser(t, handle, "owner-b")
	seedUser(t, handle, "outsider")
	record := mustCreate(t, store, "owner-a", "alpha-team")
	other := mustCreate(t, store, "owner-b", "beta-team")
	m2sMembership(t, handle, record.ID, "member-m", "member", 20)

	sbChannel(t, handle, "ch-pub", record.ID, "pub-x", "channel", false, false)
	sbChannel(t, handle, "ch-priv-mine", record.ID, "priv-mine", "private", false, false)
	sbChannel(t, handle, "ch-priv-theirs", record.ID, "priv-theirs", "private", false, false)
	sbChannel(t, handle, "ch-deleted", record.ID, "gone", "channel", true, false)
	sbChannel(t, handle, "ch-archived", record.ID, "old", "channel", false, true)
	sbChannel(t, handle, "ch-other-ws", other.ID, "foreign", "channel", false, false)
	sbChannelHuman(t, handle, "ch-priv-mine", "owner-a")
	sbChannelHuman(t, handle, "ch-priv-theirs", "member-m")

	sbChannel(t, handle, "dm-two", record.ID, "dm-two", "dm", false, false)
	sbChannelHuman(t, handle, "dm-two", "owner-a")
	sbChannelHuman(t, handle, "dm-two", "member-m")
	sbChannel(t, handle, "dm-single", record.ID, "dm-single", "dm", false, false)
	sbChannelHuman(t, handle, "dm-single", "owner-a")
	sbChannel(t, handle, "dm-theirs", record.ID, "dm-theirs", "dm", false, false)
	sbChannelHuman(t, handle, "dm-theirs", "member-m")

	m2sAgent(t, handle, "ag-active", record.ID, false)
	m2sAgent(t, handle, "ag-deleted", record.ID, true)
	m2sAgent(t, handle, "ag-foreign", other.ID, false)
	return sbFixture{record: record}
}

func TestGetSidebarOrderDefaultShape(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")

	got := canonicalJSON(t, mustSidebar(t, store, record.ID, "owner-a"))
	want := map[string]any{
		"channelOrder":         []any{},
		"agentOrder":           []any{},
		"dmOrder":              []any{},
		"channelSortMode":      "manual",
		"jointChannelSortMode": "manual",
		"dmSortMode":           "manual",
		"pinnedSortMode":       "manual",
		"pinned":               []any{},
		"pinnedChannelIds":     []any{},
		"pinnedAgentIds":       []any{},
		"pinnedOrder":          []any{},
		"hiddenDmIds":          []any{},
		"channelPanelTabOrder": []any{},
		"agentPanelTabOrder":   []any{},
		"customSections":       []any{},
		// The canonicalizer always appends the four system sections, even
		// with nothing stored (TS canonicalizeSidebarSections behavior).
		"sectionOrder":      []any{"system:pinned", "system:joint", "system:channels", "system:dms"},
		"sectionPlacements": []any{},
		"sectionsVersion":   float64(0),
		"pinnedVersion":     float64(0),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default sidebar mismatch:\n got %#v\nwant %#v", got, want)
	}
}

func TestGetSidebarOrderSanitizesIDs(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"sidebar_channel_order":     `["ch-pub","ch-priv-mine","ch-priv-theirs","ch-other-ws","ch-deleted","ch-archived","nope"]`,
		"sidebar_agent_order":       `["ag-active","ag-deleted","ag-foreign","ag-none"]`,
		"sidebar_dm_order":          `["dm-two","dm-single","dm-theirs","ch-pub"]`,
		"hidden_dm_ids":             `["dm-two","dm-single","dm-theirs"]`,
		"sidebar_channel_sort_mode": "recent",
	})

	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))
	if !reflect.DeepEqual(got["channelOrder"], []any{"ch-pub", "ch-priv-mine"}) {
		t.Fatalf("channelOrder sanitize: %#v", got["channelOrder"])
	}
	if !reflect.DeepEqual(got["agentOrder"], []any{"ag-active"}) {
		t.Fatalf("agentOrder sanitize: %#v", got["agentOrder"])
	}
	if !reflect.DeepEqual(got["dmOrder"], []any{"dm-two", "dm-single"}) {
		t.Fatalf("dmOrder sanitize: %#v", got["dmOrder"])
	}
	if !reflect.DeepEqual(got["hiddenDmIds"], []any{"dm-two", "dm-single"}) {
		t.Fatalf("hiddenDmIds sanitize: %#v", got["hiddenDmIds"])
	}
	if got["channelSortMode"] != "recent" {
		t.Fatalf("stored sort mode must echo: %v", got["channelSortMode"])
	}
}

func TestGetSidebarOrderPanelTabWhitelists(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"channel_panel_tab_order": `["files","chat","bogus","tasks","files"]`,
		"agent_panel_tab_order":   `["activity","profile","chat","bogus","dms","reminders","workspace","integrations"]`,
	})
	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))
	if !reflect.DeepEqual(got["channelPanelTabOrder"], []any{"files", "chat", "tasks", "files"}) {
		t.Fatalf("channel panel whitelist: %#v", got["channelPanelTabOrder"])
	}
	if !reflect.DeepEqual(got["agentPanelTabOrder"],
		[]any{"activity", "profile", "chat", "dms", "reminders", "workspace", "integrations"}) {
		t.Fatalf("agent panel whitelist: %#v", got["agentPanelTabOrder"])
	}
}

func TestGetSidebarOrderSynthesizesPinnedFromLegacy(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	// pinned_refs stays NULL: typed pins are synthesized from the legacy triple.
	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"pinned_channel_ids": `["ch-pub","dm-two","ch-other-ws"]`,
		"pinned_agent_ids":   `["ag-active","ag-foreign"]`,
		"pinned_order":       `["dm-two","ag-foreign","ch-pub","ch-deleted"]`,
	})
	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))

	// Stored order drives synthesis: dm id resolves to its human peer ref,
	// then visible channels, then agent pins.
	wantPinned := []any{
		map[string]any{"kind": "human", "id": "member-m"},
		map[string]any{"kind": "channel", "id": "ch-pub"},
		map[string]any{"kind": "agent", "id": "ag-active"},
	}
	if !reflect.DeepEqual(got["pinned"], wantPinned) {
		t.Fatalf("synthesized pinned: %#v", got["pinned"])
	}
	// With pinned_refs unset the legacy triple is returned sanitized as-is.
	if !reflect.DeepEqual(got["pinnedChannelIds"], []any{"ch-pub", "dm-two"}) {
		t.Fatalf("legacy pinnedChannelIds: %#v", got["pinnedChannelIds"])
	}
	if !reflect.DeepEqual(got["pinnedAgentIds"], []any{"ag-active"}) {
		t.Fatalf("legacy pinnedAgentIds: %#v", got["pinnedAgentIds"])
	}
	if !reflect.DeepEqual(got["pinnedOrder"], []any{"dm-two", "ch-pub"}) {
		t.Fatalf("legacy pinnedOrder: %#v", got["pinnedOrder"])
	}
}

func TestGetSidebarOrderCanonicalizesTypedPinned(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"pinned_refs": `[{"kind":"channel","id":"ch-pub"},{"kind":"channel","id":"ch-priv-theirs"},
			{"kind":"agent","id":"ag-active"},{"kind":"agent","id":"ag-foreign"},
			{"kind":"channel","id":"dm-two"},{"kind":"human","id":"member-m"},
			{"kind":"human","id":"outsider"},{"kind":"bogus","id":"x"}]`,
		"pinned_channel_ids": `["ch-pub","ch-other-ws"]`,
		"pinned_agent_ids":   `["ag-active","ag-foreign"]`,
		"pinned_order":       `["ch-pub","ag-active","dm-two","ag-deleted"]`,
	})
	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))

	// Invisible refs drop; a channel ref naming a dm remaps to the human peer;
	// the later direct human ref dedups against it; bogus kinds were dropped
	// by read coercion (write-side validation is the TS invariant).
	wantPinned := []any{
		map[string]any{"kind": "channel", "id": "ch-pub"},
		map[string]any{"kind": "agent", "id": "ag-active"},
		map[string]any{"kind": "human", "id": "member-m"},
	}
	if !reflect.DeepEqual(got["pinned"], wantPinned) {
		t.Fatalf("canonical pinned: %#v", got["pinned"])
	}

	// Legacy triple is re-projected from the typed pins, then merged with the
	// sanitized stored triple (stored ids keep their exact positions).
	if !reflect.DeepEqual(got["pinnedChannelIds"], []any{"ch-pub", "dm-two"}) {
		t.Fatalf("merged pinnedChannelIds: %#v", got["pinnedChannelIds"])
	}
	if !reflect.DeepEqual(got["pinnedAgentIds"], []any{"ag-active"}) {
		t.Fatalf("merged pinnedAgentIds: %#v", got["pinnedAgentIds"])
	}
	if !reflect.DeepEqual(got["pinnedOrder"], []any{"ch-pub", "ag-active", "dm-two"}) {
		t.Fatalf("merged pinnedOrder: %#v", got["pinnedOrder"])
	}
}

func TestGetSidebarOrderCanonicalizesSections(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"sidebar_custom_sections": `[
			{"id":"sec1","name":"Work","emoji":null,"sortMode":"manual"},
			{"id":123,"name":"Broken","emoji":null,"sortMode":"manual"},
			{"id":"sec2","name":"Later","emoji":"X","sortMode":"az"}]`,
		"sidebar_section_order": `["sec2","bogus","system:dms","sec1"]`,
		"sidebar_section_placements": `[
			{"kind":"channel","id":"ch-pub","sectionId":"sec1","position":5},
			{"kind":"channel","id":"ch-priv-theirs","sectionId":"sec1","position":1},
			{"kind":"agent","id":"ag-active","sectionId":"sec2","position":0},
			{"kind":"agent","id":"ag-active","sectionId":"sec1","position":2},
			{"kind":"channel","id":"dm-two","sectionId":"sec1","position":3},
			{"kind":"channel","id":"ch-pub","sectionId":"system:pinned","position":0}]`,
		"sidebar_sections_version": 7,
		"pinned_version":           4,
	})
	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))

	wantSections := []any{
		map[string]any{"id": "sec1", "name": "Work", "emoji": nil, "sortMode": "manual"},
		map[string]any{"id": "sec2", "name": "Later", "emoji": "X", "sortMode": "az"},
	}
	if !reflect.DeepEqual(got["customSections"], wantSections) {
		t.Fatalf("customSections coercion: %#v", got["customSections"])
	}
	// Stored order first (allowed ids only), then the system tail, then any
	// unsaved custom ids.
	wantOrder := []any{"sec2", "system:dms", "sec1", "system:pinned", "system:joint", "system:channels"}
	if !reflect.DeepEqual(got["sectionOrder"], wantOrder) {
		t.Fatalf("canonical sectionOrder: %#v", got["sectionOrder"])
	}
	// Invisible placements drop; per-section positions renumber from zero.
	wantPlacements := []any{
		map[string]any{"kind": "agent", "id": "ag-active", "sectionId": "sec2", "position": float64(0)},
		map[string]any{"kind": "channel", "id": "dm-two", "sectionId": "sec1", "position": float64(0)},
		map[string]any{"kind": "channel", "id": "ch-pub", "sectionId": "sec1", "position": float64(1)},
	}
	if !reflect.DeepEqual(got["sectionPlacements"], wantPlacements) {
		t.Fatalf("canonical placements: %#v", got["sectionPlacements"])
	}
	if got["sectionsVersion"] != float64(7) || got["pinnedVersion"] != float64(4) {
		t.Fatalf("versions must echo stored values: %v/%v", got["sectionsVersion"], got["pinnedVersion"])
	}
}

func TestGetSidebarOrderMissingRowsAndGuest(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)
	ctx := context.Background()

	// Non-member: legacy route answers Server not found.
	_, err := store.GetSidebarOrder(ctx, fixture.record.ID, "outsider")
	de := domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("non-member: got %v/%q", de.Code, de.Message)
	}

	// Membership without a preference row is drift: Member not found.
	if _, err := handle.Exec(`DELETE FROM workspace_member_preferences
		WHERE workspace_id = ? AND user_id = 'owner-a'`, fixture.record.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.GetSidebarOrder(ctx, fixture.record.ID, "owner-a")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Member not found" {
		t.Fatalf("missing prefs row: got %v/%q", de.Code, de.Message)
	}

	// Guests are NOT rejected on this surface (legacy route only checks
	// membership) — they receive their own projection.
	seedUser(t, handle, "guest-g")
	m2sMembership(t, handle, fixture.record.ID, "guest-g", "guest", 50)
	got := mustSidebar(t, store, fixture.record.ID, "guest-g")
	if got["channelSortMode"] != "manual" {
		t.Fatalf("guest must read own defaults, got %#v", got)
	}

	// Soft-deleted workspace: Server not found even for the owner.
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 9 WHERE id = ?`, fixture.record.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.GetSidebarOrder(ctx, fixture.record.ID, "owner-a")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("deleted workspace: got %v/%q", de.Code, de.Message)
	}
}

func TestGetSidebarOrderDoesNotLeakCrossWorkspace(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	fixture := sbSeed(t, handle, store)

	// Everything the other workspace owns, at once.
	sbSetPrefs(t, handle, fixture.record.ID, "owner-a", map[string]any{
		"sidebar_channel_order": `["ch-other-ws"]`,
		"sidebar_agent_order":   `["ag-foreign"]`,
		"sidebar_dm_order":      `["ch-other-ws"]`,
		"pinned_refs":           `[{"kind":"channel","id":"ch-other-ws"},{"kind":"agent","id":"ag-foreign"}]`,
		"pinned_channel_ids":    `["ch-other-ws"]`,
		"pinned_agent_ids":      `["ag-foreign"]`,
		"pinned_order":          `["ch-other-ws","ag-foreign"]`,
		"hidden_dm_ids":         `["ch-other-ws"]`,
	})
	got := canonicalJSON(t, mustSidebar(t, store, fixture.record.ID, "owner-a"))
	for _, key := range []string{"channelOrder", "agentOrder", "dmOrder",
		"pinned", "pinnedChannelIds", "pinnedAgentIds", "pinnedOrder", "hiddenDmIds"} {
		if field := got[key].([]any); len(field) != 0 {
			t.Fatalf("%s must not leak foreign ids: %#v", key, field)
		}
	}
}
