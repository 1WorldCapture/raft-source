package readstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/realtime"
)

// Executor is the minimal write/execute surface shared with the parent's
// db package (ExecContext, QueryContext, QueryRowContext).
type Executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Queryer is the read-only subset accepted by validation helpers.
type Queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// PublicationIntent is the transactional wake-signal intent. It mirrors the
// locked realtime.Publication shape (object/state owner references only, no
// payload, no recipient list); the integrator bridges it 1:1 onto
// realtime.Enqueue.
type PublicationIntent struct {
	WorkspaceID   string
	ObjectType    string
	ObjectID      string
	EventType     string
	Revision      int64
	SubjectUserID string
	ScopeID       string
}

// Publication event vocabulary owned by this package.
const (
	EventReadStateUpdated       = "read_state:updated"
	EventReadStateUpdatedBulk   = "read_state:updated_bulk"
	EventUnreadSummaryChanged   = "unread_summary:changed"
	EventNotificationPrefs      = "notification_prefs:updated"
	EventMessageDisplayPrefs    = "message_display_prefs:updated"
	EventThreadFollowersUpdated = "thread:followers-updated"
)

// writeTxAttempts matches the reference serialization retry budget; SQLite
// IMMEDIATE transactions fail fast on lock contention, so the retry only
// fires on transient busy errors.
const writeTxAttempts = 3

// Store is the readstate use-case entry point. The zero value is unusable;
// build with NewStore.
type Store struct {
	db       *sql.DB
	channels *channel.Store

	now func() time.Time

	// validateHuman revalidates the full claims inside the caller's
	// transaction. Default: in-package port of the locked
	// auth.ValidateHumanTx contract; the integrator overrides with the real
	// shared helper once it lands.
	validateHuman func(ctx context.Context, ex Queryer, claims auth.AccessTokenClaims, at time.Time) error

	// enqueue records a transactional publication intent. Default: faithful
	// insert into realtime_publications (0010) with idempotency and a bounded
	// pending budget; the integrator overrides with realtime.Enqueue.
	enqueue func(ctx context.Context, ex Executor, p PublicationIntent) error

	// runWriteTx runs fn inside one short write transaction (BEGIN IMMEDIATE
	// via the DSN). Default: in-package port; the integrator overrides with
	// db.WithWriteTx.
	runWriteTx func(ctx context.Context, handle *sql.DB, fn func(*sql.Tx) error) error

	// readSnapshot runs fn on one pinned connection inside BEGIN DEFERRED so
	// every projection reads a single consistent snapshot without blocking
	// writers. The integrator overrides with db.WithReadSnapshot.
	readSnapshot func(ctx context.Context, handle *sql.DB, fn func(Executor) error) error
}

// NewStore builds the default store. handle comes from db.Open; channels is
// the channel worker's store (used only through its public read helpers and
// as the shared DB handle owner — never for cross-module writes).
func NewStore(db *sql.DB, channels *channel.Store) *Store {
	s := &Store{
		db:       db,
		channels: channels,
		now:      time.Now,
	}
	s.validateHuman = defaultValidateHumanBinding
	s.enqueue = defaultEnqueueBinding
	s.runWriteTx = defaultWriteTxBinding
	s.readSnapshot = defaultReadSnapshotBinding
	return s
}

// SetClock overrides the time source (tests).
func (s *Store) SetClock(now func() time.Time) {
	if now != nil {
		s.now = now
	}
}

// SetValidateHuman overrides the in-transaction human revalidation seam with
// the parent's auth.ValidateHumanTx.
func (s *Store) SetValidateHuman(fn func(ctx context.Context, ex Queryer, claims auth.AccessTokenClaims, at time.Time) error) {
	if fn != nil {
		s.validateHuman = fn
	}
}

// SetEnqueue overrides the publication seam with realtime.Enqueue.
func (s *Store) SetEnqueue(fn func(ctx context.Context, ex Executor, p PublicationIntent) error) {
	if fn != nil {
		s.enqueue = fn
	}
}

// SetWriteTx overrides the write-transaction seam with db.WithWriteTx.
func (s *Store) SetWriteTx(fn func(ctx context.Context, handle *sql.DB, fn func(*sql.Tx) error) error) {
	if fn != nil {
		s.runWriteTx = fn
	}
}

// SetReadSnapshot overrides the snapshot-read seam with db.WithReadSnapshot.
func (s *Store) SetReadSnapshot(fn func(ctx context.Context, handle *sql.DB, fn func(Executor) error) error) {
	if fn != nil {
		s.readSnapshot = fn
	}
}

// DB exposes the shared handle (integration tests only).
func (s *Store) DB() *sql.DB { return s.db }

// writeTx is the internal wrapper every mutation uses.
func (s *Store) writeTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return s.runWriteTx(ctx, s.db, fn)
}

// The default seams bind the SHARED helpers, not local re-implementations
// (docs/m4-readstate-review-notes.md item 1): db.WithWriteTx /
// db.WithReadSnapshot / auth.ValidateHumanTx / realtime.Enqueue. The adapters
// only translate the structurally identical executor interfaces; every
// behavioral decision (callback-exactly-once, fence scope, identity
// predicate, outbox admission) stays inside the shared implementations.
func defaultWriteTxBinding(ctx context.Context, handle *sql.DB, fn func(*sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, handle, fn)
}

func defaultReadSnapshotBinding(ctx context.Context, handle *sql.DB, fn func(Executor) error) error {
	return platformdb.WithReadSnapshot(ctx, handle, func(ex platformdb.Executor) error { return fn(ex) })
}

func defaultValidateHumanBinding(ctx context.Context, ex Queryer, claims auth.AccessTokenClaims, at time.Time) error {
	err := auth.ValidateHumanTx(ctx, ex, claims, at)
	if errors.Is(err, auth.ErrTokenInvalid) {
		return ErrTokenInvalid
	}
	return err
}

func defaultEnqueueBinding(ctx context.Context, ex Executor, p PublicationIntent) error {
	tx, ok := ex.(*sql.Tx)
	if !ok {
		return errors.New("publication enqueue requires the mutation transaction")
	}
	err := realtime.Enqueue(ctx, tx, realtime.Publication{
		WorkspaceID:   p.WorkspaceID,
		ObjectType:    p.ObjectType,
		ObjectID:      p.ObjectID,
		EventType:     p.EventType,
		Revision:      p.Revision,
		SubjectUserID: p.SubjectUserID,
		ScopeID:       p.ScopeID,
	})
	if errors.Is(err, realtime.ErrBacklogFull) {
		return fmt.Errorf("readstate mutation rejected by the publication budget: %w", err)
	}
	return err
}

// pendingPublicationBudget documents the shared realtime budget that gates
// the default enqueue (realtime.MaxPending); kept here for test sizing.
const pendingPublicationBudget = realtime.MaxPending
