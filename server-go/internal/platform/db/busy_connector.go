package db

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// SQLite's native busy handler sleeps without responding promptly to an
// interrupted Go context. Use short native waits and keep the original 10s
// contention budget in Go, where cancellation can be observed between attempts.
// Retry ONLY transaction acquisition or a single autocommit statement: NEVER
// replay a transaction body, multi-statement migration, or failed commit.
// Open verifies WAL mode: these autocommit retry boundaries depend on it.
// Prepared statements keep the underlying driver's short native wait and are
// deliberately not replayed; current product writers use direct Exec/Query.
const sqliteBusyBudget = 10 * time.Second

var isolatedSQLiteDriver = &sqlite.Driver{}

type busyConnector struct{ dsn string }

func (c *busyConnector) Driver() driver.Driver { return isolatedSQLiteDriver }

func (c *busyConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := retrySQLiteBusy(ctx, func() (driver.Conn, error) {
		return isolatedSQLiteDriver.Open(c.dsn)
	})
	if err != nil {
		return nil, err
	}
	return &busyConn{Conn: conn}, nil
}

func retrySQLiteBusy[T any](ctx context.Context, attempt func() (T, error)) (T, error) {
	deadline := time.Now().Add(sqliteBusyBudget)
	for {
		if err := ctx.Err(); err != nil {
			var zero T
			return zero, err
		}
		value, err := attempt()
		if err == nil {
			return value, nil
		}
		if canceled := ctx.Err(); canceled != nil {
			return value, canceled
		}
		var sqliteError *sqlite.Error
		if !errors.As(err, &sqliteError) || sqliteError.Code()&0xff != 5 || !time.Now().Before(deadline) {
			return value, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return value, ctx.Err()
		case <-timer.C:
		}
	}
}

// database/sql serializes driver operations on a connection. inTransaction
// ensures retry boundaries never encompass already executed business writes.
type busyConn struct {
	driver.Conn
	inTransaction bool
}

func (c *busyConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *busyConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	tx, err := retrySQLiteBusy(ctx, func() (driver.Tx, error) {
		return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
	})
	if err != nil {
		return nil, err
	}
	c.inTransaction = true
	return &busyTx{Tx: tx, conn: c}, nil
}

type busyTx struct {
	driver.Tx
	conn *busyConn
}

func (t *busyTx) Commit() error {
	err := t.Tx.Commit()
	t.conn.inTransaction = false
	return err
}

func (t *busyTx) Rollback() error {
	err := t.Tx.Rollback()
	t.conn.inTransaction = false
	return err
}

func (c *busyConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	attempt := func() (driver.Result, error) {
		return c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
	}
	// The read-snapshot helper explicitly starts a DEFERRED transaction on a
	// pinned connection (the DSN otherwise forces IMMEDIATE). Track these
	// exact control statements too, so statements/COMMIT inside that snapshot
	// are never incorrectly treated as retryable autocommit operations.
	switch strings.ToUpper(strings.TrimSpace(query)) {
	case "BEGIN DEFERRED":
		result, err := retrySQLiteBusy(ctx, attempt)
		if err == nil {
			c.inTransaction = true
		}
		return result, err
	case "COMMIT", "ROLLBACK":
		result, err := attempt()
		if err == nil {
			c.inTransaction = false
		}
		return result, err
	}
	// Any semicolon conservatively disables replay, including one inside a
	// quoted literal. This is not an SQL parser; false negatives are safe.
	if c.inTransaction || strings.Contains(query, ";") {
		return attempt()
	}
	return retrySQLiteBusy(ctx, attempt)
}

func (c *busyConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	attempt := func() (driver.Rows, error) {
		return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
	}
	if c.inTransaction || strings.Contains(query, ";") {
		return attempt()
	}
	return retrySQLiteBusy(ctx, attempt)
}

func (c *busyConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	return c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, query)
}

func (c *busyConn) Ping(ctx context.Context) error {
	return c.Conn.(driver.Pinger).Ping(ctx)
}

func (c *busyConn) ResetSession(ctx context.Context) error {
	return c.Conn.(driver.SessionResetter).ResetSession(ctx)
}

func (c *busyConn) IsValid() bool { return c.Conn.(driver.Validator).IsValid() }

var (
	_ driver.Connector          = (*busyConnector)(nil)
	_ driver.ConnBeginTx        = (*busyConn)(nil)
	_ driver.ExecerContext      = (*busyConn)(nil)
	_ driver.QueryerContext     = (*busyConn)(nil)
	_ driver.ConnPrepareContext = (*busyConn)(nil)
	_ driver.Pinger             = (*busyConn)(nil)
	_ driver.SessionResetter    = (*busyConn)(nil)
	_ driver.Validator          = (*busyConn)(nil)
)
