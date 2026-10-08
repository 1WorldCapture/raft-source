// Behavioral tests for the M2 member directory (GET /api/servers/:id/members):
// email visibility by role, the hidden human directory, guest rejection,
// workspace isolation and joinedAt ordering.
package workspace_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"raft.local/server-go/internal/workspace"
)

func memberGravatar(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}

func mustListMembers(t *testing.T, store *workspace.Store, workspaceID, userID string) []map[string]any {
	t.Helper()
	out, err := store.ListMembers(context.Background(), workspaceID, userID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	return out
}

func TestListMembersEmailVisibilityByRole(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a") // owner-a@example.test
	seedUser(t, handle, "admin-d")
	seedUser(t, handle, "member-m")
	seedUser(t, handle, "member-n")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "admin-d", "admin", 20)
	m2sMembership(t, handle, record.ID, "member-m", "member", 30)
	m2sMembership(t, handle, record.ID, "member-n", "member", 40)

	emailOf := func(row map[string]any) any { return row["email"] }
	byUser := func(rows []map[string]any) map[string]map[string]any {
		out := map[string]map[string]any{}
		for _, row := range rows {
			out[row["userId"].(string)] = row
		}
		return out
	}

	// Owner and admin see every member's email.
	for _, viewer := range []string{"owner-a", "admin-d"} {
		rows := byUser(mustListMembers(t, store, record.ID, viewer))
		if len(rows) != 4 {
			t.Fatalf("%s sees 4 members, got %d", viewer, len(rows))
		}
		for id := range rows {
			if emailOf(rows[id]) != id+"@example.test" {
				t.Fatalf("%s must see %s email, got %v", viewer, id, emailOf(rows[id]))
			}
		}
	}

	// Ordinary member: own email visible, everyone else's null.
	rows := byUser(mustListMembers(t, store, record.ID, "member-m"))
	for id, row := range rows {
		want := any(nil)
		if id == "member-m" {
			want = "member-m@example.test"
		}
		if emailOf(row) != want {
			t.Fatalf("member view of %s: email got %v want %v", id, emailOf(row), want)
		}
	}

	// gravatarHash is always the hash of the real email, hidden or not.
	for id, row := range rows {
		if row["gravatarHash"] != memberGravatar(id+"@example.test") {
			t.Fatalf("gravatarHash of %s must use the real email", id)
		}
	}
}

func TestListMembersFieldSetAndOrdering(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	// Creation stamps the owner at the fixed clock; the member joins later.
	m2sMembership(t, handle, record.ID, "member-m", "member", fixedBase.UnixMilli()+60000)

	rows := mustListMembers(t, store, record.ID, "owner-a")
	if len(rows) != 2 {
		t.Fatalf("2 members, got %d", len(rows))
	}
	for _, row := range rows {
		for _, key := range []string{"userId", "email", "name", "displayName", "description",
			"avatarUrl", "role", "joinedAt", "gravatarHash"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("member row missing %q: %#v", key, row)
			}
		}
	}
	// joinedAt ordering (seeded owner first); fixtures pin distinct times.
	if rows[0]["userId"] != "owner-a" || rows[1]["userId"] != "member-m" {
		t.Fatalf("joinedAt ordering broken: %#v", rows)
	}
	// Creation-time null profile columns stay null, not absent/empty.
	member := rows[1]
	if member["displayName"] != nil || member["description"] != nil || member["avatarUrl"] != nil {
		t.Fatalf("unset profile columns must be null: %#v", member)
	}
	if member["joinedAt"] != "2026-10-08T12:01:00.000Z" {
		t.Fatalf("joinedAt ms formatting: got %v", member["joinedAt"])
	}
}

func TestListMembersHiddenHumanDirectory(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "member-m")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "member-m", "member", 20)

	if _, err := handle.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = ?`, record.ID); err != nil {
		t.Fatal(err)
	}

	// Ordinary member: directory limited to self.
	rows := mustListMembers(t, store, record.ID, "member-m")
	if len(rows) != 1 || rows[0]["userId"] != "member-m" {
		t.Fatalf("hidden directory must limit member to self: %#v", rows)
	}

	// Owner and admin keep the full management directory.
	for _, viewer := range []string{"owner-a"} {
		rows := mustListMembers(t, store, record.ID, viewer)
		if len(rows) != 2 {
			t.Fatalf("%s must still see the full directory, got %d rows", viewer, len(rows))
		}
	}
}

func TestListMembersGuestAndMembershipGates(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "guest-g")
	seedUser(t, handle, "outsider")
	store, _ := newTestStore(handle, workspace.Policy{})
	record := mustCreate(t, store, "owner-a", "alpha-team")
	m2sMembership(t, handle, record.ID, "guest-g", "guest", 20)
	ctx := context.Background()

	// Guests are rejected by this endpoint itself (not just middleware).
	_, err := store.ListMembers(ctx, record.ID, "guest-g")
	de := domainError(t, err)
	if de.Code != "FORBIDDEN" || de.Message != "Guests cannot access server management data" {
		t.Fatalf("guest: got %v/%q", de.Code, de.Message)
	}

	// Non-member and soft-deleted workspace both read as Server not found.
	_, err = store.ListMembers(ctx, record.ID, "outsider")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("non-member: got %v/%q", de.Code, de.Message)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 9 WHERE id = ?`, record.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.ListMembers(ctx, record.ID, "owner-a")
	de = domainError(t, err)
	if de.Code != "NOT_FOUND" || de.Message != "Server not found" {
		t.Fatalf("deleted workspace: got %v/%q", de.Code, de.Message)
	}
}

func TestListMembersWorkspaceIsolation(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-a")
	seedUser(t, handle, "owner-b")
	seedUser(t, handle, "member-m")
	store, _ := newTestStore(handle, workspace.Policy{})
	alpha := mustCreate(t, store, "owner-a", "alpha-team")
	beta := mustCreate(t, store, "owner-b", "beta-team")
	m2sMembership(t, handle, alpha.ID, "member-m", "member", 20)

	rows := mustListMembers(t, store, alpha.ID, "owner-a")
	if len(rows) != 2 {
		t.Fatalf("alpha directory must not leak beta members: %#v", rows)
	}
	rows = mustListMembers(t, store, beta.ID, "owner-b")
	if len(rows) != 1 || rows[0]["userId"] != "owner-b" {
		t.Fatalf("beta directory must not leak alpha members: %#v", rows)
	}
}
