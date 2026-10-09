package message

import (
	"context"
	"database/sql"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/publication"
)

// Store owns message facts over the shared SQLite handle. Channel authority
// is delegated to the locked channel.Store transaction APIs; this store never
// mutates channel-owned tables.
type Store struct {
	db                *sql.DB
	channels          *channel.Store
	clock             clock.Clock
	nowFn             func() time.Time
	fixedCursorSecret []byte
}

// Options are the constructor-time inputs. Every dependency is captured
// once; there is no post-construction setter for the clock or the cursor
// signing key.
type Options struct {
	// Clock overrides the time source. Nil means the real clock.
	Clock clock.Clock
	// CursorSecret pins the reaction-actors cursor signing key so cursors
	// stay valid across restarts. Nil generates a process-random key once.
	CursorSecret []byte
}

// NewStore builds the store with the real clock and a process-random
// cursor key (test/fixture seeding default; cursors then do not survive a
// restart, which only production wiring cares about).
func NewStore(handle *sql.DB, channels *channel.Store) *Store {
	return NewStoreWithOptions(handle, channels, Options{})
}

// NewStoreWithOptions is the locked constructor used by the app composition
// root: the clock and the reaction-cursor signing key are injected here and
// frozen — there is no post-construction setter for either.
func NewStoreWithOptions(handle *sql.DB, channels *channel.Store, opts Options) *Store {
	c := opts.Clock
	if c == nil {
		c = clock.Real{}
	}
	var cursorSecret []byte
	if opts.CursorSecret != nil {
		cursorSecret = append([]byte(nil), opts.CursorSecret...)
	}
	s := &Store{db: handle, channels: channels, clock: c, fixedCursorSecret: cursorSecret}
	s.nowFn = c.Now
	return s
}

// NewStoreWithOptionsForTest is NewStoreWithOptions with only the clock
// injected, for domain tests and frozen external harnesses.
func NewStoreWithOptionsForTest(handle *sql.DB, channels *channel.Store, c clock.Clock) *Store {
	return NewStoreWithOptions(handle, channels, Options{Clock: c})
}

func (s *Store) now() time.Time { return s.nowFn() }

// DB exposes the owning handle for composition-time ownership validation and
// test fixtures. Transport handlers must never obtain or query this handle.
func (s *Store) DB() *sql.DB { return s.db }

// Channels exposes the locked channel store for composition-time ownership
// validation. Cross-domain conversation work belongs to application/messaging.
func (s *Store) Channels() *channel.Store { return s.channels }

// withWriteTx runs fn in one IMMEDIATE transaction under the authority fence.
func (s *Store) withWriteTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, s.db, fn)
}

// dbExecutor is the pinned snapshot/transaction read surface used by the
// domain queries (satisfied by *sql.Tx and the WithReadSnapshot executor).
type dbExecutor = platformdb.Executor

// withReadSnapshot runs fn on one pinned deferred-read snapshot connection.
func (s *Store) withReadSnapshot(ctx context.Context, fn func(platformdb.Executor) error) error {
	return platformdb.WithReadSnapshot(ctx, s.db, fn)
}

// validateHuman revalidates the verified-JWT-derived claims at the actual
// database boundary. Claims that did not originate from TokenSigner fail
// closed inside auth.ValidateHumanTx.
func (s *Store) validateHuman(ctx context.Context, ex platformdb.Executor, claims auth.AccessTokenClaims) error {
	return auth.ValidateHumanTx(ctx, ex, claims, s.now())
}

// enqueue wraps publication.Enqueue for the mutation transactions in this
// package. Publications carry references only and join the same commit as
// their fact.
func enqueue(ctx context.Context, tx *sql.Tx, workspaceID, objectType, objectID, eventType string, revision int64, subjectUserID, scopeID string) error {
	return publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID:   workspaceID,
		ObjectType:    objectType,
		ObjectID:      objectID,
		EventType:     eventType,
		Revision:      revision,
		SubjectUserID: subjectUserID,
		ScopeID:       scopeID,
	})
}

// BuildSendResponse projects the creation-surface DTO from one snapshot read
// after the committing transaction returned.
func (s *Store) BuildSendResponse(ctx context.Context, result *CreateResult) (*Projection, error) {
	var facts *Projection
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		projected, err := s.SendResponseMessage(ctx, ex, result.Message, result.Mentions)
		if err != nil {
			return err
		}
		facts = projected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return facts, nil
}

// ProjectSnapshot enriches committed rows on one fresh read snapshot. Used
// by the transport to render history/context/sync responses after the
// authoritative snapshot read returned the rows.
func (s *Store) ProjectSnapshot(ctx context.Context, workspaceID string, msgs []*Message) ([]*Projection, error) {
	var projections []*Projection
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		projected, err := s.ProjectMessages(ctx, ex, workspaceID, msgs)
		if err != nil {
			return err
		}
		projections = projected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return projections, nil
}

// HasPriorRelationship backs the legacy 403/404 deny split on a snapshot.
func (s *Store) HasPriorRelationship(ctx context.Context, userID, channelID string) (bool, error) {
	var prior bool
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		ok, err := s.hasPriorRelationship(ctx, ex, userID, channelID)
		if err != nil {
			return err
		}
		prior = ok
		return nil
	})
	if err != nil {
		return false, err
	}
	return prior, nil
}

// SubjectID exposes the acting user for receiver coordinates.
func (c Claims) SubjectID() string { return c.userID }
