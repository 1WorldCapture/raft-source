package delivery

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Store owns the durable delivery facts over the shared SQLite handle. It is
// the locked construction target for the messaging service (execution lock
// §2): construction needs no goroutines and no network, and every dependency
// is frozen at construction.
type Store struct {
	db    *sql.DB
	clock clock.Clock

	// Managed scanning has its own fair, process-local keyset cursor. It is
	// only a performance hint: restart begins at zero, while every delivery,
	// attempt and pull eligibility remains authoritative in SQLite. Never
	// reuse next_attempt_at as a scan cursor for external claim-only rows.
	// The mutex is held only by PrepareManagedDispatches, before the DB fence;
	// no receipt/claim/fact callback takes it under another transaction.
	managedScanMu    sync.Mutex
	managedScanAfter int64
}

// Options are the constructor-time inputs. There is no post-construction
// setter: the clock is frozen like every other fact owner in this server.
type Options struct {
	// Clock overrides the time source. Nil means the real clock.
	Clock clock.Clock
}

// NewStore builds the delivery fact store with the real clock (locked API).
func NewStore(handle *sql.DB) *Store {
	return NewStoreWithOptions(handle, Options{})
}

// NewStoreWithOptions is the constructor the composition root uses.
func NewStoreWithOptions(handle *sql.DB, opts Options) *Store {
	c := opts.Clock
	if c == nil {
		c = clock.Real{}
	}
	return &Store{db: handle, clock: c}
}

// DB exposes the owning handle for composition-time ownership validation
// (the messaging service asserts one shared database). Transport handlers
// must never obtain or query this handle.
func (s *Store) DB() *sql.DB { return s.db }

// Executor is the pinned transaction/snapshot read surface shared with the
// injected fact callbacks (identical to platformdb.Executor).
type Executor = platformdb.Executor

func (s *Store) now() time.Time { return s.clock.Now() }

func (s *Store) nowMs() int64 { return s.clock.Now().UnixMilli() }

// withWriteTx runs fn in one IMMEDIATE transaction under the authority fence.
func (s *Store) withWriteTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, s.db, fn)
}

// withReadSnapshot runs fn on one pinned deferred-read snapshot connection.
func (s *Store) withReadSnapshot(ctx context.Context, fn func(Executor) error) error {
	return platformdb.WithReadSnapshot(ctx, s.db, fn)
}

// deliveryByIDTx loads one delivery row inside a transaction/snapshot.
func deliveryByIDTx(ctx context.Context, ex Executor, id string) (*Delivery, error) {
	row := ex.QueryRowContext(ctx,
		`SELECT `+deliveryColumns+` FROM agent_deliveries WHERE id = ?`, id)
	d, err := scanDelivery(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return d, err
}

// attemptByOccurrenceTx loads one attempt row by occurrence id.
func attemptByOccurrenceTx(ctx context.Context, ex Executor, occurrenceID string) (*Attempt, error) {
	row := ex.QueryRowContext(ctx,
		`SELECT `+attemptColumns+` FROM agent_delivery_attempts WHERE occurrence_id = ?`, occurrenceID)
	a, err := scanAttempt(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return a, err
}

// openAttemptForDeliveryTx returns the delivery's current in_flight attempt
// (the occurrence a same-identity resend reuses), or nil.
func openAttemptForDeliveryTx(ctx context.Context, ex Executor, deliveryID string) (*Attempt, error) {
	row := ex.QueryRowContext(ctx,
		`SELECT `+attemptColumns+` FROM agent_delivery_attempts
		WHERE delivery_id = ? AND state = 'in_flight'
		ORDER BY attempt_number DESC LIMIT 1`, deliveryID)
	a, err := scanAttempt(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return a, err
}

// agentHasOtherInFlightTx reports whether the agent already carries a
// different in-flight managed attempt that still occupies the single
// outstanding slot. Cancelled and blocked logical intents do not occupy it:
// an open occurrence kept only so a genuine receipt can resolve THAT intent
// must not starve later messages for the same agent. Pending, waiting and
// leased rows still do. The check stays inside one workspace.
func agentHasOtherInFlightTx(ctx context.Context, ex Executor, workspaceID, agentID, exceptDeliveryID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx,
		`SELECT 1 FROM agent_delivery_attempts AS a
		JOIN agent_deliveries AS d ON d.id = a.delivery_id
		WHERE a.workspace_id = ? AND a.agent_id = ? AND a.state = 'in_flight'
		  AND a.transport_kind = ? AND a.delivery_id <> ?
		  AND d.workspace_id = a.workspace_id
		  AND d.scheduling_state NOT IN ('cancelled', 'blocked')
		LIMIT 1`,
		workspaceID, agentID, TransportManagedWire, exceptDeliveryID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// terminalCloseOpenAttemptTx CAS-closes the delivery's in_flight attempt.
// No open attempt is success. code is a server verdict and must not be
// ACKED: this does not record a receipt, does not invent acked_at, and does
// not clear received/pending/drained observation timestamps.
func terminalCloseOpenAttemptTx(ctx context.Context, ex Executor, deliveryID, code string, nowMs int64) error {
	if code == "" || code == TerminalAcked {
		return fmt.Errorf("%w: terminal close requires a non-ACK verdict", ErrInvalidInput)
	}
	open, err := openAttemptForDeliveryTx(ctx, ex, deliveryID)
	if err != nil {
		return err
	}
	if open == nil {
		return nil
	}
	ok, err := terminateAttemptTx(ctx, ex, open.OccurrenceID, code, open.Revision, nowMs)
	if err != nil {
		return err
	}
	if !ok {
		return ErrConcurrentModification
	}
	return nil
}

// messageSeqTx reads the committed messages.seq for one message. seq is the
// WIRE seq of agent:deliver and the value an ACK must repeat. It is an
// immutable committed fact (allocated in the creation transaction), not an
// authorization, so a direct read does not smuggle a live cross-module fact.
func messageSeqTx(ctx context.Context, ex Executor, workspaceID, messageID string) (int64, bool, error) {
	var seq int64
	err := ex.QueryRowContext(ctx,
		`SELECT seq FROM messages WHERE id = ? AND workspace_id = ?`, messageID, workspaceID).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return seq, true, nil
}

// terminateAttemptTx CAS-closes an in_flight attempt with a server verdict.
// Zero rows affected means a concurrent writer closed it first; the caller
// treats that as a lost race (ErrConcurrentModification) rather than blindly
// overwriting a terminal verdict.
func terminateAttemptTx(ctx context.Context, ex Executor, occurrenceID, code string, revision int64, now int64) (bool, error) {
	res, err := ex.ExecContext(ctx,
		`UPDATE agent_delivery_attempts
		SET state = 'terminal', terminal_code = ?, revision = revision + 1, updated_at = ?
		WHERE occurrence_id = ? AND state = 'in_flight' AND revision = ?`,
		code, now, occurrenceID, revision)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
