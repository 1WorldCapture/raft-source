package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Executor is a pinned transaction/connection read or write surface. Domain
// methods must use the supplied executor, not acquire another pool connection.
type Executor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// A single application owns one database. This short per-database fence orders
// commits against realtime authorization + bounded queue admission. It does
// NOT cover network writes or ordinary snapshot reads. A channel rather than
// a mutex makes acquisition cancelable while a writer waits for SQLite.
type authorityFence struct {
	token              chan struct{}
	mu                 sync.Mutex
	nextListener       uint64
	listeners          map[uint64]func()
	authorityListeners map[uint64]func([]AuthorityChange)
	epochs             sync.Map      // AuthorityScope -> *atomic.Uint64
	authorityEnabled   bool          // initialized before Open returns
	authorityWatermark int64         // guarded by token
	authoritySerial    atomic.Uint64 // published after cache update, before fence release
}

var authorityFences sync.Map // *sql.DB -> *authorityFence; released by App.Close

func fenceFor(handle *sql.DB) *authorityFence {
	if f, ok := authorityFences.Load(handle); ok {
		return f.(*authorityFence)
	}
	f := &authorityFence{token: make(chan struct{}, 1)}
	f.token <- struct{}{}
	actual, _ := authorityFences.LoadOrStore(handle, f)
	return actual.(*authorityFence)
}

// ReleaseAuthorityFence is called only after all application users of the
// database have stopped. It is not a way to bypass a live authority check.
func ReleaseAuthorityFence(handle *sql.DB) { authorityFences.Delete(handle) }

func (f *authorityFence) enter(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-f.token:
		if err := ctx.Err(); err != nil {
			f.token <- struct{}{}
			return err
		}
		return nil
	}
}

func (f *authorityFence) leave() { f.token <- struct{}{} }

// WithWriteTx runs the callback exactly once in an IMMEDIATE transaction.
// The fence spans acquisition through commit/rollback. No callback may perform
// network I/O, call another WithWriteTx, or wait for a realtime consumer.
func WithWriteTx(ctx context.Context, handle *sql.DB, fn func(*sql.Tx) error) error {
	f := fenceFor(handle)
	if err := f.enter(ctx); err != nil {
		return err
	}
	committed := false
	var changes []AuthorityChange
	defer func() {
		f.leave()
		if committed {
			f.notifyAuthorityChanges(changes)
			f.notifyCommit()
		}
	}()
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	watermark := f.authorityWatermark
	if f.authorityEnabled {
		watermark, changes, err = readAuthorityChanges(ctx, tx, watermark)
		if err != nil {
			return err
		}
	}
	err = tx.Commit()
	committed = err == nil
	if committed && f.authorityEnabled {
		// A sender taking the same short fence can never observe a committed
		// revocation with the previous generation still published in memory.
		f.applyAuthorityChanges(watermark, changes)
	}
	return err
}

// RegisterCommitListener installs a nonblocking wake notification. Listeners
// must not do I/O or synchronously wait for work. They run AFTER releasing the
// authority fence, and never for rollback. The returned function unsubscribes.
func RegisterCommitListener(handle *sql.DB, listener func()) func() {
	f := fenceFor(handle)
	f.mu.Lock()
	f.nextListener++
	id := f.nextListener
	if f.listeners == nil {
		f.listeners = make(map[uint64]func())
	}
	f.listeners[id] = listener
	f.mu.Unlock()
	return func() { f.mu.Lock(); delete(f.listeners, id); f.mu.Unlock() }
}

func (f *authorityFence) notifyCommit() {
	f.mu.Lock()
	listeners := make([]func(), 0, len(f.listeners))
	for _, fn := range f.listeners {
		listeners = append(listeners, fn)
	}
	f.mu.Unlock()
	for _, fn := range listeners {
		fn()
	}
}

// WithAuthorityRead is for a short current-state revalidation followed by
// bounded, nonblocking queue admission. It must NEVER invoke WithWriteTx or
// perform a network write. Use the context variant for request-bound work.
func WithAuthorityRead(handle *sql.DB, fn func() error) error {
	return WithAuthorityReadContext(context.Background(), handle, fn)
}

func WithAuthorityReadContext(ctx context.Context, handle *sql.DB, fn func() error) error {
	f := fenceFor(handle)
	if err := f.enter(ctx); err != nil {
		return err
	}
	defer f.leave()
	return fn()
}

// WithReadSnapshot explicitly uses BEGIN DEFERRED on a pinned connection.
// database/sql BeginTx(ReadOnly:true) is insufficient: the configured driver
// still selects BEGIN IMMEDIATE from _txlock. PRAGMA query_only prevents even
// an accidental write via QueryContext("UPDATE ... RETURNING") in a reader.
// WAL writers can commit while this snapshot remains open.
func WithReadSnapshot(ctx context.Context, handle *sql.DB, fn func(Executor) error) (err error) {
	conn, err := handle.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	begun := false
	queryOnly := false
	defer func() {
		// A cancelled request still has to release its SQLite read transaction
		// and query_only flag before returning the connection to the pool.
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var cleanupErr error
		if begun {
			_, cleanupErr = conn.ExecContext(cleanup, "ROLLBACK")
		}
		if queryOnly {
			_, resetErr := conn.ExecContext(cleanup, "PRAGMA query_only=OFF")
			cleanupErr = errors.Join(cleanupErr, resetErr)
		}
		if cleanupErr != nil {
			// Do not pool a connection with a surviving transaction or read-only
			// flag. ErrBadConn tells database/sql to discard this connection.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			err = errors.Join(err, cleanupErr)
		}
	}()
	if _, err = conn.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
		return err
	}
	queryOnly = true
	if _, err = conn.ExecContext(ctx, "BEGIN DEFERRED"); err != nil {
		return err
	}
	begun = true
	if err = fn(conn); err != nil {
		return err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	begun = false
	return nil
}
