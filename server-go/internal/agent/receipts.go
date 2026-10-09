// Typed daemon receipt frames (MachineToServerMessage slice frozen in
// docs/m5-protocol-evidence.md §1): agent:deliver:ack,
// agent:delivery:transition and agent:delivery:terminal_error. Parsing
// enforces the protocol's closed sets and required identity snapshots;
// everything else arrives as ReceiptKindNone and flows to the existing
// agent-service lifecycle switch unchanged. IMPORTANT SEMANTICS: these are
// REPORTED receipts. agentProcessManager.ts:4361–4388 buffers a tracked
// message during start and ACKs it before any model consumption — a
// daemon_drained transition or an ACK is a transport fact, never
// "model_seen"/"task_completed". The field names below keep the word
// "reported" so no caller can conflate the two.
package agent

import (
	"encoding/json"
	"fmt"
)

// ReceiptFrame kinds.
const (
	ReceiptKindNone          = ""
	ReceiptKindInvalid       = "invalid"
	ReceiptKindDeliverAck    = "deliver_ack"
	ReceiptKindTransition    = "transition"
	ReceiptKindTerminalError = "terminal_error"
)

// Terminal error codes (MentionDeliveryTerminalErrorCode, closed set).
var deliveryTerminalErrorCodes = map[string]bool{
	"IDENTITY_UNKNOWN":          true,
	"IDENTITY_DRIFT":            true,
	"QUOTA_LIMITED":             true,
	"DELIVERY_REJECTED":         true,
	"UNSUPPORTED_DELIVERY_PATH": true,
	"INSTRUMENT_FAILED":         true,
}

// Transition stages (MentionDeliveryTransitionStage, closed set). The stage
// string "daemon_drained" means the DAEMON REPORTED drained — see the file
// comment; it is not model consumption.
var deliveryTransitionStages = map[string]bool{
	"daemon_received": true,
	"daemon_pending":  true,
	"daemon_drained":  true,
}

// Transition outcomes (closed set).
var deliveryTransitionOutcomes = map[string]bool{
	"accepted":  true,
	"coalesced": true,
}

// StartAckQueueStates is the agent:start:ack queueState closed set
// (queued/starting/running/rebound). Report states, not dispatchability.
var StartAckQueueStates = map[string]bool{
	"queued": true, "starting": true, "running": true, "rebound": true,
}

// DeliverAckReceipt is one agent:deliver:ack. deliveryId/mentionDelivery are
// optional on the wire (legacy daemons omit them); whether a tracked attempt
// may be resolved from a bare-seq ACK is the delivery domain's decision —
// the documented rule is that it may NOT guess via max(seq).
type DeliverAckReceipt struct {
	AgentID         string                   `json:"agentId"`
	Seq             int64                    `json:"seq"`
	DeliveryID      string                   `json:"deliveryId"`
	MentionDelivery *MentionDeliverySnapshot `json:"mentionDelivery"`
}

// DeliveryTransitionReceipt is one agent:delivery:transition. The mention
// snapshot is REQUIRED by the protocol; a transition without it is invalid.
type DeliveryTransitionReceipt struct {
	AgentID         string                  `json:"agentId"`
	Stage           string                  `json:"stage"` // daemon_received|daemon_pending|daemon_drained (REPORTED)
	Outcome         string                  `json:"outcome"`
	MentionDelivery MentionDeliverySnapshot `json:"mentionDelivery"`
}

// DeliveryTerminalErrorReceipt is one agent:delivery:terminal_error.
type DeliveryTerminalErrorReceipt struct {
	AgentID         string                  `json:"agentId"`
	Code            string                  `json:"code"`
	MentionDelivery MentionDeliverySnapshot `json:"mentionDelivery"`
}

// StartAckFrame is one agent:start:ack (handled by the agent domain, not the
// delivery receipt sink).
type StartAckFrame struct {
	AgentID         string  `json:"agentId"`
	StartDispatchID string  `json:"startDispatchId"`
	LaunchID        *string `json:"launchId"`
	QueueState      string  `json:"queueState"`
	QueueDepth      int64   `json:"queueDepth"`
	QueueAgeMS      int64   `json:"queueAgeMs"`
}

// ReceiptSet is the discriminated parse result of one daemon frame.
type ReceiptSet struct {
	Kind          string
	InvalidReason string
	DeliverAck    *DeliverAckReceipt
	Transition    *DeliveryTransitionReceipt
	TerminalError *DeliveryTerminalErrorReceipt
	StartAck      *StartAckFrame
}

func snapshotFromJSON(raw json.RawMessage) (MentionDeliverySnapshot, bool) {
	var snapshot MentionDeliverySnapshot
	if len(raw) == 0 {
		return snapshot, false
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return snapshot, false
	}
	return snapshot, snapshot.Complete()
}

// ParseReceiptFrame classifies one raw daemon frame into the M5 receipt
// kinds. Kind ReceiptKindNone means "not a receipt frame" (the caller routes
// it to the existing lifecycle switch); ReceiptKindInvalid means the frame
// CLAIMS to be a receipt but violates the frozen shape — it is consumed with
// a diagnostic and never forwarded as fact.
func ParseReceiptFrame(raw json.RawMessage) ReceiptSet {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Type == "" {
		return ReceiptSet{Kind: ReceiptKindNone}
	}
	switch envelope.Type {
	case "agent:deliver:ack":
		var frame struct {
			AgentID         string          `json:"agentId"`
			Seq             *int64          `json:"seq"`
			DeliveryID      string          `json:"deliveryId"`
			MentionDelivery json.RawMessage `json:"mentionDelivery"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "deliver:ack: malformed"}
		}
		if frame.AgentID == "" || frame.Seq == nil || *frame.Seq < 0 {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "deliver:ack: missing agentId or seq"}
		}
		hasMention := len(frame.MentionDelivery) > 0 && string(frame.MentionDelivery) != "null"
		// Tracked snapshots stay strictly positive. seq 0 is the control
		// notice ack (no mentionDelivery) and must name one deliveryId; it
		// is never a queue watermark.
		if hasMention && *frame.Seq <= 0 {
			return ReceiptSet{Kind: ReceiptKindInvalid,
				InvalidReason: "deliver:ack: tracked mention requires a positive seq"}
		}
		if *frame.Seq == 0 && frame.DeliveryID == "" {
			return ReceiptSet{Kind: ReceiptKindInvalid,
				InvalidReason: "deliver:ack: seq 0 without deliveryId is not a queue watermark"}
		}
		receipt := &DeliverAckReceipt{
			AgentID:    frame.AgentID,
			Seq:        *frame.Seq,
			DeliveryID: frame.DeliveryID,
		}
		if hasMention {
			snapshot, ok := snapshotFromJSON(frame.MentionDelivery)
			if !ok {
				return ReceiptSet{Kind: ReceiptKindInvalid,
					InvalidReason: "deliver:ack: mentionDelivery present but incomplete"}
			}
			receipt.MentionDelivery = &snapshot
		}
		return ReceiptSet{Kind: ReceiptKindDeliverAck, DeliverAck: receipt}
	case "agent:delivery:transition":
		var frame struct {
			AgentID         string          `json:"agentId"`
			Stage           string          `json:"stage"`
			Outcome         string          `json:"outcome"`
			MentionDelivery json.RawMessage `json:"mentionDelivery"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "transition: malformed"}
		}
		if !deliveryTransitionStages[frame.Stage] {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "transition: unknown stage"}
		}
		if !deliveryTransitionOutcomes[frame.Outcome] {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "transition: unknown outcome"}
		}
		snapshot, ok := snapshotFromJSON(frame.MentionDelivery)
		if !ok {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "transition: mentionDelivery required"}
		}
		return ReceiptSet{Kind: ReceiptKindTransition, Transition: &DeliveryTransitionReceipt{
			AgentID: frame.AgentID, Stage: frame.Stage, Outcome: frame.Outcome,
			MentionDelivery: snapshot,
		}}
	case "agent:delivery:terminal_error":
		var frame struct {
			AgentID         string          `json:"agentId"`
			Code            string          `json:"code"`
			MentionDelivery json.RawMessage `json:"mentionDelivery"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "terminal_error: malformed"}
		}
		if !deliveryTerminalErrorCodes[frame.Code] {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "terminal_error: unknown code"}
		}
		snapshot, ok := snapshotFromJSON(frame.MentionDelivery)
		if !ok {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "terminal_error: mentionDelivery required"}
		}
		return ReceiptSet{Kind: ReceiptKindTerminalError, TerminalError: &DeliveryTerminalErrorReceipt{
			AgentID: frame.AgentID, Code: frame.Code, MentionDelivery: snapshot,
		}}
	case "agent:start:ack":
		var frame StartAckFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "start:ack: malformed"}
		}
		if !StartAckQueueStates[frame.QueueState] {
			return ReceiptSet{Kind: ReceiptKindInvalid, InvalidReason: "start:ack: unknown queueState"}
		}
		return ReceiptSet{Kind: "start_ack", StartAck: &frame}
	default:
		return ReceiptSet{Kind: ReceiptKindNone}
	}
}

// String keeps diagnostics log-safe (no payload bodies).
func (r ReceiptSet) String() string {
	return fmt.Sprintf("receipt kind=%s invalid=%s", r.Kind, r.InvalidReason)
}
