// Attach authorization matrix over real SQLite: role gates, enumeration
// folding, collision policy, transactional machine link and cross-workspace
// isolation.
package computer

import (
	"context"
	"errors"
	"testing"
)

func TestAttachRoleGatesAndCloaking(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedUser(t, "admin")
	f.seedUser(t, "member")
	f.seedUser(t, "outsider")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")
	f.seedMembership(t, "w1", "admin", "admin")
	f.seedMembership(t, "w1", "member", "member")

	// Non-member, unknown slug and deleted workspace all collapse to
	// not_authorized (anti-enumeration).
	for _, tc := range []struct{ user, slug, want string }{
		{"outsider", "alpha", AttachNotAuthorized},
		{"owner", "ghost", AttachNotAuthorized},
		{"member", "alpha", AttachRequiresAdmin},
	} {
		_, err := f.store.AttachComputer(ctx, tc.user, tc.slug, "host")
		var ae *AttachError
		if !errors.As(err, &ae) || ae.Code != tc.want {
			t.Fatalf("%s/%s: got %v, want %s", tc.user, tc.slug, err, tc.want)
		}
	}

	// Admin attaches; the same display name for the same user collides.
	first, err := f.store.AttachComputer(ctx, "admin", "alpha", "Lab-Mac")
	if err != nil {
		t.Fatalf("admin attach: %v", err)
	}
	if _, err := f.store.AttachComputer(ctx, "admin", "alpha", "Lab-Mac"); errors.As(err, new(*AttachError)) {
		var ae *AttachError
		_ = errors.As(err, &ae)
		if ae.Code != AttachNameCollision {
			t.Fatalf("collision code = %s", ae.Code)
		}
	} else {
		t.Fatalf("duplicate attach want collision, got %v", err)
	}

	// The computer row and its machine link were written in ONE transaction:
	// both rows exist, the machine carries a real (discarded) credential.
	var machineID string
	var machineHash string
	if err := f.db.QueryRow(`SELECT machine_id FROM computers WHERE id = ?`, first.ServerMachineID).
		Scan(&machineID); err != nil {
		t.Fatalf("computer link: %v", err)
	}
	if machineID != first.MachineID {
		t.Fatalf("link = %s, want %s", machineID, first.MachineID)
	}
	if err := f.db.QueryRow(`SELECT api_key_hash FROM machines WHERE id = ?`, machineID).Scan(&machineHash); err != nil || machineHash == "" {
		t.Fatalf("machine credential hash missing: %v", err)
	}
	// The raw machine key was discarded: nothing outside the transaction can
	// know it, and the machine authenticates as a machine-plane member only.
	if p, err := f.store.Authenticate(ctx, first.APIKey); err != nil || p.MachineID != first.MachineID {
		t.Fatalf("computer key must resolve through the linked machine: %+v %v", p, err)
	}

	// Cross-workspace isolation: another workspace cannot see w1 machines.
	f.seedUser(t, "owner2")
	f.seedWorkspace(t, "w2", "beta", "owner2")
	f.seedMembership(t, "w2", "owner2", "owner")
	if _, err := f.store.RotateMachineKey(ctx, "w2", machineID, "owner2", "owner"); !errors.Is(err, ErrMachineNotFound) {
		t.Fatalf("cross-workspace rotate = %v, want ErrMachineNotFound", err)
	}
	entries, err := f.store.ListLegacyMachineRoster(ctx, "owner2", "beta", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("w2 roster leaked w1 machines: %+v", entries)
	}

	// Deleted workspace folds to not_authorized.
	f.seedWorkspace(t, "w3", "gamma", "owner")
	f.seedMembership(t, "w3", "owner", "owner")
	if _, err := f.db.Exec(`UPDATE workspaces SET deleted_at = 1 WHERE id = 'w3'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AttachComputer(ctx, "owner", "gamma", "host"); !errors.As(err, new(*AttachError)) {
		t.Fatalf("deleted workspace attach = %v", err)
	}
}

func TestLegacyRosterFilterContract(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "owner")
	f.seedWorkspace(t, "w1", "alpha", "owner")
	f.seedMembership(t, "w1", "owner", "owner")

	withFp, err := f.store.RegisterMachine(ctx, "w1", "owner", "has-fp")
	if err != nil {
		t.Fatal(err)
	}
	// A pre-handshake row without a fingerprint (M2-shaped fixture row).
	if _, err := f.db.Exec(`INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('legacy-null-fp', 'w1', 'owner', 'no-fp', 1)`); err != nil {
		t.Fatal(err)
	}
	// A migrated row keeps its fingerprint and reports the migration time.
	migrated, err := f.store.RegisterMachine(ctx, "w1", "owner", "migrated")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE machines SET legacy_key_migrated_at = ? WHERE id = ?`,
		f.fixed.Now().UnixMilli(), machineIDOf(t, migrated)); err != nil {
		t.Fatal(err)
	}

	// Default roster: fingerprint rows only (NULL rows cannot intersect).
	entries, err := f.store.ListLegacyMachineRoster(ctx, "owner", "alpha", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("default roster = %d entries, want 2 (with-fp + migrated): %+v", len(entries), entries)
	}
	for _, e := range entries {
		if e.APIKeyFingerprint == nil || !e.HasFingerprint {
			t.Fatalf("default roster entry must carry the fingerprint: %+v", e)
		}
		if e.DaemonID == "legacy-null-fp" {
			t.Fatal("NULL-fingerprint row leaked into the default roster")
		}
	}

	// includeAll adds the NULL row and redacts fingerprint bytes for ALL rows.
	all, err := f.store.ListLegacyMachineRoster(ctx, "owner", "alpha", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("includeAll roster = %d entries, want 3", len(all))
	}
	for _, e := range all {
		if e.APIKeyFingerprint != nil {
			t.Fatalf("includeAll must redact fingerprints: %+v", e)
		}
	}

	// lastSeenAt/legacyKeyMigratedAt wire shape.
	var migratedEntry *LegacyRosterEntry
	for i := range all {
		if all[i].DaemonID == machineIDOf(t, migrated) {
			migratedEntry = &all[i]
		}
	}
	if migratedEntry == nil || migratedEntry.LegacyKeyMigratedAt == nil {
		t.Fatalf("migrated entry missing timestamp: %+v", migratedEntry)
	}
	if want := machineIDOf(t, migrated); migratedEntry.DaemonID != want {
		t.Fatalf("daemonId = %s, want %s", migratedEntry.DaemonID, want)
	}
	_ = withFp
}
