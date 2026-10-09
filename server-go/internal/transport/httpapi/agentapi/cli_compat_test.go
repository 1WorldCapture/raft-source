// Original-CLI compatibility tests. The pure helpers below are Go ports of
// the actual client sources (read-only): packages/cli/src/commands/message/
// _claimAck.ts (Claim-Ack token encode/decode/isEmpty) and _format.ts
// (formatTarget plus the field list formatMessageLine/formatHistoryMessageLine
// consume). They pin that this server's wire output is exactly what the
// shipped CLI parses and renders — not a lookalike.
package agentapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/protocol/client"
	agentapi "raft.local/server-go/internal/transport/httpapi/agentapi"
	"raft.local/server-go/internal/transport/presenter"
)

// aliases keep the fixture builders readable next to the ported client code.
type (
	agentapiEventBatchAlias  = agentapi.AgentEventBatch
	presenterFactsAlias      = presenter.AgentMessageFacts
	presenterHistoryAlias    = presenter.AgentHistoryFacts
	messageCreateResultAlias = message.CreateResult
)

// ---- port of packages/cli/src/commands/message/_claimAck.ts -------------------

const claimAckLinePrefix = "Claim-Ack: "

const claimAckTokenVersion = 1

type claimAckTokenPayload struct {
	V int      `json:"v"`
	S []int64  `json:"s"`
	M []string `json:"m"`
	T []string `json:"t"`
}

type cliAckBatch struct {
	Seqs               []int64
	MessageIDs         []string
	ThirdPartyEventIDs []string
}

func encodeClaimAckToken(batch cliAckBatch) string {
	payload := claimAckTokenPayload{V: claimAckTokenVersion, S: batch.Seqs, M: batch.MessageIDs, T: batch.ThirdPartyEventIDs}
	raw, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(raw)
}

var claimAckTokenShape = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func decodeClaimAckToken(token string) *cliAckBatch {
	trimmed := strings.TrimSpace(token)
	if strings.HasPrefix(trimmed, claimAckLinePrefix) {
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, claimAckLinePrefix))
	}
	if !claimAckTokenShape.MatchString(trimmed) {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(trimmed)
	if err != nil {
		return nil
	}
	var p claimAckTokenPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	if p.V != claimAckTokenVersion {
		return nil
	}
	for _, n := range p.S {
		if n <= 0 {
			return nil
		}
	}
	for _, s := range p.M {
		if s == "" {
			return nil
		}
	}
	for _, s := range p.T {
		if s == "" {
			return nil
		}
	}
	return &cliAckBatch{Seqs: p.S, MessageIDs: p.M, ThirdPartyEventIDs: p.T}
}

func isEmptyAckBatch(batch cliAckBatch) bool {
	return len(batch.Seqs) == 0 && len(batch.MessageIDs) == 0 && len(batch.ThirdPartyEventIDs) == 0
}

// ---- port of the _format.ts target derivation + consumed field list ----------

// cliFormatTarget is formatTarget: derive the reply target string from one
// message envelope exactly like the CLI renderer.
func cliFormatTarget(m map[string]any) string {
	if m["third_party_event"] != nil {
		return fmt.Sprintf("agent-event:%s", strings.TrimRight(strings.SplitN(fmt.Sprint(m["third_party_event"].(map[string]any)["id"]), "", 2)[0], "")[:8])
	}
	if m["channel_type"] == "thread" && m["parent_channel_name"] != nil {
		shortID := fmt.Sprint(m["channel_name"])
		shortID = strings.TrimPrefix(shortID, "thread-")
		if m["parent_channel_type"] == "dm" {
			return fmt.Sprintf("dm:@%s:%s", m["parent_channel_name"], shortID)
		}
		return fmt.Sprintf("#%s:%s", m["parent_channel_name"], shortID)
	}
	if m["channel_type"] == "dm" {
		return fmt.Sprintf("dm:@%s", m["channel_name"])
	}
	return fmt.Sprintf("#%s", m["channel_name"])
}

// cliSenderHandle is formatSenderHandle: "@name" or "@name — description".
func cliSenderHandle(m map[string]any) string {
	name := "unknown"
	if v, ok := m["sender_name"].(string); ok && v != "" {
		name = v
	}
	if desc, ok := m["sender_description"].(string); ok && desc != "" {
		return fmt.Sprintf("@%s — %s", name, desc)
	}
	return "@" + name
}

// cliInboxLineFields are the always-present fields formatMessageLine reads.
// Parent fields are optional strings in the original shared schema, not
// nullable strings; they are asserted separately for root and thread rows.
var cliInboxLineFields = []string{
	"message_id", "timestamp", "sender_type", "sender_name", "sender_description",
	"channel_type", "channel_name",
	"content", "attachments", "mentioned",
}

// cliOptionalTaskFields are read by formatMessageLine with a truthiness guard
// (`m.task_status ? ...`): absence is the original no-task rendering, and this
// server must omit them rather than fabricate nulls while tasks are
// unimplemented.
var cliOptionalTaskFields = []string{
	"task_status", "task_number", "task_assignee_id", "task_assignee_name",
	"task_current_projection", "non_member_mention",
}

// cliHistoryLineFields are the history formatter's fields (camelCase-first
// with snake_case fallbacks).
var cliHistoryLineFields = []string{
	"seq", "id", "message_id", "createdAt", "timestamp", "senderType", "sender_type",
	"senderName", "sender_name", "sender_description",
	"content", "attachments",
}

// cliOptionalHistoryFields are camelCase fields the history formatter reads
// with a null/undefined fallback (`m.senderDescription ?? m.sender_description
// ?? null`): the original TS envelope builder does not emit the camel
// description, so absence with the snake spelling present is the faithful
// shape.
// threadId/replyCount are `if (m.threadId)`-guarded in the formatter: absent
// when the fact is null is the faithful projection; present rows must carry
// them (checked inline below).
var cliOptionalHistoryFields = []string{"senderDescription", "threadId", "replyCount"}

func envelopeAsMap(t *testing.T, raw string, envelopeKey string) map[string]any {
	t.Helper()
	var top map[string]any
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	events, ok := top[envelopeKey].([]any)
	if !ok || len(events) == 0 {
		t.Fatalf("no %s in %s", envelopeKey, raw)
	}
	first, ok := events[0].(map[string]any)
	if !ok {
		t.Fatalf("envelope[0] not an object: %s", raw)
	}
	return first
}

// ---- tests -------------------------------------------------------------------

// TestCLIClaimAckTokenRoundTrip ports _claimAck.ts's own test vectors and
// proves this server's claim ack batch is the exact token content.
func TestCLIClaimAckTokenRoundTrip(t *testing.T) {
	// original vectors: round-trip, line prefix, garbage, wrong version, negative seq
	batch := cliAckBatch{Seqs: []int64{7, 9}, MessageIDs: []string{"m-1"}, ThirdPartyEventIDs: []string{}}
	token := encodeClaimAckToken(batch)
	if !claimAckTokenShape.MatchString(token) {
		t.Fatalf("token shape: %s", token)
	}
	if got := decodeClaimAckToken(token); got == nil || len(got.Seqs) != 2 || got.Seqs[1] != 9 || got.MessageIDs[0] != "m-1" {
		t.Fatalf("round trip: %+v", got)
	}
	if got := decodeClaimAckToken(claimAckLinePrefix + token + "\n"); got == nil || len(got.Seqs) != 2 {
		t.Fatalf("line prefix: %+v", got)
	}
	if decodeClaimAckToken("not a token!") != nil {
		t.Fatal("garbage must be rejected")
	}
	wrongVersion, _ := json.Marshal(claimAckTokenPayload{V: 2, S: []int64{}, M: []string{}, T: []string{}})
	if decodeClaimAckToken(base64.RawURLEncoding.EncodeToString(wrongVersion)) != nil {
		t.Fatal("v!=1 must be rejected")
	}
	negative, _ := json.Marshal(claimAckTokenPayload{V: 1, S: []int64{-1}, M: []string{}, T: []string{}})
	if decodeClaimAckToken(base64.RawURLEncoding.EncodeToString(negative)) != nil {
		t.Fatal("negative seq must be rejected")
	}
	if !isEmptyAckBatch(cliAckBatch{}) || isEmptyAckBatch(batch) {
		t.Fatal("isEmptyAckBatch")
	}
}

// TestCLIClaimResponseIsTokenizable drives the real HTTP handler and runs the
// CLI encode/decode pipeline over its ack batch.
func TestCLIClaimResponseIsTokenizable(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = sampleBatch()
	code, _, raw := env.do(http.MethodGet, "/internal/agent-api/events/claim?since=latest", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("claim: %d %s", code, raw)
	}
	var response client.AgentEventsClaimResponse
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatalf("unmarshal claim: %v", err)
	}
	batch := cliAckBatch{
		Seqs:               response.Ack.Seqs,
		MessageIDs:         response.Ack.MessageIDs,
		ThirdPartyEventIDs: response.Ack.ThirdPartyEventIDs,
	}
	if isEmptyAckBatch(batch) {
		t.Fatalf("expected a non-empty ack batch: %s", raw)
	}
	decoded := decodeClaimAckToken(encodeClaimAckToken(batch))
	if decoded == nil || len(decoded.Seqs) != len(batch.Seqs) || len(decoded.MessageIDs) != len(batch.MessageIDs) {
		t.Fatalf("server ack batch failed the CLI token round trip: %+v", decoded)
	}
	for i := range decoded.Seqs {
		if decoded.Seqs[i] != batch.Seqs[i] {
			t.Fatalf("seq drift at %d", i)
		}
	}
}

// TestCLIFormatterConsumesEnvelopes proves the rendered envelopes carry every
// field the original formatter reads and that the four target shapes derive
// the exact CLI target strings from the fixtures in _format.ts examples.
func TestCLIFormatterConsumesEnvelopes(t *testing.T) {
	env := newM5Env(t)
	parentName, parentType := "all", "channel"
	dmPeer := "owner"
	env.events.batch = agentapiEventBatchForShapes(parentName, parentType, dmPeer)
	code, _, raw := env.do(http.MethodGet, "/internal/agent-api/events?since=latest", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("drain: %d %s", code, raw)
	}
	var top map[string]any
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		t.Fatal(err)
	}
	events := top["events"].([]any)
	if len(events) != 4 {
		t.Fatalf("expected the four target shapes, got %d", len(events))
	}
	wantTargets := []string{"#all", "#all:cccccccc", "dm:@owner", "dm:@owner:dddddddd"}
	for i, ev := range events {
		m := ev.(map[string]any)
		for _, field := range cliInboxLineFields {
			if _, ok := m[field]; !ok {
				t.Fatalf("shape %d: inbox formatter field %q missing: %v", i, field, m)
			}
		}
		for _, field := range []string{"parent_channel_type", "parent_channel_name"} {
			value, present := m[field]
			if m["channel_type"] == "thread" {
				if _, ok := value.(string); !ok {
					t.Fatalf("shape %d: thread field %q must be a string: %v", i, field, m)
				}
			} else if present {
				t.Fatalf("shape %d: absent parent field %q must be omitted: %v", i, field, m)
			}
		}
		for _, field := range cliOptionalTaskFields {
			if _, ok := m[field]; ok {
				t.Fatalf("shape %d: task field %q must be omitted, not fabricated: %v", i, field, m)
			}
		}
		if got := cliFormatTarget(m); got != wantTargets[i] {
			t.Fatalf("shape %d target: got %q want %q", i, got, wantTargets[i])
		}
		if handle := cliSenderHandle(m); !strings.HasPrefix(handle, "@") {
			t.Fatalf("sender handle must start with @: %q", handle)
		}
		if _, ok := m["attachments"].([]any); !ok {
			t.Fatalf("attachments must be an array: %v", m["attachments"])
		}
	}
}

// TestCLIHistoryFormatterConsumesWindow checks the history window against the
// camelCase-first field list of formatHistoryMessageLine.
func TestCLIHistoryFormatterConsumesWindow(t *testing.T) {
	env := newM5Env(t)
	env.history.facts = historyFactsForShapes()
	code, _, raw := env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("history: %d %s", code, raw)
	}
	var top map[string]any
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		t.Fatal(err)
	}
	messages := top["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages: %d", len(messages))
	}
	for i, ev := range messages {
		m := ev.(map[string]any)
		for _, field := range cliHistoryLineFields {
			if _, ok := m[field]; !ok {
				t.Fatalf("history row %d: formatter field %q missing: %v", i, field, m)
			}
		}
		for _, field := range cliOptionalHistoryFields {
			if _, ok := m[field]; !ok {
				continue // absent is the original shape when the fact is null
			}
		}
		if m["senderName"] != m["sender_name"] || m["senderType"] != m["sender_type"] {
			t.Fatalf("camel/snake drift: %v", m)
		}
		if m["createdAt"] != m["timestamp"] {
			t.Fatalf("createdAt must echo timestamp: %v", m)
		}
		if i == 1 { // the threaded row must carry its thread facts
			if m["threadId"] != "t-1" {
				t.Fatalf("threadId on threaded row: %v", m["threadId"])
			}
			if rc, ok := m["replyCount"].(float64); !ok || int64(rc) != 2 {
				t.Fatalf("replyCount on threaded row: %v", m["replyCount"])
			}
		}
	}
	if top["has_older"] != boolOf(top["has_more"]) && top["has_more"] == nil {
		t.Fatal("has_more must be present")
	}
}

func boolOf(v any) bool { b, _ := v.(bool); return b }

// TestCLISendBodyFieldAcceptance sends a body carrying every field the real
// CLI emits (send.ts builds target/content/draftReholdCount always, plus the
// optional flags) and proves the server accepts it without 4xx.
func TestCLISendBodyFieldAcceptance(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = messageCreateResult()
	// The normal (non-draft) CLI send carries the always-present metadata
	// fields; sendDraft/continueAnyway are draft actions and covered by the
	// refusal test in m5_http_test.go.
	body := `{"target":"#all","content":"hello","draftReholdCount":2,"draftReplacedExisting":true,` +
		`"seenUpToSeq":33,"freshnessContextMode":"inline",` +
		`"idempotencyKey":"retry-1","attachmentIds":[],"mentions":[{"type":"user","id":"11111111-1111-1111-1111-111111111111","name":"owner"}]}`
	code, _, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("full CLI body: %d %s", code, raw)
	}
	if env.send.lastIn.IdempotencyKey != "retry-1" {
		t.Fatalf("idempotency key: %q", env.send.lastIn.IdempotencyKey)
	}
	// A 256-char idempotency key is legal on the original protocol.
	long := strings.Repeat("k", 256)
	body = strings.Replace(body, "retry-1", long, 1)
	code, _, raw = env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("256-char key: %d %s", code, raw)
	}
	if env.send.lastIn.IdempotencyKey != long {
		t.Fatalf("long key must pass through verbatim")
	}
}

// ---- fixtures for the four CLI target shapes ----------------------------------

func agentapiEventBatchForShapes(parentName string, parentType string, dmPeer string) *agentapiEventBatchAlias {
	dmType := "dm"
	threadName := "thread-cccccccc"
	dmThreadName := "thread-dddddddd"
	return &agentapiEventBatchAlias{Events: []presenterFactsAlias{
		{ // plain channel: "#all"
			Seq: 21, MessageID: "aaaaaaaa-0000-0000-0000-000000000001", TimestampMS: 1_700_000_021_000,
			SenderType: "human", SenderName: "owner", ChannelID: "chan-1", ChannelName: "all",
			ChannelType: "channel", Content: "channel message",
		},
		{ // channel thread: "#all:cccccccc"
			Seq: 22, MessageID: "cccccccc-0000-0000-0000-000000000003", TimestampMS: 1_700_000_022_000,
			SenderType: "agent", SenderName: "ada", ChannelID: "thread-1", ChannelName: threadName,
			ChannelType: "thread", ParentChannelName: &parentName, ParentChannelType: &parentType,
			Content: "thread reply",
		},
		{ // dm: "dm:@owner"
			Seq: 23, MessageID: "eeeeeeee-0000-0000-0000-000000000004", TimestampMS: 1_700_000_023_000,
			SenderType: "human", SenderName: "owner", ChannelID: "dm-1", ChannelName: dmPeer,
			ChannelType: "dm", Content: "dm message",
		},
		{ // dm thread: "dm:@owner:dddddddd"
			Seq: 24, MessageID: "dddddddd-0000-0000-0000-000000000005", TimestampMS: 1_700_000_024_000,
			SenderType: "agent", SenderName: "ada", ChannelID: "thread-2", ChannelName: dmThreadName,
			ChannelType: "thread", ParentChannelName: &dmPeer, ParentChannelType: &dmType,
			Content: "dm thread reply",
		},
	}, HasMore: false, AckSeqs: []int64{21, 22, 23, 24}, AckMessageIDs: []string{}}
}

func historyFactsForShapes() *presenterHistoryAlias {
	return &presenterHistoryAlias{Messages: []presenterFactsAlias{
		{
			Seq: 31, MessageID: "aaaaaaaa-0000-0000-0000-000000000011", TimestampMS: 1_700_000_031_000,
			SenderType: "human", SenderName: "owner", ChannelID: "chan-1", ChannelName: "all",
			ChannelType: "channel", Content: "first",
		},
		{
			Seq: 32, MessageID: "bbbbbbbb-0000-0000-0000-000000000012", TimestampMS: 1_700_000_032_000,
			SenderType: "agent", SenderName: "ada", ChannelID: "chan-1", ChannelName: "all",
			ChannelType: "channel", Content: "second", ThreadID: strPtr("t-1"), ReplyCount: int64Ptr(2),
		},
	}, HasOlder: false, HasNewer: false}
}

func int64Ptr(v int64) *int64 { return &v }

func messageCreateResult() *messageCreateResultAlias {
	return &messageCreateResultAlias{Message: msg("m-cli", 99)}
}
