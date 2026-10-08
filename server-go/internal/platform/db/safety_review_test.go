package db_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	store "raft.local/server-go/internal/platform/db"
)

func TestReviewDatabasePathIsLiteralAndPrivate(t *testing.T) {
	// A configured file path is not a raw SQLite URI. URI metacharacters in
	// directory names must neither truncate the path nor inject pragmas.
	p := filepath.Join(t.TempDir(), "accounts ? # &", "raft.sqlite")
	db, err := store.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("configured database path was not created literally: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("account database permissions are not private: %o", info.Mode().Perm())
	}
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM users`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
}

func TestReviewForeignKeysOnEveryPooledConnection(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "raft.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	var connections []*sql.Conn
	defer func() {
		for _, c := range connections {
			_ = c.Close()
		}
	}()
	// Hold connections simultaneously so database/sql cannot reuse one.
	for i := 0; i < 4; i++ {
		c, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, c)
		var enabled int
		if err := c.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&enabled); err != nil {
			t.Fatal(err)
		}
		if enabled != 1 {
			t.Fatal("foreign keys disabled on pooled connection")
		}
	}
	if _, err := connections[0].ExecContext(ctx, `INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at) VALUES('missing','missing','member',1)`); err == nil {
		t.Fatal("invalid membership must fail foreign-key enforcement")
	}
}

func TestReviewConcurrentFirstStartup(t *testing.T) {
	p := filepath.Join(t.TempDir(), "raft.sqlite")
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	start := make(chan struct{})
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			db, err := store.Open(p)
			if err == nil {
				var count int
				err = db.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&count)
				if err == nil && count != 2 {
					t.Errorf("migration count = %d; want init and email-quota migration exactly once each", count)
				}
				_ = db.Close()
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent startup: %v", err)
		}
	}
}

func TestReviewNewerSchemaFailsClosed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "raft.sqlite")
	db, err := store.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO schema_migrations(version,applied_at) VALUES('9999_future.sql',1)`)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_ = db.Close()
	db, err = store.Open(p)
	if err == nil {
		_ = db.Close()
		t.Fatal("older binary must not silently accept an unknown newer schema")
	}
}
