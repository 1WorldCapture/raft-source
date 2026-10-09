package machinews

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

// The suite runs against the real artifacts end to end: the real SQLite
// migration chain, the real computer.Store authenticator (real argon2id
// verification of real generated keys), and REAL HTTP + WebSocket protocol
// exchanges — the same http.Server and the same coder/websocket Dial that
// production uses, over net.Pipe links because this sandbox forbids local
// port binds (the M2 suite runs the same way). Every handshake byte,
// upgrade header, close code and frame boundary exercised here is real; no
// fake Socket.IO, no stubbed handshake. Deterministic timers come from the
// ManualScheduler plus a fixed clock; socket events are consumed through
// short bounded polls instead of sleeps.
const (
	testPepper = "test-pepper-0123456789abcdef0123456789"
	dialWait   = 3 * time.Second
)

type testEnv struct {
	t       *testing.T
	db      *sql.DB
	clock   *clock.Fixed
	sched   *ManualScheduler
	hub     *Hub
	store   *computer.Store
	httpSrv *http.Server
	pipes   *pipeListener
	client  *http.Client

	// Presence fault-injection state shared with the env's PresenceStore.
	// The production store captured plain func values at construction; these
	// mutable slots are the TEST's own dispatchers, read by those captured
	// closures on every call (no pointer-to-func seam exists on the store).
	presence         *computer.PresenceStore
	failReady        atomic.Int32
	beforeReadyWrite func()
	duringReadyTx    func()

	mu       chanMutex
	ready    []readyCapture
	messages []msgCapture
	disconn  []computer.Principal
}

type readyCapture struct {
	principal computer.Principal
	raw       json.RawMessage
}

type msgCapture struct {
	principal computer.Principal
	raw       json.RawMessage
}

// chanMutex is a mutex the test can hold across channel sends.
type chanMutex chan struct{}

func (m chanMutex) Lock()   { <-m }
func (m chanMutex) Unlock() { m <- struct{}{} }

func newChanMutex() chanMutex {
	m := make(chan struct{}, 1)
	m <- struct{}{}
	return m
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestEnv(t *testing.T, mutate func(*Config)) *testEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	store, err := computer.NewStore(handle, computer.Options{
		Clock:            fixed,
		DeviceCodePepper: []byte(testPepper),
		Argon:            computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1},
	})
	if err != nil {
		t.Fatalf("computer store: %v", err)
	}

	env := &testEnv{
		t:     t,
		db:    handle,
		clock: fixed,
		sched: NewManualScheduler(fixed.Now()),
		store: store,
		mu:    newChanMutex(),
	}
	env.presence, err = computer.NewPresenceStore(handle, computer.PresenceOptions{
		TestFailReady: &env.failReady,
		TestBeforeReadyWrite: func() {
			if env.beforeReadyWrite != nil {
				env.beforeReadyWrite()
			}
		},
		TestDuringReadyTx: func() {
			if env.duringReadyTx != nil {
				env.duringReadyTx()
			}
		},
	})
	if err != nil {
		t.Fatalf("presence store: %v", err)
	}
	cfg := Config{
		Authenticator: store,
		Facts:         env.presence,
		Clock:         fixed,
		Logger:        discardLogger(),
		Scheduler:     env.sched,
		OnReady: func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			env.mu.Lock()
			defer env.mu.Unlock()
			env.ready = append(env.ready, readyCapture{principal: p, raw: append(json.RawMessage(nil), raw...)})
			return nil
		},
		OnMessage: func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			env.mu.Lock()
			defer env.mu.Unlock()
			env.messages = append(env.messages, msgCapture{principal: p, raw: append(json.RawMessage(nil), raw...)})
			return nil
		},
		OnDisconnect: func(ctx context.Context, p computer.Principal) error {
			env.mu.Lock()
			defer env.mu.Unlock()
			env.disconn = append(env.disconn, p)
			return nil
		},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	hub, err := NewHub(cfg)
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	env.hub = hub
	mux := http.NewServeMux()
	mux.Handle(ConnectPath, hub)

	// In-memory transport: a real http.Server serving a pipe listener, and
	// an HTTP client whose dialer hands out the other pipe end. The full
	// request/upgrade/frame protocol runs; only the link layer is a pipe.
	// (httptest.Server is avoided: since Go 1.27 its constructor eagerly
	// binds a TCP port, which this sandbox forbids.)
	env.pipes = newPipeListener()
	env.httpSrv = &http.Server{Handler: mux}
	go func() { _ = env.httpSrv.Serve(env.pipes) }()
	t.Cleanup(func() { _ = env.httpSrv.Close() })
	t.Cleanup(func() { _ = env.pipes.Close() })
	t.Cleanup(func() { _ = hub.Close() })

	env.client = &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return env.pipes.Dial()
			},
		},
	}
	return env
}

// pipeListener is an in-memory net.Listener (no TCP, no port bind).
type pipeListener struct {
	ready chan net.Conn
	done  chan struct{}
}

func newPipeListener() *pipeListener {
	return &pipeListener{ready: make(chan net.Conn), done: make(chan struct{})}
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.ready:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	select {
	case <-l.done:
	default:
		close(l.done)
	}
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

// Dial creates one pipe end and hands the other to the listener.
func (l *pipeListener) Dial() (net.Conn, error) {
	client, server := net.Pipe()
	select {
	case l.ready <- server:
		return client, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// advance moves the fixed clock and fires every scheduler callback that came
// due, in order, on this goroutine.
func (e *testEnv) advance(d time.Duration) {
	e.t.Helper()
	e.clock.Advance(d)
	e.sched.Advance(e.clock.Now())
}

// waitFor polls cond with a short deadline. Socket-driven state flips arrive
// through this rather than sleeps.
func (e *testEnv) waitFor(desc string, cond func() bool) {
	e.t.Helper()
	// Predicates such as readyCount/messageCount own the capture lock.
	// Holding it here would deadlock both the predicate and the callback
	// being awaited, preventing even the poll deadline from being checked.
	e.waitCond(desc, cond)
}

func (e *testEnv) waitCond(desc string, cond func() bool) {
	e.t.Helper()
	deadline := time.Now().Add(dialWait)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	e.t.Fatalf("timed out waiting for %s", desc)
}

func (e *testEnv) seedUser(id string) {
	e.t.Helper()
	now := e.clock.Now().UnixMilli()
	mustExec(e.t, e.db, `INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 'x', ?, ?)`, id, id+"@example.test", id, now, now)
}

func (e *testEnv) seedWorkspace(id, slug, ownerID string) {
	e.t.Helper()
	mustExec(e.t, e.db, `INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, "WS "+id, slug, ownerID, e.clock.Now().UnixMilli())
}

func (e *testEnv) seedMembership(workspaceID, userID, role string) {
	e.t.Helper()
	mustExec(e.t, e.db, `INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)`, workspaceID, userID, role, e.clock.Now().UnixMilli())
}

// seedLegacyMachine creates a machines row carrying a REAL legacy machine
// key (generated + argon2-hashed exactly like a registered daemon) and
// returns the raw key and machine id.
func (e *testEnv) seedLegacyMachine(workspaceID, userID, name string) (machineID, apiKey string) {
	e.t.Helper()
	apiKey, hash, prefix, fingerprint, err := computer.GenerateMachineKeyMaterial(
		computer.Argon2Config{MemoryKiB: 16, Iterations: 1, Parallelism: 1})
	if err != nil {
		e.t.Fatalf("machine key material: %v", err)
	}
	machineID = "m_" + name
	mustExec(e.t, e.db, `INSERT INTO machines
		(id, workspace_id, user_id, name, api_key_hash, api_key_prefix, api_key_fingerprint, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		machineID, workspaceID, userID, name, hash, prefix, fingerprint, e.clock.Now().UnixMilli())
	return machineID, apiKey
}

// seedComputer attaches a real managed Computer and returns the raw
// sk_computer_ key plus the linked machine id.
func (e *testEnv) seedComputer(userID, slug, name string) (computerID, machineID, apiKey string) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	attached, err := e.store.AttachComputer(ctx, userID, slug, name)
	if err != nil {
		e.t.Fatalf("attach computer: %v", err)
	}
	return attached.ServerMachineID, attached.MachineID, attached.APIKey
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("exec %s: %v", query, err)
	}
}

// baseURL is a virtual host the pipe transport resolves in memory.
const baseURL = "http://machinews.test"

func (e *testEnv) url() string { return "ws://machinews.test" + ConnectPath }

// dial opens a real WebSocket connection presenting the Bearer key.
func (e *testEnv) dial(apiKey string) *websocket.Conn {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, e.url(), &websocket.DialOptions{
		HTTPClient: e.client,
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + apiKey}},
	})
	if err != nil {
		e.t.Fatalf("dial: %v", err)
	}
	ws.SetReadLimit(DefaultReadLimit)
	return ws
}

// dialQuery uses the legacy ?key= form.
func (e *testEnv) dialQuery(apiKey string) *websocket.Conn {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, e.url()+"?key="+apiKey, &websocket.DialOptions{
		HTTPClient: e.client,
	})
	if err != nil {
		e.t.Fatalf("dial(query key): %v", err)
	}
	return ws
}

// readFrame reads one JSON frame with a bounded wait.
func readFrame(t *testing.T, ws *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	_, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var frame map[string]any
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("frame not JSON: %v (%s)", err, data)
	}
	return frame
}

// readFrameExpect reads one frame and asserts its type.
func readFrameExpect(t *testing.T, ws *websocket.Conn, wantType string) map[string]any {
	t.Helper()
	frame := readFrame(t, ws)
	if frame["type"] != wantType {
		t.Fatalf("frame type = %v, want %q (frame %v)", frame["type"], wantType, frame)
	}
	return frame
}

func sendFrame(t *testing.T, ws *websocket.Conn, payload string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func sendJSON(t *testing.T, ws *websocket.Conn, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	sendFrame(t, ws, string(data))
}

// expectClose waits for the peer close and returns the status code.
func expectClose(t *testing.T, ws *websocket.Conn) websocket.StatusCode {
	t.Helper()
	deadline := time.Now().Add(dialWait)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), dialWait)
		_, _, err := ws.Read(ctx)
		cancel()
		if err != nil {
			if status := websocket.CloseStatus(err); status != -1 {
				return status
			}
			t.Fatalf("read until close: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("no close frame within deadline")
		}
	}
}

type machineRow struct {
	runtimes                sql.NullString
	hostname                sql.NullString
	os                      sql.NullString
	daemonVersion           sql.NullString
	computerVersion         sql.NullString
	computerVersionReported sql.NullInt64
	lastHeartbeat           sql.NullInt64
	lastStatus              sql.NullString
	statusChangedAt         sql.NullInt64
}

func (e *testEnv) machineRow(machineID string) machineRow {
	e.t.Helper()
	var row machineRow
	err := e.db.QueryRow(`
		SELECT runtimes, hostname, os, daemon_version, computer_version,
		       computer_version_reported_at, last_heartbeat, last_status, status_changed_at
		FROM machines WHERE id = ?`, machineID).
		Scan(&row.runtimes, &row.hostname, &row.os, &row.daemonVersion,
			&row.computerVersion, &row.computerVersionReported,
			&row.lastHeartbeat, &row.lastStatus, &row.statusChangedAt)
	if err != nil {
		e.t.Fatalf("load machine row: %v", err)
	}
	return row
}

func (e *testEnv) readyCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.ready)
}

func (e *testEnv) messageCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.messages)
}

func (e *testEnv) disconnectCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.disconn)
}
