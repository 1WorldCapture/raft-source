package machinecontrol_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/machinecontrol"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/delivery"
	"raft.local/server-go/internal/runtimecatalog"
)

type recordingSink struct {
	acks        []agent.DeliverAckReceipt
	transitions []agent.DeliveryTransitionReceipt
	terminals   []agent.DeliveryTerminalErrorReceipt
	principals  []computer.Principal
}

func (s *recordingSink) ApplyDeliverAck(_ context.Context, p computer.Principal, r agent.DeliverAckReceipt) error {
	s.acks = append(s.acks, r)
	s.principals = append(s.principals, p)
	return nil
}
func (s *recordingSink) ApplyDeliveryTransition(_ context.Context, p computer.Principal, r agent.DeliveryTransitionReceipt) error {
	s.transitions = append(s.transitions, r)
	s.principals = append(s.principals, p)
	return nil
}
func (s *recordingSink) ApplyDeliveryTerminalError(_ context.Context, p computer.Principal, r agent.DeliveryTerminalErrorReceipt) error {
	s.terminals = append(s.terminals, r)
	s.principals = append(s.principals, p)
	return nil
}

func newReceiptCoordinator(t *testing.T, sink machinecontrol.DeliveryReceiptSink) *machinecontrol.Coordinator {
	t.Helper()
	c, err := machinecontrol.NewCoordinatorWithOptions(
		&agent.Service{}, &runtimecatalog.Broker{},
		func(context.Context, computer.Principal) error { return nil },
		machinecontrol.Options{Receipts: sink})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCoordinatorRoutesReceiptFramesToSink(t *testing.T) {
	sink := &recordingSink{}
	c := newReceiptCoordinator(t, sink)
	ctx := context.Background()
	principal := computer.Principal{
		Kind: computer.KindComputer, ComputerID: "comp-1",
		MachineID: "machine-1", WorkspaceID: "ws", CredentialRevision: "rev",
	}

	ack := json.RawMessage(`{"type":"agent:deliver:ack","agentId":"agent-1","seq":7,
		"deliveryId":"occ-1","mentionDelivery":{"occurrenceId":"occ-1","messageId":"m1",
		"machineId":"machine-1","launchId":"launch-1","sessionId":"session-1"}}`)
	if err := c.OnMessage(ctx, principal, ack); err != nil {
		t.Fatal(err)
	}
	transition := json.RawMessage(`{"type":"agent:delivery:transition","agentId":"agent-1",
		"stage":"daemon_drained","outcome":"accepted",
		"mentionDelivery":{"occurrenceId":"occ-1","messageId":"m1","machineId":"machine-1",
		"launchId":"launch-1","sessionId":"session-1"}}`)
	if err := c.OnMessage(ctx, principal, transition); err != nil {
		t.Fatal(err)
	}
	terminal := json.RawMessage(`{"type":"agent:delivery:terminal_error","agentId":"agent-1",
		"code":"IDENTITY_DRIFT",
		"mentionDelivery":{"occurrenceId":"occ-1","messageId":"m1","machineId":"machine-1",
		"launchId":"launch-1","sessionId":"session-1"}}`)
	if err := c.OnMessage(ctx, principal, terminal); err != nil {
		t.Fatal(err)
	}

	if len(sink.acks) != 1 || sink.acks[0].Seq != 7 || sink.acks[0].DeliveryID != "occ-1" {
		t.Fatalf("acks: %+v", sink.acks)
	}
	if sink.acks[0].MentionDelivery == nil || !sink.acks[0].MentionDelivery.Complete() {
		t.Fatalf("ack snapshot not parsed: %+v", sink.acks[0].MentionDelivery)
	}
	if len(sink.transitions) != 1 || sink.transitions[0].Stage != "daemon_drained" ||
		sink.transitions[0].Outcome != "accepted" {
		t.Fatalf("transitions: %+v", sink.transitions)
	}
	if len(sink.terminals) != 1 || sink.terminals[0].Code != "IDENTITY_DRIFT" {
		t.Fatalf("terminals: %+v", sink.terminals)
	}
	for _, seen := range sink.principals {
		if seen.MachineID != "machine-1" || seen.CredentialRevision != "rev" {
			t.Fatalf("principal not forwarded intact: %+v", seen)
		}
	}
}

func TestCoordinatorConsumesInvalidReceiptsWithoutSinkCall(t *testing.T) {
	sink := &recordingSink{}
	c := newReceiptCoordinator(t, sink)
	principal := computer.Principal{MachineID: "machine-1", WorkspaceID: "ws"}
	ctx := context.Background()

	invalid := []json.RawMessage{
		// transition without the required mentionDelivery
		json.RawMessage(`{"type":"agent:delivery:transition","agentId":"a","stage":"daemon_drained","outcome":"accepted"}`),
		// unknown transition stage
		json.RawMessage(`{"type":"agent:delivery:transition","agentId":"a","stage":"model_consumed","outcome":"accepted","mentionDelivery":{"occurrenceId":"o","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`),
		// unknown terminal code
		json.RawMessage(`{"type":"agent:delivery:terminal_error","agentId":"a","code":"MADE_UP","mentionDelivery":{"occurrenceId":"o","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`),
		// seq 0 without a deliveryId is not a control ack and not a watermark
		json.RawMessage(`{"type":"agent:deliver:ack","agentId":"a","seq":0}`),
		// tracked snapshot with seq 0 stays invalid
		json.RawMessage(`{"type":"agent:deliver:ack","agentId":"a","seq":0,"deliveryId":"occ","mentionDelivery":{"occurrenceId":"occ","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`),
		// ack with a present-but-incomplete snapshot
		json.RawMessage(`{"type":"agent:deliver:ack","agentId":"a","seq":3,"mentionDelivery":{"occurrenceId":"o"}}`),
	}
	for i, frame := range invalid {
		if err := c.OnMessage(ctx, principal, frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	if len(sink.acks)+len(sink.transitions)+len(sink.terminals) != 0 {
		t.Fatal("malformed receipt reached the sink as fact")
	}
}

func TestCoordinatorStartAckFlowsToLifecycleNotSink(t *testing.T) {
	sink := &recordingSink{}
	c := newReceiptCoordinator(t, sink)
	frame := json.RawMessage(`{"type":"agent:start:ack","agentId":"a","startDispatchId":"d","queueState":"running","queueDepth":0,"queueAgeMs":1}`)
	// The zero-valued agent.Service ignores the frame (no launch store), but
	// the routing decision is what matters here: the sink must not see it.
	if err := c.OnMessage(context.Background(), computer.Principal{MachineID: "m"}, frame); err != nil {
		t.Fatal(err)
	}
	if len(sink.acks)+len(sink.transitions)+len(sink.terminals) != 0 {
		t.Fatal("start ack leaked into the delivery sink")
	}
}

func TestCoordinatorValidatesPrincipalBeforeReceiptDispatch(t *testing.T) {
	sink := &recordingSink{}
	denied := errors.New("revoked")
	c, err := machinecontrol.NewCoordinatorWithOptions(
		&agent.Service{}, &runtimecatalog.Broker{},
		func(context.Context, computer.Principal) error { return denied },
		machinecontrol.Options{Receipts: sink})
	if err != nil {
		t.Fatal(err)
	}
	frame := json.RawMessage(`{"type":"agent:deliver:ack","agentId":"a","seq":1,
		"mentionDelivery":{"occurrenceId":"o","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`)
	if err := c.OnMessage(context.Background(), computer.Principal{MachineID: "m"}, frame); !errors.Is(err, denied) {
		t.Fatalf("validation denial lost: %v", err)
	}
	if len(sink.acks) != 0 {
		t.Fatal("sink invoked before validation")
	}
}

// fakeDeliveryStore records A-side inputs for the adapter tests.
type fakeDeliveryStore struct {
	acks        []delivery.AckInput
	controls    []delivery.ControlAckInput
	transitions []delivery.TransitionInput
	terminals   []delivery.TerminalErrorInput
	failWith    error
}

func (f *fakeDeliveryStore) RecordTransition(_ context.Context, in delivery.TransitionInput) (delivery.TransitionResult, error) {
	if f.failWith != nil {
		return delivery.TransitionResult{}, f.failWith
	}
	f.transitions = append(f.transitions, in)
	return delivery.TransitionResult{Recorded: true}, nil
}
func (f *fakeDeliveryStore) AcknowledgeManaged(_ context.Context, in delivery.AckInput) (delivery.AckResult, error) {
	if f.failWith != nil {
		return delivery.AckResult{}, f.failWith
	}
	// Mirror A's frozen contract: a legacy ack (Snapshot == nil) is refused
	// as ambiguous for tracked attempts with zero state change.
	if in.Snapshot == nil {
		return delivery.AckResult{}, delivery.ErrLegacyAckAmbiguous
	}
	f.acks = append(f.acks, in)
	return delivery.AckResult{}, nil
}
func (f *fakeDeliveryStore) AcknowledgeControl(_ context.Context, in delivery.ControlAckInput) (delivery.AckResult, error) {
	if f.failWith != nil {
		return delivery.AckResult{}, f.failWith
	}
	f.controls = append(f.controls, in)
	return delivery.AckResult{}, nil
}
func (f *fakeDeliveryStore) RecordTerminalError(_ context.Context, in delivery.TerminalErrorInput) (delivery.TerminalErrorResult, error) {
	if f.failWith != nil {
		return delivery.TerminalErrorResult{}, f.failWith
	}
	f.terminals = append(f.terminals, in)
	return delivery.TerminalErrorResult{}, nil
}

func TestDeliveryReceiptAdapterMapsPrincipalAndSnapshotVerbatim(t *testing.T) {
	store := &fakeDeliveryStore{}
	adapter := machinecontrol.NewDeliveryReceiptAdapter(store, nil)
	ctx := context.Background()
	principal := computer.Principal{
		Kind: computer.KindComputer, ComputerID: "comp-9",
		MachineID: "machine-9", WorkspaceID: "ws-9",
	}
	ack := agent.DeliverAckReceipt{
		AgentID: "agent-1", Seq: 42, DeliveryID: "occ-42",
		MentionDelivery: &agent.MentionDeliverySnapshot{
			OccurrenceID: "occ-42", MessageID: "m-42",
			MachineID: "machine-9", LaunchID: "launch-9", SessionID: "session-9",
		},
	}
	if err := adapter.ApplyDeliverAck(ctx, principal, ack); err != nil {
		t.Fatal(err)
	}
	if len(store.acks) != 1 {
		t.Fatal("ack not forwarded")
	}
	mapped := store.acks[0]
	if mapped.Principal.ComputerID != "comp-9" || mapped.Principal.MachineID != "machine-9" ||
		mapped.Principal.WorkspaceID != "ws-9" {
		t.Fatalf("principal projection: %+v", mapped.Principal)
	}
	if mapped.Snapshot == nil || mapped.Snapshot.OccurrenceID != "occ-42" ||
		mapped.Snapshot.SessionID != "session-9" {
		t.Fatalf("snapshot mapping: %+v", mapped.Snapshot)
	}
	if mapped.Seq != 42 || mapped.AgentID != "agent-1" {
		t.Fatalf("ack mapping: %+v", mapped)
	}

	// A legacy ack (no snapshot) forwards Snapshot == nil — A's contract
	// rejects it as ambiguous for tracked attempts; the adapter surfaces
	// that as a logged no-change outcome, not an error.
	legacy := agent.DeliverAckReceipt{AgentID: "agent-1", Seq: 41}
	if err := adapter.ApplyDeliverAck(ctx, principal, legacy); err != nil {
		t.Fatal(err)
	}
	if len(store.acks) != 1 {
		t.Fatal("legacy ack forwarded with a fabricated snapshot")
	}
}

func TestDeliveryReceiptAdapterSwallowsExpectedRefusalsOnly(t *testing.T) {
	store := &fakeDeliveryStore{}
	adapter := machinecontrol.NewDeliveryReceiptAdapter(store, nil)
	ctx := context.Background()
	principal := computer.Principal{MachineID: "machine-1", WorkspaceID: "ws"}
	transition := agent.DeliveryTransitionReceipt{
		AgentID: "agent-1", Stage: "daemon_received", Outcome: "accepted",
		MentionDelivery: agent.MentionDeliverySnapshot{
			OccurrenceID: "occ-1", MessageID: "m1", MachineID: "machine-1",
			LaunchID: "launch-1", SessionID: "session-1",
		},
	}

	// Every closed-set refusal (foreign machine / drift / legacy / unknown
	// occurrence / terminal attempt) is a zero-change outcome by design.
	for _, refusal := range []error{
		delivery.ErrIdentityMismatch,
		delivery.ErrOccurrenceUnknown,
		delivery.ErrLegacyAckAmbiguous,
		delivery.ErrAttemptTerminal,
		delivery.ErrInvalidInput,
	} {
		store.failWith = refusal
		if err := adapter.ApplyDeliveryTransition(ctx, principal, transition); err != nil {
			t.Fatalf("expected refusal surfaced as transport failure: %v", err)
		}
	}

	// Infrastructure failures propagate.
	store.failWith = delivery.ErrConcurrentModification
	if err := adapter.ApplyDeliveryTransition(ctx, principal, transition); err == nil {
		t.Fatal("infrastructure failure swallowed")
	}
	store.failWith = errors.New("disk full")
	if err := adapter.ApplyDeliveryTerminalError(ctx, principal, agent.DeliveryTerminalErrorReceipt{
		AgentID: "agent-1", Code: "QUOTA_LIMITED", MentionDelivery: transition.MentionDelivery,
	}); err == nil {
		t.Fatal("unknown failure swallowed")
	}
}

// End-to-end: coordinator -> adapter -> A-side store, proving the composition
// the parent assembles in the machine hub's OnMessage path.
func TestCoordinatorThroughAdapterEndToEnd(t *testing.T) {
	store := &fakeDeliveryStore{}
	c, err := machinecontrol.NewCoordinatorWithOptions(
		&agent.Service{}, &runtimecatalog.Broker{},
		func(context.Context, computer.Principal) error { return nil },
		machinecontrol.Options{Receipts: machinecontrol.NewDeliveryReceiptAdapter(store, nil)})
	if err != nil {
		t.Fatal(err)
	}
	frame := json.RawMessage(`{"type":"agent:deliver:ack","agentId":"agent-1","seq":9,
		"deliveryId":"occ-9","mentionDelivery":{"occurrenceId":"occ-9","messageId":"m9",
		"machineId":"machine-1","launchId":"l1","sessionId":"s1"}}`)
	principal := computer.Principal{MachineID: "machine-1", WorkspaceID: "ws"}
	if err := c.OnMessage(context.Background(), principal, frame); err != nil {
		t.Fatal(err)
	}
	if len(store.acks) != 1 || store.acks[0].Seq != 9 {
		t.Fatalf("end-to-end ack: %+v", store.acks)
	}
}

func TestControlAckUsesCurrentIdentityAndDoesNotClearQueue(t *testing.T) {
	store := &fakeDeliveryStore{}
	adapter := machinecontrol.NewDeliveryReceiptAdapterWithIdentity(store, nil,
		func(context.Context, string, string) (string, string, error) {
			return "launch-now", "session-now", nil
		})
	principal := computer.Principal{
		ComputerID: "comp-1", MachineID: "machine-1", WorkspaceID: "ws",
	}
	receipt := agent.DeliverAckReceipt{AgentID: "agent-1", Seq: 0, DeliveryID: "occ-control"}
	if err := adapter.ApplyDeliverAck(context.Background(), principal, receipt); err != nil {
		t.Fatal(err)
	}
	if len(store.acks) != 0 {
		t.Fatal("seq 0 control ack was treated as a tracked ack")
	}
	if len(store.controls) != 1 {
		t.Fatalf("control acks: %+v", store.controls)
	}
	got := store.controls[0]
	if got.OccurrenceID != "occ-control" || got.LaunchID != "launch-now" || got.SessionID != "session-now" ||
		got.Principal.MachineID != "machine-1" || got.AgentID != "agent-1" {
		t.Fatalf("control input: %+v", got)
	}

	// Without a current-identity reader the ack is refused and does not
	// fall through to AcknowledgeManaged.
	bare := machinecontrol.NewDeliveryReceiptAdapter(store, nil)
	if err := bare.ApplyDeliverAck(context.Background(), principal, receipt); err != nil {
		t.Fatal(err)
	}
	if len(store.controls) != 1 || len(store.acks) != 0 {
		t.Fatal("unwired control ack mutated a receipt path")
	}

	// A positive seq without a snapshot stays a legacy tracked ack.
	legacy := agent.DeliverAckReceipt{AgentID: "agent-1", Seq: 4, DeliveryID: "occ-control"}
	if err := adapter.ApplyDeliverAck(context.Background(), principal, legacy); err != nil {
		t.Fatal(err)
	}
	if len(store.controls) != 1 {
		t.Fatal("legacy ack was routed as a control ack")
	}
}

func TestCoordinatorRoutesControlAckAndKeepsRevokedCredentialOut(t *testing.T) {
	store := &fakeDeliveryStore{}
	identity := func(context.Context, string, string) (string, string, error) {
		return "launch-1", "session-1", nil
	}
	c, err := machinecontrol.NewCoordinatorWithOptions(
		&agent.Service{}, &runtimecatalog.Broker{},
		func(context.Context, computer.Principal) error { return nil },
		machinecontrol.Options{Receipts: machinecontrol.NewDeliveryReceiptAdapterWithIdentity(store, nil, identity)})
	if err != nil {
		t.Fatal(err)
	}
	frame := json.RawMessage(`{"type":"agent:deliver:ack","agentId":"agent-1","seq":0,"deliveryId":"occ-1"}`)
	principal := computer.Principal{MachineID: "machine-1", WorkspaceID: "ws", CredentialRevision: "rev"}
	if err := c.OnMessage(context.Background(), principal, frame); err != nil {
		t.Fatal(err)
	}
	if len(store.controls) != 1 || store.controls[0].OccurrenceID != "occ-1" || len(store.acks) != 0 {
		t.Fatalf("control route: controls=%+v acks=%+v", store.controls, store.acks)
	}

	revoked := errors.New("credential revoked")
	denied, err := machinecontrol.NewCoordinatorWithOptions(
		&agent.Service{}, &runtimecatalog.Broker{},
		func(context.Context, computer.Principal) error { return revoked },
		machinecontrol.Options{Receipts: machinecontrol.NewDeliveryReceiptAdapterWithIdentity(store, nil, identity)})
	if err != nil {
		t.Fatal(err)
	}
	if err := denied.OnMessage(context.Background(), principal, frame); !errors.Is(err, revoked) {
		t.Fatalf("revoked credential: %v", err)
	}
	if len(store.controls) != 1 {
		t.Fatal("revoked credential reached AcknowledgeControl")
	}
}
