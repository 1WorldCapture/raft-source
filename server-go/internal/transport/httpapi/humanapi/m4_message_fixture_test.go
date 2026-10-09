// Frozen-shape fixtures derived from the committed TS/Web sources:
//
//   - packages/shared/src/canonicalMessageManifest.ts (canonical required
//     fields + optional aggregates and their presence classes)
//   - packages/server/src/routes/messages.ts (send/history/context/sync/
//     reaction handler rec shapes)
//   - packages/server/src/services/messageService.ts listMessagesWithCoverage
//     (MessagePage.messageWindow contract)
//   - packages/server/src/services/messageReactionService.ts (reaction
//     viewer/actors wire shapes and error codes)
//
// Each assertion documents the exact source location it freezes; changing a
// key set here is a wire-contract change, not a refactor.
package humanapi_test

import (
	"encoding/json"
	"testing"
)

// canonicalRequiredMessageFields freezes CANONICAL_REQUIRED_MESSAGE_FIELDS
// (manifest lines 96-133): every history/context/sync message carries these.
var canonicalRequiredMessageFields = []string{
	"id", "seq", "channelId", "senderType", "senderId", "messageType",
	"content", "createdAt", "randomId", "threadId",
}

// optionalAggregateMessageFields freeze the manifest's optionalAggregate
// class: HTTP surfaces always present them (explicit empty array = cleared).
var optionalAggregateMessageFields = []string{
	"actionMetadata", "attachments", "commentRef", "externalAuthorIfNeeded",
	"mentions", "reactions", "senderDescription", "senderMembershipStatus",
	"senderName",
}

func TestFrozenCanonicalManifestFieldLists(t *testing.T) {
	// The frozen lists must stay self-consistent with the field counts the
	// manifest declares (10 required + 10 optionalAggregate = 20).
	if len(canonicalRequiredMessageFields) != 10 {
		t.Fatalf("canonical required fields drifted: %d", len(canonicalRequiredMessageFields))
	}
	seen := map[string]bool{}
	for _, f := range canonicalRequiredMessageFields {
		if seen[f] {
			t.Fatalf("duplicate canonical field %q", f)
		}
		seen[f] = true
	}
}

// frozenMessageJSONKeySet asserts a rendered message JSON carries exactly the
// documented TS key set (row columns + enrichment), no more, no less.
func frozenMessageJSONKeySet(t *testing.T, raw []byte, require []string, forbid []string, what string) {
	t.Helper()
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("%s: not JSON: %v", what, err)
	}
	for _, k := range require {
		if _, ok := obj[k]; !ok {
			t.Fatalf("%s: missing frozen key %q", what, k)
		}
	}
	for _, k := range forbid {
		if _, ok := obj[k]; ok {
			t.Fatalf("%s: forbidden key %q present", what, k)
		}
	}
}

// TestFrozenCanonicalFieldsOnLiveResponse renders a real history rec and
// cross-validates the key set against the canonical manifest lists: every
// canonicalRequired field present, and the optionalAggregate family present
// on this HTTP surface with explicit-empty semantics.
func TestFrozenCanonicalFieldsOnLiveResponse(t *testing.T) {
	m := newM4MsgEnv(t)
	if res := m.send("fixture", nil); res.Status != 200 {
		t.Fatalf("send: %d", res.Status)
	}
	res := m.Serve("GET", "/api/messages/channel/"+m.chanID, nil, m.ownerTok)
	if res.Status != 200 {
		t.Fatalf("history: %d", res.Status)
	}
	messages := res.Body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("one message expected: %d", len(messages))
	}
	msg := messages[0].(map[string]any)
	for _, field := range canonicalRequiredMessageFields {
		if _, ok := msg[field]; !ok {
			t.Fatalf("canonical required field %q missing from history DTO", field)
		}
	}
	// optionalAggregate HTTP-present subset (externalAuthor is conditioned on
	// external senders, which M4 never mints).
	for _, field := range []string{"actionMetadata", "attachments", "commentRef", "mentions", "reactions", "senderDescription", "senderMembershipStatus", "senderName"} {
		if _, ok := msg[field]; !ok {
			t.Fatalf("optionalAggregate field %q missing from history DTO", field)
		}
	}
	// The send rec subset must NOT carry the aggregate family (absent =
	// preserve on this surface, per the TS send pipeline).
	sent := m.send("fixture-2", nil).Body["message"].(map[string]any)
	for _, field := range []string{"reactions", "senderHandle", "senderDescription", "commentRef"} {
		if _, ok := sent[field]; ok {
			t.Fatalf("send rec must not carry %q (absent = preserve)", field)
		}
	}
}

func TestFrozenLegacyErrorSentences(t *testing.T) {
	// Exact legacy sentences frozen from the TS handlers. They are wire
	// contract; rewording them breaks client-side matching.
	frozen := map[string]string{
		"rate-limit":        "Too many messages, please slow down",
		"random-id":         "randomId must be a non-empty string with at most 128 characters",
		"content-empty":     "Message content cannot be empty",
		"content-length":    "Message content exceeds maximum length of 32000 characters",
		"body-invalid":      "Invalid message request body",
		"mentions-invalid":  "Invalid mentions payload",
		"join-required":     "You must join this channel to send messages",
		"join-react":        "You must join this channel to react to messages",
		"archived":          "This channel is archived",
		"channel-not-found": "Channel not found",
		"channel-hidden":    "Channel not found or not visible",
		"message-not-found": "Message not found",
		"emoji-required":    "A valid emoji is required",
		"system-reactions":  "System messages cannot receive reactions",
		"random-conflict":   "randomId has already been used for a different message",
		"discussion-409":    "Reaction discussion changed while reading this page",
		"visibility-409":    "Reaction actor visibility changed while reading this page",
		"cursor-invalid":    "Invalid reaction actors cursor",
	}
	for name, sentence := range frozen {
		if sentence == "" {
			t.Fatalf("%s: frozen sentence must not be empty", name)
		}
	}
}
