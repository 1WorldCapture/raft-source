package machinews

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
)

func closeReady(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}

func TestNewHubRequiresPrincipalCheck(t *testing.T) {
	env := newTestEnv(t, nil)
	_, err := NewHub(Config{
		Authenticator: stubAuthenticator{},
		DB:            env.db,
		Clock:         env.clock,
	})
	if err == nil || !strings.Contains(err.Error(), "ValidatePrincipal") {
		t.Fatalf("NewHub err = %v, want a ValidatePrincipal requirement", err)
	}
}

type stubAuthenticator struct{}

func (stubAuthenticator) Authenticate(context.Context, string) (computer.Principal, error) {
	return computer.Principal{}, errors.New("stub")
}

func TestCurrentSnapshotIsImmutableAndPerMachine(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	firstID, firstKey := env.seedLegacyMachine("w1", "u1", "snap-a")
	secondID, secondKey := env.seedLegacyMachine("w1", "u1", "snap-b")
	ws1 := env.dial(firstKey)
	defer closeQuietly(ws1)
	readFrameExpect(t, ws1, "machine:context")
	ws2 := env.dial(secondKey)
	defer closeQuietly(ws2)
	readFrameExpect(t, ws2, "machine:context")
	env.waitCond("both online", func() bool {
		return env.hub.IsOnline(firstID) && env.hub.IsOnline(secondID)
	})
	if env.hub.StatusVersion(firstID) != 1 || env.hub.StatusVersion(secondID) != 1 {
		t.Fatalf("status versions = %d %d, want 1 and 1 (not a global counter)",
			env.hub.StatusVersion(firstID), env.hub.StatusVersion(secondID))
	}
	if env.hub.StatusVersion("missing") != 0 {
		t.Fatal("unknown machine status version must stay 0")
	}
	sendFrame(t, ws1, `{"type":"ready","runtimes":["claude"],"runtimeVersions":{"claude":"1.2.3"},"runningAgents":[]}`)
	env.waitFor("ready", func() bool { return env.readyCount() == 1 })
	env.waitCond("loops joined into the hub lifetime", func() bool {
		return env.hub.life.active.Load() >= 2
	})
	snap := env.hub.CurrentSnapshot(firstID)
	if snap == nil || snap.Generation != 1 {
		t.Fatalf("first generation = %+v, want 1", snap)
	}
	other := env.hub.Snapshot(secondID)
	if other == nil || other.Generation != 1 {
		t.Fatalf("second generation = %+v, want its own 1", other)
	}
	snap.RuntimeVersions["claude"] = "mutated"
	snap.Runtimes[0] = "mutated"
	again := env.hub.CurrentSnapshot(firstID)
	if again.RuntimeVersions["claude"] != "1.2.3" || again.Runtimes[0] != "claude" {
		t.Fatalf("snapshot aliased live state: %+v", again)
	}
	if again.Generation != snap.Generation {
		t.Fatalf("generation changed across copies: %d %d", snap.Generation, again.Generation)
	}
}

func TestIsOnlineFalseUntilContextPublishes(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	env := newTestEnv(t, nil)
	env.hub.testBeforePublish = func(string) {
		once.Do(func() { close(entered) })
		<-release
	}
	t.Cleanup(func() { closeReady(release) })
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	machineID, apiKey := env.seedLegacyMachine("w1", "u1", "early-online")

	readDone := make(chan struct{})
	wsCh := make(chan *websocket.Conn, 1)
	go func() {
		ws := env.dial(apiKey)
		wsCh <- ws
		readFrameExpect(t, ws, "machine:context")
		close(readDone)
	}()
	<-entered
	if env.hub.IsOnline(machineID) {
		t.Fatal("IsOnline was true before the context frame was published")
	}
	if env.hub.CurrentSnapshot(machineID) != nil {
		t.Fatal("CurrentSnapshot returned a connection before publish")
	}
	close(release)
	<-readDone
	ws := <-wsCh
	defer closeQuietly(ws)
	env.waitCond("online after publish", func() bool { return env.hub.IsOnline(machineID) })
	if env.hub.Status(machineID) != "online" {
		t.Fatalf("Status = %q", env.hub.Status(machineID))
	}
}

func TestReadyCallbackFollowsCommitAndLatestRetryWins(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.hub.facts.testFailReady.Store(1)
	sendFrame(t, ws, `{"type":"ready","runtimes":["claude"],"runningAgents":[],"daemonVersion":"old"}`)
	env.waitCond("first ready waiting to retry", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.readyCount() != 0 {
		t.Fatal("OnReady ran before a successful persist")
	}
	sendFrame(t, ws, `{"type":"ready","runtimes":["codex"],"runningAgents":[],"daemonVersion":"new"}`)
	env.waitFor("latest ready committed", func() bool { return env.readyCount() == 1 })
	env.mu.Lock()
	raw := string(env.ready[0].raw)
	env.mu.Unlock()
	if !strings.Contains(raw, `"daemonVersion":"new"`) || strings.Contains(raw, `"daemonVersion":"old"`) {
		t.Fatalf("OnReady payload = %s, want the latest ready frame", raw)
	}
	env.advance(DefaultReadyRetryInterval)
	if env.readyCount() != 1 {
		t.Fatalf("retry fired OnReady again: %d", env.readyCount())
	}
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["codex"]` {
		t.Fatalf("runtimes = %v, want codex only", row.runtimes)
	}
}

func TestBlockedCallbackCannotObserveReplacement(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	var sawReplacement atomic.Bool
	var during atomic.Uint64
	probe := make(chan struct{})
	snapped := make(chan struct{})
	var env *testEnv
	env = newTestEnv(t, func(cfg *Config) {
		cfg.OnMessage = func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			if !strings.Contains(string(raw), "agent:block") {
				return nil
			}
			once.Do(func() { close(entered) })
			<-probe
			// Snapshot from the lock owner. The test goroutine cannot take
			// the same lock while this callback is the fence.
			if snap := env.hub.CurrentSnapshot(p.MachineID); snap != nil {
				during.Store(snap.Generation)
			}
			close(snapped)
			<-release
			snap := env.hub.CurrentSnapshot(p.MachineID)
			if snap == nil || snap.Generation != 1 {
				sawReplacement.Store(true)
			}
			return nil
		}
	})
	t.Cleanup(func() { closeReady(release) })
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:block"}`)
	<-entered

	contended := make(chan struct{}, 1)
	env.hub.slotExisting(machineID).onWait.Store(func() {
		select {
		case <-probe:
		default:
			close(probe)
		}
		select {
		case contended <- struct{}{}:
		default:
		}
	})
	replaced := make(chan *websocket.Conn, 1)
	go func() {
		ws2 := env.dial(apiKey)
		readFrameExpect(t, ws2, "machine:context")
		replaced <- ws2
	}()
	select {
	case <-contended:
	case <-time.After(dialWait):
		t.Fatal("replacement was not blocked by the callback fence")
	}
	select {
	case <-snapped:
	case <-time.After(dialWait):
		t.Fatal("callback did not observe the generation while fencing replacement")
	}
	if got := during.Load(); got != 1 {
		t.Fatalf("generation during blocked callback = %d, want 1", got)
	}
	close(release)
	ws2 := <-replaced
	defer closeQuietly(ws2)
	env.waitCond("replacement published", func() bool {
		next := env.hub.CurrentSnapshot(machineID)
		return next != nil && next.Generation == 2
	})
	if sawReplacement.Load() {
		t.Fatal("callback kept running after the replacement was published")
	}
}

func TestBlockedReadyDoesNotCommitAfterReplacement(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	env := newTestEnv(t, nil)
	env.hub.testDropFence = func(op, _ string, generation uint64) {
		if op != "ready" || generation != 1 {
			return
		}
		once.Do(func() { close(entered) })
		<-release
	}
	t.Cleanup(func() { closeReady(release) })
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"ready","runtimes":["stale"],"runningAgents":[]}`)
	<-entered

	ws2 := env.dial(apiKey)
	defer closeQuietly(ws2)
	readFrameExpect(t, ws2, "machine:context")
	env.waitCond("replacement current", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
	close(release)
	sendFrame(t, ws2, `{"type":"ready","runtimes":["fresh"],"runningAgents":[]}`)
	env.waitFor("fresh ready", func() bool { return env.readyCount() == 1 })
	env.mu.Lock()
	raw := string(env.ready[0].raw)
	env.mu.Unlock()
	if strings.Contains(raw, "stale") || !strings.Contains(raw, "fresh") {
		t.Fatalf("OnReady = %s", raw)
	}
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["fresh"]` {
		t.Fatalf("runtimes = %v, want fresh only", row.runtimes)
	}
}

func TestOfflineProjectionAbortsWhenReconnectWins(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	env.hub.testDropFence = func(op, _ string, _ uint64) {
		if op != "offline" {
			return
		}
		once.Do(func() { close(entered) })
		<-release
	}
	t.Cleanup(func() { closeReady(release) })
	closeQuietly(ws)
	env.waitCond("offline armed", func() bool { return offlineArmed(env.hub, machineID) })
	advanced := make(chan struct{})
	go func() {
		env.sched.Advance(env.sched.Now().Add(DefaultDisconnectGrace))
		close(advanced)
	}()
	<-entered
	ws2 := env.dial(apiKey)
	defer closeQuietly(ws2)
	readFrameExpect(t, ws2, "machine:context")
	env.waitCond("reconnected", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
	close(release)
	<-advanced
	if env.disconnectCount() != 0 {
		t.Fatalf("OnDisconnect = %d, want 0 after reconnect won", env.disconnectCount())
	}
	row := env.machineRow(machineID)
	if !row.lastStatus.Valid || row.lastStatus.String != "online" {
		t.Fatalf("last_status = %+v, want online", row.lastStatus)
	}
}

func TestRotationRejectsEstablishedMutation(t *testing.T) {
	t.Run("next frame", func(t *testing.T) {
		env := newTestEnv(t, nil)
		machineID, _, ws := dialLegacy(t, env)
		defer closeQuietly(ws)
		rotateLegacyVerifier(t, env, machineID)
		sendFrame(t, ws, `{"type":"agent:status","agentId":"a","status":"running"}`)
		if got := expectClose(t, ws); got != websocket.StatusCode(1008) {
			t.Fatalf("close = %d, want 1008", got)
		}
		if env.messageCount() != 0 {
			t.Fatalf("OnMessage ran after rotation: %d", env.messageCount())
		}
	})
	t.Run("in flight before transaction", func(t *testing.T) {
		env := newTestEnv(t, nil)
		machineID, _, ws := dialLegacy(t, env)
		defer closeQuietly(ws)
		_, hash, prefix, fingerprint, err := computer.GenerateMachineKeyMaterial(
			computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1})
		if err != nil {
			t.Fatal(err)
		}
		env.hub.facts.testBeforeReadyWrite = func() {
			_, _ = env.db.Exec(`UPDATE machines SET api_key_hash = ?, api_key_prefix = ?, api_key_fingerprint = ? WHERE id = ?`,
				hash, prefix, fingerprint, machineID)
		}
		sendFrame(t, ws, `{"type":"ready","runtimes":["stale"],"runningAgents":[]}`)
		if got := expectClose(t, ws); got != websocket.StatusCode(1008) {
			t.Fatalf("close = %d, want 1008", got)
		}
		if env.readyCount() != 0 {
			t.Fatal("OnReady ran after the verifier changed")
		}
		row := env.machineRow(machineID)
		if row.runtimes.Valid {
			t.Fatalf("stale ready committed %s", row.runtimes.String)
		}
	})
}

func TestCallbackSendDoesNotDeadlockWithReplacement(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	var sendErr atomic.Value
	var env *testEnv
	env = newTestEnv(t, func(cfg *Config) {
		cfg.OnMessage = func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			if !strings.Contains(string(raw), "agent:block") {
				return nil
			}
			if err := env.hub.Send(ctx, p.MachineID, map[string]any{"type": "server:echo"}); err != nil {
				sendErr.Store(err)
			}
			once.Do(func() { close(started) })
			<-release
			return nil
		}
	})
	t.Cleanup(func() { closeReady(release) })
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:block"}`)
	select {
	case <-started:
	case <-time.After(dialWait):
		t.Fatal("Send from OnMessage did not return")
	}
	if err, _ := sendErr.Load().(error); err != nil {
		t.Fatalf("Send from callback: %v", err)
	}
	readFrameExpect(t, ws, "server:echo")

	contended := make(chan struct{}, 1)
	env.hub.slotExisting(machineID).onWait.Store(func() {
		select {
		case contended <- struct{}{}:
		default:
		}
	})
	replaced := make(chan *websocket.Conn, 1)
	go func() {
		ws2 := env.dial(apiKey)
		readFrameExpect(t, ws2, "machine:context")
		replaced <- ws2
	}()
	select {
	case <-contended:
	case <-time.After(dialWait):
		t.Fatal("replacement deadlocked behind callback Send")
	}
	close(release)
	ws2 := <-replaced
	defer closeQuietly(ws2)
	env.waitCond("replaced", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
}

func TestConcurrentCloseJoinsHandshake(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	auth := &gateAuth{entered: entered, release: release}
	env := newTestEnv(t, func(cfg *Config) {
		cfg.Authenticator = auth
	})
	atWait := make(chan struct{})
	allow := make(chan struct{})
	var waitOnce sync.Once
	env.hub.testBeforeWait = func() {
		waitOnce.Do(func() { close(atWait) })
		<-allow
	}
	second := make(chan struct{})
	var secondOnce sync.Once
	env.hub.testCloseWaiter = func() {
		secondOnce.Do(func() { close(second) })
	}
	t.Cleanup(func() {
		closeReady(release)
		closeReady(allow)
	})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, _ = websocket.Dial(ctx, env.url(), &websocket.DialOptions{
			HTTPClient: env.client,
			HTTPHeader: map[string][]string{"Authorization": {"Bearer sk_machine_" + strings.Repeat("ab", 32)}},
		})
	}()
	<-entered
	if env.hub.life.active.Load() < 1 {
		t.Fatal("handshake was not tracked")
	}
	done1 := make(chan error, 1)
	done2 := make(chan error, 1)
	go func() { done1 <- env.hub.Close() }()
	<-atWait
	if env.hub.life.active.Load() < 1 {
		t.Fatal("Close reached its barrier without the handshake")
	}
	go func() { done2 <- env.hub.Close() }()
	<-second
	select {
	case err := <-done1:
		t.Fatalf("Close returned while the handshake was still blocked: %v", err)
	default:
	}
	close(release)
	close(allow)
	if err := <-done1; err != nil {
		t.Fatal(err)
	}
	if err := <-done2; err != nil {
		t.Fatal(err)
	}
	if got := env.hub.life.active.Load(); got != 0 {
		t.Fatalf("active goroutines after Close = %d", got)
	}
}

func TestCloseCancelsHandshake(t *testing.T) {
	entered := make(chan struct{})
	auth := &gateAuth{entered: entered, release: make(chan struct{})}
	env := newTestEnv(t, func(cfg *Config) {
		cfg.Authenticator = auth
	})
	var finished atomic.Bool
	auth.done = &finished
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, _ = websocket.Dial(ctx, env.url(), &websocket.DialOptions{
			HTTPClient: env.client,
			HTTPHeader: map[string][]string{"Authorization": {"Bearer sk_machine_" + strings.Repeat("ab", 32)}},
		})
	}()
	<-entered
	done := make(chan error, 1)
	go func() { done <- env.hub.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(dialWait):
		t.Fatal("Close did not cancel the in-flight handshake")
	}
	if !finished.Load() {
		t.Fatal("Close returned before the handshake observed cancellation")
	}
}

func TestContextCancelUnblocksCallbackAndClose(t *testing.T) {
	started := make(chan struct{})
	var env *testEnv
	env = newTestEnv(t, func(cfg *Config) {
		cfg.OnMessage = func(ctx context.Context, _ computer.Principal, raw json.RawMessage) error {
			if !strings.Contains(string(raw), "agent:stall") {
				return nil
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}
	})
	_, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:stall"}`)
	<-started
	done1 := make(chan error, 1)
	done2 := make(chan error, 1)
	go func() { done1 <- env.hub.Close() }()
	go func() { done2 <- env.hub.Close() }()
	select {
	case err := <-done1:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(dialWait):
		t.Fatal("Close did not return after the callback context was canceled")
	}
	select {
	case err := <-done2:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(dialWait):
		t.Fatal("concurrent Close did not observe the same completion")
	}
	if got := env.hub.life.active.Load(); got != 0 {
		t.Fatalf("active after Close = %d", got)
	}
}

func TestStatusVersionAdvancesForOffline(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	env.waitCond("online", func() bool { return env.hub.StatusVersion(machineID) == 1 })
	closeQuietly(ws)
	env.waitCond("offline armed", func() bool { return offlineArmed(env.hub, machineID) })
	env.advance(DefaultDisconnectGrace)
	env.waitFor("disconnect callback", func() bool { return env.disconnectCount() == 1 })
	if got := env.hub.StatusVersion(machineID); got != 2 {
		t.Fatalf("status version after offline = %d, want 2", got)
	}
	if env.hub.IsOnline(machineID) || env.hub.CurrentSnapshot(machineID) != nil {
		t.Fatal("offline machine still has a current snapshot")
	}
	if env.hub.Status(machineID) != "offline" {
		t.Fatalf("Status = %q", env.hub.Status(machineID))
	}
}

func TestFenceRace(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			_, _, err := ws.Read(ctx)
			cancel()
			if err != nil {
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 30; n++ {
				_ = env.hub.IsOnline(machineID)
				_ = env.hub.Status(machineID)
				_ = env.hub.StatusVersion(machineID)
				_ = env.hub.Snapshot(machineID)
				_ = env.hub.CurrentSnapshot(machineID)
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				_ = env.hub.Send(ctx, machineID, map[string]any{"type": "server:tick"})
				cancel()
			}
		}()
	}
	wg.Wait()
}

type gateAuth struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	done    *atomic.Bool
}

func (g *gateAuth) Authenticate(ctx context.Context, _ string) (computer.Principal, error) {
	g.once.Do(func() { close(g.entered) })
	if g.done != nil {
		select {
		case <-ctx.Done():
		case <-g.release:
		}
		g.done.Store(true)
		return computer.Principal{}, ctx.Err()
	}
	<-g.release
	return computer.Principal{}, errors.New("stopped")
}

func (g *gateAuth) ValidatePrincipal(context.Context, computer.Principal) error {
	return errors.New("stopped")
}

func rotateLegacyVerifier(t *testing.T, env *testEnv, machineID string) {
	t.Helper()
	_, hash, prefix, fingerprint, err := computer.GenerateMachineKeyMaterial(
		computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1})
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, env.db, `UPDATE machines SET api_key_hash = ?, api_key_prefix = ?, api_key_fingerprint = ? WHERE id = ?`,
		hash, prefix, fingerprint, machineID)
}

func offlineArmed(h *Hub, machineID string) bool {
	s := h.slotExisting(machineID)
	if s == nil {
		return false
	}
	s.Lock()
	defer s.Unlock()
	return s.offline != nil
}
