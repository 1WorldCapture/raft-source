package humanapi_test

import (
	"context"
	"database/sql"
	"sync/atomic"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/tests/testkit"
)

// The process-level commit listener must not turn the dispatcher's own empty
// reconciliation transactions into an endless stream of new scan work. This
// uses a real app and database: no isolated mock can reveal the feedback loop
// between the dispatcher and the shared transaction notification seam.
func TestM5IdleDispatcherDoesNotWakeItselfForever(t *testing.T) {
	env := testkit.NewTestEnv(t)
	var commits atomic.Int64
	storm := make(chan struct{}, 1)
	stop := platformdb.RegisterCommitListener(env.App.DB, func() {
		if commits.Add(1) > 64 {
			select {
			case storm <- struct{}{}:
			default:
			}
		}
	})
	defer stop()
	if err := platformdb.WithWriteTx(context.Background(), env.App.DB, func(*sql.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// No messages, pending deliveries, or external writers exist. One trigger
	// can produce a few bounded reconciliation commits, but never >64 before
	// the five-second durable recovery ticker. The deadline is only a guard
	// for absence of a spin; the failure itself is driven by observed commits.
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-storm:
		t.Fatalf("idle dispatcher is self-waking: %d commits from one trigger with no work", commits.Load())
	case <-timer.C:
	}
}
