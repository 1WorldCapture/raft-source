package db

import (
	"context"
	"database/sql"
	"errors"
	"sync/atomic"
)

// AuthorityScope is an internal invalidation domain, not a room or a grant.
// Family scope is distinct from user scope so logging out one login does not
// retire unrelated logins. Workspace invalidation is deliberately conservative.
type AuthorityScope struct {
	Kind string
	ID   string
}

type AuthorityChange struct {
	Scope      AuthorityScope
	Generation uint64
}

// AuthorityGeneration is a cheap cache lookup, safe in a realtime sender's
// short admission guard. The cache is updated after COMMIT, before releasing
// WithWriteTx's fence. No database or network operation happens here.
func AuthorityGeneration(handle *sql.DB, kind, id string) uint64 {
	f := fenceFor(handle)
	scope := AuthorityScope{Kind: kind, ID: id}
	if slot, ok := f.epochs.Load(scope); ok {
		return slot.(*atomic.Uint64).Load()
	}
	return 0
}

// AuthoritySerial binds an asynchronously projected audience/payload to the
// authority snapshot used to compute it. Capture it BEFORE projection and
// require the same value INSIDE final guarded admission. A newly admitted
// connection has a valid new generation and would otherwise accept a stale
// pre-revocation audience. This counter is internal, not a message cursor.
func AuthoritySerial(handle *sql.DB) uint64 {
	return fenceFor(handle).authoritySerial.Load()
}

// RegisterAuthorityListener installs an eviction wake hook. Unlike the cache
// update, these callbacks run AFTER releasing the admission fence. Senders
// must still compare current generation / exact session under that fence.
// A slow network close must be scheduled, never executed synchronously here.
func RegisterAuthorityListener(handle *sql.DB, listener func([]AuthorityChange)) func() {
	f := fenceFor(handle)
	f.mu.Lock()
	f.nextListener++
	id := f.nextListener
	if f.authorityListeners == nil {
		f.authorityListeners = make(map[uint64]func([]AuthorityChange))
	}
	f.authorityListeners[id] = listener
	f.mu.Unlock()
	return func() {
		f.mu.Lock()
		delete(f.authorityListeners, id)
		f.mu.Unlock()
	}
}

// initializeAuthorityEpochs is called only by Open after all embedded
// migrations completed, before exposing the handle. An intentionally raw
// sql.Open M1 upgrade fixture has no realtime surface and does not opt in.
// The application always uses Open; a missing/corrupt table fails startup.
func initializeAuthorityEpochs(ctx context.Context, handle *sql.DB) error {
	f := fenceFor(handle)
	if err := f.enter(ctx); err != nil {
		return err
	}
	defer f.leave()
	var watermark int64
	var changes []AuthorityChange
	err := WithReadSnapshot(ctx, handle, func(ex Executor) error {
		var err error
		watermark, changes, err = readAuthorityChanges(ctx, ex, 0)
		return err
	})
	if err != nil {
		return err
	}
	f.applyAuthorityChanges(watermark, changes)
	f.authorityEnabled = true
	return nil
}

func readAuthorityChanges(ctx context.Context, ex Executor, after int64) (int64, []AuthorityChange, error) {
	var watermark int64
	if err := ex.QueryRowContext(ctx, `SELECT value FROM authority_clock WHERE id=1`).Scan(&watermark); err != nil {
		return 0, nil, err
	}
	if watermark < after {
		return 0, nil, errors.New("authority clock moved backwards")
	}
	if watermark == after {
		return watermark, nil, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT kind,scope_id,generation FROM authority_epochs
		WHERE generation>? AND generation<=? ORDER BY generation`, after, watermark)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	changes := make([]AuthorityChange, 0)
	for rows.Next() {
		var change AuthorityChange
		if err := rows.Scan(&change.Scope.Kind, &change.Scope.ID, &change.Generation); err != nil {
			return 0, nil, err
		}
		changes = append(changes, change)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return watermark, changes, nil
}

// applyAuthorityChanges runs with the admission token held, after the write
// committed. There are no fallible operations after COMMIT: cache publication
// is local, and a restart rebuilds it from these same durable rows.
func (f *authorityFence) applyAuthorityChanges(watermark int64, changes []AuthorityChange) {
	for _, change := range changes {
		slot, _ := f.epochs.LoadOrStore(change.Scope, &atomic.Uint64{})
		slot.(*atomic.Uint64).Store(change.Generation)
	}
	f.authorityWatermark = watermark
	f.authoritySerial.Store(uint64(watermark))
}

func (f *authorityFence) notifyAuthorityChanges(changes []AuthorityChange) {
	if len(changes) == 0 {
		return
	}
	f.mu.Lock()
	listeners := make([]func([]AuthorityChange), 0, len(f.authorityListeners))
	for _, fn := range f.authorityListeners {
		listeners = append(listeners, fn)
	}
	f.mu.Unlock()
	for _, fn := range listeners {
		fn(append([]AuthorityChange(nil), changes...))
	}
}
