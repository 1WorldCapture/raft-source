// Upgrade compatibility: databases that predate 0007 (true M2 shape) must
// keep their identities and gain admission columns reading as "no
// credential"; migration application is idempotent through db.Open.
package computer

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"raft.local/server-go/internal/platform/db"
)

func TestUpgradeFromM2PreservesRowsAndAddsColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raft.db")
	handle, err := db.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// True M2-shaped rows (pre-0007): machines/computers without any
	// credential columns carrying values.
	now := int64(1790000000000)
	if _, err := handle.Exec(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES ('u1','u1@x.test','u1','h',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES ('w1','WS','alpha','u1',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES ('w1','u1','owner',0,?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('m1','w1','u1','legacy-box',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO computers (id, workspace_id, name, created_at)
		VALUES ('c1','w1','legacy-computer',?)`, now); err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen = upgrade path (0007 applies on the existing database).
	handle, err = db.Open(path)
	if err != nil {
		t.Fatalf("reopen/upgrade: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	// Rows survive with identities intact.
	var machineCount, computerCount int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM machines WHERE id = 'm1' AND name = 'legacy-box'`).Scan(&machineCount); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT COUNT(*) FROM computers WHERE id = 'c1'`).Scan(&computerCount); err != nil {
		t.Fatal(err)
	}
	if machineCount != 1 || computerCount != 1 {
		t.Fatalf("upgrade lost rows: machines=%d computers=%d", machineCount, computerCount)
	}
	// New columns exist and read as "no credential".
	var hash sql.NullString
	var migrated sql.NullInt64
	if err := handle.QueryRow(`SELECT api_key_hash, legacy_key_migrated_at FROM machines WHERE id = 'm1'`).Scan(&hash, &migrated); err != nil {
		t.Fatalf("machines admission columns: %v", err)
	}
	if hash.Valid || migrated.Valid {
		t.Fatal("pre-admission rows must read as credential-less")
	}
	if err := handle.QueryRow(`SELECT api_key_hash FROM computers WHERE id = 'c1'`).Scan(&hash); err != nil {
		t.Fatalf("computers admission columns: %v", err)
	}
	if hash.Valid {
		t.Fatal("pre-admission computer must read as credential-less")
	}

	// A pre-existing NULL-fingerprint row never joins the roster
	// intersection, and the roster still answers.
	store, err := NewStore(handle, Options{
		DeviceCodePepper: []byte(testPepper),
		Argon:            fastArgon(),
	})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := store.ListLegacyMachineRoster(context.Background(), "u1", "alpha", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("NULL-fingerprint row must not intersect: %+v", entries)
	}
	// ...but it is visible with includeAll (manual pick), fingerprint redacted.
	all, err := store.ListLegacyMachineRoster(context.Background(), "u1", "alpha", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].APIKeyFingerprint != nil || all[0].HasFingerprint {
		t.Fatalf("includeAll shape after upgrade: %+v", all)
	}
}
