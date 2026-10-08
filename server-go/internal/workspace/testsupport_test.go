package workspace_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

// fixedBase is the deterministic instant all store writes use.
var fixedBase = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

// newWorkspaceDB opens a fully migrated isolated SQLite database. Tests must
// depend on the production migration chain: no fallback or shadow schema may
// mask a missing migration, constraint, or setup/preferences table.
func newWorkspaceDB(t *testing.T) *sql.DB {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	return handle
}

// seedUser inserts the minimal M1 user row (creation only needs it to exist).
func seedUser(t *testing.T, handle *sql.DB, id string) {
	t.Helper()
	if _, err := handle.Exec(`
		INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, 1)`,
		id, id+"@example.test", id); err != nil {
		t.Fatal(err)
	}
}

// newTestStore builds a store over the fixed clock and the given policy.
func newTestStore(handle *sql.DB, policy workspace.Policy) (*workspace.Store, *clock.Fixed) {
	fixed := &clock.Fixed{T: fixedBase}
	return workspace.NewStoreWithOptions(handle, workspace.Options{
		Clock:  fixed,
		Policy: policy,
	}), fixed
}

// domainError asserts err is a DomainError and returns it.
func domainError(t *testing.T, err error) *workspace.DomainError {
	t.Helper()
	de := workspace.AsDomainError(err)
	if de == nil {
		t.Fatalf("expected a DomainError, got %v", err)
	}
	return de
}

// countRows counts for simple diagnostics in tests.
func countRows(t *testing.T, handle *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := handle.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}
