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
	"raft.local/server-go/internal/publication"
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
// locked publication.Publication shape (object/state owner references only,
// no payload, no recipient list); the store bridges it 1:1 onto
// publication.Enqueue.
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

// Options are the constructor-time store inputs. Zero values select the
// production defaults (real clock). Dependencies are frozen at construction;
// there are no post-construction mutation seams.
type Options struct {
	// Clock overrides the time source (tests). Nil means time.Now.
	Clock func() time.Time
}

// Store is the readstate use-case entry point. The zero value is unusable;
// build with NewStore.
type Store struct {
	db       *sql.DB
	channels *channel.Store

	now func() time.Time
}

// NewStore builds the default store. handle comes from db.Open; channels is
// the channel worker's store (used only through its public read helpers and
// as the shared DB handle owner — never for cross-module writes).
func NewStore(db *sql.DB, channels *channel.Store) *Store {
	return NewStoreWithOptions(db, channels, Options{})
}

// NewStoreWithOptions builds the store with explicit constructor-time inputs.
func NewStoreWithOptions(db *sql.DB, channels *channel.Store, opts Options) *Store {
	now := opts.Clock
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, channels: channels, now: now}
}

// DB exposes the shared handle (integration tests only).
func (s *Store) DB() *sql.DB { return s.db }

// writeTx is the internal wrapper every mutation uses: the SHARED
// db.WithWriteTx helper (callback exactly once, fence scope, no nested write
// transactions) — there is no swappable transaction implementation.
func (s *Store) writeTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, s.db, fn)
}

// readSnapshot runs fn on one pinned connection inside BEGIN DEFERRED so
// every projection reads a single consistent snapshot without blocking
// writers: the SHARED db.WithReadSnapshot helper.
func (s *Store) readSnapshot(ctx context.Context, handle *sql.DB, fn func(Executor) error) error {
	return platformdb.WithReadSnapshot(ctx, handle, func(ex platformdb.Executor) error { return fn(ex) })
}

// validateHuman revalidates the full claims inside the caller's transaction
// through the SHARED auth.ValidateHumanTx contract.
func (s *Store) validateHuman(ctx context.Context, ex Queryer, claims auth.AccessTokenClaims, at time.Time) error {
	err := auth.ValidateHumanTx(ctx, ex, claims, at)
	if errors.Is(err, auth.ErrTokenInvalid) {
		return ErrTokenInvalid
	}
	return err
}

// enqueue records a transactional publication intent through the SHARED
// publication.Enqueue (idempotency and the bounded pending budget).
func (s *Store) enqueue(ctx context.Context, ex Executor, p PublicationIntent) error {
	tx, ok := ex.(*sql.Tx)
	if !ok {
		return errors.New("publication enqueue requires the mutation transaction")
	}
	err := publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID:   p.WorkspaceID,
		ObjectType:    p.ObjectType,
		ObjectID:      p.ObjectID,
		EventType:     p.EventType,
		Revision:      p.Revision,
		SubjectUserID: p.SubjectUserID,
		ScopeID:       p.ScopeID,
	})
	if errors.Is(err, publication.ErrBacklogFull) {
		return fmt.Errorf("readstate mutation rejected by the publication budget: %w", err)
	}
	return err
}

// pendingPublicationBudget documents the shared publication budget that gates
// enqueue (publication.MaxPending); kept here for test sizing.
const pendingPublicationBudget = publication.MaxPending
