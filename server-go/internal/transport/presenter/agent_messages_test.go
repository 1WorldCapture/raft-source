package presenter

import (
	"encoding/json"
	"strings"
	"testing"

	"raft.local/server-go/internal/protocol/client"
)

func TestAgentMessageWireSnakeAndCamelEchoes(t *testing.T) {
	desc := "example agent role"
	facts := AgentMessageFacts{
		Seq: 12, MessageID: "aaaaaaaa-0000-0000-0000-000000000001", TimestampMS: 1_700_000_012_000,
		SenderType: "human", SenderName: "owner", SenderDescription: &desc,
		ChannelID: "chan-1", ChannelName: "all", ChannelType: "channel",
		Content: "hello", Mentioned: true,
	}
	wire := AgentMessageWire(facts)
	if wire.SenderType != "human" || wire.SenderTypeEcho != "human" ||
		wire.SenderName != "owner" || wire.SenderNameEcho != "owner" ||
		wire.SenderDescription != &desc || wire.SenderDescriptionCam != &desc {
		t.Fatalf("echo drift: %+v", wire)
	}
	if wire.Timestamp != "2023-11-14T22:13:32.000Z" || wire.CreatedAt != wire.Timestamp {
		t.Fatalf("timestamp projection: %q / %q", wire.Timestamp, wire.CreatedAt)
	}
	if wire.ID != facts.MessageID || wire.MessageID != facts.MessageID {
		t.Fatalf("id spellings: %+v", wire)
	}
	if wire.Attachments == nil || len(wire.Attachments) != 0 {
		t.Fatalf("attachments must be an empty array: %v", wire.Attachments)
	}
}

func TestAgentMessageWireSeqOmissionAndUnknownSender(t *testing.T) {
	// A seq-less row (id-only event) omits seq entirely; a nameless sender
	// falls back to "unknown" exactly like formatSenderHandle.
	wire := AgentMessageWire(AgentMessageFacts{
		MessageID: "bbbbbbbb-0000-0000-0000-000000000002", TimestampMS: 1,
		SenderType: "agent", ChannelID: "c", ChannelName: "n", ChannelType: "channel",
	})
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"seq"`) {
		t.Fatalf("seq must be omitted for seq-less rows: %s", raw)
	}
	if !strings.Contains(string(raw), `"sender_name":"unknown"`) || !strings.Contains(string(raw), `"senderName":"unknown"`) {
		t.Fatalf("unknown sender fallback: %s", raw)
	}
	if strings.Contains(string(raw), "task_status") || strings.Contains(string(raw), "taskStatus") {
		t.Fatalf("task fields must never be fabricated: %s", raw)
	}
	if strings.Contains(string(raw), "non_member_mention") {
		t.Fatalf("non_member_mention omitted when false: %s", raw)
	}
}

func TestAgentMessageWireThreadNaming(t *testing.T) {
	parent, parentType := "all", "channel"
	wire := AgentMessageWire(AgentMessageFacts{
		Seq: 13, MessageID: "cccccccc-0000-0000-0000-000000000003", TimestampMS: 1,
		SenderType: "agent", SenderName: "ada", ChannelID: "thread-1",
		ChannelName: "thread-cccccccc", ChannelType: "thread",
		ParentChannelName: &parent, ParentChannelType: &parentType,
	})
	if wire.ChannelName != "thread-cccccccc" || *wire.ParentName != "all" || *wire.ParentType != "channel" {
		t.Fatalf("thread naming: %+v", wire)
	}
	// The CLI derives "#all:cccccccc" by stripping the thread- prefix.
	if !strings.HasPrefix(wire.ChannelName, "thread-") || len(wire.ChannelName) != len("thread-")+8 {
		t.Fatalf("thread short id spelling: %q", wire.ChannelName)
	}
}

// The original shared schema uses optional strings, not nullable strings,
// for parent_channel_* (agentApiMessageContract.ts). These envelopes are also
// embedded in daemon input snapshots, so a null breaks both CLI check and read.
func TestAgentMessageWireParentFieldsAreOptionalStrings(t *testing.T) {
	parent, parentType := "all", "channel"
	for _, tc := range []struct {
		name       string
		kind       string
		parent     *string
		parentType *string
	}{
		{name: "channel", kind: "channel"},
		{name: "dm", kind: "dm"},
		{name: "thread", kind: "thread", parent: &parent, parentType: &parentType},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wire := AgentMessageWire(AgentMessageFacts{
				Seq: 1, MessageID: "m-1", TimestampMS: 1,
				SenderType: "human", SenderName: "owner", ChannelID: "c-1",
				ChannelName: "all", ChannelType: tc.kind,
				ParentChannelName: tc.parent, ParentChannelType: tc.parentType,
			})
			raw, err := json.Marshal(wire)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err := json.Unmarshal(raw, &fields); err != nil {
				t.Fatal(err)
			}
			for key, want := range map[string]*string{
				"parent_channel_name": tc.parent,
				"parent_channel_type": tc.parentType,
			} {
				got, present := fields[key]
				if want == nil {
					if present {
						t.Fatalf("absent %s must be omitted, not null: %s", key, raw)
					}
				} else if !present || got != *want {
					t.Fatalf("%s = %v, want %q: %s", key, got, *want, raw)
				}
			}
			// This different field really is nullable in the original schema.
			if value, present := fields["sender_description"]; !present || value != nil {
				t.Fatalf("nullable sender description must remain explicit: %s", raw)
			}
		})
	}
}

func TestAgentMessageWireListNeverNil(t *testing.T) {
	if out := AgentMessageWireList(nil); out == nil || len(out) != 0 {
		t.Fatalf("nil in must yield [] on the wire: %v", out)
	}
	var _ []client.AgentMessageEnvelope = out2()
}

func out2() []client.AgentMessageEnvelope { return AgentMessageWireList(nil) }
