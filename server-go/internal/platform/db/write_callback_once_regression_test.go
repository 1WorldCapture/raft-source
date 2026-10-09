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

// This is a behavioral contract of the shared transaction boundary, not a
// source-inspection test. Non-transactional callback invocations are counted
// separately from SQL effects so a rollback cannot hide a replayed callback.
func TestWriteTransactionCallbackIsNotReplayed(t *testing.T) {
	for _, mode := range []string{"commit", "domain failure", "constraint failure", "cancel after write"} {
		t.Run(mode, func(t *testing.T) {
			handle := callbackRegressionDB(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var calls, notifications atomic.Int32
			unsubscribe := RegisterCommitListener(handle, func() { notifications.Add(1) })
			defer unsubscribe()
			rejected := errors.New("callback rejected after its first durable write")

			err := WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
				calls.Add(1)
				if _, err := tx.ExecContext(ctx, `INSERT INTO callback_regression_probe(id) VALUES (1)`); err != nil {
					return err
				}
				switch mode {
				case "domain failure":
					return rejected
				case "constraint failure":
					// Force a real SQL error after a successful write. The first
					// insert must roll back, and the callback must not be retried.
					_, err := tx.ExecContext(ctx, `INSERT INTO callback_regression_probe(id) VALUES (1)`)
					return err
				case "cancel after write":
					cancel()
					return nil
				default:
					return nil
				}
			})
			if got := calls.Load(); got != 1 {
				t.Fatalf("business callback invoked %d times, want exactly one", got)
			}
			wantRows, wantNotifications := 0, int32(0)
			if mode == "commit" {
				if err != nil {
					t.Fatalf("commit failed: %v", err)
				}
				wantRows, wantNotifications = 1, 1
			} else if err == nil {
				t.Fatal("failed or cancelled callback was reported as committed")
			}
			if mode == "domain failure" && !errors.Is(err, rejected) {
				t.Fatalf("domain failure was replaced: %v", err)
			}
			var rows int
			readCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
			defer stop()
			if err := handle.QueryRowContext(readCtx, `SELECT COUNT(*) FROM callback_regression_probe`).Scan(&rows); err != nil {
				t.Fatalf("inspect committed effects: %v", err)
			}
			if rows != wantRows {
				t.Fatalf("durable rows = %d, want %d", rows, wantRows)
			}
			if got := notifications.Load(); got != wantNotifications {
				t.Fatalf("commit notifications = %d, want %d", got, wantNotifications)
			}
		})
	}
}

// SQLite acquisition waits/retries under the current bounded busy contract;
// an operation cancelled while another writer owns SQLite must not invoke
// its business callback. This also preserves the approved waiting policy:
// replacing it with immediate SQLITE_BUSY rejection is not a rename-only
// refactor and requires a separately reviewed behavior change.
func TestWriteTransactionCancelledAcquisitionDoesNotInvokeCallback(t *testing.T) {
	handle := callbackRegressionDB(t)
	held, err := handle.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err := held.Exec(`INSERT INTO callback_regression_probe(id) VALUES (7)`); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var calls, notifications atomic.Int32
	unsubscribe := RegisterCommitListener(handle, func() { notifications.Add(1) })
	defer unsubscribe()
	err = WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		calls.Add(1)
		_, err := tx.ExecContext(ctx, `INSERT INTO callback_regression_probe(id) VALUES (9)`)
		return err
	})
	if err == nil {
		t.Fatal("acquisition succeeded while another writer retained its transaction")
	}
	if ctx.Err() == nil {
		t.Fatalf("acquisition did not honor the cancellation deadline: %v", err)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("cancelled acquisition invoked callback %d times", got)
	}
	if got := notifications.Load(); got != 0 {
		t.Fatalf("cancelled acquisition emitted %d commit notifications", got)
	}
	if err := held.Rollback(); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM callback_regression_probe`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("cancelled acquisition or rollback leaked %d rows", rows)
	}
}

func callbackRegressionDB(t *testing.T) *sql.DB {
	t.Helper()
	handle, err := Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("close callback regression database: %v", err)
		}
		ReleaseAuthorityFence(handle)
	})
	if _, err := handle.Exec(`CREATE TABLE callback_regression_probe(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	return handle
}
