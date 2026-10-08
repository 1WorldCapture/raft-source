package workspace_test

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/workspace"
)

// TestGetOrderDefaults: no saved row → join order with version 0.
func TestGetOrderDefaults(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, fixed := newTestStore(handle, workspace.Policy{})
	first := mustCreate(t, store, "user-a", "order-one")
	fixed.Advance(time.Second)
	second := mustCreate(t, store, "user-a", "order-two")

	order, err := store.GetOrder(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if order.ServerOrderVersion != 0 || len(order.ServerOrder) != 2 ||
		order.ServerOrder[0] != first.ID || order.ServerOrder[1] != second.ID {
		t.Fatalf("default order wrong: %+v", order)
	}
	// A user without memberships gets an empty array, not null.
	empty, err := store.GetOrder(t.Context(), "user-b")
	if err != nil {
		t.Fatal(err)
	}
	if empty.ServerOrder == nil || len(empty.ServerOrder) != 0 || empty.ServerOrderVersion != 0 {
		t.Fatalf("empty order must be [] with version 0: %+v", empty)
	}
}

// TestUpdateOrderFiltersDedupAppendsAndVersions mirrors the TS semantics
// (T09 slice): foreign/unknown IDs silently filtered, duplicates collapsed,
// missing memberships appended, version bumped only on a real change.
func TestUpdateOrderFiltersDedupAppendsAndVersions(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	seedUser(t, handle, "user-b")
	store, fixed := newTestStore(handle, workspace.Policy{})
	first := mustCreate(t, store, "user-a", "uo-one")
	fixed.Advance(time.Second)
	second := mustCreate(t, store, "user-a", "uo-two")
	foreign := mustCreate(t, store, "user-b", "uo-foreign")

	// First update whose effective order equals the current one: no bump.
	order, err := store.UpdateOrder(t.Context(), "user-a", []string{first.ID, second.ID})
	if err != nil {
		t.Fatal(err)
	}
	if order.ServerOrderVersion != 0 {
		t.Fatalf("effective no-op must not bump the version: %+v", order)
	}
	_ = foreign

	order, err = store.UpdateOrder(t.Context(), "user-a", []string{foreign.ID, second.ID, second.ID, "missing", first.ID, first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if order.ServerOrderVersion != 1 {
		t.Fatalf("real change must bump the version: %+v", order)
	}
	want := []string{second.ID, first.ID}
	if len(order.ServerOrder) != 2 || order.ServerOrder[0] != want[0] || order.ServerOrder[1] != want[1] {
		t.Fatalf("filtered order wrong: %+v", order)
	}

	// Repeating the effective order is again a no-op.
	same, err := store.UpdateOrder(t.Context(), "user-a", []string{second.ID, first.ID, first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if same.ServerOrderVersion != 1 {
		t.Fatalf("repeated order must keep the version: %+v", same)
	}

	// A later real change bumps again; the persisted state survives a reopen.
	if _, err := store.UpdateOrder(t.Context(), "user-a", []string{first.ID, second.ID}); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.GetOrder(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if reopened.ServerOrderVersion != 2 || reopened.ServerOrder[0] != first.ID {
		t.Fatalf("persisted order wrong: %+v", reopened)
	}
}

// TestUpdateOrderRejectsNothingForForeignIDs is the explicit non-403 rule:
// submitting another user's workspace is filtered, not forbidden.
func TestUpdateOrderRejectsNothingForForeignIDs(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	seedUser(t, handle, "user-b")
	store, _ := newTestStore(handle, workspace.Policy{})
	foreign := mustCreate(t, store, "user-b", "only-foreign")
	order, err := store.UpdateOrder(t.Context(), "user-a", []string{foreign.ID})
	if err != nil {
		t.Fatalf("foreign IDs must be filtered, not rejected: %v", err)
	}
	if len(order.ServerOrder) != 0 || order.ServerOrderVersion != 0 {
		t.Fatalf("no memberships and a no-op change: %+v", order)
	}
	_ = foreign
}

// TestUpdateOrderCorruptSavedJSONDegradesToJoinOrder: a non-array or
// mixed-type payload reads as "no saved order" (TS toStringArray), never as
// an error and never as leaked foreign IDs.
func TestUpdateOrderCorruptSavedJSONDegradesToJoinOrder(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	first := mustCreate(t, store, "user-a", "corrupt-one")

	for _, payload := range []string{`{"not":"an array"}`, `[1, true, null]`, `not json at all`} {
		if _, err := handle.Exec(`
			INSERT INTO account_workspace_order (user_id, server_order, version, updated_at)
			VALUES ('user-a', ?, 42, 1)
			ON CONFLICT(user_id) DO UPDATE SET server_order = excluded.server_order`,
			payload); err != nil {
			t.Fatal(err)
		}
		order, err := store.GetOrder(t.Context(), "user-a")
		if err != nil {
			t.Fatalf("corrupt payload %q must degrade, not error: %v", payload, err)
		}
		if len(order.ServerOrder) != 1 || order.ServerOrder[0] != first.ID {
			t.Fatalf("corrupt payload %q must fall back to join order: %+v", payload, order)
		}
		if order.ServerOrderVersion != 42 {
			t.Fatalf("version survives payload corruption: %+v", order)
		}
	}
	// Mixed arrays keep only the string entries.
	if _, err := handle.Exec(`
		UPDATE account_workspace_order SET server_order = ? WHERE user_id = 'user-a'`,
		`[7, "garbage-id", false, `+jsonString(first.ID)+`]`); err != nil {
		t.Fatal(err)
	}
	order, err := store.GetOrder(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(order.ServerOrder) != 1 || order.ServerOrder[0] != first.ID {
		t.Fatalf("non-string entries must be dropped: %+v", order)
	}
}

func jsonString(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

// TestUpdateOrderConcurrentVersionsStayMonotonic: concurrent distinct updates
// serialize in the transaction; every real change bumps exactly once and no
// version is lost (design D08).
func TestUpdateOrderConcurrentVersionsStayMonotonic(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, fixed := newTestStore(handle, workspace.Policy{})
	a := mustCreate(t, store, "user-a", "race-a")
	fixed.Advance(time.Second)
	b := mustCreate(t, store, "user-a", "race-b")
	fixed.Advance(time.Second)
	c := mustCreate(t, store, "user-a", "race-c")
	// Join order is now deterministically [a, b, c]; none of the permutations
	// below equals it, so every concurrent transaction sees a real change.

	// All four permutations differ from the join order AND from each other, so
	// whichever transaction runs last still sees a real change: the final
	// version is deterministic.
	permutations := [][]string{
		{a.ID, c.ID, b.ID},
		{b.ID, a.ID, c.ID},
		{b.ID, c.ID, a.ID},
		{c.ID, a.ID, b.ID},
	}
	var wg sync.WaitGroup
	errs := make(chan error, len(permutations))
	for _, perm := range permutations {
		wg.Add(1)
		go func(ids []string) {
			defer wg.Done()
			_, err := store.UpdateOrder(t.Context(), "user-a", ids)
			errs <- err
		}(perm)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent update failed: %v", err)
		}
	}
	final, err := store.GetOrder(t.Context(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if final.ServerOrderVersion != int64(len(permutations)) {
		t.Fatalf("version = %d, want %d (no lost updates)", final.ServerOrderVersion, len(permutations))
	}
	if len(final.ServerOrder) != 3 {
		t.Fatalf("final order must hold all memberships: %+v", final)
	}
}
