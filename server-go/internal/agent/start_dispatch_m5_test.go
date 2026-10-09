package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

// anyGateway records every payload verbatim (both MachineCommand and the M5
// StartDispatchCommand / DeliveryCommand wire types).
type anyGateway struct {
	online  bool
	sent    []any
	sendErr error
}

func (g *anyGateway) IsOnline(string) bool { return g.online }
func (g *anyGateway) Send(_ context.Context, _ string, payload any) error {
	if g.sendErr != nil {
		return g.sendErr
	}
	if !g.online {
		return errMachineOfflineForTest
	}
	g.sent = append(g.sent, payload)
	return nil
}

// errMachineOfflineForTest mirrors the hub's typed offline refusal so the
// dispatch entry point's error propagation is exercised against a realistic
// transport denial.
var errMachineOfflineForTest = errf(409, "machine_offline", "Machine offline. Please start your local daemon.")

func newDispatchService(t *testing.T) (*sql.DB, *Store, *LaunchStore, *Service, *anyGateway) {
	t.Helper()
	handle, store, launches, _ := newLaunchTestStore(t)
	seedLaunchTarget(t, handle, "agent-1", "machine-1")
	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", Launches: launches,
	})
	return handle, store, launches, service, gateway
}

func TestEnsureStartLaunchSendsOneDispatchIdentity(t *testing.T) {
	_, _, _, service, gateway := newDispatchService(t)
	ctx := context.Background()
	agent, err := service.store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	// The batch-mention race: a second reservation for the same agent gets
	// the SAME dispatch identity — the daemon sees one start, not N — and
	// because the first reservation already dispatched, the second call does
	// NOT resend (scans must not spam starts; resends are recovery's job).
	second, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || first.StartDispatchID != second.StartDispatchID {
		t.Fatalf("concurrent starts produced different dispatch identities: %+v vs %+v", first, second)
	}
	if second.State != LaunchStateDispatched {
		t.Fatalf("dedup lost the dispatched state: %s", second.State)
	}
	if len(gateway.sent) != 1 {
		t.Fatalf("resent an already-dispatched launch: %d starts", len(gateway.sent))
	}
	for _, payload := range gateway.sent {
		command, ok := payload.(StartDispatchCommand)
		if !ok {
			t.Fatalf("unexpected payload type %T", payload)
		}
		if command.LaunchID != first.ID || command.StartDispatchID != first.StartDispatchID {
			t.Fatalf("start frame identity drifted: %+v", command)
		}
	}
}

// FIRST-SESSION BOOTSTRAP ANALYSIS (test 1 of 2): the cold-start contract.
// A tracked mention needs a non-empty launchId/sessionId, and the original
// daemon explicitly EXCLUDES mention deliveries from wake promotion
// (packages/daemon/src/core.ts:1498–1516, selectWakeDeliveryIndex). The M5
// start dispatch therefore NEVER carries a wakeMessage: if it did, a mention
// would have to be demoted to an ordinary wake (dropping mentionDelivery) to
// ride it — the exact forbidden simplification. This test pins that the
// lifecycle start frame contains no wake/resume context at all, so the only
// way a mention reaches the daemon is the instrumented occurrence path.
func TestStartDispatchNeverCarriesWakeMessage(t *testing.T) {
	_, store, _, _, _ := newDispatchService(t)
	agent, err := store.GetAgent(context.Background(), "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	command := NewStartDispatchCommand(agent, "http://127.0.0.1:8080",
		strPtr("laptop"), nil, nil, nil, strPtr("0.31.0"), "launch-1", "dispatch-1")
	encoded, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"wakeMessage", "resumeMessages", "resumePrompt", "unreadSummary"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("lifecycle start frame carries %s: %s", forbidden, encoded)
		}
	}
	if command.LaunchID != "launch-1" || command.StartDispatchID != "dispatch-1" {
		t.Fatalf("fence identity missing: %+v", command)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["type"] != MachineCommandStart {
		t.Fatalf("wrong wire type: %v", wire["type"])
	}
}

// FIRST-SESSION BOOTSTRAP ANALYSIS (companion): with no wake message, the
// first session can only come from the runtime through agent:session. Until
// that frame lands (fenced by the launch), the tracked-delivery identity is
// INCOMPLETE and tracked frames must refuse to build — the scheduler waits
// (waiting_identity), it never sends a half-identified delivery.
func TestTrackedDeliveryRequiresCompleteIdentitySnapshot(t *testing.T) {
	message := json.RawMessage(`{"channel_id":"c1","content":"hi","message_id":"m1","seq":7,"sender_type":"human"}`)
	complete := MentionDeliverySnapshot{
		OccurrenceID: "occ-1", MessageID: "m1",
		MachineID: "machine-1", LaunchID: "launch-1", SessionID: "session-1",
	}
	command, err := NewMentionDeliveryCommand("agent-1", message, 7, complete)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Type            string          `json:"type"`
		Seq             int64           `json:"seq"`
		DeliveryID      string          `json:"deliveryId"`
		MentionDelivery json.RawMessage `json:"mentionDelivery"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Type != "agent:deliver" || wire.Seq != 7 {
		t.Fatalf("wire shape: %s", encoded)
	}
	if wire.DeliveryID != "occ-1" {
		t.Fatalf("deliveryId must be the occurrenceId: %s", encoded)
	}

	// Cold-start incomplete identities (empty session / empty launch) are
	// refused at frame construction — the waiting_identity gate.
	for name, patch := range map[string]func(*MentionDeliverySnapshot){
		"no session":    func(s *MentionDeliverySnapshot) { s.SessionID = "" },
		"no launch":     func(s *MentionDeliverySnapshot) { s.LaunchID = "" },
		"no machine":    func(s *MentionDeliverySnapshot) { s.MachineID = "" },
		"no message":    func(s *MentionDeliverySnapshot) { s.MessageID = "" },
		"no occurrence": func(s *MentionDeliverySnapshot) { s.OccurrenceID = "" },
	} {
		broken := complete
		patch(&broken)
		if _, err := NewMentionDeliveryCommand("agent-1", message, 7, broken); err == nil {
			t.Fatalf("%s: half-identity tracked frame accepted", name)
		}
	}
	if _, err := NewMentionDeliveryCommand("agent-1", nil, 7, complete); err == nil {
		t.Fatal("empty message body accepted")
	}
	if _, err := NewMentionDeliveryCommand("agent-1", message, 0, complete); err == nil {
		t.Fatal("non-positive seq accepted")
	}
}

// REPORTED-RECEIPT BOUNDARY: a start ack saying queueState "running" — and a
// delivery transition saying "daemon_drained" — are daemon REPORTS. Neither
// establishes a session identity, and the delivery side records drained as
// drained_reported_at (worker A's naming), never model consumption. This
// test pins the lifecycle half: running acks never fabricate the session the
// tracked snapshot needs.
func TestReportedAckAndDrainedAreNotModelConsumption(t *testing.T) {
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, principal.MachineID, "owner")
	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", Launches: launches,
	})
	ctx := context.Background()
	agent, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}

	// start:ack running (the strongest queue report) arrives over the
	// authenticated machine connection.
	ack := `{"type":"agent:start:ack","agentId":"agent-1","startDispatchId":"` +
		launch.StartDispatchID + `","launchId":"` + launch.ID +
		`","queueState":"running","queueDepth":0,"queueAgeMs":12}`
	if err := service.OnMessage(ctx, principal, json.RawMessage(ack)); err != nil {
		t.Fatal(err)
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if !current.QueueState.Valid || current.QueueState.String != "running" {
		t.Fatalf("reported queue state not stored: %+v", current.QueueState)
	}
	var session sql.NullString
	if err := handle.QueryRow(`SELECT session_id FROM agents WHERE id = 'agent-1'`).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if session.Valid {
		t.Fatal("queueState running fabricated a session (model-consumption conflation)")
	}
	// The tracked-delivery identity gate stays closed until a REAL session
	// frame lands: the launch is current, but the session half lives on
	// agents.session_id and is still empty — the scheduler must wait, not
	// dispatch on the queue report.
	identity, err := service.CurrentLaunchIdentity(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if identity == nil || !identity.QueueState.Valid || identity.QueueState.String != "running" {
		t.Fatalf("identity query lost the launch: %+v", identity)
	}

	// A fenced agent:session frame (launch echo) is what actually opens the
	// identity gate — the report alone never does.
	sessionFrame := `{"type":"agent:session","agentId":"agent-1","sessionId":"session-live","launchId":"` +
		launch.ID + `"}`
	if err := service.OnMessage(ctx, principal, json.RawMessage(sessionFrame)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT session_id FROM agents WHERE id = 'agent-1'`).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if !session.Valid || session.String != "session-live" {
		t.Fatalf("fenced session frame not applied: %+v", session)
	}

	// A LATE session frame from a superseded launch changes nothing: a
	// stop+restart cycle terminates the launch and mints a new one.
	if err := service.StopInternal(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agents SET status = 'active' WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	moved, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if moved.ID == launch.ID {
		t.Fatal("restart reused the terminated launch")
	}
	late := `{"type":"agent:session","agentId":"agent-1","sessionId":"session-late","launchId":"` +
		launch.ID + `"}`
	if err := service.OnMessage(ctx, principal, json.RawMessage(late)); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT session_id FROM agents WHERE id = 'agent-1'`).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if session.Valid && session.String != "session-live" {
		t.Fatalf("late frame overwrote the session: %+v", session)
	}
	_ = moved
}

func strPtr(v string) *string { return &v }

func TestEnsureStartLaunchOfflineKeepsDurableReservation(t *testing.T) {
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, principal.MachineID, "owner")
	gateway := &anyGateway{online: false} // machine offline
	service := NewService(store, ServiceOptions{
		Gateway: gateway, ServerURL: "http://127.0.0.1:8080", Launches: launches,
	})
	ctx := context.Background()
	agent, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := service.EnsureStartLaunch(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 0 {
		t.Fatal("offline machine received a start")
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if current.State != LaunchStateReserved {
		t.Fatalf("offline reservation not durable: %s", current.State)
	}

	// The machine comes back: OnReady drives recovery, which re-sends the
	// SAME dispatch identity (the daemon dedups by dispatch id).
	gateway.online = true
	if err := service.RecoverPendingStarts(ctx, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 1 {
		t.Fatalf("recovery sent %d starts", len(gateway.sent))
	}
	command, ok := gateway.sent[0].(StartDispatchCommand)
	if !ok {
		t.Fatalf("payload type %T", gateway.sent[0])
	}
	if command.LaunchID != launch.ID || command.StartDispatchID != launch.StartDispatchID {
		t.Fatalf("recovery identity drifted: %+v", command)
	}
	if current, err = launches.CurrentLaunch(ctx, "ws", "agent-1"); err != nil {
		t.Fatal(err)
	}
	if current.State != LaunchStateDispatched || current.DispatchCount != 1 {
		t.Fatalf("recovery accounting: %+v", current)
	}
}

func TestRecoverPendingStartsSkipsStoppedAndUnboundAgents(t *testing.T) {
	handle, store, launches, fixed := newLaunchTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	principal := attachProvedComputer(t, handle, fixed, "owner", "ws")
	insertAgent(t, handle, "agent-live", "ws", "Ada", StatusActive, principal.MachineID, "owner")
	insertAgent(t, handle, "agent-stopped", "ws", "Bea", StatusStopped, principal.MachineID, "owner")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-far', 'ws', 'owner', 'far', 3)`); err != nil {
		t.Fatal(err)
	}
	insertAgent(t, handle, "agent-moved", "ws", "Cara", StatusActive, "machine-far", "owner")
	ctx := context.Background()
	reserve := func(agentID string) *Launch {
		var launch *Launch
		inLaunchTx(t, launches, func(tx *sql.Tx) error {
			reserved, freshRow, err := launches.ReserveStartLaunchTx(ctx, tx, "ws", agentID, principal.MachineID)
			launch = reserved
			_ = freshRow
			return err
		})
		return launch
	}
	live := reserve("agent-live")
	// A stopped agent can no longer reserve at all (live re-read refuses);
	// simulate the historical window — the reservation happened while the
	// agent was eligible, THEN the operator stopped it — with a direct row.
	_ = live
	insertLaunch := func(agentID, machine string) string {
		id := "launch-" + agentID
		if _, err := handle.Exec(`INSERT INTO agent_launches
			(id, start_dispatch_id, workspace_id, agent_id, machine_id, state, dispatch_count, last_dispatch_at, revision, created_at, updated_at)
			VALUES (?, ?, 'ws', ?, ?, 'dispatched', 1, 1, 1, 1, 1)`,
			id, "dispatch-"+agentID, agentID, machine); err != nil {
			t.Fatal(err)
		}
		return id
	}
	stopped := insertLaunch("agent-stopped", principal.MachineID)
	moved := insertLaunch("agent-moved", principal.MachineID)

	gateway := &anyGateway{online: true}
	service := NewService(store, ServiceOptions{Gateway: gateway, Launches: launches})
	if err := service.RecoverPendingStarts(ctx, principal.MachineID); err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 1 {
		t.Fatalf("recovery sent %d starts, want exactly the live agent", len(gateway.sent))
	}
	command := gateway.sent[0].(StartDispatchCommand)
	if command.AgentID != "agent-live" {
		t.Fatalf("recovery started the wrong agent: %+v", command)
	}
	for id, launchID := range map[string]string{"stopped": stopped, "moved": moved} {
		var state string
		if err := handle.QueryRow(`SELECT state FROM agent_launches WHERE id = ?`, launchID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != LaunchStateCancelled {
			t.Fatalf("%s agent's launch not closed: %s", id, state)
		}
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-live")
	if err != nil {
		t.Fatal(err)
	}
	if current == nil || current.State != LaunchStateDispatched {
		t.Fatalf("live agent's launch disturbed by recovery: %+v", current)
	}
}

func TestDispatchDeliveryDelegatesToGateway(t *testing.T) {
	_, store, _, service, gateway := newDispatchService(t)
	ctx := context.Background()
	command, err := NewMentionDeliveryCommand("agent-1",
		json.RawMessage(`{"channel_id":"c1","content":"hi","message_id":"m1","seq":3,"sender_type":"human"}`),
		3, MentionDeliverySnapshot{
			OccurrenceID: "occ-1", MessageID: "m1",
			MachineID: "machine-1", LaunchID: "launch-1", SessionID: "session-1",
		})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchDelivery(ctx, "machine-1", command); err != nil {
		t.Fatal(err)
	}
	if len(gateway.sent) != 1 {
		t.Fatalf("delivery not dispatched: %d", len(gateway.sent))
	}
	// Offline machines surface the transport's typed offline error; the
	// entry point never fabricates success.
	gateway.online = false
	if err := service.DispatchDelivery(ctx, "machine-1", command); err == nil {
		t.Fatal("offline dispatch reported success")
	}
	_ = store
}
