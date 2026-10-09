// Focused HTTP tests for the M5 Agent CLI surface (send/v2-send, events/
// claim/ack, history, resolve-channel) against fake ports. The credential
// path is real (sqlite + argon2id store): a user JWT and a computer key must
// never authenticate, only a live sk_agent_* bound to a live agent of a live
// workspace. Every response body is the frozen original sentence/shape.
package agentapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	agentapi "raft.local/server-go/internal/transport/httpapi/agentapi"
	"raft.local/server-go/internal/transport/presenter"
)

// ---- fakes -----------------------------------------------------------------

type fakeTargets struct {
	resolution *agentapi.WritableTargetResolution
	err        error
	lastTarget string
	lastScope  string
}

func (f *fakeTargets) ResolveWritableAgentTarget(_ context.Context, _ agent.CredentialLookup, target string) (*agentapi.WritableTargetResolution, error) {
	f.lastTarget = target
	return f.resolution, f.err
}

type fakeSend struct {
	err    error
	result *message.CreateResult
	lastIn agentapi.AgentSendInput
	calls  int
}

func (f *fakeSend) SendAgent(_ context.Context, _ agent.CredentialLookup, in agentapi.AgentSendInput) (*message.CreateResult, error) {
	f.calls++
	f.lastIn = in
	if f.err != nil {
		return nil, f.err
	}
	return f.result, nil
}

type fakeEvents struct {
	batch      *agentapi.AgentEventBatch
	drainErr   error
	claimCalls int
	drainCalls int
	ackCalls   int
	ackRemoved int64
	lastSince  *int64
	lastLimit  int
	lastSeqs   []int64
	lastMsgIDs []string
}

func (f *fakeEvents) DrainEvents(_ context.Context, _ agent.CredentialLookup, q agentapi.AgentEventQuery) (*agentapi.AgentEventBatch, error) {
	f.drainCalls++
	f.lastSince, f.lastLimit = q.SinceSeq, q.Limit
	if f.drainErr != nil {
		return nil, f.drainErr
	}
	return f.batch, nil
}

func (f *fakeEvents) ClaimEvents(_ context.Context, _ agent.CredentialLookup, q agentapi.AgentEventQuery) (*agentapi.AgentEventBatch, error) {
	f.claimCalls++
	f.lastSince, f.lastLimit = q.SinceSeq, q.Limit
	return f.batch, nil
}

func (f *fakeEvents) AckEvents(_ context.Context, _ agent.CredentialLookup, seqs []int64, messageIDs []string) (int64, error) {
	f.ackCalls++
	f.lastSeqs, f.lastMsgIDs = seqs, messageIDs
	return f.ackRemoved, nil
}

type fakeHistory struct {
	facts     *presenter.AgentHistoryFacts
	err       error
	lastQuery agentapi.AgentHistoryQuery
}

func (f *fakeHistory) ReadAgentHistory(_ context.Context, _ agent.CredentialLookup, q agentapi.AgentHistoryQuery) (*presenter.AgentHistoryFacts, error) {
	f.lastQuery = q
	if f.err != nil {
		return nil, f.err
	}
	return f.facts, nil
}

// ---- environment -------------------------------------------------------------

type m5Env struct {
	t       *testing.T
	db      *sql.DB
	mux     *http.ServeMux
	store   *agent.Store
	targets *fakeTargets
	send    *fakeSend
	events  *fakeEvents
	history *fakeHistory
	apiKey  string
	readKey string // read-only capability credential
}

func newM5Env(t *testing.T) *m5Env {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	hasher, err := agent.NewCredentialHasher([]byte("agent-api-pepper-0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	store := agent.NewStore(handle, agent.StoreOptions{
		Clock:  &clock.Fixed{T: time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)},
		Hasher: hasher,
	})
	env := &m5Env{t: t, db: handle, store: store,
		targets: &fakeTargets{}, send: &fakeSend{}, events: &fakeEvents{}, history: &fakeHistory{}}
	env.seed()
	full, err := store.MintCredential(context.Background(), "agent-1", []string{"read", "send", "channels", "server"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	env.apiKey = full.APIKey
	readOnly, err := store.MintCredential(context.Background(), "agent-1", []string{"read"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	env.readKey = readOnly.APIKey
	handlers, err := agentapi.NewHandlers(store, agentapi.Dependencies{
		Send:    env.send,
		Targets: env.targets,
		History: env.history,
		Events:  env.events,
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	agentapi.RegisterRoutes(mux, handlers)
	env.mux = mux
	return env
}

func (e *m5Env) seed() {
	e.t.Helper()
	now := int64(1_700_000_000_000)
	if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('owner', 'owner@example.test', 'owner', 'x', 1, ?, ?)`, now, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES ('ws', 'Workspace', 'ws', 'owner', ?)`, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES ('ws', 'owner', 'owner', 0, ?)`, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, creator_type, creator_id, created_at, updated_at)
		VALUES ('agent-1', 'ws', 'ada', 'Ada', 'active', 'claude', 'user', 'owner', ?, ?)`, now, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', ?, ?)`, now, now); err != nil {
		e.t.Fatal(err)
	}
}

func (e *m5Env) do(method, path, body, bearer string, headers map[string]string) (int, map[string]any, string) {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") && rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return rec.Code, parsed, rec.Body.String()
}

func msg(id string, seq int64) *message.Message {
	return &message.Message{ID: id, Seq: seq, ChannelID: "chan-1", SenderType: "agent"}
}

// ---- auth gates ---------------------------------------------------------------

func TestM5RejectsNonAgentPrincipals(t *testing.T) {
	env := newM5Env(t)
	cases := []struct {
		name   string
		bearer string
	}{
		{"missing", ""},
		{"jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig"},
		{"computer key", "sk_computer_abcdef"},
		{"other secret", "slock_secret_whatever"},
	}
	for _, tc := range cases {
		code, body, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", `{"target":"#all","content":"hi"}`, tc.bearer, nil)
		if code != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d %s", tc.name, code, raw)
		}
		if tc.bearer != "" && body["code"] != "invalid_principal" {
			t.Fatalf("%s: expected invalid_principal, got %s", tc.name, raw)
		}
	}
}

func TestM5CapabilityGates(t *testing.T) {
	env := newM5Env(t)
	// read-only credential cannot send
	code, body, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send", `{"target":"#all","content":"hi"}`, env.readKey, nil)
	if code != http.StatusForbidden || body["code"] != "capability_not_authorized" || body["requiredCapability"] != "send" {
		t.Fatalf("scope gate: %d %v", code, body)
	}
	// active-capabilities header without send
	code, body, _ = env.do(http.MethodPost, "/internal/agent-api/v2/send", `{"target":"#all","content":"hi"}`, env.apiKey,
		map[string]string{"X-Slock-Agent-Active-Capabilities": "read,channels"})
	if code != http.StatusNotImplemented || body["code"] != "unsupported_capability" {
		t.Fatalf("active gate: %d %v", code, body)
	}
	// send-scoped key cannot drain events? it holds read too; use header instead
	code, body, _ = env.do(http.MethodGet, "/internal/agent-api/events?since=latest", "", env.apiKey,
		map[string]string{"X-Slock-Agent-Active-Capabilities": "send"})
	if code != http.StatusNotImplemented || body["code"] != "unsupported_capability" || body["requiredCapability"] != "read" {
		t.Fatalf("events active gate: %d %v", code, body)
	}
}

// ---- send --------------------------------------------------------------------

func TestM5SendV2SentEnvelope(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-1", 42)}
	body := `{"target":"#all","content":"hello","draftReholdCount":0,"idempotencyKey":"k-1","mentions":[{"type":"user","id":"11111111-1111-1111-1111-111111111111","name":"owner"}]}`
	code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("send: %d %s", code, raw)
	}
	if parsed["ok"] != true || parsed["state"] != "sent" || parsed["messageId"] != "m-1" {
		t.Fatalf("sent envelope: %s", raw)
	}
	if seq, ok := parsed["messageSeq"].(float64); !ok || int64(seq) != 42 {
		t.Fatalf("messageSeq: %s", raw)
	}
	if env.targets.lastTarget != "#all" {
		t.Fatalf("target forwarded: %q", env.targets.lastTarget)
	}
	if env.send.lastIn.ChannelID != "chan-1" || env.send.lastIn.Content != "hello" {
		t.Fatalf("send input: %+v", env.send.lastIn)
	}
	if env.send.lastIn.IdempotencyKey != "k-1" {
		t.Fatalf("idempotency key: %q", env.send.lastIn.IdempotencyKey)
	}
	if len(env.send.lastIn.Mentions) != 1 || env.send.lastIn.Mentions[0].Type != "user" {
		t.Fatalf("mentions: %+v", env.send.lastIn.Mentions)
	}
}

func TestM5SendV1IgnoresMentionsAndValidationOrder(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-2", 7)}

	// v1 with a mentions field: ignored like the TS passthrough (v1 reads no
	// structured mentions), still sends.
	code, _, raw := env.do(http.MethodPost, "/internal/agent-api/send", `{"target":"#all","content":"x","mentions":[{"type":"agent","id":"11111111-1111-1111-1111-111111111111","name":"ada"}]}`, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("v1 send: %d %s", code, raw)
	}
	if len(env.send.lastIn.Mentions) != 0 {
		t.Fatalf("v1 mentions must be ignored: %+v", env.send.lastIn.Mentions)
	}

	// Original validation order, exact sentences.
	for _, tc := range []struct {
		body string
		want string
	}{
		{`{}`, "target is required"},
		{`{"target":5}`, "target is required"},
		{`{"target":"#all"}`, "Content is required"},
		{`{"target":"#all","content":""}`, "Content is required"},
		{`{"target":"#all","content":"x","continue":true}`, "--continue is no longer supported. Use normal message send to update a draft, or --send-draft to send the current saved draft."},
		{`{"target":"#all","content":"x","continueAnyway":true}`, "--send-draft --anyway requires a saved draft"},
	} {
		code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/send", tc.body, env.apiKey, nil)
		if code != http.StatusBadRequest || parsed["error"] != tc.want {
			t.Fatalf("validation: %d %s (want %q)", code, raw, tc.want)
		}
	}

	// attachments refuse honestly
	code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/send", `{"target":"#all","content":"x","attachmentIds":["a-1"]}`, env.apiKey, nil)
	if code != http.StatusNotImplemented || parsed["code"] != "feature_not_implemented" ||
		parsed["error"] != "Attachments are not enabled in this server stage" {
		t.Fatalf("attachments: %d %v", code, parsed)
	}
	// empty array is fine
	code, _, _ = env.do(http.MethodPost, "/internal/agent-api/send", `{"target":"#all","content":"x","attachmentIds":[]}`, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("empty attachments: %d", code)
	}
}

func TestM5SendTargetErrorMapping(t *testing.T) {
	env := newM5Env(t)
	for _, tc := range []struct {
		name string
		err  error
		code int
		want string
	}{
		{"forbidden", &agentapi.TargetForbiddenError{Message: "Agent cannot post in this channel - not a member."}, 403, "Agent cannot post in this channel - not a member."},
		{"not found", &agentapi.TargetNotFoundError{Message: "Channel not found: #nope"}, 404, "Channel not found: #nope"},
		{"peer", agentapi.ErrAgentTargetPeerNotFound, 404, "User or agent not found: @ghost"},
		{"self dm", agentapi.ErrAgentTargetSelfDM, 400, "Cannot create a DM with yourself"},
		{"agent dm", &agentapi.AgentDMNotEnabledError{Message: "Agent DMs are not enabled in this server stage"}, 501, "Agent DMs are not enabled in this server stage"},
	} {
		env.targets.err = tc.err
		code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", `{"target":"dm:@ghost","content":"hi"}`, env.apiKey, nil)
		if code != tc.code || parsed["error"] != tc.want {
			t.Fatalf("%s: %d %s", tc.name, code, raw)
		}
		if tc.name == "agent dm" && parsed["code"] != "feature_not_implemented" {
			t.Fatalf("agent dm code: %s", raw)
		}
	}
}

func TestM5SendDomainErrorMapping(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	for _, tc := range []struct {
		name string
		err  error
		code int
		body map[string]any
	}{
		{"archived", message.ErrChannelArchived, 409, map[string]any{"error": "This channel is archived", "code": "channel_archived"}},
		{"invalid", &message.InvalidInput{Reason: "Message content cannot be empty"}, 400, map[string]any{"error": "Message content cannot be empty"}},
		{"binding v2", &message.MentionBindingConflict{Handle: "ada"}, 400, map[string]any{"error": "Mention @ada is bound to more than one actor. Select exactly one actor id and type.", "code": "mention_binding_conflict"}},
		{"unsupported", &message.UnsupportedEffect{Reason: "Attachments are not enabled in this server stage"}, 501, map[string]any{"error": "Attachments are not enabled in this server stage", "code": "feature_not_implemented"}},
		{"randomId conflict", &message.RandomIDConflict{Reason: "randomId has already been used for a different message"}, 409, map[string]any{"error": "randomId has already been used for a different message", "code": "random_id_conflict"}},
		{"internal", errors.New("boom"), 500, map[string]any{"error": "Failed to send message"}},
	} {
		env.send.err = tc.err
		code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", `{"target":"#all","content":"hi"}`, env.apiKey, nil)
		if code != tc.code {
			t.Fatalf("%s: %d %s", tc.name, code, raw)
		}
		for k, v := range tc.body {
			if parsed[k] != v {
				t.Fatalf("%s: %s=%v want %v (%s)", tc.name, k, parsed[k], v, raw)
			}
		}
	}
}

// ---- events ------------------------------------------------------------------

func sampleBatch() *agentapi.AgentEventBatch {
	desc := "example agent role"
	parentName, parentType := "all", "channel"
	return &agentapi.AgentEventBatch{
		Events: []presenter.AgentMessageFacts{
			{
				Seq: 12, MessageID: "aaaaaaaa-0000-0000-0000-000000000001", TimestampMS: 1_700_000_012_000,
				SenderType: "human", SenderName: "owner", ChannelID: "chan-1", ChannelName: "all",
				ChannelType: "channel", Content: "first", Mentioned: true,
			},
			{
				Seq: 13, MessageID: "bbbbbbbb-0000-0000-0000-000000000002", TimestampMS: 1_700_000_013_000,
				SenderType: "agent", SenderName: "ada", SenderDescription: &desc,
				ChannelID: "thread-1", ChannelName: "thread-cccccccc", ChannelType: "thread",
				ParentChannelName: &parentName, ParentChannelType: &parentType,
				Content: "reply", ThreadID: strPtr("cccccccc-0000-0000-0000-000000000003"),
			},
		},
		HasMore:       true,
		AckSeqs:       []int64{12, 13},
		AckMessageIDs: []string{},
	}
}

func strPtr(v string) *string { return &v }

func TestM5EventsDrainEnvelope(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = sampleBatch()
	code, parsed, raw := env.do(http.MethodGet, "/internal/agent-api/events?since=latest", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("drain: %d %s", code, raw)
	}
	if env.events.drainCalls != 1 || env.events.claimCalls != 0 {
		t.Fatalf("drain must call DrainEvents only: drain=%d claim=%d", env.events.drainCalls, env.events.claimCalls)
	}
	if env.events.lastSince != nil || env.events.lastLimit != 50 {
		t.Fatalf("query: since=%v limit=%d", env.events.lastSince, env.events.lastLimit)
	}
	events := parsed["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("events: %s", raw)
	}
	first := events[0].(map[string]any)
	if first["channel_type"] != "channel" || first["channel_name"] != "all" || first["sender_type"] != "human" ||
		first["senderType"] != "human" || first["message_id"] != "aaaaaaaa-0000-0000-0000-000000000001" ||
		first["timestamp"] != "2023-11-14T22:13:32.000Z" || first["mentioned"] != true {
		t.Fatalf("first envelope: %v", first)
	}
	second := events[1].(map[string]any)
	if second["channel_type"] != "thread" || second["channel_name"] != "thread-cccccccc" ||
		second["parent_channel_name"] != "all" || second["parent_channel_type"] != "channel" ||
		second["sender_description"] != "example agent role" {
		t.Fatalf("thread envelope: %v", second)
	}
	if parsed["last_seen_msgId"] != "bbbbbbbb-0000-0000-0000-000000000002" {
		t.Fatalf("last_seen_msgId: %s", raw)
	}
	if seq, ok := parsed["last_seen_seq"].(float64); !ok || int64(seq) != 13 {
		t.Fatalf("last_seen_seq: %s", raw)
	}
	if parsed["reply_target"] != "channelId:thread-1" {
		t.Fatalf("reply_target: %s", raw)
	}
	if notices, ok := parsed["pending_notice_ids"].([]any); !ok || len(notices) != 0 {
		t.Fatalf("pending_notice_ids: %s", raw)
	}
	if parsed["wake_reason"] != nil {
		t.Fatalf("wake_reason: %s", raw)
	}
	if parsed["has_more"] != true {
		t.Fatalf("has_more: %s", raw)
	}
	if _, has := parsed["ack"]; has {
		t.Fatalf("drain must not carry an ack batch: %s", raw)
	}
}

func TestM5EventsClaimCarriesAckBatch(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = sampleBatch()
	code, parsed, raw := env.do(http.MethodGet, "/internal/agent-api/events/claim?since=latest", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("claim: %d %s", code, raw)
	}
	if env.events.claimCalls != 1 || env.events.drainCalls != 0 {
		t.Fatalf("claim must call ClaimEvents only")
	}
	ack, ok := parsed["ack"].(map[string]any)
	if !ok {
		t.Fatalf("ack batch missing: %s", raw)
	}
	if seqs, ok := ack["seqs"].([]any); !ok || len(seqs) != 2 || seqs[0].(float64) != 12 {
		t.Fatalf("ack seqs: %s", raw)
	}
	if ids, ok := ack["message_ids"].([]any); !ok || len(ids) != 0 {
		t.Fatalf("ack message_ids: %s", raw)
	}
	if tp, ok := ack["third_party_event_ids"].([]any); !ok || len(tp) != 0 {
		t.Fatalf("ack third_party_event_ids: %s", raw)
	}
}

func TestM5EventsQueryValidationAndPaging(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = sampleBatch()
	code, parsed, _ := env.do(http.MethodGet, "/internal/agent-api/events?since=abc", "", env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["code"] != "since_invalid" ||
		parsed["error"] != "since must be a non-negative integer (messageSeq) or 'latest'" {
		t.Fatalf("since invalid: %d %v", code, parsed)
	}
	code, _, _ = env.do(http.MethodGet, "/internal/agent-api/events?since=-1", "", env.apiKey, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("since negative: %d", code)
	}
	// numeric since is forwarded; empty batch echoes since as last_seen_seq
	env.events.batch = &agentapi.AgentEventBatch{}
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/events?since=9&limit=500", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("numeric since: %d", code)
	}
	if env.events.lastLimit != 200 {
		t.Fatalf("limit clamp: %d", env.events.lastLimit)
	}
	if seq, ok := parsed["last_seen_seq"].(float64); !ok || int64(seq) != 9 {
		t.Fatalf("empty batch last_seen_seq fallback: %v", parsed["last_seen_seq"])
	}
	if parsed["last_seen_msgId"] != nil || parsed["reply_target"] != nil {
		t.Fatalf("empty batch cursors must be null")
	}
}

func TestM5EventsAck(t *testing.T) {
	env := newM5Env(t)
	env.events.ackRemoved = 2
	code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/events/ack",
		`{"seqs":[12,13],"message_ids":[],"third_party_event_ids":[]}`, env.apiKey, nil)
	if code != http.StatusOK || parsed["ok"] != true || parsed["removed_count"].(float64) != 2 {
		t.Fatalf("ack: %d %s", code, raw)
	}
	if len(env.events.lastSeqs) != 2 || env.events.lastSeqs[0] != 12 {
		t.Fatalf("ack forwarded: %v", env.events.lastSeqs)
	}
	// repeat is idempotent on the wire (removed_count from the port; the
	// delivery store returns 0 for replays)
	env.events.ackRemoved = 0
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/events/ack",
		`{"seqs":[12,13],"message_ids":[],"third_party_event_ids":[]}`, env.apiKey, nil)
	if code != http.StatusOK || parsed["removed_count"].(float64) != 0 {
		t.Fatalf("ack replay: %v", parsed)
	}
	// schema violations
	for _, body := range []string{
		`{"seqs":[0]}`,
		`{"seqs":[-1]}`,
		`{"seqs":[1.5]}`,
		`{"message_ids":[""]}`,
	} {
		code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/events/ack", body, env.apiKey, nil)
		if code != http.StatusBadRequest || parsed["code"] != "agent_api_contract_invalid" {
			t.Fatalf("ack schema (%s): %d %v", body, code, parsed)
		}
	}
	// third-party ids are accepted and never fabricated into removals
	env.events.ackRemoved = 0
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/events/ack",
		`{"seqs":[],"message_ids":[],"third_party_event_ids":["tp-1"]}`, env.apiKey, nil)
	if code != http.StatusOK || parsed["removed_count"].(float64) != 0 {
		t.Fatalf("third-party ack: %v", parsed)
	}
	if len(env.events.lastMsgIDs) != 0 {
		t.Fatalf("third-party ids must not be forwarded as message ids")
	}
}

// ---- history -----------------------------------------------------------------

func TestM5HistoryWindow(t *testing.T) {
	env := newM5Env(t)
	lastRead := int64(11)
	env.history.facts = &presenter.AgentHistoryFacts{
		Messages: []presenter.AgentMessageFacts{{
			Seq: 12, MessageID: "aaaaaaaa-0000-0000-0000-000000000001", TimestampMS: 1_700_000_012_000,
			SenderType: "human", SenderName: "owner", ChannelID: "chan-1", ChannelName: "all",
			ChannelType: "channel", Content: "first",
		}},
		HasOlder: true, HasNewer: false, LastReadSeq: &lastRead,
	}
	code, parsed, raw := env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all&limit=10", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("history: %d %s", code, raw)
	}
	if env.history.lastQuery.ChannelRef != "#all" || env.history.lastQuery.Limit != 10 {
		t.Fatalf("query: %+v", env.history.lastQuery)
	}
	if parsed["has_more"] != true || parsed["has_older"] != true || parsed["has_newer"] != false {
		t.Fatalf("cursors: %s", raw)
	}
	if seq, ok := parsed["last_read_seq"].(float64); !ok || int64(seq) != 11 {
		t.Fatalf("last_read_seq: %s", raw)
	}
	rows := parsed["messages"].([]any)
	row := rows[0].(map[string]any)
	if row["senderName"] != "owner" || row["sender_name"] != "owner" || row["createdAt"] != "2023-11-14T22:13:32.000Z" {
		t.Fatalf("history envelope: %v", row)
	}
	if _, has := row["taskStatus"]; has {
		t.Fatalf("task fields must not be fabricated: %v", row)
	}
}

func TestM5HistoryValidationAndErrors(t *testing.T) {
	env := newM5Env(t)
	code, parsed, _ := env.do(http.MethodGet, "/internal/agent-api/history", "", env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["code"] != "agent_api_contract_invalid" {
		t.Fatalf("missing channel: %d %v", code, parsed)
	}
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all&before=zz", "", env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["errorCode"] != "INVALID_ARG" ||
		parsed["error"] != "Message anchor must be a seq, full UUID, or 8-character short id in #all: zz" {
		t.Fatalf("anchor invalid: %d %v", code, parsed)
	}
	env.history.err = &agentapi.HistoryAnchorError{Reason: agentapi.HistoryAnchorAmbiguous, ChannelRef: "#all", Anchor: "aaaaaaaa"}
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all&around=aaaaaaaa", "", env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["errorCode"] != "AMBIGUOUS_ID" ||
		parsed["suggestedNextAction"] != "Use the full message UUID instead of the 8-character short id." {
		t.Fatalf("anchor ambiguous: %d %v", code, parsed)
	}
	env.history.err = &agentapi.HistoryAnchorError{Reason: agentapi.HistoryAnchorNotFound, ChannelRef: "#all", Anchor: "9"}
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all&before=9", "", env.apiKey, nil)
	if code != http.StatusNotFound || parsed["errorCode"] != "NOT_FOUND" {
		t.Fatalf("anchor missing: %d %v", code, parsed)
	}
	env.history.err = agentapi.HistoryChannelHiddenError
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23ghost", "", env.apiKey, nil)
	if code != http.StatusNotFound || parsed["error"] != "Channel not found or not visible" {
		t.Fatalf("hidden channel: %d %v", code, parsed)
	}
	env.history.err = agentapi.HistoryForbiddenError
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all", "", env.apiKey, nil)
	if code != http.StatusForbidden || parsed["error"] != "You do not have access to this history" {
		t.Fatalf("forbidden history: %d %v", code, parsed)
	}
	env.history.err = &agentapi.HistoryNotFoundError{
		Message: "No thread on message abcd1234 in #all: the message is here, but it has no replies yet.",
		Code:    "NOT_FOUND",
	}
	code, parsed, _ = env.do(http.MethodGet, "/internal/agent-api/history?channel=%23all%3Aabcd1234", "", env.apiKey, nil)
	if code != http.StatusNotFound || parsed["errorCode"] != "NOT_FOUND" ||
		parsed["error"] != "No thread on message abcd1234 in #all: the message is here, but it has no replies yet." {
		t.Fatalf("thread no replies: %d %v", code, parsed)
	}
}

// ---- resolve-channel -----------------------------------------------------------

func TestM5ResolveChannel(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-9", Kind: "dm"}
	code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/resolve-channel", `{"target":"dm:@owner"}`, env.apiKey, nil)
	if code != http.StatusOK || parsed["channelId"] != "chan-9" {
		t.Fatalf("resolve: %d %s", code, raw)
	}
	if env.targets.lastTarget != "dm:@owner" {
		t.Fatalf("resolve target: %q", env.targets.lastTarget)
	}
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/resolve-channel", `{}`, env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["code"] != "agent_api_contract_invalid" {
		t.Fatalf("resolve missing target: %d %v", code, parsed)
	}
	env.targets.err = &agentapi.TargetForbiddenError{Message: "Agent cannot post in this channel - not a member."}
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/resolve-channel", `{"target":"#all"}`, env.apiKey, nil)
	if code != http.StatusForbidden || parsed["error"] != "Agent cannot post in this channel - not a member." {
		t.Fatalf("resolve forbidden: %d %v", code, parsed)
	}
}

// ---- fail-closed wiring ---------------------------------------------------------

func TestM5UnwiredFamiliesStayDeferred(t *testing.T) {
	env := newM5Env(t)
	// rebuild the mux with no M5 ports at all: neither the exact method
	// routes nor the 405 fallbacks exist, so the deferred family answer
	// (auth, then 501) is unchanged for every method.
	bare := http.NewServeMux()
	agentapi.RegisterRoutes(bare, &agentapi.Handlers{Store: env.store})
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		req := httptest.NewRequest(method, "/internal/agent-api/send", strings.NewReader(`{"target":"#all","content":"x"}`))
		req.Header.Set("Authorization", "Bearer "+env.apiKey)
		rec := httptest.NewRecorder()
		bare.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotImplemented {
			t.Fatalf("unwired %s /send must stay 501, got %d %s", method, rec.Code, rec.Body.String())
		}
	}
	// unknown family is unregistered even with a valid key
	code, _, _ := env.do(http.MethodGet, "/internal/agent-api/not-a-family", "", env.apiKey, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unknown family must be 401, got %d", code)
	}
	// a valid key on a deferred family (tasks) is the honest 501
	code, _, _ = env.do(http.MethodGet, "/internal/agent-api/tasks", "", env.apiKey, nil)
	if code != http.StatusNotImplemented {
		t.Fatalf("deferred family must be 501, got %d", code)
	}
}

// TestM5WrongMethodOnImplementedRoutes: a wired route answers every other
// method with 405 + Allow — behind the same proof and capability gates, so
// 401/403/501-capability still win over the 405.
func TestM5WrongMethodOnImplementedRoutes(t *testing.T) {
	env := newM5Env(t)
	for _, tc := range []struct {
		method, path, allow string
	}{
		{http.MethodGet, "/internal/agent-api/send", "POST"},
		{http.MethodPut, "/internal/agent-api/send", "POST"},
		{http.MethodGet, "/internal/agent-api/v2/send", "POST"},
		{http.MethodGet, "/internal/agent-api/resolve-channel", "POST"},
		{http.MethodPost, "/internal/agent-api/events", "GET"},
		{http.MethodDelete, "/internal/agent-api/events/claim", "GET"},
		{http.MethodGet, "/internal/agent-api/events/ack", "POST"},
		{http.MethodPatch, "/internal/agent-api/history", "GET"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("Authorization", "Bearer "+env.apiKey)
		rec := httptest.NewRecorder()
		env.mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: expected 405, got %d %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s %s: Allow=%q want %q", tc.method, tc.path, rec.Header().Get("Allow"), tc.allow)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["code"] != "method_not_allowed" || body["allow"] != tc.allow {
			t.Fatalf("%s %s body: %s", tc.method, tc.path, rec.Body.String())
		}
	}
	// gates win over 405: read-only key on a send path -> 403 capability
	req := httptest.NewRequest(http.MethodPut, "/internal/agent-api/send", nil)
	req.Header.Set("Authorization", "Bearer "+env.readKey)
	rec := httptest.NewRecorder()
	env.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("capability gate must precede 405, got %d %s", rec.Code, rec.Body.String())
	}
	// no credential at all -> 401
	req = httptest.NewRequest(http.MethodPut, "/internal/agent-api/send", nil)
	rec = httptest.NewRecorder()
	env.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("proof must precede 405, got %d", rec.Code)
	}
	// active-capabilities header still applies to the fallback
	code, body, _ := env.do(http.MethodPut, "/internal/agent-api/send", "", env.apiKey,
		map[string]string{"X-Slock-Agent-Active-Capabilities": "read"})
	if code != http.StatusNotImplemented || body["code"] != "unsupported_capability" {
		t.Fatalf("active-capability gate must precede 405: %d %v", code, body)
	}
}

func TestM5ConstructorValidation(t *testing.T) {
	if _, err := agentapi.NewHandlers(nil, agentapi.Dependencies{}); err == nil {
		t.Fatal("nil store must be rejected")
	}
	env := newM5Env(t)
	if _, err := agentapi.NewHandlers(env.store, agentapi.Dependencies{Send: &fakeSend{}}); err == nil {
		t.Fatal("send without targets must be rejected")
	}
	if _, err := agentapi.NewHandlers(env.store, agentapi.Dependencies{Events: &fakeEvents{}}); err != nil {
		t.Fatalf("events-only wiring must be allowed: %v", err)
	}
}

func TestM5EventsLimitZeroFallsBackToDefault(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = sampleBatch()
	// Number("0") || 50: zero is falsy in the original, so the default batch
	// applies rather than a 1-item clamp.
	code, _, _ := env.do(http.MethodGet, "/internal/agent-api/events?since=latest&limit=0", "", env.apiKey, nil)
	if code != http.StatusOK || env.events.lastLimit != 50 {
		t.Fatalf("limit=0 must behave like absent: %d limit=%d", code, env.events.lastLimit)
	}
	code, _, _ = env.do(http.MethodGet, "/internal/agent-api/events?since=latest&limit=abc", "", env.apiKey, nil)
	if code != http.StatusOK || env.events.lastLimit != 50 {
		t.Fatalf("limit=abc must behave like absent: %d limit=%d", code, env.events.lastLimit)
	}
}

func TestM5EventsNilBatchIsAnEmptyEnvelope(t *testing.T) {
	env := newM5Env(t)
	env.events.batch = nil
	code, parsed, raw := env.do(http.MethodGet, "/internal/agent-api/events?since=latest", "", env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("nil batch: %d %s", code, raw)
	}
	if events, ok := parsed["events"].([]any); !ok || len(events) != 0 {
		t.Fatalf("nil batch must render []: %s", raw)
	}
	if parsed["last_seen_msgId"] != nil || parsed["last_seen_seq"] != nil || parsed["reply_target"] != nil {
		t.Fatalf("nil batch cursors: %s", raw)
	}
}

// TestM5SendDraftActionRefused: stateful saved-draft actions get the honest
// 501 (no draft store / freshness gate exists here) and NEVER reach the send
// port as ordinary content; the legacy 400 precedence still wins first.
func TestM5SendDraftActionRefused(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-d", 1)}

	// legacy precedence: continue wins over the draft refusal
	code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","continue":true,"sendDraft":true}`, env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["error"] != "--continue is no longer supported. Use normal message send to update a draft, or --send-draft to send the current saved draft." {
		t.Fatalf("continue precedence: %d %v", code, parsed)
	}
	// legacy precedence: --anyway without --send-draft
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","continueAnyway":true}`, env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["error"] != "--send-draft --anyway requires a saved draft" {
		t.Fatalf("anyway precedence: %d %v", code, parsed)
	}
	// the draft action itself: honest 501, both alone and with --anyway
	for _, body := range []string{
		`{"target":"#all","content":"x","sendDraft":true}`,
		`{"target":"#all","content":"x","sendDraft":true,"continueAnyway":true}`,
	} {
		code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
		if code != http.StatusNotImplemented || parsed["code"] != "feature_not_implemented" ||
			parsed["error"] != "Saved drafts are not enabled in this server stage" {
			t.Fatalf("draft action: %d %v", code, parsed)
		}
	}
	if env.send.calls != 0 {
		t.Fatalf("draft actions must never reach the send port: %d calls", env.send.calls)
	}
	// harmless always-present metadata still commits normally
	code, _, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","draftReholdCount":0,"draftReplacedExisting":false,"seenUpToSeq":5}`, env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("metadata-only body must send: %d %s", code, raw)
	}
}

// TestM5AttachmentShapeNeverDisappears: any REQUESTED attachment array either
// reaches the honest 501 or is rejected as malformed — it can never be
// silently dropped and the message committed.
func TestM5AttachmentShapeNeverDisappears(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-a", 1)}
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"target":"#all","content":"x","attachmentIds":["a-1"]}`, 501},
		{`{"target":"#all","content":"x","attachmentIds":["a-1","b-2"]}`, 501},
		{`{"target":"#all","content":"x","attachmentIds":[1,"a"]}`, 400},   // mixed: was silently ignored before
		{`{"target":"#all","content":"x","attachmentIds":[17]}`, 400},      // non-string element
		{`{"target":"#all","content":"x","attachmentIds":[""]}`, 400},      // empty id
		{`{"target":"#all","content":"x","attachmentIds":"a-1"}`, 400},     // not an array
		{`{"target":"#all","content":"x","attachmentIds":{"0":"a"}}`, 400}, // object, not array
	} {
		before := env.send.calls
		code, parsed, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", tc.body, env.apiKey, nil)
		if code != tc.code {
			t.Fatalf("body %s: expected %d, got %d %s", tc.body, tc.code, code, raw)
		}
		if env.send.calls != before {
			t.Fatalf("body %s: send port must not be called", tc.body)
		}
		if tc.code == 400 && parsed["code"] != "agent_api_contract_invalid" {
			t.Fatalf("malformed shape body: %s", raw)
		}
		if tc.code == 501 && parsed["error"] != "Attachments are not enabled in this server stage" {
			t.Fatalf("unsupported body: %s", raw)
		}
	}
	// empty array stays the honest "no attachments requested"
	code, _, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","attachmentIds":[]}`, env.apiKey, nil)
	if code != http.StatusOK || env.send.calls != 1 {
		t.Fatalf("empty attachmentIds: %d calls=%d", code, env.send.calls)
	}
}

// TestM5IdempotencyKeyBounds: 1..256 UTF-16 units enforced at the boundary so
// the caller's dedupe identity is never silently lost or truncated.
func TestM5IdempotencyKeyBounds(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-k", 1)}
	// 256 units commit with the key verbatim
	key := strings.Repeat("k", 256)
	body := `{"target":"#all","content":"x","idempotencyKey":"` + key + `"}`
	code, _, raw := env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusOK || env.send.lastIn.IdempotencyKey != key {
		t.Fatalf("256-unit key: %d %s", code, raw)
	}
	// 257 units -> contract 400, no commit
	body = `{"target":"#all","content":"x","idempotencyKey":"` + key + `x"}`
	before := env.send.calls
	code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["code"] != "agent_api_contract_invalid" {
		t.Fatalf("257-unit key: %d %v", code, parsed)
	}
	if env.send.calls != before {
		t.Fatal("over-long key must not reach the send port")
	}
	// non-string would silently drop the dedupe identity -> contract 400
	code, parsed, _ = env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","idempotencyKey":42}`, env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["code"] != "agent_api_contract_invalid" {
		t.Fatalf("non-string key: %d %v", code, parsed)
	}
	// UTF-16 counting: 128 astral pairs = 256 units commit
	astral := strings.Repeat("😀", 128)
	body = `{"target":"#all","content":"x","idempotencyKey":"` + astral + `"}`
	code, _, _ = env.do(http.MethodPost, "/internal/agent-api/v2/send", body, env.apiKey, nil)
	if code != http.StatusOK || env.send.lastIn.IdempotencyKey != astral {
		t.Fatalf("256-unit astral key: %d", code)
	}
	// empty/absent stay absent (the TS length>0 rule)
	code, _, _ = env.do(http.MethodPost, "/internal/agent-api/v2/send",
		`{"target":"#all","content":"x","idempotencyKey":""}`, env.apiKey, nil)
	if code != http.StatusOK || env.send.lastIn.IdempotencyKey != "" {
		t.Fatalf("empty key must be treated as absent: %q", env.send.lastIn.IdempotencyKey)
	}
}

// TestM5MentionNameUTF16Bound: mention names are bounded by JavaScript
// string length (128 UTF-16 units), not by rune count, matching the shared
// schema and the message domain.
func TestM5MentionNameUTF16Bound(t *testing.T) {
	env := newM5Env(t)
	env.targets.resolution = &agentapi.WritableTargetResolution{ChannelID: "chan-1", Kind: "channel"}
	env.send.result = &message.CreateResult{Message: msg("m-n", 1)}
	withName := func(name string) string {
		return `{"target":"#all","content":"x","mentions":[{"type":"user","id":"11111111-1111-1111-1111-111111111111","name":"` + name + `"}]}`
	}
	// 64 astral characters = 128 UTF-16 units: legal
	legal := strings.Repeat("😀", 64)
	code, _, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send", withName(legal), env.apiKey, nil)
	if code != http.StatusOK {
		t.Fatalf("128-unit mention name must pass: %d", code)
	}
	// 65 astral characters = 130 units: rejected before the port
	tooLong := strings.Repeat("😀", 65)
	before := env.send.calls
	code, parsed, _ := env.do(http.MethodPost, "/internal/agent-api/v2/send", withName(tooLong), env.apiKey, nil)
	if code != http.StatusBadRequest || parsed["error"] != "Invalid mentions payload" {
		t.Fatalf("130-unit mention name: %d %v", code, parsed)
	}
	if env.send.calls != before {
		t.Fatal("over-long mention must not reach the send port")
	}
}
