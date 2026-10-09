package agentdelivery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
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

// coldGateway is the lifecycle Service's machine gateway. It stays a
// bounded in-memory double: online is a flag the test sets, Send does not
// open a socket, and it never touches SQLite. Delivery frames do not travel
// this path; those use the dispatcher's AdmittedSender.
type coldGateway struct {
	mu     sync.Mutex
	online bool
	fail   error
	sent   []coldStart
}

type coldStart struct {
	at        time.Time
	machineID string
	command   agent.StartDispatchCommand
}

func (g *coldGateway) IsOnline(string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.online
}

func (g *coldGateway) Send(_ context.Context, machineID string, payload any) error {
	command, ok := payload.(agent.StartDispatchCommand)
	if !ok {
		return errors.New("cold gateway: unexpected payload")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sent = append(g.sent, coldStart{at: time.Now(), machineID: machineID, command: command})
	if g.fail != nil {
		return g.fail
	}
	if !g.online {
		return errors.New("machine offline")
	}
	return nil
}

func (g *coldGateway) starts() []coldStart {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]coldStart, len(g.sent))
	copy(out, g.sent)
	return out
}

func (g *coldGateway) setFail(err error) {
	g.mu.Lock()
	g.fail = err
	g.mu.Unlock()
}

func (g *coldGateway) isOnline() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.online
}

type coldEnv struct {
	t     *testing.T
	db    *sql.DB
	d     *Dispatcher
	gw    *coldGateway
	store *delivery.Store
}

func newColdEnv(t *testing.T) *coldEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.DiscardHandler)
	store := delivery.NewStore(handle)
	directory := agent.NewStore(handle, agent.StoreOptions{})
	launches, err := agent.NewLaunchStore(handle, nil)
	if err != nil {
		t.Fatal(err)
	}
	gw := &coldGateway{online: true}
	agents := agent.NewService(directory, agent.ServiceOptions{
		Gateway: gw, ServerURL: "http://127.0.0.1:8080", Launches: launches, Logger: logger,
	})
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
	dispatcher, err := NewDispatcher(svc, coldAdmitSender{}, stubEncoder{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	env := &coldEnv{t: t, db: handle, d: dispatcher, gw: gw, store: store}
	env.seedWorkspace()
	t.Cleanup(func() {
		_ = dispatcher.Close()
		_ = handle.Close()
	})
	return env
}

// coldAdmitSender accepts the delivery frame path without a machine slot.
// These tests assert start reservation, not agent:deliver admission.
type coldAdmitSender struct{}

func (coldAdmitSender) SendAdmitted(context.Context, string, any, func(context.Context, computer.Principal, func() error) error) error {
	return nil
}

func (e *coldEnv) seedWorkspace() {
	e.t.Helper()
	now := time.Now().UnixMilli()
	e.exec(`INSERT INTO users (id, email, name, display_name, password_hash, email_verified, created_at, updated_at)
		VALUES ('owner', 'owner@example.test', 'owner', 'Owner', 'x', 1, ?, ?)`, now, now)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES ('ws', 'Workspace', 'ws', 'owner', ?)`, now)
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES ('ws', 'owner', 'owner', 0, ?)`, now)
	e.exec(`INSERT INTO machines (id, workspace_id, user_id, name, last_status, created_at)
		VALUES ('machine-1', 'ws', 'owner', 'laptop', 'online', ?)`, now)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES ('chan-1', 'ws', 'general', 'channel', ?)`, now)
}

func (e *coldEnv) addMachine(id string) {
	e.t.Helper()
	e.exec(`INSERT INTO machines (id, workspace_id, user_id, name, last_status, created_at)
		VALUES (?, 'ws', 'owner', ?, 'online', ?)`, id, id, time.Now().UnixMilli())
}

func (e *coldEnv) addAgent(id, name, status, runtime, machineID string) {
	e.t.Helper()
	now := time.Now().UnixMilli()
	var machine any
	if machineID != "" {
		machine = machineID
	}
	e.exec(`INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, machine_id, created_at, updated_at)
		VALUES (?, 'ws', ?, ?, ?, ?, ?, ?, ?)`, id, name, name, status, runtime, machine, now, now)
	if machineID != "" {
		e.exec(`INSERT INTO channel_agents (channel_id, agent_id, role, authority_revision, added_at)
			VALUES ('chan-1', ?, 'member', 1, ?)`, id, now)
	}
}

func (e *coldEnv) planDue(agentIDs ...string) {
	e.t.Helper()
	msgID := "msg-" + agentIDs[0]
	e.exec(`INSERT INTO messages
		(id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at)
		VALUES (?, 'ws', 'chan-1', 'user', 'owner', 'hello agent', 'chat', ?, 1, ?)`,
		msgID, "digest-"+msgID, time.Now().UnixMilli())
	err := platformdb.WithWriteTx(context.Background(), e.db, func(tx *sql.Tx) error {
		return e.store.PlanMessageTx(context.Background(), tx, delivery.PlanInput{
			WorkspaceID: "ws", MessageID: msgID, ChannelID: "chan-1", AgentIDs: agentIDs,
		})
	})
	if err != nil {
		e.t.Fatal(err)
	}
}

func (e *coldEnv) pass() {
	e.t.Helper()
	if _, err := e.d.pass(context.Background()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *coldEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatalf("%s: %v", query, err)
	}
}

func (e *coldEnv) delivery(agentID string) (state string, next int64) {
	e.t.Helper()
	var code sql.NullString
	if err := e.db.QueryRow(`SELECT scheduling_state, next_attempt_at, last_error_code
		FROM agent_deliveries WHERE workspace_id = 'ws' AND agent_id = ?`, agentID).
		Scan(&state, &next, &code); err != nil {
		e.t.Fatalf("delivery %s: %v", agentID, err)
	}
	return state, next
}

type launchSnap struct {
	id, dispatchID, machineID, state string
	count                            int64
	session                          sql.NullString
}

func (e *coldEnv) launches(agentID string) []launchSnap {
	e.t.Helper()
	rows, err := e.db.Query(`SELECT id, start_dispatch_id, machine_id, state, dispatch_count, confirmed_session_id
		FROM agent_launches WHERE workspace_id = 'ws' AND agent_id = ? ORDER BY created_at, id`, agentID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []launchSnap
	for rows.Next() {
		var snap launchSnap
		if err := rows.Scan(&snap.id, &snap.dispatchID, &snap.machineID, &snap.state, &snap.count, &snap.session); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, snap)
	}
	if err := rows.Err(); err != nil {
		e.t.Fatal(err)
	}
	return out
}

func assertNoWake(t *testing.T, command agent.StartDispatchCommand) {
	t.Helper()
	raw, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"wakeMessage", "resumeMessages", "resumePrompt", "unreadSummary"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("start frame carries %s: %s", forbidden, raw)
		}
	}
	if command.Config == nil || command.Config.SessionID != nil {
		t.Fatalf("start config session = %#v, want an empty resume pointer", command.Config)
	}
	if command.LaunchID == "" || command.StartDispatchID == "" || command.Type != agent.MachineCommandStart {
		t.Fatalf("start fence missing: %+v", command)
	}
}

func TestColdStartDuePendingReservesLaunchAfterBackoff(t *testing.T) {
	env := newColdEnv(t)
	env.addAgent("agent-due", "Ada", "active", "claude", "machine-1")
	env.planDue("agent-due")

	env.pass()

	state, next := env.delivery("agent-due")
	if state != delivery.StateWaitingIdentity {
		t.Fatalf("scheduling_state = %s, want waiting_identity", state)
	}
	if next <= time.Now().UnixMilli() {
		t.Fatalf("next_attempt_at = %d, want the scheduler backoff in the future", next)
	}
	launches := env.launches("agent-due")
	if len(launches) != 1 {
		t.Fatalf("launches = %d, want the due input reserved in the same pass that applied backoff", len(launches))
	}
	if launches[0].state != agent.LaunchStateDispatched || launches[0].machineID != "machine-1" {
		t.Fatalf("launch = %+v, want dispatched on the bound machine", launches[0])
	}
	if launches[0].session.Valid {
		t.Fatalf("confirmed_session_id = %q, want NULL until agent:session", launches[0].session.String)
	}
	starts := env.gw.starts()
	if len(starts) != 1 || starts[0].machineID != "machine-1" || starts[0].command.LaunchID != launches[0].id {
		t.Fatalf("starts = %+v", starts)
	}
	assertNoWake(t, starts[0].command)

	// The row the bug left behind: waiting_identity, due again, no launch.
	env.addAgent("agent-backoff", "Bea", "active", "claude", "machine-1")
	env.planDue("agent-backoff")
	env.exec(`UPDATE agent_deliveries
		SET scheduling_state = 'waiting_identity', next_attempt_at = ?, last_error_code = 'identity_incomplete'
		WHERE agent_id = 'agent-backoff'`, time.Now().UnixMilli())
	env.pass()
	backoffLaunches := env.launches("agent-backoff")
	if len(backoffLaunches) != 1 || backoffLaunches[0].state != agent.LaunchStateDispatched {
		t.Fatalf("due waiting_identity after backoff did not reserve: %+v", backoffLaunches)
	}
	if len(env.launches("agent-due")) != 1 {
		t.Fatal("reserving the second agent duplicated the first launch")
	}
}

func TestColdStartStartupAndRepeatedPassesOneLaunch(t *testing.T) {
	env := newColdEnv(t)
	env.addAgent("agent-due", "Ada", "active", "claude", "machine-1")
	env.planDue("agent-due")

	env.d.scan(context.Background())
	first := env.launches("agent-due")
	if len(first) != 1 {
		t.Fatalf("startup scan launches = %d", len(first))
	}
	if got := len(env.gw.starts()); got != 1 {
		t.Fatalf("startup scan starts = %d, want 1", got)
	}
	// A due again row must not mint or send another start while the launch is open.
	env.exec(`UPDATE agent_deliveries SET next_attempt_at = ? WHERE agent_id = 'agent-due'`, time.Now().UnixMilli())
	for range 5 {
		env.pass()
	}
	if got := env.launches("agent-due"); len(got) != 1 || got[0].id != first[0].id || got[0].dispatchID != first[0].dispatchID {
		t.Fatalf("repeated passes changed the launch: %+v", got)
	}
	if got := len(env.gw.starts()); got != 1 {
		t.Fatalf("repeated passes sent %d starts", got)
	}

	// Process start with the deferred row already due. One worker scan, then
	// a wake, still one launch and one start. The recovery ticker is 5s;
	// this observation stays inside that window.
	env2 := newColdEnv(t)
	env2.addAgent("agent-due", "Ada", "active", "claude", "machine-1")
	env2.planDue("agent-due")
	env2.exec(`UPDATE agent_deliveries
		SET scheduling_state = 'waiting_identity', next_attempt_at = ?
		WHERE agent_id = 'agent-due'`, time.Now().UnixMilli())
	env2.d.Start(context.Background())
	deadline := time.Now().Add(3 * time.Second)
	for len(env2.gw.starts()) < 1 {
		if time.Now().After(deadline) {
			t.Fatal("startup scan did not reserve a start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Let the startup scan drop wake suppression, then wake once. Close
	// joins that worker before the test goroutine runs another pass.
	time.Sleep(100 * time.Millisecond)
	env2.d.Wake()
	time.Sleep(200 * time.Millisecond)
	if err := env2.d.Close(); err != nil {
		t.Fatal(err)
	}
	env2.d.scan(context.Background())
	if got := env2.launches("agent-due"); len(got) != 1 {
		t.Fatalf("startup launches = %d", len(got))
	}
	if got := len(env2.gw.starts()); got != 1 {
		t.Fatalf("startup and later passes sent %d starts", got)
	}
}

func TestColdStartLostStartRecoversWithoutReconnect(t *testing.T) {
	env := newColdEnv(t)
	env.addAgent("agent-due", "Ada", "active", "claude", "machine-1")
	env.planDue("agent-due")
	env.gw.setFail(errors.New("send queue full"))

	env.pass()
	starts := env.gw.starts()
	if len(starts) != 1 {
		t.Fatalf("queue error attempts = %d, want 1", len(starts))
	}
	reserved := env.launches("agent-due")
	if len(reserved) != 1 || reserved[0].state != agent.LaunchStateReserved || reserved[0].count != 0 {
		t.Fatalf("queue error launch = %+v, want reserved with no dispatch count", reserved)
	}
	for range 5 {
		env.pass()
	}
	if got := len(env.gw.starts()); got != 1 {
		t.Fatalf("retries inside the backoff window = %d, want 1", got)
	}

	waitStartBackoff(t)
	env.gw.setFail(nil)
	env.pass()
	starts = env.gw.starts()
	if len(starts) != 2 {
		t.Fatalf("attempts after backoff = %d, want the reserved start retried", len(starts))
	}
	if starts[1].command.LaunchID != reserved[0].id || starts[1].command.StartDispatchID != reserved[0].dispatchID {
		t.Fatalf("retry minted a new start: %+v vs %+v", starts[1].command, reserved[0])
	}
	if gap := starts[1].at.Sub(starts[0].at); gap < time.Duration(agent.StartResendBackoffMS)*time.Millisecond {
		t.Fatalf("queue-error retry gap %s, want at least %dms", gap, agent.StartResendBackoffMS)
	}
	dispatched := env.launches("agent-due")
	if len(dispatched) != 1 || dispatched[0].state != agent.LaunchStateDispatched || dispatched[0].count != 1 {
		t.Fatalf("recovered launch = %+v", dispatched)
	}
	for range 5 {
		env.pass()
	}
	if got := len(env.gw.starts()); got != 2 {
		t.Fatalf("dispatched start resent inside the backoff window: %d", got)
	}

	// The ack never arrives and the gateway never goes offline. The next
	// window resends the same launch and dispatch id.
	waitStartBackoff(t)
	if !env.gw.isOnline() {
		t.Fatal("gateway went offline; recovery must not depend on reconnect")
	}
	env.pass()
	starts = env.gw.starts()
	if len(starts) != 3 {
		t.Fatalf("lost-ack attempts = %d, want 3", len(starts))
	}
	if starts[2].machineID != "machine-1" ||
		starts[2].command.LaunchID != reserved[0].id ||
		starts[2].command.StartDispatchID != reserved[0].dispatchID {
		t.Fatalf("lost ack minted a new start: %+v", starts[2])
	}
	if gap := starts[2].at.Sub(starts[1].at); gap < time.Duration(agent.StartResendBackoffMS)*time.Millisecond {
		t.Fatalf("lost-ack retry gap %s, want at least %dms", gap, agent.StartResendBackoffMS)
	}
	if !env.gw.isOnline() {
		t.Fatal("recovery flipped the gateway offline")
	}
	final := env.launches("agent-due")
	if len(final) != 1 || final[0].count != 2 || final[0].session.Valid {
		t.Fatalf("lost-ack launch = %+v, want one row, two sends, no session", final)
	}
	assertNoWake(t, starts[2].command)
}

func TestColdStartDoesNotWakeStoppedDeletedOrReassigned(t *testing.T) {
	env := newColdEnv(t)
	env.addMachine("machine-2")
	env.addAgent("agent-stopped", "Stopped", "stopped", "claude", "machine-1")
	env.addAgent("agent-deleted", "Deleted", "active", "claude", "machine-1")
	env.addAgent("agent-moved", "Moved", "active", "claude", "machine-1")
	env.addAgent("agent-external", "External", "active", "external", "machine-1")
	env.planDue("agent-stopped", "agent-deleted", "agent-moved", "agent-external")
	env.exec(`UPDATE agents SET deleted_at = ? WHERE id = 'agent-deleted'`, time.Now().UnixMilli())
	oldDispatchAt := time.Now().Add(-time.Duration(agent.StartResendBackoffMS)*time.Millisecond - time.Second).UnixMilli()
	env.exec(`INSERT INTO agent_launches
		(id, start_dispatch_id, workspace_id, agent_id, machine_id, state,
		 dispatch_count, last_dispatch_at, revision, created_at, updated_at)
		VALUES ('launch-deleted', 'dispatch-deleted', 'ws', 'agent-deleted', 'machine-1', 'reserved',
		        0, NULL, 1, ?, ?)`, oldDispatchAt, oldDispatchAt)
	env.exec(`INSERT INTO agent_launches
		(id, start_dispatch_id, workspace_id, agent_id, machine_id, state,
		 dispatch_count, last_dispatch_at, revision, created_at, updated_at)
		VALUES ('launch-moved', 'dispatch-moved', 'ws', 'agent-moved', 'machine-1', 'dispatched',
		        1, ?, 1, ?, ?)`, oldDispatchAt, oldDispatchAt, oldDispatchAt)
	env.exec(`UPDATE agents SET machine_id = 'machine-2' WHERE id = 'agent-moved'`)

	env.pass()

	for _, id := range []string{"agent-stopped", "agent-external"} {
		if got := env.launches(id); len(got) != 0 {
			t.Fatalf("%s launches = %+v, want none", id, got)
		}
	}
	deleted := env.launches("agent-deleted")
	if len(deleted) != 1 || deleted[0].state != agent.LaunchStateCancelled {
		t.Fatalf("deleted agent launch = %+v, want cancelled", deleted)
	}
	moved := env.launches("agent-moved")
	var oldCancelled, neu *launchSnap
	for i := range moved {
		switch moved[i].id {
		case "launch-moved":
			oldCancelled = &moved[i]
		default:
			neu = &moved[i]
		}
	}
	if oldCancelled == nil || oldCancelled.state != agent.LaunchStateCancelled || oldCancelled.machineID != "machine-1" {
		t.Fatalf("old launch = %+v, want cancelled on machine-1", moved)
	}
	if neu == nil || neu.machineID != "machine-2" {
		t.Fatalf("current binding launch = %+v, want a new reservation on machine-2", moved)
	}
	for _, start := range env.gw.starts() {
		switch start.command.AgentID {
		case "agent-stopped", "agent-deleted", "agent-external":
			t.Fatalf("woke %s: %+v", start.command.AgentID, start)
		case "agent-moved":
			if start.machineID != "machine-2" || start.command.LaunchID == "launch-moved" {
				t.Fatalf("reassigned start used the old machine or launch: %+v", start)
			}
		default:
			t.Fatalf("unexpected start: %+v", start)
		}
	}
	if len(env.gw.starts()) != 1 {
		t.Fatalf("starts = %+v, want only the current machine", env.gw.starts())
	}
}

func waitStartBackoff(t *testing.T) {
	t.Helper()
	time.Sleep(time.Duration(agent.StartResendBackoffMS)*time.Millisecond + 300*time.Millisecond)
}
