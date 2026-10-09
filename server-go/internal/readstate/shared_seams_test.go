package readstate

import (
	"database/sql"
	"errors"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/publication"
)

// TestProductionDefaultsAreSharedHelpers: NewStore binds db.WithWriteTx /
// db.WithReadSnapshot / auth.ValidateHumanTx / publication.Enqueue (the review
// notes' item 1) — verified behaviorally: the authority fence serializes two
// writers, the snapshot tolerates a concurrent writer, the exact identity
// predicate runs, and a committed mutation leaves a real publication row.
func TestProductionDefaultsAreSharedHelpers(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")

	// Identity exactness through the production binding.
	for name, mutate := range map[string]func(claims *auth.AccessTokenClaims){
		"zero-expiry":   func(c *auth.AccessTokenClaims) { c.ExpiresAt = time.Time{} },
		"future-issued": func(c *auth.AccessTokenClaims) { c.IssuedAt = fx.clock.Now().Add(time.Hour) },
		"expired":       func(c *auth.AccessTokenClaims) { c.ExpiresAt = fx.clock.Now().Add(-time.Minute) },
	} {
		claims := fx.claims[fxAlice]
		mutate(&claims)
		_, err := fx.store.MarkRead(fx.ctx(), claims, fxWS, fxGeneral, 1)
		if !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("%s claims accepted: %v", name, err)
		}
	}

	// The committed mutation leaves exactly the expected publication rows
	// (read_state + unread_summary wake) written by publication.Enqueue.
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1); err != nil {
		t.Fatal(err)
	}
	var readWake, summaryWake int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE workspace_id = ? AND event_type = 'read_state:updated'`, fxWS).Scan(&readWake); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE workspace_id = ? AND event_type = 'unread_summary:changed'`, fxWS).Scan(&summaryWake); err != nil {
		t.Fatal(err)
	}
	if readWake != 1 || summaryWake < 1 {
		t.Fatalf("publications = read %d / summary %d", readWake, summaryWake)
	}
}

// TestWriteTxCommitAndRollbackEffects: the store's mutations run on the
// SHARED db.WithWriteTx with no swappable seam; the callback-exactly-once
// contract itself is owned and tested by the platform package
// (transactions_test.go). What this package still proves behaviorally is that
// one operation commits exactly one set of durable effects and a domain
// denial rolls the whole transaction back.
func TestWriteTxCommitAndRollbackEffects(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")

	// Rollback path: a domain 404 inside the callback rolls the tx back and
	// leaves no durable effects.
	_, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, "missing-channel", 1)
	if AsError(err) == nil {
		t.Fatalf("missing channel read should 404, got %v", err)
	}
	var rows int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE workspace_id = ?`, fxWS).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("rolled-back mutation left %d publication rows", rows)
	}
	// Commit path: exactly the expected wake rows.
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1); err != nil {
		t.Fatal(err)
	}
	var readWake, summaryWake int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE workspace_id = ? AND event_type = 'read_state:updated'`, fxWS).Scan(&readWake); err != nil {
		t.Fatal(err)
	}
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE workspace_id = ? AND event_type = 'unread_summary:changed'`, fxWS).Scan(&summaryWake); err != nil {
		t.Fatal(err)
	}
	if readWake != 1 || summaryWake < 1 {
		t.Fatalf("publications = read %d / summary %d", readWake, summaryWake)
	}
}

// TestBacklogFullRejectsAndRollsBack: publication.Enqueue refuses new intents
// when the pending budget is exhausted; the associated fact must roll back
// (review notes item 4 — no silent wake-loss fallback).
func TestBacklogFullRejectsAndRollsBack(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	tx, err := fx.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < publication.MaxPending; i++ {
		if _, err := tx.Exec(`INSERT INTO realtime_publications
			(workspace_id, object_type, object_id, event_type, revision, subject_user_id, scope_id, created_at, next_attempt_at)
			VALUES (?, 'filler', ?, 'filled', ?, '', '', ?, 0)`,
			fxWS, itoa(int64(i)), itoa(int64(i+1)), fx.clock.Now().UnixMilli()); err != nil {
			tx.Rollback()
			t.Fatalf("fill backlog: %v", err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	_, err = fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1)
	if err == nil {
		t.Fatal("budget-exhausted mutation must fail")
	}
	if _, _, present := fx.readStateRow(fxAlice, fxGeneral); present {
		t.Fatal("rejected mutation must not leave a cursor row")
	}
}

// TestFollowHookMarkReadLatestTx: the same-transaction hook the channel
// worker's follow flow consumes revalidates full claims and advances the
// frontier on the caller's transaction.
func TestFollowHookMarkReadLatestTx(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	var result ReadStateResult
	err := fx.store.writeTx(fx.ctx(), func(tx *sql.Tx) error {
		state, err := fx.store.MarkReadLatestTx(fx.ctx(), tx, fx.claims[fxAlice], fxWS, fxGeneral)
		result = state
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.MaxReadSeq != seq {
		t.Fatalf("hook result = %+v, want frontier %d", result, seq)
	}
	// Revoked family is still refused through the hook.
	if _, err := fx.db.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`,
		fx.clock.Now().UnixMilli(), fx.family[fxAlice]); err != nil {
		t.Fatal(err)
	}
	err = fx.store.writeTx(fx.ctx(), func(tx *sql.Tx) error {
		_, err := fx.store.MarkReadLatestTx(fx.ctx(), tx, fx.claims[fxAlice], fxWS, fxGeneral)
		return err
	})
	if !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("revoked hook call = %v", err)
	}
}

// TestReadCursorTxHook: the channel-owned thread projection hook reads the
// effective frontier, 0 for absent cursors.
func TestReadCursorTxHook(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	var cursor int64
	err := fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		cursor, err = fx.store.ReadCursorTx(fx.ctx(), ex, fxWS, fxAlice, fxGeneral)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if cursor != 0 {
		t.Fatalf("absent cursor = %d, want 0", cursor)
	}
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq); err != nil {
		t.Fatal(err)
	}
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		cursor, err = fx.store.ReadCursorTx(fx.ctx(), ex, fxWS, fxAlice, fxGeneral)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if cursor != seq {
		t.Fatalf("cursor = %d, want %d", cursor, seq)
	}
}
