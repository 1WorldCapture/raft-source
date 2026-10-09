package machinews

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
)

func TestConnectionPrincipalCarriesAuthenticateProof(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:status","agentId":"a","status":"running"}`)
	env.waitFor("message", func() bool { return env.messageCount() == 1 })
	env.mu.Lock()
	p := env.messages[0].principal
	env.mu.Unlock()
	if p.CredentialRevision == "" || p.MachineID != machineID || p.Kind != computer.KindLegacyMachine || p.UserID != "u1" {
		t.Fatalf("principal = %+v, want the Authenticate proof", p)
	}
	if err := env.store.ValidatePrincipal(context.Background(), p); err != nil {
		t.Fatalf("Authenticate proof rejected: %v", err)
	}
	rotateLegacyVerifier(t, env, machineID)
	if err := env.store.ValidatePrincipal(context.Background(), p); computer.AsAuthError(err) == nil {
		t.Fatalf("rotated verifier err = %v, want an auth denial", err)
	}
}

func TestRevokedComputerRetiresEstablishedSocket(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	computerID, machineID, apiKey := env.seedComputer("u1", "alpha", "Maria-laptop")
	ws := env.dial(apiKey)
	defer closeQuietly(ws)
	readFrameExpect(t, ws, "machine:context")
	env.waitCond("online", func() bool { return env.hub.IsOnline(machineID) })

	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	if err := env.store.RevokeComputer(ctx, computerID, "u1", "rotated"); err != nil {
		t.Fatal(err)
	}
	sendFrame(t, ws, `{"type":"agent:status","agentId":"a","status":"running"}`)
	if got := expectClose(t, ws); got != websocket.StatusPolicyViolation {
		t.Fatalf("close = %d, want 1008", got)
	}
	if env.messageCount() != 0 {
		t.Fatalf("OnMessage ran after revoke: %d", env.messageCount())
	}
	sendCtx, sendCancel := context.WithTimeout(context.Background(), dialWait)
	defer sendCancel()
	if err := env.hub.Send(sendCtx, machineID, map[string]any{"type": "server:after"}); err == nil {
		t.Fatal("Send succeeded after revoke")
	}
}

func TestLegacyMigrationRetiresEstablishedSocket(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.waitCond("online", func() bool { return env.hub.IsOnline(machineID) })
	mustExec(t, env.db, `UPDATE machines SET legacy_key_migrated_at = ? WHERE id = ?`,
		env.clock.Now().UnixMilli(), machineID)
	sendFrame(t, ws, `{"type":"agent:status","agentId":"a","status":"running"}`)
	if got := expectClose(t, ws); got != websocket.StatusCode(4002) {
		t.Fatalf("close = %d, want 4002", got)
	}
	if env.messageCount() != 0 {
		t.Fatalf("OnMessage ran after migration: %d", env.messageCount())
	}
}

func TestDelayedCallbackSendCannotTargetReplacement(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	var scopeCtx context.Context
	var machineID string
	var sendErr atomic.Value
	var env *testEnv
	env = newTestEnv(t, func(cfg *Config) {
		cfg.OnMessage = func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			if !strings.Contains(string(raw), "agent:hold") {
				return nil
			}
			if err := env.hub.Send(ctx, p.MachineID, map[string]any{"type": "server:live"}); err != nil {
				sendErr.Store(err)
			}
			once.Do(func() {
				scopeCtx = ctx
				machineID = p.MachineID
				close(entered)
			})
			<-release
			return nil
		}
	})
	t.Cleanup(func() { closeReady(release) })
	_, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:hold"}`)
	<-entered
	if err, _ := sendErr.Load().(error); err != nil {
		t.Fatalf("scoped send while current: %v", err)
	}
	readFrameExpect(t, ws, "server:live")

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
		t.Fatal("replacement was not fenced by the callback")
	}
	close(release)
	ws2 := <-replaced
	defer closeQuietly(ws2)
	env.waitCond("replacement published", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})

	// WithoutCancel keeps the generation value after the old socket is
	// retired, which is the delayed-callback case that must not follow the
	// machine id onto the replacement.
	stale := context.WithoutCancel(scopeCtx)
	err := env.hub.Send(stale, machineID, map[string]any{"type": "server:stale"})
	if !errors.Is(err, ErrMachineOffline) {
		t.Fatalf("stale scoped send err = %v, want offline", err)
	}
	s := env.hub.slotExisting(machineID)
	s.Lock()
	queued := len(s.conn.sendQueue)
	s.Unlock()
	if queued != 0 {
		t.Fatalf("replacement queue len = %d, want 0", queued)
	}
}

func TestReplacementWaitsForBlockedReadyWrite(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	var saw atomic.Uint64
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.duringReadyTx = func() {
		snap := env.hub.CurrentSnapshot(machineID)
		if snap != nil {
			saw.Store(snap.Generation)
		}
		once.Do(func() { close(entered) })
		<-release
	}
	t.Cleanup(func() { closeReady(release) })
	sendFrame(t, ws, `{"type":"ready","runtimes":["stale"],"runningAgents":[]}`)
	<-entered
	if got := saw.Load(); got != 1 {
		t.Fatalf("generation inside ready transaction = %d, want 1", got)
	}

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
		t.Fatal("replacement was not blocked by the ready transaction")
	}
	close(release)
	ws2 := <-replaced
	defer closeQuietly(ws2)
	env.waitCond("replacement published", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["stale"]` {
		t.Fatalf("runtimes after blocked write = %v, want stale committed before replacement", row.runtimes)
	}
	sendFrame(t, ws2, `{"type":"ready","runtimes":["fresh"],"runningAgents":[]}`)
	env.waitFor("fresh ready", func() bool { return env.readyCount() == 2 })
	row = env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["fresh"]` {
		t.Fatalf("runtimes = %v, want fresh", row.runtimes)
	}
}

func TestReadyRetryRepeatsUntilSuccess(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.failReady.Store(3)
	sendFrame(t, ws, `{"type":"ready","runtimes":["claude"],"runningAgents":[]}`)
	env.waitCond("first retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.readyCount() != 0 {
		t.Fatal("OnReady ran before the facts committed")
	}
	env.advance(DefaultReadyRetryInterval)
	env.waitCond("second retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.readyCount() != 0 {
		t.Fatal("first retry was treated as success")
	}
	env.advance(DefaultReadyRetryInterval)
	env.waitCond("third retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.readyCount() != 0 {
		t.Fatal("second retry was treated as success")
	}
	env.advance(DefaultReadyRetryInterval)
	env.waitFor("ready committed", func() bool { return env.readyCount() == 1 })
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["claude"]` {
		t.Fatalf("runtimes = %v", row.runtimes)
	}
	if readyRetryArmed(env.hub, machineID) {
		t.Fatal("retry stayed armed after success")
	}
}

func TestReadyRetryDoesNotCommitAfterReplacement(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.failReady.Store(1)
	sendFrame(t, ws, `{"type":"ready","runtimes":["stale"],"runningAgents":[]}`)
	env.waitCond("retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	ws2 := env.dial(apiKey)
	defer closeQuietly(ws2)
	readFrameExpect(t, ws2, "machine:context")
	env.waitCond("replacement current", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
	env.advance(DefaultReadyRetryInterval)
	if env.readyCount() != 0 {
		t.Fatal("replaced generation's retry ran OnReady")
	}
	if row := env.machineRow(machineID); row.runtimes.Valid {
		t.Fatalf("stale retry committed %s", row.runtimes.String)
	}
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
		t.Fatalf("runtimes = %v, want fresh", row.runtimes)
	}
}

func TestReconnectCancelsDelayedOffline(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	closeQuietly(ws)
	env.waitCond("offline armed", func() bool { return offlineArmed(env.hub, machineID) })
	ws2 := env.dial(apiKey)
	defer closeQuietly(ws2)
	readFrameExpect(t, ws2, "machine:context")
	env.waitCond("reconnected", func() bool {
		snap := env.hub.CurrentSnapshot(machineID)
		return snap != nil && snap.Generation == 2
	})
	env.advance(DefaultDisconnectGrace)
	if env.disconnectCount() != 0 {
		t.Fatalf("OnDisconnect = %d, want 0", env.disconnectCount())
	}
	row := env.machineRow(machineID)
	if !row.lastStatus.Valid || row.lastStatus.String != "online" {
		t.Fatalf("last_status = %+v, want online", row.lastStatus)
	}
}

func TestInfrastructureValidationDoesNotMutate(t *testing.T) {
	var gate atomic.Bool
	var env *testEnv
	env = newTestEnv(t, func(cfg *Config) {
		cfg.ValidatePrincipal = func(ctx context.Context, p computer.Principal) error {
			if gate.Load() {
				return errors.New("db unavailable")
			}
			return env.store.ValidatePrincipal(ctx, p)
		}
	})
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.waitCond("online", func() bool { return env.hub.IsOnline(machineID) })
	gate.Store(true)
	sendFrame(t, ws, `{"type":"agent:status","agentId":"a","status":"running"}`)
	sendFrame(t, ws, `{"type":"ready","runtimes":["claude"],"runningAgents":[]}`)
	env.waitCond("ready retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.messageCount() != 0 || env.readyCount() != 0 {
		t.Fatalf("infra failure still mutated messages=%d ready=%d", env.messageCount(), env.readyCount())
	}
	if row := env.machineRow(machineID); row.runtimes.Valid {
		t.Fatalf("infra failure committed runtimes %s", row.runtimes.String)
	}
	if !env.hub.IsOnline(machineID) {
		t.Fatal("infra failure retired the socket")
	}
	gate.Store(false)
	env.advance(DefaultReadyRetryInterval)
	env.waitFor("retry after recovery", func() bool { return env.readyCount() == 1 })
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["claude"]` {
		t.Fatalf("runtimes = %v", row.runtimes)
	}
}

func TestCloseJoinsBlockedOfflineCallback(t *testing.T) {
	entered := make(chan struct{})
	var once sync.Once
	env := newTestEnv(t, func(cfg *Config) {
		cfg.OnDisconnect = func(ctx context.Context, _ computer.Principal) error {
			once.Do(func() { close(entered) })
			<-ctx.Done()
			return ctx.Err()
		}
	})
	machineID, _, ws := dialLegacy(t, env)
	closeQuietly(ws)
	env.waitCond("offline armed", func() bool { return offlineArmed(env.hub, machineID) })
	advanced := make(chan struct{})
	go func() {
		env.advance(DefaultDisconnectGrace)
		close(advanced)
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
		t.Fatal("Close did not join the offline callback")
	}
	select {
	case <-advanced:
	case <-time.After(dialWait):
		t.Fatal("offline callback did not return after Close")
	}
	if got := env.hub.life.active.Load(); got != 0 {
		t.Fatalf("active after Close = %d", got)
	}
}

func TestCloseStopsReadyRetry(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	env.failReady.Store(5)
	sendFrame(t, ws, `{"type":"ready","runtimes":["claude"],"runningAgents":[]}`)
	env.waitCond("retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	done := make(chan error, 1)
	go func() { done <- env.hub.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(dialWait):
		t.Fatal("Close did not return")
	}
	if got := env.hub.life.active.Load(); got != 0 {
		t.Fatalf("active after Close = %d", got)
	}
	env.advance(4 * DefaultReadyRetryInterval)
	if env.readyCount() != 0 {
		t.Fatal("ready retry committed after Close")
	}
}

func TestReplacementRaceRepeats(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	current := ws
	defer func() { closeQuietly(current) }()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = env.hub.IsOnline(machineID)
			_ = env.hub.Status(machineID)
			_ = env.hub.CurrentSnapshot(machineID)
			_ = env.hub.StatusVersion(machineID)
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
	}()

	for i := 0; i < 4; i++ {
		payload := fmt.Sprintf(`{"type":"ready","runtimes":["r%d"],"runningAgents":[]}`, i)
		sendFrame(t, ws, payload)
		want := i + 1
		env.waitFor(fmt.Sprintf("ready %d", want), func() bool { return env.readyCount() == want })
		row := env.machineRow(machineID)
		if !row.runtimes.Valid || row.runtimes.String != fmt.Sprintf(`["r%d"]`, i) {
			t.Fatalf("iteration %d runtimes = %v", i, row.runtimes)
		}
		next := env.dial(apiKey)
		readFrameExpect(t, next, "machine:context")
		wantGen := uint64(i + 2)
		env.waitCond(fmt.Sprintf("generation %d", wantGen), func() bool {
			snap := env.hub.CurrentSnapshot(machineID)
			return snap != nil && snap.Generation == wantGen
		})
		closeQuietly(current)
		current = next
		ws = next
	}
	env.advance(DefaultDisconnectGrace)
	row := env.machineRow(machineID)
	if !row.runtimes.Valid || row.runtimes.String != `["r3"]` {
		t.Fatalf("final runtimes = %v", row.runtimes)
	}
	if !row.lastStatus.Valid || row.lastStatus.String != "online" {
		t.Fatalf("final status = %+v", row.lastStatus)
	}
}
