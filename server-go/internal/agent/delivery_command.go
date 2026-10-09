// Typed machine wire for M5 delivery (frozen from
// packages/shared/src/index.ts:557–582, 853–862 — see
// docs/m5-protocol-evidence.md §1). Two payloads live here:
//
//   - the agent:start extensions the M5 lifecycle dispatch adds on top of the
//     M3 MachineCommand (launchId + startDispatchId; wake/resume fields exist
//     on the wire type for the frozen start contract, but THIS builder never
//     sets them — the server does not fabricate a user message to force a
//     cold-start session, and a tracked mention must never be demoted to an
//     ordinary wakeMessage, packages/daemon/src/core.ts:1498–1516),
//   - agent:deliver, one explicit retryable delivery. The message body is the
//     presenter's exact snake_case AgentMessage JSON passed through as
//     json.RawMessage; this package never re-projects it. seq is the
//     message's messages.seq; deliveryId is mentionDelivery.occurrenceId.
package agent

import (
	"encoding/json"
)

// Machine wire command types beyond the M3 four.
const MachineCommandDeliver = "agent:deliver"

// MentionDeliverySnapshot is the wire's MentionDeliveryIdentitySnapshot:
// { occurrenceId, messageId, machineId, launchId, sessionId }. The managed
// wire requires all five to be non-empty on a tracked delivery (design
// §5.3); a missing machine/launch/session snapshot is refused at build time,
// never sent half-filled.
type MentionDeliverySnapshot struct {
	OccurrenceID string `json:"occurrenceId"`
	MessageID    string `json:"messageId"`
	MachineID    string `json:"machineId"`
	LaunchID     string `json:"launchId"`
	SessionID    string `json:"sessionId"`
}

// Complete reports whether all five identity fields are non-empty.
func (m MentionDeliverySnapshot) Complete() bool {
	return m.OccurrenceID != "" && m.MessageID != "" &&
		m.MachineID != "" && m.LaunchID != "" && m.SessionID != ""
}

// AgentStartExtras carries the optional agent:start fields of the original
// protocol. The M5 lifecycle dispatch leaves them zero: no invented wake
// message, no fabricated resume context. A later, fixture-frozen start
// contract may populate them; the wire type is complete so that day needs no
// protocol change here.
type AgentStartExtras struct {
	// WakeMessage is one AgentMessage JSON. NEVER set for a tracked-mention
	// driven start: the daemon's selectWakeDeliveryIndex excludes mentions
	// from wake promotion, and removing mentionDelivery to "simplify" the
	// cold start is forbidden (design §7.1).
	WakeMessage json.RawMessage `json:"wakeMessage,omitempty"`
	// WakeMessageTransient marks WakeMessage transient on the wire.
	WakeMessageTransient bool `json:"wakeMessageTransient,omitempty"`
	// ResumeMessages is the resume AgentMessage array JSON.
	ResumeMessages json.RawMessage `json:"resumeMessages,omitempty"`
	// UnreadSummary is the Record<string,number> JSON.
	UnreadSummary json.RawMessage `json:"unreadSummary,omitempty"`
	// ResumePrompt is the frozen start-contract resume prompt.
	ResumePrompt string `json:"resumePrompt,omitempty"`
}

// StartDispatchCommand is the M5 agent:start payload: the M3 MachineCommand
// body plus launchId and startDispatchId. Extras is nil on the lifecycle
// path (no fabricated wake/resume context).
type StartDispatchCommand struct {
	Type            string            `json:"type"`
	AgentID         string            `json:"agentId"`
	Config          *AgentStartConfig `json:"config,omitempty"`
	LaunchID        string            `json:"launchId,omitempty"`
	StartDispatchID string            `json:"startDispatchId,omitempty"`
	AgentStartExtras
}

// NewStartDispatchCommand builds the M5 start for a reserved launch. It
// reuses NewStartCommand's config projection verbatim (one presenter) and
// stamps the launch fence pair. It never sets a wakeMessage.
func NewStartDispatchCommand(a *Agent, serverURL string, machineName, machineDescription, machineHostname, machineOS, daemonVersion *string, launchID, startDispatchID string) StartDispatchCommand {
	base := NewStartCommand(a, serverURL, machineName, machineDescription, machineHostname, machineOS, daemonVersion)
	return StartDispatchCommand{
		Type:            MachineCommandStart,
		AgentID:         base.AgentID,
		Config:          base.Config,
		LaunchID:        launchID,
		StartDispatchID: startDispatchID,
	}
}

// DeliveryCommand is one agent:deliver ServerToMachineMessage. Message is the
// presenter-owned AgentMessage JSON (snake_case fields, passed through
// verbatim); Seq is the message's messages.seq — NOT a delivery ordering
// counter (design §3.1: delivery_order never enters the wire seq).
type DeliveryCommand struct {
	Type            string                   `json:"type"`
	AgentID         string                   `json:"agentId"`
	Message         json.RawMessage          `json:"message"`
	Seq             int64                    `json:"seq"`
	DeliveryID      string                   `json:"deliveryId,omitempty"`
	Transient       bool                     `json:"transient,omitempty"`
	MentionDelivery *MentionDeliverySnapshot `json:"mentionDelivery,omitempty"`
}

// NewMentionDeliveryCommand builds one tracked agent:deliver for a managed
// attempt. Refuses an incomplete identity snapshot (the managed wire always
// carries machine/launch/session), an empty message body and a non-positive
// seq — fail closed at the only place the frame is born, so no caller can
// queue a half-identified delivery.
func NewMentionDeliveryCommand(agentID string, message json.RawMessage, seq int64, snapshot MentionDeliverySnapshot) (DeliveryCommand, error) {
	if agentID == "" {
		return DeliveryCommand{}, errf(400, "", "delivery requires an agent id")
	}
	if len(message) == 0 || !json.Valid(message) {
		return DeliveryCommand{}, errf(400, "", "delivery requires the presenter's AgentMessage JSON")
	}
	if seq <= 0 {
		return DeliveryCommand{}, errf(400, "", "delivery seq must be the message's positive messages.seq")
	}
	if !snapshot.Complete() {
		return DeliveryCommand{}, errf(400, "incomplete_mention_delivery_identity",
			"tracked delivery requires a complete machine/launch/session identity snapshot")
	}
	frozen := snapshot // copy so the caller cannot mutate the sent frame
	return DeliveryCommand{
		Type:            MachineCommandDeliver,
		AgentID:         agentID,
		Message:         message,
		Seq:             seq,
		DeliveryID:      frozen.OccurrenceID, // deliveryId === occurrenceId (wire contract)
		MentionDelivery: &frozen,
	}, nil
}

// NewControlDeliveryCommand builds the onboarding control notice
// (core.ts sendDeliveryAck / the non-mention accepted branch). The frame is
// seq 0, transient, deliveryId equal to the attempt occurrence, and it
// carries no mentionDelivery. The daemon then acks
// `msg.seq > 0 ? msg.seq : msg.message.seq ?? 0`, so a positive seq inside
// the message JSON would come back as a positive-seq ack and miss this
// path. That message seq is rejected here. The resulting ack is a reported
// receipt, not model consumption, and seq 0 names this occurrence only.
func NewControlDeliveryCommand(agentID string, message json.RawMessage, occurrenceID string) (DeliveryCommand, error) {
	if agentID == "" {
		return DeliveryCommand{}, errf(400, "", "delivery requires an agent id")
	}
	if len(message) == 0 || !json.Valid(message) {
		return DeliveryCommand{}, errf(400, "", "delivery requires the presenter's AgentMessage JSON")
	}
	if occurrenceID == "" {
		return DeliveryCommand{}, errf(400, "", "control delivery requires the attempt occurrence id")
	}
	if err := rejectPositiveControlMessageSeq(message); err != nil {
		return DeliveryCommand{}, err
	}
	return DeliveryCommand{
		Type:       MachineCommandDeliver,
		AgentID:    agentID,
		Message:    message,
		Seq:        0,
		DeliveryID: occurrenceID,
		Transient:  true,
	}, nil
}

// rejectPositiveControlMessageSeq enforces the daemon ack rule: frame seq 0
// falls through to message.seq. A positive message seq would not ack as seq 0.
func rejectPositiveControlMessageSeq(message json.RawMessage) error {
	var probe struct {
		Seq json.RawMessage `json:"seq"`
	}
	if err := json.Unmarshal(message, &probe); err != nil {
		return errf(400, "", "delivery requires the presenter's AgentMessage JSON")
	}
	if len(probe.Seq) == 0 || string(probe.Seq) == "null" {
		return nil
	}
	var seq int64
	if err := json.Unmarshal(probe.Seq, &seq); err != nil || seq != 0 {
		return errf(400, "", "control notice message seq must be absent or zero; a positive seq makes the daemon ack that seq")
	}
	return nil
}

// NewTransientDeliveryCommand builds an ordinary (non-tracked) delivery — the
// brief/transient path. No mention snapshot is attached; the daemon acks it
// from deliverMessage's accepted branch (a reported receipt, not model
// consumption). Seq 0 control notices use NewControlDeliveryCommand, which
// also stamps deliveryId.
func NewTransientDeliveryCommand(agentID string, message json.RawMessage, seq int64) (DeliveryCommand, error) {
	if agentID == "" {
		return DeliveryCommand{}, errf(400, "", "delivery requires an agent id")
	}
	if len(message) == 0 || !json.Valid(message) {
		return DeliveryCommand{}, errf(400, "", "delivery requires the presenter's AgentMessage JSON")
	}
	if seq <= 0 {
		return DeliveryCommand{}, errf(400, "", "delivery seq must be the message's positive messages.seq")
	}
	return DeliveryCommand{
		Type:      MachineCommandDeliver,
		AgentID:   agentID,
		Message:   message,
		Seq:       seq,
		Transient: true,
	}, nil
}
