// Real-SQLite behavior tests for the admission store: authenticate lifecycle,
// attach authorization, legacy machine admission and the roster read.
package computer

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

const testPepper = "test-pepper-0123456789abcdef0123456789"

type fixture struct {
	t     *testing.T
	store *Store
	fixed *clock.Fixed
	db    *sql.DB
}

func fastArgon() Argon2Config { return Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1} }

func newFixture(t *testing.T) *fixture {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	store, err := NewStore(handle, Options{
		Clock:            &fixed,
		DeviceCodePepper: []byte(testPepper),
		Argon:            fastArgon(),
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	return &fixture{t: t, store: store, fixed: &fixed, db: handle}
}

func (f *fixture) seedUser(t *testing.T, id string) {
	t.Helper()
	now := f.fixed.Now().UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 'x', ?, ?)`, id, id+"@example.test", id, now, now); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) seedWorkspace(t *testing.T, id, slug, ownerID string) {
	t.Helper()
	if _, err := f.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, "WS "+id, slug, ownerID, f.fixed.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) seedMembership(t *testing.T, workspaceID, userID, role string) {
	t.Helper()
	if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspaceID, userID, role, f.fixed.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func wantAuthReason(t *testing.T, err error, reason, stage string) {
	t.Helper()
	ae := AsAuthError(err)
	if ae == nil {
		t.Fatalf("want AuthError(%s), got %v", reason, err)
	}
	if ae.Reason != reason {
		t.Fatalf("reason = %s, want %s", ae.Reason, reason)
	}
	if stage != "" && ae.Stage != stage {
		t.Fatalf("stage = %s, want %s", ae.Stage, stage)
	}
}

func TestAuthenticateComputerLifecycle(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "u1")
	f.seedWorkspace(t, "w1", "alpha", "u1")
	f.seedMembership(t, "w1", "u1", "owner")

	attached, err := f.store.AttachComputer(ctx, "u1", "alpha", "Maria-laptop")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if attached.Resumed {
		t.Error("resumed must be false; attach never resumes by name")
	}
	if attached.ServerMachineID == "" || attached.MachineID == "" || attached.ServerMachineID == attached.MachineID {
		t.Fatalf("serverMachineId (%s) and machineId (%s) must be distinct non-empty ids", attached.ServerMachineID, attached.MachineID)
	}
	if !strings.HasPrefix(attached.APIKey, "sk_computer_") {
		t.Fatalf("apiKey prefix = %q", attached.APIKey[:12])
	}

	p, err := f.store.Authenticate(ctx, attached.APIKey)
	if err != nil {
		t.Fatalf("authenticate fresh key: %v", err)
	}
	if p.Kind != KindComputer || p.ComputerID != attached.ServerMachineID ||
		p.MachineID != attached.MachineID || p.WorkspaceID != "w1" || p.UserID != "" {
		t.Fatalf("principal = %+v", p)
	}

	// Wrong key with a valid prefix: uniform mismatch, no enumeration.
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, attached.APIKey+"ff"); return err }),
		ReasonComputerKeyMismatch, StageComputerLookup)

	// Revoke invalidates immediately (no cache to poison).
	if err := f.store.RevokeComputer(ctx, attached.ServerMachineID, "u1", "rotated_by_admin"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, attached.APIKey); return err }),
		ReasonComputerRevoked, StageComputerLookup)
	// Idempotent revoke.
	if err := f.store.RevokeComputer(ctx, attached.ServerMachineID, "u1", "again"); err != nil {
		t.Fatalf("revoke twice: %v", err)
	}

	// A fresh attach after revocation is allowed with the same display name.
	again, err := f.store.AttachComputer(ctx, "u1", "alpha", "Maria-laptop")
	if err != nil {
		t.Fatalf("re-attach after revoke: %v", err)
	}
	if _, err := f.store.Authenticate(ctx, again.APIKey); err != nil {
		t.Fatalf("authenticate re-attached: %v", err)
	}

	// Unlinked machine fails closed with the wire-terminal reason.
	if _, err := f.db.Exec(`UPDATE computers SET machine_id = NULL WHERE id = ?`, again.ServerMachineID); err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, again.APIKey); return err }),
		ReasonComputerMachineUnlinked, StageMachineLookup)

	// Soft-deleted workspace loses the principal.
	if _, err := f.db.Exec(`UPDATE computers SET machine_id = ? WHERE id = ?`, again.MachineID, again.ServerMachineID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE workspaces SET deleted_at = ? WHERE id = 'w1'`, f.fixed.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, again.APIKey); return err }),
		ReasonServerNotFound, StageServerLookup)
}

func TestAuthenticateFormatGates(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, ""); return err }),
		ReasonMissingKey, StageFormat)
	// sk_agent_* is a valid credential shape but the wrong machine-plane
	// principal: format denial on this seam, invalid_principal on the
	// computer HTTP surface.
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, "sk_agent_deadbeef"); return err }),
		ReasonInvalidKeyFormat, StageFormat)
	// Unknown prefix with no candidates.
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, "sk_computer_0000"); return err }),
		ReasonComputerNotFound, StageComputerLookup)
}

func TestAuthenticateLegacyMachineLifecycle(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "u1")
	f.seedUser(t, "u2")
	f.seedWorkspace(t, "w1", "alpha", "u1")
	f.seedMembership(t, "w1", "u1", "owner")
	f.seedMembership(t, "w1", "u2", "member")

	registered, err := f.store.RegisterMachine(ctx, "w1", "u1", "dev-box")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if !strings.HasPrefix(registered.APIKey, "sk_machine_") {
		t.Fatalf("machine key prefix: %q", registered.APIKey[:12])
	}

	p, err := f.store.Authenticate(ctx, registered.APIKey)
	if err != nil {
		t.Fatalf("authenticate machine key: %v", err)
	}
	if p.Kind != KindLegacyMachine || p.ComputerID != "" || p.MachineID != machineIDOf(t, registered) ||
		p.WorkspaceID != "w1" || p.UserID != "u1" {
		t.Fatalf("principal = %+v", p)
	}

	// Rotation retires the old key atomically.
	rotated, err := f.store.RotateMachineKey(ctx, "w1", machineIDOf(t, registered), "u2", "member")
	if err == nil || !errors.Is(err, ErrForbidden) {
		t.Fatalf("member rotate want ErrForbidden, got %v", err)
	}
	_ = rotated
	// The passed role string is not authority. Promote the live membership,
	// then rotate with a stale "member" argument; the committed role wins.
	if _, err := f.db.Exec(`UPDATE workspace_memberships SET role = 'admin' WHERE workspace_id = 'w1' AND user_id = 'u2'`); err != nil {
		t.Fatal(err)
	}
	rotated, err = f.store.RotateMachineKey(ctx, "w1", machineIDOf(t, registered), "u2", "member")
	if err != nil {
		t.Fatalf("admin rotate: %v", err)
	}
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, registered.APIKey); return err }),
		ReasonMachineKeyInvalid, StageMachineLookup)
	if _, err := f.store.Authenticate(ctx, rotated); err != nil {
		t.Fatalf("authenticate rotated: %v", err)
	}

	// Adoption marker retires the legacy key terminally.
	if _, err := f.db.Exec(`UPDATE machines SET legacy_key_migrated_at = ? WHERE id = ?`,
		f.fixed.Now().UnixMilli(), machineIDOf(t, registered)); err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, mustErr(t, func() error { _, err := f.store.Authenticate(ctx, rotated); return err }),
		ReasonLegacyKeyMigrated, StageLegacyMigration)

	// Cross-workspace rotation is a uniform miss.
	if _, err := f.store.RotateMachineKey(ctx, "w1", "not-a-machine", "u1", "owner"); !errors.Is(err, ErrMachineNotFound) {
		t.Fatalf("want ErrMachineNotFound, got %v", err)
	}
}

func machineIDOf(t *testing.T, registered MachineRegistered) string {
	t.Helper()
	id, _ := registered.ReadModel["id"].(string)
	if id == "" {
		t.Fatalf("read model id missing: %+v", registered.ReadModel)
	}
	return id
}

func mustErr(t *testing.T, fn func() error) error {
	t.Helper()
	err := fn()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	return err
}
