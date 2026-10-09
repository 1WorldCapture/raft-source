package publication

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
)

func publicationFixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "raft.db")
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close(); platformdb.ReleaseAuthorityFence(handle) })
	if _, err := handle.Exec(`INSERT INTO users(id,email,name,email_verified,password_hash,created_at,updated_at)
		VALUES('owner','owner@example.test','owner',1,'test-only',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO workspaces(id,name,slug,owner_id,created_at)
		VALUES('ws','Fixture','fixture','owner',1)`); err != nil {
		t.Fatal(err)
	}
	return handle, path
}

func testPublication(id string) Publication {
	return Publication{WorkspaceID: "ws", ObjectType: "message", ObjectID: id, EventType: "message:new", Revision: 1, ScopeID: "channel"}
}

func TestPublicationAtomicRollbackAndIdempotency(t *testing.T) {
	handle, _ := publicationFixture(t)
	ctx := context.Background()
	p := testPublication("one")
	if err := Enqueue(ctx, handle, p); err == nil {
		t.Fatal("publication accepted outside transaction")
	}
	rollback := errors.New("rollback")
	err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		if err := Enqueue(ctx, tx, p); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled back publication persisted: %d %v", count, err)
	}
	if err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		if err := Enqueue(ctx, tx, p); err != nil {
			return err
		}
		return Enqueue(ctx, tx, p)
	}); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("idempotent publication count: %d %v", count, err)
	}
}

func TestPublicationRetrySurvivesReopenAndDoesNotMeanDelivered(t *testing.T) {
	handle, path := publicationFixture(t)
	ctx := context.Background()
	if err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		return Enqueue(ctx, tx, testPublication("recover"))
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s := NewStore(handle)
	s.now = func() time.Time { return now }
	var firstID int64
	if n, err := s.DrainOnce(ctx, func(_ context.Context, p Publication) error {
		firstID = p.ID
		// Simulates a transport admission followed by a failure before the
		// publisher can mark completion. Repeating this reference is safe.
		return errors.New("temporary transport failure")
	}); n != 1 || !errors.Is(err, ErrPublicationRetry) {
		t.Fatalf("retry result: n=%d err=%v", n, err)
	}
	if n, err := s.DrainOnce(ctx, func(context.Context, Publication) error {
		t.Error("backoff was ignored")
		return nil
	}); n != 0 || err != nil {
		t.Fatalf("backoff pass: n=%d err=%v", n, err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	platformdb.ReleaseAuthorityFence(handle)
	reopened, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close(); platformdb.ReleaseAuthorityFence(reopened) }()
	s = NewStore(reopened)
	s.now = func() time.Time { return now.Add(2 * time.Second) }
	if n, err := s.DrainOnce(ctx, func(_ context.Context, p Publication) error {
		if p.ID != firstID || p.ObjectID != "recover" || p.Attempts != 1 {
			t.Fatalf("retry reference changed: %+v", p)
		}
		return nil // processed with no online receivers; NOT a delivery ACK
	}); n != 1 || err != nil {
		t.Fatalf("reopen publication: n=%d err=%v", n, err)
	}
	if n, err := s.DrainOnce(ctx, func(context.Context, Publication) error {
		t.Error("marked publication replayed")
		return nil
	}); n != 0 || err != nil {
		t.Fatalf("final empty pass: n=%d err=%v", n, err)
	}
}

func TestPublicationBacklogFailsAdmissionAtomically(t *testing.T) {
	handle, _ := publicationFixture(t)
	ctx := context.Background()
	if _, err := handle.Exec(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?)
		INSERT INTO realtime_publications(workspace_id,object_type,object_id,event_type,revision,created_at)
		SELECT 'ws','message','seed-'||v,'message:new',1,1 FROM n`, MaxPending); err != nil {
		t.Fatal(err)
	}
	s := NewStore(handle)
	if err := s.Ready(ctx); !errors.Is(err, ErrBacklogFull) {
		t.Fatalf("full backlog not surfaced by readiness: %v", err)
	}
	err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET name='must roll back' WHERE id='ws'`); err != nil {
			return err
		}
		return Enqueue(ctx, tx, testPublication("new"))
	})
	if !errors.Is(err, ErrBacklogFull) {
		t.Fatalf("full backlog accepted fact: %v", err)
	}
	var name string
	if err := handle.QueryRow(`SELECT name FROM workspaces WHERE id='ws'`).Scan(&name); err != nil || name != "Fixture" {
		t.Fatalf("fact committed without publication: %q %v", name, err)
	}
	if err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		return Enqueue(ctx, tx, testPublication("seed-1"))
	}); err != nil {
		t.Fatalf("existing publication consumed backlog budget: %v", err)
	}
}

func TestEmptyPublicationWorkerDoesNotCommitSpin(t *testing.T) {
	handle, _ := publicationFixture(t)
	var commits atomic.Int64
	unsubscribe := platformdb.RegisterCommitListener(handle, func() { commits.Add(1) })
	defer unsubscribe()
	s := NewStore(handle)
	stop := s.Start(context.Background(), func(context.Context, Publication) error {
		t.Error("empty outbox published an event")
		return nil
	}, nil)
	time.Sleep(100 * time.Millisecond)
	stop()
	stop()
	if got := commits.Load(); got != 0 {
		t.Fatalf("empty worker generated self-waking commits: %d", got)
	}
}
