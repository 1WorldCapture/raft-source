package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func m4TransactionDB(t *testing.T) *sql.DB {
	t.Helper()
	handle, err := Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close(); ReleaseAuthorityFence(handle) })
	if _, err := handle.Exec(`CREATE TABLE m4_snapshot_probe(value INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO m4_snapshot_probe VALUES(1)`); err != nil {
		t.Fatal(err)
	}
	return handle
}

func TestM4DeferredSnapshotAllowsWALCommitAndKeepsStableRead(t *testing.T) {
	handle := m4TransactionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := WithReadSnapshot(ctx, handle, func(ex Executor) error {
		var first, second int
		if err := ex.QueryRowContext(ctx, `SELECT value FROM m4_snapshot_probe`).Scan(&first); err != nil {
			return err
		}
		committed := make(chan error, 1)
		go func() {
			committed <- WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `UPDATE m4_snapshot_probe SET value=2`)
				return err
			})
		}()
		select {
		case err := <-committed:
			if err != nil {
				return err
			}
		case <-ctx.Done():
			return errors.New("read snapshot reserved writer position")
		}
		if err := ex.QueryRowContext(ctx, `SELECT value FROM m4_snapshot_probe`).Scan(&second); err != nil {
			return err
		}
		if first != 1 || second != 1 {
			t.Fatalf("snapshot changed across concurrent commit: %d -> %d", first, second)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var current int
	if err := handle.QueryRow(`SELECT value FROM m4_snapshot_probe`).Scan(&current); err != nil || current != 2 {
		t.Fatalf("new read did not observe committed writer: value=%d err=%v", current, err)
	}
}

func TestM4ReadSnapshotIsReadOnlyAndCleansCancelledConnection(t *testing.T) {
	handle := m4TransactionDB(t)
	handle.SetMaxOpenConns(1)
	ctx, cancel := context.WithCancel(context.Background())
	err := WithReadSnapshot(ctx, handle, func(ex Executor) error {
		if _, err := ex.ExecContext(ctx, `UPDATE m4_snapshot_probe SET value=99`); err == nil {
			t.Fatal("read snapshot admitted a write")
		}
		rows, err := ex.QueryContext(ctx, `UPDATE m4_snapshot_probe SET value=99 RETURNING value`)
		if err == nil {
			rows.Close()
			t.Fatal("read snapshot admitted a write through QueryContext")
		}
		cancel()
		return ctx.Err()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled snapshot result: %v", err)
	}
	writeCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := WithWriteTx(writeCtx, handle, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(writeCtx, `UPDATE m4_snapshot_probe SET value=3`)
		return err
	}); err != nil {
		t.Fatalf("connection retained transaction/query_only after cancellation: %v", err)
	}
}

func TestM4AuthorityFenceCancellationAndCommitNotifications(t *testing.T) {
	handle := m4TransactionDB(t)
	ctx := context.Background()
	var calls atomic.Int64
	unsubscribe := RegisterCommitListener(handle, func() { calls.Add(1) })
	defer unsubscribe()
	started, release := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
			close(started)
			<-release
			_, err := tx.ExecContext(ctx, `UPDATE m4_snapshot_probe SET value=4`)
			return err
		})
	}()
	<-started
	short, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	if err := WithWriteTx(short, handle, func(*sql.Tx) error {
		t.Error("cancelled queued transaction callback ran")
		return nil
	}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("expected cancellable fence acquisition, got %v", err)
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("commit wake count=%d", calls.Load())
	}
	rollback := errors.New("force rollback")
	if err := WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE m4_snapshot_probe SET value=88`); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("rollback generated commit notification")
	}
	if err := WithAuthorityRead(handle, func() error {
		var value int
		if err := handle.QueryRow(`SELECT value FROM m4_snapshot_probe`).Scan(&value); err != nil {
			return err
		}
		if value != 4 {
			t.Fatalf("rollback leaked: %d", value)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
