package workspace_test

import (
	"testing"

	"raft.local/server-go/internal/workspace"
)

// D02's proposed all-conflicts-to-409 repair was not approved in the design.
// Keep the soft-deleted slug reserved without silently changing its error path.
func TestM2DeletedSlugRemainsReservedWithoutUnapprovedConflictRepair(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	first, err := store.CreateWorkspace(t.Context(), "user-a", "Original", "reserved-slug")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 1 WHERE id = ?`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(t.Context(), "user-a", "Replacement", "reserved-slug"); err == nil || workspace.AsDomainError(err) != nil {
		t.Fatalf("deleted-slug collision must remain a legacy failed insert, got %v", err)
	}
	for table, want := range map[string]int{
		"workspaces": 1, "workspace_memberships": 1, "workspace_member_setup": 1,
		"workspace_member_preferences": 1, "workspace_membership_agreement_audit": 1, "channels": 2,
	} {
		if got := countRows(t, handle, `SELECT COUNT(*) FROM `+table); got != want {
			t.Fatalf("failed replacement changed %s: got %d rows, want %d", table, got, want)
		}
	}
}
