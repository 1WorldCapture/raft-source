package workspace_test

import (
	"testing"
	"time"

	"raft.local/server-go/internal/workspace"
)

// TestListUserServersFiltersAndOrders covers eligibility, saved-order
// application and the stamped version (T08/T09 slices).
func TestListUserServersFiltersAndOrders(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	seedUser(t, handle, "user-b")
	store, fixed := newTestStore(handle, workspace.Policy{})

	first := mustCreate(t, store, "user-a", "first-ws")
	fixed.Advance(time.Second)
	second := mustCreate(t, store, "user-a", "second-ws")
	// A workspace of another user: not visible to user-a.
	foreign := mustCreate(t, store, "user-b", "foreign-ws")

	// Default: join order, version 0.
	list, err := store.ListUserServers(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("default list wrong: %+v", list)
	}
	for _, m := range list {
		if m.ServerOrderVersion != 0 {
			t.Fatalf("default version must be 0, got %d", m.ServerOrderVersion)
		}
		if m.Role != "owner" {
			t.Fatalf("role must come from the membership row, got %q", m.Role)
		}
	}
	_ = foreign

	// Saved order reorders the list and stamps the new version everywhere.
	if _, err := store.UpdateOrder(t.Context(), "user-a", []string{second.ID, first.ID}); err != nil {
		t.Fatal(err)
	}
	list, err = store.ListUserServers(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if list[0].ID != second.ID || list[1].ID != first.ID {
		t.Fatalf("saved order not applied: %+v", list)
	}
	if list[0].ServerOrderVersion != 1 || list[1].ServerOrderVersion != 1 {
		t.Fatalf("version must be stamped on every item: %+v", list)
	}
}

// TestListUserServersExcludesDeletedAndJointStorage pins eligibility.
func TestListUserServersExcludesDeletedAndJointStorage(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	normal := mustCreate(t, store, "user-a", "normal-ws")
	deleted := mustCreate(t, store, "user-a", "deleted-ws")
	joint := mustCreate(t, store, "user-a", "joint-ws")

	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`, 5, deleted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET kind = 'joint_storage' WHERE id = ?`, joint.ID); err != nil {
		t.Fatal(err)
	}
	list, err := store.ListUserServers(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != normal.ID {
		t.Fatalf("list must contain only the eligible workspace: %+v", list)
	}
	if n, err := store.CountMemberships(t.Context()); err != nil || n != 3 {
		t.Fatalf("CountMemberships = %d err %v (rows themselves stay)", n, err)
	}
}

// TestGetWorkspaceByIDOnly: detail is an ID lookup with no slug fallback.
func TestGetWorkspaceByIDOnly(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	created := mustCreate(t, store, "user-a", "slug-ws")

	record, err := store.GetWorkspace(t.Context(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != created.ID || record.Slug != "slug-ws" {
		t.Fatalf("unexpected record %+v", record)
	}
	if _, err := store.GetWorkspace(t.Context(), "slug-ws"); workspace.AsDomainError(err) == nil {
		t.Fatal("slug must not resolve as an ID")
	} else if de := workspace.AsDomainError(err); de.Code != workspace.CodeNotFound {
		t.Fatalf("slug lookup must be NOT_FOUND, got %s", de.Code)
	}
	de := workspace.AsDomainError(mustFail(t, func() error {
		_, err := store.GetWorkspace(t.Context(), "missing")
		return err
	}))
	if de == nil || de.Code != workspace.CodeNotFound || de.Message != "Server not found" {
		t.Fatalf("missing workspace error wrong: %+v", de)
	}
}

// TestGetMembershipFiltersAndForbidden covers the scope answer.
func TestGetMembershipFiltersAndForbidden(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	seedUser(t, handle, "user-b")
	store, _ := newTestStore(handle, workspace.Policy{})
	normal := mustCreate(t, store, "user-a", "member-ws")
	deleted := mustCreate(t, store, "user-a", "gone-ws")
	joint := mustCreate(t, store, "user-a", "joint-ws")
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 9 WHERE id = ?`, deleted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET kind = 'joint_storage' WHERE id = ?`, joint.ID); err != nil {
		t.Fatal(err)
	}

	membership, err := store.GetMembership(t.Context(), normal.ID, "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if membership.Role != "owner" || membership.ID != normal.ID || membership.OwnerID != "user-a" {
		t.Fatalf("membership wrong: %+v", membership)
	}
	for _, tc := range []struct {
		label, workspaceID, userID string
	}{{"non-member", normal.ID, "user-b"}, {"deleted workspace", deleted.ID, "user-a"}, {"joint storage", joint.ID, "user-a"}} {
		t.Run(tc.label, func(t *testing.T) {
			_, err := store.GetMembership(t.Context(), tc.workspaceID, tc.userID)
			de := domainError(t, err)
			if de.Code != workspace.CodeForbidden || de.Message != "Not a member of this server" {
				t.Fatalf("got %s/%q", de.Code, de.Message)
			}
		})
	}
}

func mustCreate(t *testing.T, store *workspace.Store, userID, slug string) workspace.ServerRecord {
	t.Helper()
	record, err := store.CreateWorkspace(t.Context(), userID, "Name "+slug, slug)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func mustFail(t *testing.T, fn func() error) error {
	t.Helper()
	err := fn()
	if err == nil {
		t.Fatal("expected an error")
	}
	return err
}
