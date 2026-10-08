package workspace_test

import (
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"raft.local/server-go/internal/workspace"
)

var recordKeys = []string{
	"id", "name", "avatarUrl", "slug", "kind", "ownerId", "onboardingAgentId",
	"agentAllChannelGreetingEnabled", "hideHumansFromMembers", "publiclyVisible",
	"plan", "translationEnabled", "progressAnnouncementsEnabled",
	"planDowngradedAt", "deletedAt", "createdAt", "updatedAt",
}

// TestCreateWorkspaceHappyPath writes every legacy side effect in one
// transaction and returns the bare record (T02 slice).
func TestCreateWorkspaceHappyPath(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record, err := store.CreateWorkspace(t.Context(), "user-a", "Example team", "example-team")
	if err != nil {
		t.Fatal(err)
	}
	if record.ID == "" || record.Name != "Example team" || record.Slug != "example-team" {
		t.Fatalf("unexpected record core: %+v", record)
	}
	if record.OwnerID != "user-a" || record.Kind != "normal" || record.Plan != "free" {
		t.Fatalf("owner/kind/plan wrong: %+v", record)
	}
	if record.AvatarURL != nil || record.OnboardingAgentID != nil ||
		record.PlanDowngradedAt != nil || record.DeletedAt != nil {
		t.Fatalf("nullable fields must stay null: %+v", record)
	}
	if record.AgentAllChannelGreetingEnabled != true || record.HideHumansFromMembers ||
		record.PubliclyVisible || record.TranslationEnabled || record.ProgressAnnouncementsEnabled {
		t.Fatalf("default booleans wrong: %+v", record)
	}
	if !record.CreatedAt.Equal(fixedBase) || !record.UpdatedAt.Equal(fixedBase) {
		t.Fatalf("timestamps must use the injected clock: %v %v", record.CreatedAt, record.UpdatedAt)
	}
	// Owner membership is a real owner row, not a derived guess.
	var role string
	if err := handle.QueryRow(`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = 'user-a'`, record.ID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "owner" {
		t.Fatalf("creator role = %q, want owner", role)
	}
	// Setup row is born under the v2 contract, not started, no reason.
	var status, contract string
	var reason sql.NullString
	if err := handle.QueryRow(`
		SELECT status, completion_reason, contract_version
		FROM workspace_member_setup WHERE workspace_id = ? AND user_id = 'user-a'`, record.ID).
		Scan(&status, &reason, &contract); err != nil {
		t.Fatal(err)
	}
	if status != "not_started" || reason.Valid || contract != "onboarding-setup-v2" {
		t.Fatalf("setup row = %q %v %q", status, reason, contract)
	}
	// Default preferences row exists for the creator.
	if n := countRows(t, handle, `SELECT COUNT(*) FROM workspace_member_preferences WHERE workspace_id = ?`, record.ID); n != 1 {
		t.Fatalf("preferences rows = %d, want 1", n)
	}
	// Agreement audit records the admin-add fact with no fabricated agreement.
	var subjectType, subjectID, actor, source string
	var agreementID, agreementVersion any
	if err := handle.QueryRow(`
		SELECT subject_type, subject_id, actor_user_id, source, agreement_id, agreement_version
		FROM workspace_membership_agreement_audit WHERE workspace_id = ?`, record.ID).
		Scan(&subjectType, &subjectID, &actor, &source, &agreementID, &agreementVersion); err != nil {
		t.Fatal(err)
	}
	if subjectType != "user" || subjectID != "user-a" || actor != "user-a" || source != "admin-add" ||
		agreementID != nil || agreementVersion != nil {
		t.Fatalf("agreement audit row wrong: %v %v %v %v %v %v", subjectType, subjectID, actor, source, agreementID, agreementVersion)
	}
	assertSystemChannels(t, handle, record.ID, "channel", false)
}

// TestCreateWorkspaceOpenerV2 flips #all private and adds the owner roster.
func TestCreateWorkspaceOpenerV2(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{OnboardingOpenerV2: true})
	record, err := store.CreateWorkspace(t.Context(), "user-a", "Opener", "opener-on")
	if err != nil {
		t.Fatal(err)
	}
	assertSystemChannels(t, handle, record.ID, "private", true)
}

// assertSystemChannels verifies the created channel set for a policy vector:
// #all with the policy-driven type, the always-present #announcement, and —
// only with the opener on — the private onboarding-owner channel whose roster
// holds exactly the creator.
func assertSystemChannels(t *testing.T, handle *sql.DB, workspaceID, allType string, opener bool) {
	t.Helper()
	rows, err := handle.Query(`
		SELECT name, type, system_kind, description FROM channels WHERE workspace_id = ? ORDER BY name`, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]struct {
		typ, systemKind, description string
	}{}
	for rows.Next() {
		var name string
		var typ, systemKind, description sql.NullString
		if err := rows.Scan(&name, &typ, &systemKind, &description); err != nil {
			t.Fatal(err)
		}
		got[name] = struct {
			typ, systemKind, description string
		}{typ.String, systemKind.String, description.String}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	all, ok := got["all"]
	if !ok || all.typ != allType || all.systemKind != "all" || all.description != "General channel for all members" {
		t.Fatalf("#all channel wrong: %+v", all)
	}
	announcement, ok := got["announcement"]
	if !ok || announcement.typ != "channel" || announcement.systemKind != "announcement" ||
		announcement.description != "Agent progress announcements" {
		t.Fatalf("#announcement channel wrong: %+v", announcement)
	}
	owner, hasOwner := got["onboarding-owner"]
	if opener {
		if !hasOwner || owner.typ != "private" || owner.systemKind != "" || owner.description != "Your private onboarding space" {
			t.Fatalf("onboarding-owner channel wrong: %+v", owner)
		}
		var roster int
		if err := handle.QueryRow(`
			SELECT COUNT(*) FROM channel_humans ch
			JOIN channels c ON c.id = ch.channel_id
			WHERE c.workspace_id = ? AND c.name = 'onboarding-owner' AND ch.user_id = 'user-a'`, workspaceID).Scan(&roster); err != nil {
			t.Fatal(err)
		}
		if roster != 1 {
			t.Fatalf("owner roster rows = %d, want 1", roster)
		}
	} else if hasOwner {
		t.Fatal("onboarding-owner channel must not exist with the opener off")
	}
	if len(got) != map[bool]int{true: 3, false: 2}[opener] {
		t.Fatalf("unexpected channel set: %+v", got)
	}
}

// TestCreateWorkspaceJSONShape pins the external wire contract: exact keys,
// null semantics and millisecond UTC timestamps (T24 slice).
func TestCreateWorkspaceJSONShape(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record, err := store.CreateWorkspace(t.Context(), "user-a", "Example team", "example-team")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed) != len(recordKeys) {
		t.Fatalf("field count = %d, want %d (%v)", len(parsed), len(recordKeys), parsed)
	}
	for _, key := range recordKeys {
		if _, ok := parsed[key]; !ok {
			t.Fatalf("missing key %q in %s", key, raw)
		}
	}
	for _, key := range []string{"avatarUrl", "onboardingAgentId", "planDowngradedAt", "deletedAt"} {
		if parsed[key] != nil {
			t.Fatalf("%s must marshal to null", key)
		}
	}
	msPattern := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	for _, key := range []string{"createdAt", "updatedAt"} {
		s, ok := parsed[key].(string)
		if !ok || !msPattern.MatchString(s) {
			t.Fatalf("%s must be a millisecond UTC timestamp, got %v", key, parsed[key])
		}
	}
	if parsed["createdAt"] != parsed["updatedAt"] {
		t.Fatalf("creation must stamp one unified time: %v vs %v", parsed["createdAt"], parsed["updatedAt"])
	}
	// Create never trims or limits the name (D01: only PATCH does).
	long := strings.Repeat("x", 101)
	rec, err := store.CreateWorkspace(t.Context(), "user-a", "  "+long+"  ", "long-name-input")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Name != "  "+long+"  " {
		t.Fatalf("create must store the name verbatim, got %q", rec.Name)
	}
}

// TestCreateWorkspaceSlugValidation covers the shared slug rules with the
// legacy sentences and no implicit normalization (T04 slice).
func TestCreateWorkspaceSlugValidation(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	cases := []struct {
		label, name, slug, message string
	}{
		{"empty name", "", "abcde", "Name and slug are required"},
		{"empty slug", "N", "", "Name and slug are required"},
		{"too short", "N", "abcd", "Slug must be at least 5 characters"},
		{"uppercase", "N", "UPPER", "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"leading digit", "N", "1abcd", "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"leading hyphen", "N", "-abcd", "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"inner space", "N", "ab cd", "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"inner underscore", "N", "ab_cd", "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"},
		{"utf16 short", "N", "日本語", "Slug must be at least 5 characters"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			_, err := store.CreateWorkspace(t.Context(), "user-a", tc.name, tc.slug)
			de := domainError(t, err)
			if de.Code != workspace.CodeInvalidInput || de.Message != tc.message {
				t.Fatalf("got %s/%q, want INVALID_INPUT/%q", de.Code, de.Message, tc.message)
			}
		})
	}
	// A 5-unit slug containing an astral char passes length then fails pattern.
	if _, err := store.CreateWorkspace(t.Context(), "user-a", "N", "abc😀"); workspace.AsDomainError(err) == nil {
		t.Fatal("expected pattern failure for astral slug")
	}
	if n := countRows(t, handle, `SELECT COUNT(*) FROM workspaces`); n != 0 {
		t.Fatalf("rejected creates must not leave workspaces behind: %d", n)
	}
}

// TestCreateWorkspaceSlugConflict keeps the legacy 409 sentence.
func TestCreateWorkspaceSlugConflict(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	if _, err := store.CreateWorkspace(t.Context(), "user-a", "First", "taken-slug"); err != nil {
		t.Fatal(err)
	}
	_, err := store.CreateWorkspace(t.Context(), "user-a", "Second", "taken-slug")
	de := domainError(t, err)
	if de.Code != workspace.CodeConflict || de.Message != `Server slug "taken-slug" is already taken` {
		t.Fatalf("got %s/%q", de.Code, de.Message)
	}
}

// TestCreateWorkspaceMissingUser refuses to create for an unknown account.
func TestCreateWorkspaceMissingUser(t *testing.T) {
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	if _, err := store.CreateWorkspace(t.Context(), "ghost", "Ghost", "ghost-slug"); err == nil {
		t.Fatal("creation for a missing user must fail")
	}
	if n := countRows(t, handle, `SELECT COUNT(*) FROM workspaces`); n != 0 {
		t.Fatalf("no workspace may remain: %d", n)
	}
}

// TestCreateWorkspaceAtomicity injects a failure into each side-effect write
// (SQLite triggers) and asserts the whole transaction rolls back (T03).
func TestCreateWorkspaceAtomicity(t *testing.T) {
	cases := []struct {
		name   string
		table  string
		opener bool
	}{
		{"workspace insert", "workspaces", false},
		{"membership insert", "workspace_memberships", false},
		{"setup insert", "workspace_member_setup", false},
		{"preferences insert", "workspace_member_preferences", false},
		{"agreement audit insert", "workspace_membership_agreement_audit", false},
		{"channel insert", "channels", false},
		{"owner channel insert", "channels", true},
		{"owner roster insert", "channel_humans", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handle := newWorkspaceDB(t)
			seedUser(t, handle, "user-a")
			store, _ := newTestStore(handle, workspace.Policy{OnboardingOpenerV2: tc.opener})
			if _, err := handle.Exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON ` + tc.table +
				` BEGIN SELECT RAISE(ABORT, 'injected failure'); END`); err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateWorkspace(t.Context(), "user-a", "Doomed", "doomed-slug"); err == nil {
				t.Fatal("injected failure must surface")
			}
			for _, table := range []string{"workspaces", "workspace_memberships", "workspace_member_setup",
				"workspace_member_preferences", "workspace_membership_agreement_audit", "channels", "channel_humans"} {
				if n := countRows(t, handle, `SELECT COUNT(*) FROM `+table); n != 0 {
					t.Fatalf("%s left %d rows in %s after rollback", tc.name, n, table)
				}
			}
		})
	}
}
