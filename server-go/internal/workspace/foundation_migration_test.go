package workspace_test

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

// openRawSQLite opens the file with the production pragmas but without the
// migration chain, so a fixture can construct an older schema by hand.
// The driver is registered through the platform/db import.
func openRawSQLite(t *testing.T, path string) *sql.DB {
	t.Helper()
	q := url.Values{}
	q.Set("_txlock", "immediate")
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "foreign_keys(1)")
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: q.Encode()}
	handle, err := sql.Open("sqlite", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	return handle
}

// TestM1DataUpgradesThroughFoundationMigration builds a genuine M1 database
// (only 0001 applied, default-owner memberships included), then upgrades via
// db.Open and asserts rows survive, defaults change for FUTURE inserts only,
// and referential integrity holds (T06 slice for the foundation migration).
func TestM1DataUpgradesThroughFoundationMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "raft.db")
	raw := openRawSQLite(t, path)

	m1SQL, err := os.ReadFile(filepath.Join("..", "platform", "db", "migrations", "0001_init.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(string(m1SQL)); err != nil {
		t.Fatalf("apply 0001: %v", err)
	}
	if _, err := raw.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO schema_migrations(version, applied_at) VALUES ('0001_init.sql', 1)`); err != nil {
		t.Fatal(err)
	}
	// M1-shaped data: two users, one workspace, an owner row created by the
	// M1 default (INSERT omitting role) and an explicit member row.
	for _, id := range []string{"legacy-owner", "legacy-member"} {
		if _, err := raw.Exec(`
			INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
			VALUES (?, ?, ?, 'hash', 11, 11)`,
			id, id+"@legacy.test", id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`
		INSERT INTO workspaces (id, name, slug, owner_id, hide_humans_from_members, plan, created_at)
		VALUES ('legacy-ws', 'Legacy', 'legacy-ws', 'legacy-owner', 0, 'free', 22)`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, joined_at) VALUES ('legacy-ws', 'legacy-owner', 33)`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES ('legacy-ws', 'legacy-member', 'member', 44)`); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	// Upgrade: Open applies the whole remaining chain (0002, 0003, ...).
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	// Rows preserved byte-for-byte: existing owner roles are NOT downgraded.
	rows, err := handle.Query(`SELECT user_id, role FROM workspace_memberships ORDER BY joined_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var userID, role string
		if err := rows.Scan(&userID, &role); err != nil {
			t.Fatal(err)
		}
		got[userID] = role
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if got["legacy-owner"] != "owner" || got["legacy-member"] != "member" {
		t.Fatalf("legacy roles must be preserved: %+v", got)
	}

	// New columns read with their TS defaults on legacy rows.
	var kind string
	var greeting, publiclyVisible, translation, progress int
	var updatedAt sql.NullInt64
	if err := handle.QueryRow(`
		SELECT kind, agent_all_channel_greeting_enabled, publicly_visible,
		       translation_enabled, progress_announcements_enabled, updated_at
		FROM workspaces WHERE id = 'legacy-ws'`).
		Scan(&kind, &greeting, &publiclyVisible, &translation, &progress, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if kind != "normal" || greeting != 1 || publiclyVisible != 0 || translation != 0 || progress != 0 {
		t.Fatalf("legacy column defaults wrong: %q %d %d %d %d", kind, greeting, publiclyVisible, translation, progress)
	}
	if !updatedAt.Valid {
		t.Fatal("legacy workspaces must gain an updated_at")
	}

	// The default role changed for FUTURE inserts only (D05).
	seedUser(t, handle, "fresh-user")
	if _, err := handle.Exec(`
		INSERT INTO workspace_memberships (workspace_id, user_id, joined_at) VALUES ('legacy-ws', 'fresh-user', 66)`); err != nil {
		t.Fatal(err)
	}
	var defaultRole string
	if err := handle.QueryRow(`SELECT role FROM workspace_memberships WHERE user_id = 'fresh-user'`).Scan(&defaultRole); err != nil {
		t.Fatal(err)
	}
	if defaultRole != "member" {
		t.Fatalf("future inserts must default to member, got %q", defaultRole)
	}

	// Referential integrity holds after the rebuild (the runner also checks
	// this before recording the migration; assert it independently).
	violations, err := handle.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer violations.Close()
	if violations.Next() {
		t.Fatal("foreign key violations after upgrade")
	}

	// Foundation tables exist and start empty.
	for _, table := range []string{"channels", "channel_humans", "workspace_membership_agreement_audit", "account_workspace_order"} {
		var n int
		if err := handle.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			t.Fatalf("table %s missing: %v", table, err)
		}
		if n != 0 {
			t.Fatalf("table %s must start empty, has %d rows", table, n)
		}
	}
	var applied int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied < 3 {
		t.Fatalf("upgrade must record the chain, got %d migrations", applied)
	}
}
