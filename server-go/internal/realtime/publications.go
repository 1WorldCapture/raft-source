// Package realtime stores publication intents alongside committed facts. It is
// not a browser receipt or Agent delivery service. Transport is injected; this
// package never stores message bodies or stale audience lists in the outbox.
package realtime

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
)

type Executor = platformdb.Executor

const (
	MaxPending         = 10000
	BatchSize          = 128
	PublishedRetention = 24 * time.Hour
)

var ErrBacklogFull = errors.New("realtime publication backlog is full")
var ErrPublicationRetry = errors.New("realtime publication deferred for retry")

// Publication contains only durable object references. SubjectUserID denotes
// the owner of a private read/prefs/viewer object, never an arbitrary room.
type Publication struct {
	ID            int64
	WorkspaceID   string
	ObjectType    string
	ObjectID      string
	EventType     string
	Revision      int64
	SubjectUserID string
	ScopeID       string
	Attempts      int
}

// Enqueue MUST be used inside the transaction that changes the domain fact.
// A replay of the same committed object version does not consume backlog.
func Enqueue(ctx context.Context, ex Executor, p Publication) error {
	if _, ok := ex.(*sql.Tx); !ok {
		return errors.New("publication enqueue requires a transaction")
	}
	if p.WorkspaceID == "" || p.ObjectType == "" || p.ObjectID == "" || p.EventType == "" || p.Revision < 1 {
		return errors.New("invalid publication reference")
	}
	var existing bool
	if err := ex.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM realtime_publications
		WHERE workspace_id=? AND object_type=? AND object_id=? AND event_type=? AND revision=? AND subject_user_id=?)`,
		p.WorkspaceID, p.ObjectType, p.ObjectID, p.EventType, p.Revision, p.SubjectUserID).Scan(&existing); err != nil {
		return err
	}
	if existing {
		return nil
	}
	var pending int
	if err := ex.QueryRowContext(ctx, `SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NULL`).Scan(&pending); err != nil {
		return err
	}
	if pending >= MaxPending {
		return ErrBacklogFull
	}
	_, err := ex.ExecContext(ctx, `INSERT INTO realtime_publications
		(workspace_id,object_type,object_id,event_type,revision,subject_user_id,scope_id,created_at)
		VALUES (?,?,?,?,?,?,?,?)`, p.WorkspaceID, p.ObjectType, p.ObjectID, p.EventType,
		p.Revision, p.SubjectUserID, p.ScopeID, time.Now().UnixMilli())
	return err
}

// Publisher must reproject the referenced current fact and reauthorize every
// target at queue admission/dequeue. nil means processed, NOT delivered.
type Publisher func(context.Context, Publication) error

type Stats struct {
	Published uint64
	Retries   uint64
}

type Store struct {
	db        *sql.DB
	wake      chan struct{}
	published atomic.Uint64
	retries   atomic.Uint64
	startOnce sync.Once
	stop      func()
	now       func() time.Time
}

func NewStore(handle *sql.DB) *Store {
	return &Store{db: handle, wake: make(chan struct{}, 1), now: time.Now}
}

func (s *Store) Stats() Stats {
	return Stats{Published: s.published.Load(), Retries: s.retries.Load()}
}

func (s *Store) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Ready makes sustained backlog visible; no online sockets is not a failure.
func (s *Store) Ready(ctx context.Context) error {
	var pending int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NULL`).Scan(&pending); err != nil {
		return err
	}
	if pending >= MaxPending {
		return ErrBacklogFull
	}
	return nil
}

// Start launches a single bounded worker. Its returned stop function waits for
// cancellation and can be called repeatedly. No listener or external service
// is started here; transport and lifecycle are owned by app.
func (s *Store) Start(parent context.Context, publish Publisher, logger *slog.Logger) func() {
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		done := make(chan struct{})
		unsubscribe := platformdb.RegisterCommitListener(s.db, s.Wake)
		var stopOnce sync.Once
		s.stop = func() {
			stopOnce.Do(func() { unsubscribe(); cancel() })
			<-done
		}
		go func() {
			defer close(done)
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			s.Wake()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				case <-s.wake:
				}
				batchCtx, batchCancel := context.WithTimeout(ctx, 10*time.Second)
				n, err := s.DrainOnce(batchCtx, publish)
				batchCancel()
				if err != nil && ctx.Err() == nil && logger != nil {
					// Error strings can contain SQL values. Deliberately omit them.
					logger.Warn("realtime publication pass failed; durable intents retained")
				}
				if n == BatchSize {
					s.Wake()
				}
			}
		}()
	})
	return s.stop
}

// DrainOnce is deterministic at the batch boundary and exposed for failure /
// restart tests. A crash after publish but before mark causes replay; clients
// deduplicate stable IDs/revisions. Failed publications remain durable.
func (s *Store) DrainOnce(ctx context.Context, publish Publisher) (int, error) {
	if publish == nil {
		return 0, errors.New("publication transport is not configured")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,workspace_id,object_type,object_id,event_type,revision,
		subject_user_id,scope_id,attempts FROM realtime_publications
		WHERE published_at IS NULL AND next_attempt_at<=? ORDER BY id LIMIT ?`, s.now().UnixMilli(), BatchSize)
	if err != nil {
		return 0, err
	}
	batch := make([]Publication, 0, BatchSize)
	for rows.Next() {
		var p Publication
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.ObjectType, &p.ObjectID, &p.EventType,
			&p.Revision, &p.SubjectUserID, &p.ScopeID, &p.Attempts); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	hadFailure := false
	for _, p := range batch {
		if err := ctx.Err(); err != nil {
			return len(batch), err
		}
		publishErr := publish(ctx, p)
		err := platformdb.WithWriteTx(ctx, s.db, func(tx *sql.Tx) error {
			if publishErr == nil {
				_, err := tx.ExecContext(ctx, `UPDATE realtime_publications SET published_at=?
					WHERE id=? AND published_at IS NULL`, s.now().UnixMilli(), p.ID)
				return err
			}
			shift := p.Attempts
			if shift > 6 {
				shift = 6
			}
			retryAt := s.now().Add(time.Second * time.Duration(1<<shift)).UnixMilli()
			_, err := tx.ExecContext(ctx, `UPDATE realtime_publications
				SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND published_at IS NULL`, retryAt, p.ID)
			return err
		})
		if err != nil {
			return len(batch), err
		}
		if publishErr == nil {
			s.published.Add(1)
		} else {
			hadFailure = true
			s.retries.Add(1)
		}
	}
	// An empty pass must not commit a cleanup transaction: commit listeners
	// would wake this same worker forever. Cleanup is opportunistic after a
	// nonempty publication batch; pending rows NEVER expire.
	if len(batch) == 0 {
		return 0, nil
	}
	err = platformdb.WithWriteTx(ctx, s.db, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM realtime_publications WHERE id IN
			(SELECT id FROM realtime_publications WHERE published_at IS NOT NULL AND published_at<?
			 ORDER BY published_at LIMIT 1000)`, s.now().Add(-PublishedRetention).UnixMilli())
		return err
	})
	if err == nil && hadFailure {
		err = ErrPublicationRetry
	}
	return len(batch), err
}
