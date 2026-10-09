// Authenticated delivery-receipt dispatch (M5): the coordinator routes the
// daemon's agent:deliver:ack / agent:delivery:transition /
// agent:delivery:terminal_error frames into the delivery domain's persistent
// attempt facts. The transport has ALREADY authenticated the machine
// principal and held the connection's admission guard; this layer adds no
// trust of its own — every payload field (including mentionDelivery.
// machineId) is consistency evidence only, never an identity source. The
// production sink is worker A's *delivery.Store through the adapter below
// (A's frozen §2.5 API, docs/m5-delivery-worker-contract.md).
package machinecontrol

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/delivery"
)

// DeliveryReceiptSink receives authenticated receipts. Every method gets the
// AUTHENTICATED machine principal plus the parsed wire receipt; the sink
// locates the attempt among its own facts, closes the five-tuple identity
// snapshot and applies one idempotent CAS. A receipt that fences out (no
// such attempt for this principal, identity drift, legacy ack, attempt
// already terminal) is an EXPECTED protocol refusal: the sink reports it
// through the receipt adapter as a no-error no-change outcome with a log
// line, never as a transport failure.
type DeliveryReceiptSink interface {
	// ApplyDeliverAck applies one agent:deliver:ack. For a tracked attempt
	// the sink requires a resolving deliveryId/mentionDelivery; a bare-seq
	// legacy ACK never resolves tracked attempts via max(seq) guessing
	// (design §6.2). An ACK is a reported receipt: nothing becomes
	// model-consumed or task-completed.
	ApplyDeliverAck(ctx context.Context, principal computer.Principal, receipt agent.DeliverAckReceipt) error
	// ApplyDeliveryTransition applies one daemon-REPORTED stage observation
	// (daemon_received/daemon_pending/daemon_drained). Duplicate/reordered
	// reports never move timestamps backwards and never resurrect an
	// acknowledged record; daemon_drained is a report, not consumption.
	ApplyDeliveryTransition(ctx context.Context, principal computer.Principal, receipt agent.DeliveryTransitionReceipt) error
	// ApplyDeliveryTerminalError applies one terminal_error (six-code closed
	// set). Error-category policy (which codes end an attempt vs the logical
	// delivery; IDENTITY_UNKNOWN staying recoverable) belongs to the
	// delivery domain; this layer passes the typed fact.
	ApplyDeliveryTerminalError(ctx context.Context, principal computer.Principal, receipt agent.DeliveryTerminalErrorReceipt) error
}

// dispatchReceipt parses and forwards one receipt frame. Returns
// handled=false for non-receipt frames (the caller continues to the agent
// lifecycle switch). Invalid receipt shapes are consumed with a diagnostic —
// never forwarded as fact, never fatal to the connection.
func (c *Coordinator) dispatchReceipt(ctx context.Context, principal computer.Principal, raw json.RawMessage) (bool, error) {
	parsed := agent.ParseReceiptFrame(raw)
	switch parsed.Kind {
	case agent.ReceiptKindDeliverAck:
		return true, c.receipts.ApplyDeliverAck(ctx, principal, *parsed.DeliverAck)
	case agent.ReceiptKindTransition:
		return true, c.receipts.ApplyDeliveryTransition(ctx, principal, *parsed.Transition)
	case agent.ReceiptKindTerminalError:
		return true, c.receipts.ApplyDeliveryTerminalError(ctx, principal, *parsed.TerminalError)
	case agent.ReceiptKindInvalid:
		c.logger.Warn("daemon receipt frame rejected on shape",
			"machine_id", principal.MachineID, "reason", parsed.InvalidReason)
		return true, nil
	case "start_ack":
		// Owned by the agent lifecycle switch (launch-fenced start acks),
		// not the delivery sink.
		return false, nil
	default:
		return false, nil
	}
}

// deliveryStore is the slice of worker A's frozen Store API the receipt
// adapter programs against (satisfied by *delivery.Store).
type deliveryStore interface {
	RecordTransition(ctx context.Context, input delivery.TransitionInput) (delivery.TransitionResult, error)
	AcknowledgeManaged(ctx context.Context, input delivery.AckInput) (delivery.AckResult, error)
	AcknowledgeControl(ctx context.Context, input delivery.ControlAckInput) (delivery.AckResult, error)
	RecordTerminalError(ctx context.Context, input delivery.TerminalErrorInput) (delivery.TerminalErrorResult, error)
}

// ControlIdentity reads the agent's CURRENT persisted launch and session.
// A control ack (seq 0, deliveryId, no mentionDelivery) carries neither, so
// the adapter must not invent them. The function must not take the machine
// slot: the receipt path already holds it. Nil refuses control acks closed.
type ControlIdentity func(ctx context.Context, workspaceID, agentID string) (launchID, sessionID string, err error)

// expectedReceiptRefusals are delivery-domain protocol refusals that leave
// zero state change BY DESIGN (forged/late/foreign receipts, legacy acks,
// already-terminal attempts). They are logged, not surfaced as transport
// failures — "零越权修改" is the correct outcome, not an error condition.
var expectedReceiptRefusals = []error{
	delivery.ErrInvalidInput,
	delivery.ErrOccurrenceUnknown,
	delivery.ErrLegacyAckAmbiguous,
	delivery.ErrIdentityMismatch,
	delivery.ErrAttemptTerminal,
	delivery.ErrControlPathMismatch,
}

func isExpectedReceiptRefusal(err error) bool {
	for _, candidate := range expectedReceiptRefusals {
		if errors.Is(err, candidate) {
			return true
		}
	}
	return false
}

// DeliveryReceiptAdapter wires A's delivery Store into the coordinator's
// sink contract. It performs NO authorization of its own: the principal
// translation is a projection of the already-authenticated transport
// identity, and every payload field maps verbatim as evidence.
type DeliveryReceiptAdapter struct {
	store    deliveryStore
	identity ControlIdentity
	logger   *slog.Logger
}

// NewDeliveryReceiptAdapter binds A's store at assembly time. Control acks
// are refused until NewDeliveryReceiptAdapterWithIdentity supplies the
// current launch/session reader (agent.Service.CurrentControlIdentity).
func NewDeliveryReceiptAdapter(store deliveryStore, logger *slog.Logger) *DeliveryReceiptAdapter {
	return NewDeliveryReceiptAdapterWithIdentity(store, logger, nil)
}

// NewDeliveryReceiptAdapterWithIdentity binds the store and the current
// launch/session reader used for seq-0 control acks.
func NewDeliveryReceiptAdapterWithIdentity(store deliveryStore, logger *slog.Logger, identity ControlIdentity) *DeliveryReceiptAdapter {
	if logger == nil {
		logger = slog.Default()
	}
	return &DeliveryReceiptAdapter{store: store, identity: identity, logger: logger}
}

func machinePrincipalOf(p computer.Principal) delivery.MachinePrincipal {
	return delivery.MachinePrincipal{
		ComputerID:  p.ComputerID,
		MachineID:   p.MachineID,
		WorkspaceID: p.WorkspaceID,
	}
}

func snapshotOf(s agent.MentionDeliverySnapshot) delivery.MentionSnapshot {
	return delivery.MentionSnapshot{
		OccurrenceID: s.OccurrenceID,
		MessageID:    s.MessageID,
		MachineID:    s.MachineID,
		LaunchID:     s.LaunchID,
		SessionID:    s.SessionID,
	}
}

// controlAck reports a seq-0 notice ack: one deliveryId, no mention snapshot.
// A bare seq 0 is not a control ack and is not a queue watermark.
func controlAck(receipt agent.DeliverAckReceipt) bool {
	return receipt.Seq == 0 && receipt.DeliveryID != "" && receipt.MentionDelivery == nil
}

// ApplyDeliverAck forwards one ack. Tracked acks go to AcknowledgeManaged.
// seq 0 plus a deliveryId and no mentionDelivery goes to AcknowledgeControl
// with the current launch/session — never to a max-seq clear. A legacy ack
// (positive seq, no mention snapshot) is forwarded with Snapshot == nil.
func (a *DeliveryReceiptAdapter) ApplyDeliverAck(ctx context.Context, principal computer.Principal, receipt agent.DeliverAckReceipt) error {
	if controlAck(receipt) {
		return a.applyControlAck(ctx, principal, receipt)
	}
	input := delivery.AckInput{
		Principal: machinePrincipalOf(principal),
		AgentID:   receipt.AgentID,
		Seq:       receipt.Seq,
	}
	if receipt.MentionDelivery != nil {
		snapshot := snapshotOf(*receipt.MentionDelivery)
		input.Snapshot = &snapshot
	}
	result, err := a.store.AcknowledgeManaged(ctx, input)
	if err != nil {
		if isExpectedReceiptRefusal(err) {
			a.logger.Info("deliver ack refused with zero state change",
				"machine_id", principal.MachineID, "agent_id", receipt.AgentID,
				"reason", err.Error())
			return nil
		}
		return err
	}
	if result.AlreadyAcknowledged {
		a.logger.Info("deliver ack replay idempotent",
			"machine_id", principal.MachineID, "agent_id", receipt.AgentID)
	}
	return nil
}

func (a *DeliveryReceiptAdapter) applyControlAck(ctx context.Context, principal computer.Principal, receipt agent.DeliverAckReceipt) error {
	if a.identity == nil {
		a.logger.Info("control ack refused: current launch/session reader is not wired",
			"machine_id", principal.MachineID, "agent_id", receipt.AgentID)
		return nil
	}
	launchID, sessionID, err := a.identity(ctx, principal.WorkspaceID, receipt.AgentID)
	if err != nil {
		return err
	}
	result, err := a.store.AcknowledgeControl(ctx, delivery.ControlAckInput{
		Principal:    machinePrincipalOf(principal),
		AgentID:      receipt.AgentID,
		OccurrenceID: receipt.DeliveryID,
		LaunchID:     launchID,
		SessionID:    sessionID,
	})
	if err != nil {
		if isExpectedReceiptRefusal(err) {
			a.logger.Info("control ack refused with zero state change",
				"machine_id", principal.MachineID, "agent_id", receipt.AgentID,
				"reason", err.Error())
			return nil
		}
		return err
	}
	if result.AlreadyAcknowledged {
		a.logger.Info("control ack replay idempotent",
			"machine_id", principal.MachineID, "agent_id", receipt.AgentID)
	}
	return nil
}

// ApplyDeliveryTransition forwards one daemon-reported stage observation.
func (a *DeliveryReceiptAdapter) ApplyDeliveryTransition(ctx context.Context, principal computer.Principal, receipt agent.DeliveryTransitionReceipt) error {
	_, err := a.store.RecordTransition(ctx, delivery.TransitionInput{
		Principal: machinePrincipalOf(principal),
		AgentID:   receipt.AgentID,
		Stage:     receipt.Stage,
		Snapshot:  snapshotOf(receipt.MentionDelivery),
	})
	if err != nil {
		if isExpectedReceiptRefusal(err) {
			a.logger.Info("delivery transition refused with zero state change",
				"machine_id", principal.MachineID, "agent_id", receipt.AgentID,
				"stage", receipt.Stage, "reason", err.Error())
			return nil
		}
		return err
	}
	return nil
}

// ApplyDeliveryTerminalError forwards one terminal_error.
func (a *DeliveryReceiptAdapter) ApplyDeliveryTerminalError(ctx context.Context, principal computer.Principal, receipt agent.DeliveryTerminalErrorReceipt) error {
	_, err := a.store.RecordTerminalError(ctx, delivery.TerminalErrorInput{
		Principal: machinePrincipalOf(principal),
		AgentID:   receipt.AgentID,
		Code:      receipt.Code,
		Snapshot:  snapshotOf(receipt.MentionDelivery),
	})
	if err != nil {
		if isExpectedReceiptRefusal(err) {
			a.logger.Info("terminal error refused with zero state change",
				"machine_id", principal.MachineID, "agent_id", receipt.AgentID,
				"code", receipt.Code, "reason", err.Error())
			return nil
		}
		return err
	}
	return nil
}
