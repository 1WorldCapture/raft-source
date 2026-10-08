package db

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestM2ForeignKeyCheckConsumesViolationsBeforeCommit(t *testing.T) {
	handle, err := Open(filepath.Join(t.TempDir(), "foreign-keys.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	ctx := context.Background()
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// Defer (not disable) enforcement so the same transaction can demonstrate
	// a broken rebuild before commit. The production connection keeps FKs on.
	if _, err := tx.ExecContext(ctx, `PRAGMA defer_foreign_keys = ON`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_memberships(workspace_id,user_id,joined_at) VALUES ('missing-workspace','missing-user',1)`); err != nil {
		t.Fatal(err)
	}
	err = checkForeignKeys(ctx, tx)
	if err == nil || !strings.Contains(err.Error(), "foreign key violation") {
		t.Fatalf("expected an actionable migration failure, got %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_memberships`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rollback left %d memberships", count)
	}
}

func TestM2ForeignKeyCheckHonorsCancellation(t *testing.T) {
	handle, err := Open(filepath.Join(t.TempDir(), "cancel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	tx, err := handle.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := checkForeignKeys(ctx, tx); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}
