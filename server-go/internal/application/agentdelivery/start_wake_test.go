package agentdelivery

import (
	"context"
	"runtime"
	"testing"
)

// Start must suppress redundant commit wakes before it exposes the listener,
// not only after the new goroutine gets CPU time. The initial full scan covers
// these committed facts; retaining a pre-worker wake schedules a second scan.
func TestDispatcherStartSuppressesWakeBeforeWorkerRuns(t *testing.T) {
	previous := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(previous)
	env := newLifecycleEnv(t)
	release := holdWriteFence(t, env.db)
	defer release()

	// No helper goroutine or wait between Start and the callback: exercise
	// the interval in which Start returned but its worker has not run yet.
	env.d.Start(context.Background())
	env.d.Wake()
	if queued := len(env.d.wake); queued != 0 {
		t.Fatalf("Start left %d redundant wakes queued before startup recovery", queued)
	}
	if !env.d.suppressWake.Load() {
		t.Fatal("Start returned before enabling startup wake suppression")
	}
	if err := env.d.Close(); err != nil {
		t.Fatal(err)
	}
}
