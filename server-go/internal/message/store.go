package message

import (
	"context"
	"database/sql"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/realtime"
)

// Store owns message facts over the shared SQLite handle. Channel authority
// is delegated to the locked channel.Store transaction APIs; this store never
// mutates channel-owned tables.
type Store struct {
	db                  *sql.DB
	channels            *channel.Store
	clock               clock.Clock
	nowFn               func() time.Time
	fixedCursorSecret   []byte
	threadReplyReadHook ThreadReplyReadHook
}

// NewStore is the locked constructor used by the app composition root.
func NewStore(handle *sql.DB, channels *channel.Store) *Store {
	s := &Store{db: handle, channels: channels, clock: clock.Real{}}
	s.nowFn = s.clock.Now
	return s
}

// SetClock injects the clock (tests). Production keeps the real clock.
func (s *Store) SetClock(c clock.Clock) {
	if c == nil {
		return
	}
	s.clock = c
	s.nowFn = c.Now
}

// SetCursorSecret pins the reaction-actors cursor signing key so cursors stay
// valid across restarts. Without it a process-random key is generated once.
func (s *Store) SetCursorSecret(secret []byte) { s.fixedCursorSecret = append([]byte(nil), secret...) }

// SetThreadReplyReadHook injects the readstate seam invoked after every NEW
// human thread reply, inside the committing transaction. See
// ThreadReplyReadHook; the parent app assembly wires it to
// readstate.MarkReadLatestTx.
func (s *Store) SetThreadReplyReadHook(h ThreadReplyReadHook) { s.threadReplyReadHook = h }

// HasThreadReplyReadHook reports whether the full product path (reply also
// advancing the author's thread read cursor) is wired. Pure fact unit tests
// may construct without it; production assembly must wire it.
func (s *Store) HasThreadReplyReadHook() bool { return s.threadReplyReadHook != nil }

// NewStoreWithOptionsForTest is NewStore with an injected clock for domain
// tests; production wiring stays on NewStore + the real clock.
func NewStoreWithOptionsForTest(handle *sql.DB, channels *channel.Store, c clock.Clock) *Store {
	s := NewStore(handle, channels)
	if c != nil {
		s.SetClock(c)
	}
	return s
}

func (s *Store) now() time.Time { return s.nowFn() }

// DB exposes the handle for transport-level wiring only.
func (s *Store) DB() *sql.DB { return s.db }

// Channels exposes the locked channel store for assembly-time wiring of the
// conversation HTTP worker (thread initial content path).
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

// enqueue wraps realtime.Enqueue for the mutation transactions in this
// package. Publications carry references only and join the same commit as
// their fact.
func enqueue(ctx context.Context, tx *sql.Tx, workspaceID, objectType, objectID, eventType string, revision int64, subjectUserID, scopeID string) error {
	return realtime.Enqueue(ctx, tx, realtime.Publication{
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
func (s *Store) BuildSendResponse(ctx context.Context, result *CreateResult) (*SendResponseMessageDTO, error) {
	var dto *SendResponseMessageDTO
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		projected, err := s.SendResponseMessage(ctx, ex, result.Message, result.Mentions)
		if err != nil {
			return err
		}
		dto = projected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return dto, nil
}

// ProjectSnapshot enriches committed rows on one fresh read snapshot. Used
// by the transport to render history/context/sync responses after the
// authoritative snapshot read returned the rows.
func (s *Store) ProjectSnapshot(ctx context.Context, workspaceID string, msgs []*Message) ([]*MessageDTO, error) {
	var dtos []*MessageDTO
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		projected, err := s.ProjectMessages(ctx, ex, workspaceID, msgs)
		if err != nil {
			return err
		}
		dtos = projected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return dtos, nil
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
