package computer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestRegisterAndRotateRevalidateLiveMembership(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedUser(t, "member")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")
	f.seedMembership(t, "w1", "member", "member")

	registered, err := f.store.RegisterMachine(ctx, "w1", "owner", "box")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	machineID := machineIDOf(t, registered)
	hash := machineHash(t, f.db, machineID)

	// A caller-supplied admin role must not authorize a live member, and must
	// not rotate the verifier.
	if _, err := f.store.RotateMachineKey(ctx, "w1", machineID, "member", "admin"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("stale admin role = %v, want ErrForbidden", err)
	}
	if got := machineHash(t, f.db, machineID); got != hash {
		t.Fatal("forbidden rotate changed the verifier")
	}
	if strings.Contains(errText(f.store.RotateMachineKey(ctx, "w1", machineID, "member", "admin")), "sk_") {
		t.Fatal("rotation error included key material")
	}

	// Demotion to guest removes creator authority as well. The row and verifier
	// stay put.
	if _, err := f.db.Exec(`UPDATE workspace_memberships SET role = 'guest' WHERE workspace_id = 'w1' AND user_id = 'owner'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RotateMachineKey(ctx, "w1", machineID, "owner", "owner"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest creator rotate = %v", err)
	}
	if got := machineHash(t, f.db, machineID); got != hash {
		t.Fatal("guest rotate changed the verifier")
	}
	kept := "box"
	if _, err := f.store.UpdateMachine(ctx, "w1", machineID, "owner", MachinePatch{Name: &kept}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest creator update = %v", err)
	}
	if err := f.store.DeleteMachine(ctx, "w1", machineID, "owner"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest creator delete = %v", err)
	}
	if !machineExists(t, f.db, machineID) {
		t.Fatal("guest delete removed the machine")
	}

	// The creator keeps rotate authority after demotion to member. The role
	// argument is still ignored.
	if _, err := f.db.Exec(`UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = 'w1' AND user_id = 'owner'`); err != nil {
		t.Fatal(err)
	}
	rotated, err := f.store.RotateMachineKey(ctx, "w1", machineID, "owner", "guest")
	if err != nil {
		t.Fatalf("creator rotate: %v", err)
	}
	if rotated == "" || rotated == registered.APIKey || strings.Contains(rotated, "\n") {
		t.Fatalf("rotated key shape rejected")
	}
	wantAuthReason(t, mustErr(t, func() error {
		_, err := f.store.Authenticate(ctx, registered.APIKey)
		return err
	}), ReasonMachineKeyInvalid, StageMachineLookup)
	if _, err := f.store.Authenticate(ctx, rotated); err != nil {
		t.Fatalf("new key: %v", err)
	}

	// Losing membership fails closed for both register and rotate, and does
	// not insert or replace a verifier.
	if _, err := f.db.Exec(`DELETE FROM workspace_memberships WHERE workspace_id = 'w1' AND user_id = 'owner'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RegisterMachine(ctx, "w1", "owner", "other"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("register after removal = %v, want ErrNotAuthorized", err)
	}
	var extra int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM machines WHERE name = 'other'`).Scan(&extra); err != nil || extra != 0 {
		t.Fatalf("unauthorized register inserted %d rows (%v)", extra, err)
	}
	hash = machineHash(t, f.db, machineID)
	if _, err := f.store.RotateMachineKey(ctx, "w1", machineID, "owner", "owner"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("rotate after removal = %v, want ErrNotAuthorized", err)
	}
	if got := machineHash(t, f.db, machineID); got != hash {
		t.Fatal("unauthorized rotate changed the verifier")
	}

	// A member of a different workspace does not learn that the machine exists.
	f.seedWorkspace(t, "w2", "beta", "member")
	if _, err := f.store.RotateMachineKey(ctx, "w2", machineID, "owner", "owner"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("cross-workspace non-member = %v, want ErrNotAuthorized", err)
	}
	f.seedMembership(t, "w2", "member", "admin")
	if _, err := f.store.RotateMachineKey(ctx, "w2", machineID, "member", "admin"); !errors.Is(err, ErrMachineNotFound) {
		t.Fatalf("machine in another workspace = %v, want ErrMachineNotFound", err)
	}
}

func TestRegisterRejectsMemberGuestAndDeadWorkspace(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedUser(t, "member")
	f.seedUser(t, "guest")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")
	f.seedMembership(t, "w1", "member", "member")
	f.seedMembership(t, "w1", "guest", "guest")

	if _, err := f.store.RegisterMachine(ctx, "w1", "member", "nope"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member register = %v", err)
	}
	if _, err := f.store.RegisterMachine(ctx, "w1", "guest", "nope"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest register = %v", err)
	}
	if _, err := f.store.RegisterMachine(ctx, "w1", "missing", "nope"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("non-member register = %v", err)
	}
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM machines`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rejected register left %d machines (%v)", n, err)
	}

	if _, err := f.db.Exec(`UPDATE workspaces SET kind = 'joint_storage' WHERE id = 'w1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RegisterMachine(ctx, "w1", "owner", "joint"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("joint_storage register = %v", err)
	}
	if _, err := f.db.Exec(`UPDATE workspaces SET kind = 'normal', deleted_at = 1 WHERE id = 'w1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RegisterMachine(ctx, "w1", "owner", "dead"); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("deleted workspace register = %v", err)
	}
}

func TestUpdateMachineCreatorCapabilityAndNullDescription(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedUser(t, "member")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")
	f.seedMembership(t, "w1", "member", "member")
	registered, err := f.store.RegisterMachine(ctx, "w1", "owner", "box")
	if err != nil {
		t.Fatal(err)
	}
	machineID := machineIDOf(t, registered)

	if _, err := f.db.Exec(`UPDATE workspace_memberships SET role = 'member' WHERE user_id = 'owner'`); err != nil {
		t.Fatal(err)
	}
	renamed := "renamed"
	updated, err := f.store.UpdateMachine(ctx, "w1", machineID, "owner", MachinePatch{Name: &renamed})
	if err != nil {
		t.Fatalf("creator update: %v", err)
	}
	if updated.Name != "renamed" || updated.Description != nil || updated.ServerID != "w1" || updated.UserID != "owner" {
		t.Fatalf("record = %+v", updated)
	}
	if updated.APIKeyPrefix == nil || strings.Contains(string(mustJSON(t, updated)), "apiKeyHash") || strings.Contains(string(mustJSON(t, updated)), "argon2") {
		t.Fatalf("update leaked verifier material: %s", mustJSON(t, updated))
	}

	if _, err := f.store.UpdateMachine(ctx, "w1", machineID, "member", MachinePatch{Name: &renamed}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-creator member = %v", err)
	}
	if _, err := f.db.Exec(`UPDATE workspace_memberships SET role = 'admin' WHERE user_id = 'member'`); err != nil {
		t.Fatal(err)
	}
	cleared, err := f.store.UpdateMachine(ctx, "w1", machineID, "member", MachinePatch{DescriptionSet: true})
	if err != nil {
		t.Fatalf("admin clear description: %v", err)
	}
	if cleared.Name != "renamed" || cleared.Description != nil {
		t.Fatalf("cleared = %+v", cleared)
	}
	note := "kept"
	if _, err := f.store.UpdateMachine(ctx, "w1", machineID, "member", MachinePatch{Description: &note, DescriptionSet: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`DELETE FROM workspace_memberships WHERE user_id = 'member'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.UpdateMachine(ctx, "w1", machineID, "member", MachinePatch{DescriptionSet: true}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("update after removal = %v", err)
	}
	var stored string
	if err := f.db.QueryRow(`SELECT description FROM machines WHERE id = ?`, machineID).Scan(&stored); err != nil || stored != "kept" {
		t.Fatalf("description after denied update = %q (%v)", stored, err)
	}
}

func TestDeleteMachineAssignedAgentsRevokeAndRollback(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedUser(t, "member")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")
	f.seedMembership(t, "w1", "member", "member")
	registered, err := f.store.RegisterMachine(ctx, "w1", "owner", "box")
	if err != nil {
		t.Fatal(err)
	}
	machineID := machineIDOf(t, registered)
	now := f.fixed.Now().UnixMilli()
	if _, err := f.db.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at)
		VALUES ('c-live', 'w1', 'box', 'owner', ?, ?)`, machineID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at, revoked_at, revoked_reason)
		VALUES ('c-old', 'w1', 'old', 'owner', ?, ?, ?, 'manual')`, machineID, now, now-10); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`
		INSERT INTO agents (id, workspace_id, name, status, runtime, machine_id, created_at, updated_at)
		VALUES ('a-live', 'w1', 'cindy', 'active', 'claude', ?, ?, ?)`, machineID, now, now); err != nil {
		t.Fatal(err)
	}

	err = f.store.DeleteMachine(ctx, "w1", machineID, "member")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-creator delete = %v", err)
	}
	err = f.store.DeleteMachine(ctx, "w1", machineID, "owner")
	var conflict *MachineDeleteConflictError
	if !errors.As(err, &conflict) || conflict.Code != MachineDeleteAssignedAgents || conflict.Error() != MachineDeleteAssignedAgentsMessage {
		t.Fatalf("assigned delete = %v", err)
	}
	if !machineExists(t, f.db, machineID) {
		t.Fatal("conflict deleted the machine")
	}
	var reason sql.NullString
	var revoked sql.NullInt64
	var link sql.NullString
	if err := f.db.QueryRow(`SELECT revoked_at, revoked_reason, machine_id FROM computers WHERE id = 'c-live'`).Scan(&revoked, &reason, &link); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid || reason.Valid || link.String != machineID {
		t.Fatalf("conflict revoked the computer: revoked=%v reason=%v link=%v", revoked, reason, link)
	}
	var agentMachine string
	if err := f.db.QueryRow(`SELECT machine_id FROM agents WHERE id = 'a-live'`).Scan(&agentMachine); err != nil || agentMachine != machineID {
		t.Fatalf("conflict detached the live agent: %q %v", agentMachine, err)
	}

	// A soft-deleted assignment is not a live binding and must not block.
	if _, err := f.db.Exec(`UPDATE agents SET deleted_at = ? WHERE id = 'a-live'`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`
		CREATE TRIGGER machine_delete_abort BEFORE DELETE ON machines
		BEGIN
			SELECT RAISE(ABORT, 'forced delete failure');
		END`); err != nil {
		t.Fatal(err)
	}
	if err := f.store.DeleteMachine(ctx, "w1", machineID, "owner"); err == nil || strings.Contains(err.Error(), "sk_") {
		t.Fatalf("forced delete failure = %v", err)
	}
	if !machineExists(t, f.db, machineID) {
		t.Fatal("failed delete committed")
	}
	if err := f.db.QueryRow(`SELECT revoked_at, machine_id FROM computers WHERE id = 'c-live'`).Scan(&revoked, &link); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid || link.String != machineID {
		t.Fatalf("revoke survived rollback: revoked=%v link=%v", revoked, link)
	}
	if _, err := f.db.Exec(`DROP TRIGGER machine_delete_abort`); err != nil {
		t.Fatal(err)
	}

	if err := f.store.DeleteMachine(ctx, "w1", machineID, "owner"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if machineExists(t, f.db, machineID) {
		t.Fatal("machine row survived delete")
	}
	if err := f.db.QueryRow(`SELECT revoked_at, revoked_reason, machine_id FROM computers WHERE id = 'c-live'`).Scan(&revoked, &reason, &link); err != nil {
		t.Fatal(err)
	}
	if !revoked.Valid || revoked.Int64 != now || reason.String != "machine_deleted" || link.Valid {
		t.Fatalf("live computer after delete: revoked=%v reason=%v link=%v", revoked, reason, link)
	}
	var oldReason string
	var oldRevoked int64
	if err := f.db.QueryRow(`SELECT revoked_at, revoked_reason FROM computers WHERE id = 'c-old'`).Scan(&oldRevoked, &oldReason); err != nil {
		t.Fatal(err)
	}
	if oldRevoked != now-10 || oldReason != "manual" {
		t.Fatalf("already-revoked computer was rewritten: at=%d reason=%s", oldRevoked, oldReason)
	}
	var leftover sql.NullString
	if err := f.db.QueryRow(`SELECT machine_id FROM agents WHERE id = 'a-live'`).Scan(&leftover); err != nil || leftover.Valid {
		t.Fatalf("soft-deleted agent binding after machine delete = %+v %v", leftover, err)
	}
}

func machineHash(t *testing.T, db *sql.DB, machineID string) string {
	t.Helper()
	var hash string
	if err := db.QueryRow(`SELECT api_key_hash FROM machines WHERE id = ?`, machineID).Scan(&hash); err != nil || hash == "" {
		t.Fatalf("hash for %s: %v", machineID, err)
	}
	return hash
}

func machineExists(t *testing.T, db *sql.DB, machineID string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM machines WHERE id = ?`, machineID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func errText(v any, err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
