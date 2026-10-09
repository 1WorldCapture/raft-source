package agentdelivery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/agentconversation"
	"raft.local/server-go/internal/application/onboarding"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/delivery"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

type recordingSender struct {
	steps    []string
	enqueued bool
	fail     error
}

func (s *recordingSender) SendAdmitted(ctx context.Context, machineID string, payload any, admission func(context.Context, computer.Principal, func() error) error) error {
	if s.fail != nil {
		return s.fail
	}
	s.steps = append(s.steps, "slot")
	return admission(ctx, computer.Principal{MachineID: machineID, WorkspaceID: "w"}, func() error {
		s.steps = append(s.steps, "enqueue")
		s.enqueued = true
		return nil
	})
}

func TestHoldAdmissionEnqueuesOnlyAfterAllow(t *testing.T) {
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	sender := &recordingSender{}
	err = holdAdmission(context.Background(), sender, handle, "m1", map[string]string{"type": "agent:deliver"}, func(context.Context, computer.Principal) error {
		sender.steps = append(sender.steps, "allow")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sender.enqueued {
		t.Fatal("authorized admission did not enqueue")
	}
	if got := stringsJoin(sender.steps); got != "slot allow enqueue" {
		t.Fatalf("lock order %q, want slot then authority then enqueue", got)
	}
}

func TestHoldAdmissionRefusesBeforeEnqueue(t *testing.T) {
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	sender := &recordingSender{}
	err = holdAdmission(context.Background(), sender, handle, "m1", map[string]string{"type": "agent:deliver"}, func(context.Context, computer.Principal) error {
		return &AdmissionDenied{Reason: "agent_not_member", Recoverable: false}
	})
	if sender.enqueued {
		t.Fatal("revoked admission enqueued a frame")
	}
	var denied *AdmissionDenied
	if !errors.As(err, &denied) || denied.Reason != "agent_not_member" || denied.Recoverable {
		t.Fatalf("denial = %v", err)
	}
	code, recoverable := classifyDispatchFailure(err)
	if code != "agent_not_member" || recoverable {
		t.Fatalf("classified %s recoverable=%v", code, recoverable)
	}
}

func TestDispatcherCloseBeforeStartDoesNotResurrect(t *testing.T) {
	env := newLifecycleEnv(t)
	if err := env.d.Close(); err != nil {
		t.Fatal(err)
	}
	if err := env.d.Close(); err != nil {
		t.Fatal(err)
	}
	release := holdWriteFence(t, env.db)
	defer release()
	awaitReturn(t, "Start after Close", func() { env.d.Start(context.Background()) })
	release()
	assertCommitsStay(t, env.commits, 1, time.Second)
}

func TestDispatcherDuplicateStartOneRecoveryAndScan(t *testing.T) {
	env := newLifecycleEnv(t)
	release := holdWriteFence(t, env.db)
	defer release()
	awaitReturn(t, "Start", func() { env.d.Start(context.Background()) })
	awaitReturn(t, "duplicate Start", func() { env.d.Start(context.Background()) })
	if got := env.commits.Load(); got != 0 {
		t.Fatalf("startup recovery committed while the database fence was held: %d", got)
	}
	release()
	// The unblocked fence transaction, one RecoverExpiredLeases, and one
	// scan cycle (reconcile plus finalize). A second Start would recover
	// and scan again, and a self-wake would keep writing.
	assertCommitsReachAndStay(t, env.commits, 4, time.Second)

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			errs <- env.d.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-env.d.done:
	default:
		t.Fatal("Close returned before the worker finished")
	}
	sealed := env.commits.Load()
	env.d.Start(context.Background())
	assertCommitsStay(t, env.commits, sealed, time.Second)
}

func TestDispatcherConcurrentStartClose(t *testing.T) {
	env := newLifecycleEnv(t)
	var wg sync.WaitGroup
	const n = 16
	wg.Add(n * 2)
	for range n {
		go func() {
			defer wg.Done()
			env.d.Start(context.Background())
		}()
		go func() {
			defer wg.Done()
			if err := env.d.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		}()
	}
	wg.Wait()
	if err := env.d.Close(); err != nil {
		t.Fatal(err)
	}
	env.d.mu.Lock()
	started := env.d.started
	env.d.mu.Unlock()
	if started {
		select {
		case <-env.d.done:
		default:
			t.Fatal("Close returned with the worker still running")
		}
	}
	sealed := env.commits.Load()
	if err := platformdb.WithWriteTx(context.Background(), env.db, func(*sql.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	assertCommitsStay(t, env.commits, sealed+1, time.Second)
	env.d.Start(context.Background())
	assertCommitsStay(t, env.commits, sealed+1, time.Second)
}

func TestDispatcherCloseCancelsBlockedStartupRecovery(t *testing.T) {
	env := newLifecycleEnv(t)
	release := holdWriteFence(t, env.db)
	defer release()
	awaitReturn(t, "Start", func() { env.d.Start(context.Background()) })
	// The fence is still held, so RecoverExpiredLeases cannot begin its
	// transaction. Close must cancel that wait instead of blocking on it.
	time.Sleep(100 * time.Millisecond)
	if got := env.commits.Load(); got != 0 {
		t.Fatalf("recovery committed while the fence was held: %d", got)
	}
	joined := make(chan error, 1)
	go func() { joined <- env.d.Close() }()
	select {
	case err := <-joined:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked while startup recovery waited on the database fence")
	}
	select {
	case <-env.d.done:
	default:
		t.Fatal("Close returned before the worker finished")
	}
	if err := env.d.Close(); err != nil {
		t.Fatal(err)
	}
	release()
	assertCommitsStay(t, env.commits, 1, time.Second)
}

type lifecycleEnv struct {
	d       *Dispatcher
	db      *sql.DB
	commits *atomic.Int64
}

func newLifecycleEnv(t *testing.T) *lifecycleEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.DiscardHandler)
	store := delivery.NewStore(handle)
	directory := agent.NewStore(handle, agent.StoreOptions{})
	agents := agent.NewService(directory, agent.ServiceOptions{Logger: logger})
	channels := channel.NewStore(handle)
	messages := message.NewStore(handle, channels)
	conversations, err := agentconversation.NewService(directory, channels, messages)
	if err != nil {
		t.Fatal(err)
	}
	briefings, err := onboarding.NewService(workspace.NewStore(handle), channels, store)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(store, agents, directory, conversations, briefings, logger)
	if err != nil {
		t.Fatal(err)
	}
	dispatcher, err := NewDispatcher(svc, &recordingSender{}, stubEncoder{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	var commits atomic.Int64
	stop := platformdb.RegisterCommitListener(handle, func() { commits.Add(1) })
	t.Cleanup(func() {
		_ = dispatcher.Close()
		stop()
		_ = handle.Close()
	})
	return &lifecycleEnv{d: dispatcher, db: handle, commits: &commits}
}

type stubEncoder struct{}

func (stubEncoder) EncodeMessage(agentconversation.MessageFacts) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func (stubEncoder) EncodeControl(ControlNotice) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

// holdWriteFence occupies the authority fence until release. Startup recovery
// uses that same fence, so a blocked holder is a real cancelled-wait case.
func holdWriteFence(t *testing.T, db *sql.DB) (release func()) {
	t.Helper()
	entered := make(chan struct{})
	letGo := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- platformdb.WithWriteTx(context.Background(), db, func(*sql.Tx) error {
			close(entered)
			<-letGo
			return nil
		})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out holding the database fence")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			close(letGo)
			if err := <-errc; err != nil {
				t.Errorf("release database fence: %v", err)
			}
		})
	}
}

func awaitReturn(t *testing.T, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s blocked", what)
	}
}

func assertCommitsStay(t *testing.T, commits *atomic.Int64, want int64, quiet time.Duration) {
	t.Helper()
	deadline := time.Now().Add(quiet)
	for time.Now().Before(deadline) {
		if got := commits.Load(); got != want {
			t.Fatalf("commits = %d, want %d", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := commits.Load(); got != want {
		t.Fatalf("commits = %d, want %d", got, want)
	}
}

func assertCommitsReachAndStay(t *testing.T, commits *atomic.Int64, want int64, quiet time.Duration) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for commits.Load() < want {
		if time.Now().After(deadline) {
			t.Fatalf("commits = %d, want %d", commits.Load(), want)
		}
		if got := commits.Load(); got > want {
			t.Fatalf("commits = %d, want %d", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := commits.Load(); got != want {
		t.Fatalf("commits = %d, want %d", got, want)
	}
	assertCommitsStay(t, commits, want, quiet)
}

func stringsJoin(parts []string) string {
	out := ""
	for i, part := range parts {
		if i > 0 {
			out += " "
		}
		out += part
	}
	return out
}
