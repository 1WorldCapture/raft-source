package workspace_test

import (
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/workspace"
)

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// TestUpdateProfileCapabilities: owner/admin may edit, member/guest and
// non-members may not, with the legacy sentence (T10 slice).
func TestUpdateProfileCapabilities(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-u")
	seedUser(t, handle, "admin-u")
	seedUser(t, handle, "member-u")
	seedUser(t, handle, "guest-u")
	seedUser(t, handle, "stranger-u")
	store, _ := newTestStore(handle, workspace.Policy{})
	created := mustCreate(t, store, "owner-u", "profile-ws")
	for _, role := range []string{"admin", "member", "guest"} {
		if _, err := handle.Exec(`
			INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, 2)`, created.ID, role+"-u", role); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{Name: strPtr("By owner")}); err != nil {
		t.Fatalf("owner update failed: %v", err)
	}
	if _, err := store.UpdateProfile(t.Context(), created.ID, "admin-u", workspace.ProfilePatch{Name: strPtr("By admin")}); err != nil {
		t.Fatalf("admin update failed: %v", err)
	}
	for _, userID := range []string{"member-u", "guest-u", "stranger-u"} {
		_, err := store.UpdateProfile(t.Context(), created.ID, userID, workspace.ProfilePatch{Name: strPtr("no")})
		de := domainError(t, err)
		if de.Code != workspace.CodeForbidden ||
			de.Message != "Only server owners and admins can edit the server profile" {
			t.Fatalf("%s: got %s/%q", userID, de.Code, de.Message)
		}
	}
}

// TestUpdateProfileValidation covers the PATCH-only name rules, including the
// UTF-16 boundary, and the at-least-one-field requirement.
func TestUpdateProfileValidation(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-u")
	store, fixed := newTestStore(handle, workspace.Policy{})
	created := mustCreate(t, store, "owner-u", "valid-ws")

	cases := []struct {
		label, name, message string
	}{
		{"whitespace only", "  \t\n ", "Name is required"},
		{"101 ascii", strings.Repeat("x", 101), "Name must be 100 characters or fewer"},
		{"astral 51", strings.Repeat("\U0001F600", 51), "Name must be 100 characters or fewer"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			_, err := store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{Name: strPtr(tc.name)})
			de := domainError(t, err)
			if de.Code != workspace.CodeInvalidInput || de.Message != tc.message {
				t.Fatalf("got %s/%q, want INVALID_INPUT/%q", de.Code, de.Message, tc.message)
			}
		})
	}
	// Absent fields: not an error of the name rules but the field requirement.
	_, err := store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{})
	de := domainError(t, err)
	if de.Code != workspace.CodeInvalidInput || de.Message != "At least one field is required" {
		t.Fatalf("got %s/%q", de.Code, de.Message)
	}

	// 50 astral chars = exactly 100 UTF-16 units: accepted, stored trimmed.
	fixed.Advance(time.Second)
	updated, err := store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{
		Name:                  strPtr("  " + strings.Repeat("\U0001F600", 50) + "  "),
		HideHumansFromMembers: boolPtr(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != strings.Repeat("\U0001F600", 50) {
		t.Fatalf("name must be trimmed before storing: %q", updated.Name)
	}
	if !updated.HideHumansFromMembers {
		t.Fatal("hideHumansFromMembers must persist as true")
	}
	if !updated.CreatedAt.Equal(fixedBase) {
		t.Fatalf("createdAt must never change: %v", updated.CreatedAt)
	}
	if !updated.UpdatedAt.After(updated.CreatedAt) {
		t.Fatalf("updatedAt must refresh: %v", updated.UpdatedAt)
	}
	// false stays a real value, not a null-ish reset.
	updated, err = store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{HideHumansFromMembers: boolPtr(false)})
	if err != nil {
		t.Fatal(err)
	}
	if updated.HideHumansFromMembers {
		t.Fatal("hideHumansFromMembers=false must persist")
	}
	// Only name/hideHumansFromMembers are writable: slug and owner survive.
	if updated.Slug != "valid-ws" || updated.OwnerID != "owner-u" || updated.Plan != "free" {
		t.Fatalf("immutable fields changed: %+v", updated)
	}
}

// TestUpdateProfileDeletedWorkspaceIsForbidden: a deleted workspace has no
// roles left, so the capability answer is the legacy 403 sentence.
func TestUpdateProfileDeletedWorkspaceIsForbidden(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-u")
	store, _ := newTestStore(handle, workspace.Policy{})
	created := mustCreate(t, store, "owner-u", "doomed-ws")
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 7 WHERE id = ?`, created.ID); err != nil {
		t.Fatal(err)
	}
	_, err := store.UpdateProfile(t.Context(), created.ID, "owner-u", workspace.ProfilePatch{Name: strPtr("x")})
	de := domainError(t, err)
	if de.Code != workspace.CodeForbidden {
		t.Fatalf("got %s/%q", de.Code, de.Message)
	}
}

// TestSetAvatar stores and clears the reference with capability checks.
func TestSetAvatar(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "owner-u")
	seedUser(t, handle, "member-u")
	store, fixed := newTestStore(handle, workspace.Policy{})
	created := mustCreate(t, store, "owner-u", "avatar-ws")
	fixed.Advance(time.Second)
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, 'member-u', 'member', 0, 3)`, created.ID); err != nil {
		t.Fatal(err)
	}

	updated, err := store.SetAvatar(t.Context(), created.ID, "owner-u", "/avatars/ws-avatar-1")
	if err != nil {
		t.Fatal(err)
	}
	if updated.AvatarURL == nil || *updated.AvatarURL != "/avatars/ws-avatar-1" {
		t.Fatalf("avatar URL not stored: %+v", updated.AvatarURL)
	}
	if !updated.UpdatedAt.After(updated.CreatedAt) {
		t.Fatal("avatar update must refresh updatedAt")
	}
	// Empty URL clears the reference to null.
	cleared, err := store.SetAvatar(t.Context(), created.ID, "owner-u", "")
	if err != nil {
		t.Fatal(err)
	}
	if cleared.AvatarURL != nil {
		t.Fatalf("empty URL must clear the reference: %+v", cleared.AvatarURL)
	}
	_, err = store.SetAvatar(t.Context(), created.ID, "member-u", "/avatars/nope")
	de := domainError(t, err)
	if de.Code != workspace.CodeForbidden {
		t.Fatalf("member avatar update must be forbidden, got %s", de.Code)
	}
	_, err = store.SetAvatar(t.Context(), "missing", "owner-u", "/avatars/x")
	de = domainError(t, err)
	if de.Code != workspace.CodeForbidden {
		t.Fatalf("unknown workspace must fail the capability check first, got %s", de.Code)
	}
}
