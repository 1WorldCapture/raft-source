package agent

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestNewControlDeliveryCommandMatchesDaemonAckSemantics(t *testing.T) {
	message := json.RawMessage(`{"message_id":"notice-1","sender_type":"system","content":"handoff","channel_id":"all"}`)
	cmd, err := NewControlDeliveryCommand("agent-1", message, "occ-control")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("mentionDelivery")) {
		t.Fatalf("control frame must not carry mentionDelivery: %s", encoded)
	}
	var wire struct {
		Type       string          `json:"type"`
		AgentID    string          `json:"agentId"`
		Seq        int64           `json:"seq"`
		DeliveryID string          `json:"deliveryId"`
		Transient  bool            `json:"transient"`
		Message    json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Type != "agent:deliver" || wire.AgentID != "agent-1" || wire.Seq != 0 || !wire.Transient {
		t.Fatalf("wire: %s", encoded)
	}
	if wire.DeliveryID != "occ-control" {
		t.Fatalf("deliveryId must be the attempt occurrence: %s", encoded)
	}
	if !bytes.Equal(bytes.TrimSpace(wire.Message), bytes.TrimSpace(message)) {
		t.Fatalf("message was re-projected: %s", wire.Message)
	}

	// Frame seq 0 makes the daemon ack message.seq when that field is
	// positive (core.ts sendDeliveryAck). Refuse that shape so the ack
	// stays on the seq-0 control path.
	positive := json.RawMessage(`{"message_id":"notice-1","seq":7}`)
	if _, err := NewControlDeliveryCommand("agent-1", positive, "occ-control"); err == nil {
		t.Fatal("positive message seq accepted")
	}
	zeroSeq := json.RawMessage(`{"message_id":"notice-1","seq":0}`)
	if _, err := NewControlDeliveryCommand("agent-1", zeroSeq, "occ-control"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewControlDeliveryCommand("", message, "occ-control"); err == nil {
		t.Fatal("empty agent accepted")
	}
	if _, err := NewControlDeliveryCommand("agent-1", message, ""); err == nil {
		t.Fatal("empty occurrence accepted")
	}
	if _, err := NewControlDeliveryCommand("agent-1", json.RawMessage(`{`), "occ-control"); err == nil {
		t.Fatal("invalid message accepted")
	}
	if _, err := NewTransientDeliveryCommand("agent-1", message, 0); err == nil {
		t.Fatal("transient builder accepted seq 0")
	}
}

func TestControlAckParseAllowsSeq0OnlyWithDeliveryID(t *testing.T) {
	ok := ParseReceiptFrame(json.RawMessage(
		`{"type":"agent:deliver:ack","agentId":"agent-1","seq":0,"deliveryId":"occ-1"}`))
	if ok.Kind != ReceiptKindDeliverAck || ok.DeliverAck == nil || ok.DeliverAck.Seq != 0 ||
		ok.DeliverAck.DeliveryID != "occ-1" || ok.DeliverAck.MentionDelivery != nil {
		t.Fatalf("control ack parse: %+v", ok)
	}
	watermark := ParseReceiptFrame(json.RawMessage(
		`{"type":"agent:deliver:ack","agentId":"agent-1","seq":0}`))
	if watermark.Kind != ReceiptKindInvalid {
		t.Fatalf("seq 0 without deliveryId parsed as fact: %+v", watermark)
	}
	trackedZero := ParseReceiptFrame(json.RawMessage(
		`{"type":"agent:deliver:ack","agentId":"agent-1","seq":0,"deliveryId":"occ-1","mentionDelivery":{"occurrenceId":"occ-1","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`))
	if trackedZero.Kind != ReceiptKindInvalid {
		t.Fatalf("tracked seq 0 parsed as fact: %+v", trackedZero)
	}
	positive := ParseReceiptFrame(json.RawMessage(
		`{"type":"agent:deliver:ack","agentId":"agent-1","seq":4,"deliveryId":"occ-1","mentionDelivery":{"occurrenceId":"occ-1","messageId":"m","machineId":"ma","launchId":"l","sessionId":"s"}}`))
	if positive.Kind != ReceiptKindDeliverAck || positive.DeliverAck.MentionDelivery == nil || positive.DeliverAck.Seq != 4 {
		t.Fatalf("positive tracked ack: %+v", positive)
	}
}
