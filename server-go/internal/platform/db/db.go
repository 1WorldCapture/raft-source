// Package db opens the SQLite database with the pragmas the account phase
// requires (WAL, busy timeout, foreign keys, FULL sync) and applies the
// embedded migration chain exactly once per version. The open path is
// treated as a literal filesystem path (URI-encoded into the file: DSN) so
// metacharacters in configured directories can neither truncate the path nor
// inject pragmas; the database file and its sidecars are forced to 0600.
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens (creating if needed) the SQLite database at path and migrates it.
// All write transactions use BEGIN IMMEDIATE (see dsn) so lock upgrades cannot
// deadlock; readers proceed concurrently under WAL.
func Open(path string) (*sql.DB, error) {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	// Create credentials storage privately before SQLite opens it. Refuse
	// symlinks so a misconfigured data path cannot overwrite another file.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err == nil {
		if err := f.Close(); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("SQLite path must be a regular non-symlink file")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, err
	}
	dsn := buildDSN(path)
	handle := sql.OpenDB(&busyConnector{dsn: dsn})
	// A modest connection pool: SQLite serializes writers anyway; the cap
	// bounds file descriptors and keeps SQLITE_BUSY pressure predictable.
	handle.SetMaxOpenConns(8)
	handle.SetMaxIdleConns(8)
	handle.SetConnMaxLifetime(0)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// WAL initialization can report SQLITE_BUSY before busy_timeout applies
	// when multiple fresh connections initialize the journal simultaneously.
	for {
		err := handle.PingContext(ctx)
		if err == nil {
			break
		}
		var sqliteErr *sqlite.Error
		if !errors.As(err, &sqliteErr) || (sqliteErr.Code()&0xff != 5 && sqliteErr.Code()&0xff != 6) {
			handle.Close()
			return nil, fmt.Errorf("ping sqlite: %w", err)
		}
		select {
		case <-ctx.Done():
			handle.Close()
			return nil, fmt.Errorf("initialize SQLite: %w", ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	var journalMode string
	if err := handle.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		handle.Close()
		return nil, fmt.Errorf("verify SQLite journal mode: %w", err)
	}
	if journalMode != "wal" {
		handle.Close()
		return nil, fmt.Errorf("SQLite WAL mode is required, got %q", journalMode)
	}
	if err := migrate(ctx, handle); err != nil {
		handle.Close()
		return nil, err
	}
	// Account data is private: clamp the main file and its WAL/SHM sidecars
	// (SQLite creates them with process-default modes).
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(candidate); err == nil {
			if err := os.Chmod(candidate, 0o600); err != nil {
				handle.Close()
				return nil, fmt.Errorf("restrict database permissions: %w", err)
			}
		}
	}
	if err := initializeAuthorityEpochs(ctx, handle); err != nil {
		ReleaseAuthorityFence(handle)
		_ = handle.Close()
		return nil, fmt.Errorf("initialize authority generations: %w", err)
	}
	return handle, nil
}

// buildDSN encodes the literal path into a file: URI with per-connection
// pragmas. url.URL escaping keeps "?", "#", "&" and spaces in directory names
// inert, and the query parameters cannot be smuggled through the path.
func buildDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	q := url.Values{}
	q.Set("_txlock", "immediate")
	q.Add("_pragma", "busy_timeout(50)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = q.Encode()
	return u.String()
}

// migrate applies every embedded migration newer than the recorded version,
// each inside its own IMMEDIATE transaction (the existence check lives inside
// the transaction, so concurrent first startups serialize correctly). A
// database holding a migration this binary does not know fails closed.
func migrate(ctx context.Context, handle *sql.DB) error {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".sql" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	if _, err := handle.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)`); err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}

	// Fail closed on unknown newer versions: an older binary must not run
	// against a schema it cannot understand.
	known := make(map[string]bool, len(names))
	for _, name := range names {
		known[name] = true
	}
	rows, err := handle.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		if !known[version] {
			rows.Close()
			return fmt.Errorf("database schema version %q is newer than this binary; upgrade the server", version)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, name := range names {
		body, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		err = withTx(ctx, handle, func(tx *sql.Tx) error {
			var applied bool
			if err := tx.QueryRowContext(ctx,
				`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, name).Scan(&applied); err != nil {
				return err
			}
			if applied {
				return nil
			}
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return fmt.Errorf("apply %s: %w", name, err)
			}
			if err := checkForeignKeys(ctx, tx); err != nil {
				return fmt.Errorf("validate %s: %w", name, err)
			}
			_, err := tx.ExecContext(ctx,
				`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
				name, time.Now().UnixMilli())
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// checkForeignKeys consumes the pragma's result. Executing the pragma without
// reading its rows does not validate anything: SQLite reports violations as data.
// Run this before recording a migration so a failed rebuild rolls back atomically.
func checkForeignKeys(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var foreignKeyID int64
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return err
		}
		return fmt.Errorf("foreign key violation in table %s referencing %s (constraint %d); restore or repair the source data before retrying migration", table, parent, foreignKeyID)
	}
	return rows.Err()
}

// withTx runs fn inside an IMMEDIATE transaction (the dsn's _txlock applies
// to database/sql Tx begins) and rolls back on error.
func withTx(ctx context.Context, handle *sql.DB, fn func(tx *sql.Tx) error) error {
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// IsUniqueViolation reports whether err is a SQLite UNIQUE constraint failure
// on the named table/column/index (case-insensitive substring match), mirroring
// the legacy Postgres constraint checks. Pass "" to match any unique violation.
func IsUniqueViolation(err error, constraint string) bool {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return false
	}
	if se.Code() != 19 && se.Code() != 2067 { // SQLITE_CONSTRAINT / SQLITE_CONSTRAINT_UNIQUE
		return false
	}
	if constraint == "" {
		return true
	}
	return strings.Contains(strings.ToLower(se.Error()), strings.ToLower(constraint))
}
