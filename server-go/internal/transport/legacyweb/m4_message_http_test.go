// HTTP tests for the M4 message surface. Requests run through the real auth
// chain (accounts registered/verified/completed on the app handler) against a
// mux mounting only this worker's routes — the same registration the parent
// integrates — using an in-process recorder, so the suite runs in sandboxes
// that forbid local binds.
package legacyweb_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/transport/legacyweb"
)

type m4MsgEnv struct {
	t        *testing.T
	env      *testEnv
	handlers *legacyweb.M4MessageHandlers
	mux      *http.ServeMux
	wsID     string
	ownerID  string
	ownerTok string
	memberID string
	memberTk string
	chanID   string
	rateNow  *time.Time
}

func newM4MsgEnv(t *testing.T) *m4MsgEnv {
	t.Helper()
	env := newTestEnv(t)
	store := message.NewStore(env.app.DB, channel.NewStore(env.app.DB))
	handlers := legacyweb.NewMessageHandlers(store, &legacyweb.ChannelHandlers{Store: store.Channels()})
	m := &m4MsgEnv{t: t, env: env, handlers: handlers}
	// Controllable rate clock: starts at a fixed instant tests can advance.
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	m.rateNow = &base
	handlers.SetMessageRateClock(func() time.Time { return *m.rateNow })
	m.mux = http.NewServeMux()
	legacyweb.RegisterMessageRoutes(m.mux, handlers, m.gate())

	// Two fully-verified humans in one workspace.
	m.ownerID, m.ownerTok, _ = env.fullAccount("mowner@m4.test", "m4mowner")
	m.memberID, m.memberTk, _ = env.fullAccount("mmember@m4.test", "m4mmember")
	m.wsID = "wsm4m-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if err := env.insertWorkspace(m.wsID, "M4 Msg Space", "m4-msg-space", m.ownerID); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct{ id, role string }{{m.ownerID, "owner"}, {m.memberID, "member"}} {
		if err := env.insertMembership(map[string]any{
			"workspace_id": m.wsID, "user_id": member.id, "role": member.role,
			"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	m.chanID = "5a5a5a5a-0000-4000-8000-000000000001"
	m.seedChannel(m.chanID, "general", "channel")
	m.joinChannel(m.chanID, m.ownerID, m.memberID)
	return m
}

func (m *m4MsgEnv) gate() *legacyweb.AuthGate {
	m.t.Helper()
	cfg := m.env.app.Config
	store := auth.NewStore(m.env.app.DB)
	signer := auth.NewTokenSigner(cfg.JWTSecret, cfg.AccessTokenTTL)
	root := keys.NewRoot(cfg.JWTSecret)
	receiptKey, err := root.RefreshReceiptKey()
	if err != nil {
		m.t.Fatal(err)
	}
	sessions := auth.NewSessionService(m.env.app.DB, store, signer, receiptKey,
		cfg.RefreshTokenTTL, cfg.RefreshReplayGrace, cfg.DurableReplayTTL)
	return &legacyweb.AuthGate{Signer: signer, Sessions: sessions, Users: legacyweb.UserLookup(store.UserByID)}
}

func (m *m4MsgEnv) seedChannel(id, name, channelType string) {
	m.t.Helper()
	if _, err := m.env.app.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?,?,?,?,?)`, id, m.wsID, name, channelType, time.Now().UnixMilli()); err != nil {
		m.t.Fatal(err)
	}
}

func (m *m4MsgEnv) joinChannel(id string, users ...string) {
	m.t.Helper()
	for _, u := range users {
		if _, err := m.env.app.DB.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES (?,?,'member',?)`, id, u, time.Now().UnixMilli()); err != nil {
			m.t.Fatal(err)
		}
	}
}

func (m *m4MsgEnv) serve(method, path string, body any, bearer string) response {
	m.t.Helper()
	var reader *strings.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			m.t.Fatal(err)
		}
		reader = strings.NewReader(string(buf))
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		m.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("X-Server-Id", m.wsID)
	rec := httptest.NewRecorder()
	m.mux.ServeHTTP(rec, req)
	return parseResponse(rec)
}

// send posts a v2 message as the owner.
func (m *m4MsgEnv) send(content string, extra map[string]any) response {
	m.t.Helper()
	body := map[string]any{"channelId": m.chanID, "content": content}
	for k, v := range extra {
		body[k] = v
	}
	return m.serve("POST", "/api/v2/messages", body, m.ownerTok)
}

func TestM4MessageSendV2EnvelopeAndExactDTOShape(t *testing.T) {
	m := newM4MsgEnv(t)
	res := m.send("hello world", map[string]any{"randomId": "rid-abc"})
	if res.status != http.StatusOK {
		t.Fatalf("send: %d %s", res.status, res.raw)
	}
	msg, ok := res.body["message"].(map[string]any)
	if !ok {
		t.Fatalf("v2 envelope must carry message: %s", res.raw)
	}
	if _, has := res.body["pendingMentionActions"]; has {
		t.Fatal("human-only sends never carry pendingMentionActions")
	}
	// Exact key set of the send-surface message, frozen from the TS pipeline
	// ({...row, senderName, senderMembershipStatus, attachments, mentions}).
	wantKeys := []string{
		"id", "seq", "channelId", "senderType", "senderId", "agentSendKey",
		"randomId", "messageType", "content", "actionMetadata", "searchText",
		"threadId", "taskStatus", "taskNumber", "taskAssigneeType",
		"taskAssigneeId", "taskClaimedAt", "taskCompletedAt", "createdAt",
		"updatedAt", "senderName", "senderMembershipStatus", "attachments", "mentions",
	}
	assertExactKeys(t, msg, wantKeys, "send message DTO")
	if msg["randomId"] != "rid-abc" || msg["senderType"] != "user" || msg["senderId"] != m.ownerID {
		t.Fatalf("identity/idempotency fields: %+v", msg)
	}
	if msg["senderName"] != "Display m4mowner" || msg["senderMembershipStatus"] != "active" {
		t.Fatalf("sender projection: %v %v", msg["senderName"], msg["senderMembershipStatus"])
	}
	if _, ok := msg["reactions"]; ok {
		t.Fatal("send response must not carry reactions (absent = preserve)")
	}
	if createdAt, ok := msg["createdAt"].(string); !ok || !strings.HasSuffix(createdAt, "Z") || !strings.Contains(createdAt, "T") {
		t.Fatalf("createdAt must be the legacy ISO-millis shape: %v", msg["createdAt"])
	}
	if seq, ok := msg["seq"].(float64); !ok || seq <= 0 {
		t.Fatalf("seq must be a positive number: %v", msg["seq"])
	}
}

func assertExactKeys(t *testing.T, obj map[string]any, want []string, what string) {
	t.Helper()
	have := map[string]bool{}
	for k := range obj {
		have[k] = true
	}
	missing := []string{}
	for _, k := range want {
		if !have[k] {
			missing = append(missing, k)
		}
		delete(have, k)
	}
	extra := []string{}
	for k := range have {
		extra = append(extra, k)
	}
	if len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("%s key mismatch: missing=%v extra=%v", what, missing, extra)
	}
}

func TestM4MessageSendV1BareMessage(t *testing.T) {
	m := newM4MsgEnv(t)
	res := m.serve("POST", "/api/messages", map[string]any{
		"channelId": m.chanID, "content": "v1 hello",
	}, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("v1 send: %d %s", res.status, res.raw)
	}
	if _, has := res.body["message"]; has {
		t.Fatalf("v1 send renders the bare message: %s", res.raw)
	}
	if res.body["content"] != "v1 hello" {
		t.Fatalf("v1 body: %s", res.raw)
	}
}

func TestM4MessageSendValidationAndUnsupportedEffects(t *testing.T) {
	m := newM4MsgEnv(t)
	cases := []struct {
		name   string
		body   map[string]any
		status int
		error_ string
	}{
		{"bad-channel-id", map[string]any{"channelId": "nope", "content": "x"}, 400, "Invalid message request body"},
		{"missing-channel", map[string]any{"content": "x"}, 400, "Invalid message request body"},
		{"content-required", map[string]any{"channelId": m.chanID, "content": ""}, 400, "Channel ID and content are required"},
		{"content-whitespace", map[string]any{"channelId": m.chanID, "content": "  \n "}, 400, "Message content cannot be empty"},
		{"content-number", map[string]any{"channelId": m.chanID, "content": 42}, 400, "Message content cannot be empty"},
		{"random-id-empty", map[string]any{"channelId": m.chanID, "content": "x", "randomId": ""}, 400, "randomId must be a non-empty string with at most 128 characters"},
		{"mentions-not-array", map[string]any{"channelId": m.chanID, "content": "x", "mentions": "bob"}, 400, "Invalid mentions payload"},
		{"mentions-bad-type", map[string]any{"channelId": m.chanID, "content": "x", "mentions": []map[string]any{{"type": "computer", "id": m.memberID, "name": "x"}}}, 400, "Invalid mentions payload"},
		{"as-task", map[string]any{"channelId": m.chanID, "content": "x", "asTask": true}, 501, "Tasks are not enabled in this server stage"},
		{"attachments", map[string]any{"channelId": m.chanID, "content": "x", "attachmentIds": []string{"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}}, 501, "Attachments are not enabled in this server stage"},
		{"agent-mention", map[string]any{"channelId": m.chanID, "content": "x", "mentions": []map[string]any{{"type": "agent", "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "name": "bot"}}}, 501, "Agent mentions are not enabled in this server stage"},
	}
	for _, tc := range cases {
		res := m.serve("POST", "/api/v2/messages", tc.body, m.ownerTok)
		if res.status != tc.status {
			t.Fatalf("%s: status %d want %d (%s)", tc.name, res.status, tc.status, res.raw)
		}
		if res.body["error"] != tc.error_ {
			t.Fatalf("%s: error %q want %q", tc.name, res.body["error"], tc.error_)
		}
		if tc.status == 501 && res.body["code"] != "feature_not_implemented" {
			t.Fatalf("%s: 501 must carry feature_not_implemented: %s", tc.name, res.raw)
		}
	}
	var count int
	_ = m.env.app.DB.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count)
	if count != 0 {
		t.Fatalf("rejected sends must not persist: %d", count)
	}
}

func TestM4MessageSendAuthorization(t *testing.T) {
	m := newM4MsgEnv(t)
	// No token.
	res := m.serve("POST", "/api/v2/messages", map[string]any{"channelId": m.chanID, "content": "x"}, "")
	if res.status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: %d", res.status)
	}
	// Member of another workspace (a third account).
	_, strangerTok, _ := m.env.fullAccount("stranger@m4.test", "m4stranger")
	res = m.serve("POST", "/api/v2/messages", map[string]any{"channelId": m.chanID, "content": "x"}, strangerTok)
	if res.status != http.StatusForbidden || res.body["error"] != "Not a member of this server" {
		t.Fatalf("stranger workspace: %d %s", res.status, res.raw)
	}
	// Existing channel in a foreign workspace is a plain 404.
	foreign := "wsm4f-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if err := m.env.insertWorkspace(foreign, "Foreign", "foreign", m.ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.env.app.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES ('6b6b6b6b-0000-4000-8000-000000000001', ?, 'foreign', 'channel', ?)`, foreign, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	res = m.serve("POST", "/api/v2/messages", map[string]any{"channelId": "6b6b6b6b-0000-4000-8000-000000000001", "content": "x"}, m.ownerTok)
	if res.status != http.StatusNotFound || res.body["error"] != "Channel not found" {
		t.Fatalf("foreign channel: %d %s", res.status, res.raw)
	}
	// A workspace member without a roster row must join first.
	strangerWS := "wsm4s-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if err := m.env.insertWorkspace(strangerWS, "Second", "second", m.ownerID); err != nil {
		t.Fatal(err)
	}
	if err := m.env.insertMembership(map[string]any{
		"workspace_id": strangerWS, "user_id": m.memberID, "role": "member",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.env.app.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES ('7c7c7c7c-0000-4000-8000-000000000001', ?, 'second-chan', 'channel', ?)`, strangerWS, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	req := m.serve("POST", "/api/v2/messages", map[string]any{"channelId": "7c7c7c7c-0000-4000-8000-000000000001", "content": "x"}, m.memberTk)
	_ = req
	res = m.serveWithServer("POST", "/api/v2/messages", map[string]any{"channelId": "7c7c7c7c-0000-4000-8000-000000000001", "content": "x"}, m.memberTk, strangerWS)
	if res.status != http.StatusForbidden || res.body["error"] != "You must join this channel to send messages" {
		t.Fatalf("join required: %d %s", res.status, res.raw)
	}
}

func (m *m4MsgEnv) serveWithServer(method, path string, body any, bearer, serverID string) response {
	m.t.Helper()
	var reader *strings.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		reader = strings.NewReader(string(buf))
	} else {
		reader = strings.NewReader("")
	}
	req, _ := http.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("X-Server-Id", serverID)
	rec := httptest.NewRecorder()
	m.mux.ServeHTTP(rec, req)
	return parseResponse(rec)
}

func TestM4MessageRandomIdReplayOverHTTP(t *testing.T) {
	m := newM4MsgEnv(t)
	first := m.send("original", map[string]any{"randomId": "rid-replay"})
	if first.status != http.StatusOK {
		t.Fatalf("first: %d %s", first.status, first.raw)
	}
	second := m.send("original", map[string]any{"randomId": "rid-replay"})
	if second.status != http.StatusOK {
		t.Fatalf("replay: %d %s", second.status, second.raw)
	}
	if first.body["message"].(map[string]any)["id"] != second.body["message"].(map[string]any)["id"] {
		t.Fatalf("replay diverged: %s vs %s", first.raw, second.raw)
	}
	conflict := m.send("changed", map[string]any{"randomId": "rid-replay"})
	if conflict.status != http.StatusConflict || conflict.body["code"] != "random_id_conflict" ||
		conflict.body["error"] != "randomId has already been used for a different message" {
		t.Fatalf("conflict: %d %s", conflict.status, conflict.raw)
	}
	var count int
	_ = m.env.app.DB.QueryRow(`SELECT COUNT(*) FROM messages WHERE random_id = 'rid-replay'`).Scan(&count)
	if count != 1 {
		t.Fatalf("one row expected: %d", count)
	}
}

func TestM4MessageHistoryPageShapeAndOverlay(t *testing.T) {
	m := newM4MsgEnv(t)
	// Owner + member interleave 5 messages.
	senders := []string{m.ownerTok, m.memberTk}
	var lastSeq float64
	for i := 0; i < 5; i++ {
		res := m.serve("POST", "/api/v2/messages", map[string]any{
			"channelId": m.chanID, "content": fmt.Sprintf("msg-%d", i),
		}, senders[i%2])
		if res.status != http.StatusOK {
			t.Fatalf("send %d: %d %s", i, res.status, res.raw)
		}
		lastSeq = res.body["message"].(map[string]any)["seq"].(float64)
	}

	res := m.serve("GET", "/api/messages/channel/"+m.chanID, nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("history: %d %s", res.status, res.raw)
	}
	assertExactKeys(t, res.body, []string{
		"messages", "threadSummariesByParentMessageId", "historyLimited", "messageWindow",
	}, "MessagePage")
	window, ok := res.body["messageWindow"].(map[string]any)
	if !ok {
		t.Fatalf("messageWindow missing: %s", res.raw)
	}
	assertExactKeys(t, window, []string{
		"schemaVersion", "domain", "serverId", "receiverKind", "receiverId", "scopeId",
		"coveredAfterSeq", "coveredFromSeq", "coveredThroughSeq", "remoteHighWaterSeq",
		"hasGap", "hasNewer", "completeThroughLatest",
	}, "messageWindow")
	if window["domain"] != "receiver_visible_messages_v1" || window["receiverKind"] != "user" ||
		window["receiverId"] != m.ownerID || window["scopeId"] != m.chanID || window["schemaVersion"] != float64(1) {
		t.Fatalf("window coordinates: %+v", window)
	}
	if window["completeThroughLatest"] != true || window["hasGap"] != false {
		t.Fatalf("latest tail flags: %+v", window)
	}
	if window["remoteHighWaterSeq"] != lastSeq {
		t.Fatalf("high water: %v want %v", window["remoteHighWaterSeq"], lastSeq)
	}
	messages := res.body["messages"].([]any)
	if len(messages) != 5 {
		t.Fatalf("messages: %d", len(messages))
	}
	first := messages[0].(map[string]any)
	// History DTO carries the full enrichment set.
	assertExactKeys(t, first, []string{
		"id", "seq", "channelId", "senderType", "senderId", "agentSendKey",
		"randomId", "messageType", "content", "actionMetadata", "searchText",
		"threadId", "taskStatus", "taskNumber", "taskAssigneeType",
		"taskAssigneeId", "taskClaimedAt", "taskCompletedAt", "createdAt",
		"updatedAt", "commentRef", "senderName", "senderHandle", "senderDescription",
		"senderMembershipStatus", "reactions", "mentions", "attachments",
	}, "history message DTO")
	// Ascending order.
	if messages[0].(map[string]any)["seq"].(float64) >= messages[4].(map[string]any)["seq"].(float64) {
		t.Fatal("history must render ascending seq")
	}

	// The overlay refresh pattern: after={fromSeq-1}&limit=50.
	res = m.serve("GET", fmt.Sprintf("/api/messages/channel/%s?after=%d&limit=50", m.chanID, int(lastSeq-1)), nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("overlay: %d %s", res.status, res.raw)
	}
	if got := len(res.body["messages"].([]any)); got != 1 {
		t.Fatalf("overlay page: %d messages", got)
	}

	// before/after mutual exclusion and bad cursors.
	res = m.serve("GET", fmt.Sprintf("/api/messages/channel/%s?before=3&after=1", m.chanID), nil, m.ownerTok)
	if res.status != http.StatusBadRequest || res.body["code"] != "invalid_message_page_cursor" {
		t.Fatalf("mutually exclusive cursors: %d %s", res.status, res.raw)
	}
	res = m.serve("GET", "/api/messages/channel/"+m.chanID+"?before=-1", nil, m.ownerTok)
	if res.status != http.StatusBadRequest || res.body["code"] != "invalid_message_page_cursor" {
		t.Fatalf("negative cursor: %d %s", res.status, res.raw)
	}
	res = m.serve("GET", "/api/messages/channel/"+m.chanID+"?before=abc", nil, m.ownerTok)
	if res.status != http.StatusBadRequest {
		t.Fatalf("garbage cursor: %d", res.status)
	}
}

func TestM4MessageContextAndSync(t *testing.T) {
	m := newM4MsgEnv(t)
	var ids []string
	for i := 0; i < 35; i++ {
		res := m.send(fmt.Sprintf("ctx-%d", i), nil)
		if res.status != http.StatusOK {
			t.Fatalf("send: %d", res.status)
		}
		ids = append(ids, res.body["message"].(map[string]any)["id"].(string))
	}
	// Index 17 leaves 17 before and 17 after: both window flags true.
	res := m.serve("GET", "/api/messages/context/"+ids[17]+"?channelId="+m.chanID, nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("context: %d %s", res.status, res.raw)
	}
	assertExactKeys(t, res.body, []string{
		"channelId", "targetMessageId", "hasOlder", "hasNewer", "messages",
		"threadSummariesByParentMessageId", "historyLimited", "channelArchived",
	}, "context response")
	if res.body["targetMessageId"] != ids[17] || res.body["hasOlder"] != true || res.body["hasNewer"] != true {
		t.Fatalf("context facts: %s", res.raw)
	}

	// Sync renders the bare array.
	res = m.serve("GET", "/api/messages/sync?since_seq=0&channel_id="+m.chanID, nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("sync: %d %s", res.status, res.raw)
	}
	rawArr := strings.TrimSpace(string(res.raw))
	if !strings.HasPrefix(rawArr, "[") {
		t.Fatalf("sync must render a bare array: %s", res.raw)
	}

	// A non-member of the workspace is refused by the scope middleware.
	_, strangerTok, _ := m.env.fullAccount("syncstranger@m4.test", "m4syncstr")
	res = m.serve("GET", "/api/messages/channel/"+m.chanID, nil, strangerTok)
	if res.status != http.StatusForbidden || res.body["error"] != "Not a member of this server" {
		t.Fatalf("workspace stranger: %d %s", res.status, res.raw)
	}
	// A workspace member with no prior relationship to a PRIVATE channel is
	// denied with the byte-identical 404 CHANNEL_NOT_FOUND_BODY.
	caraID, caraTok, _ := m.env.fullAccount("cara@m4.test", "m4cara")
	if err := m.env.insertMembership(map[string]any{
		"workspace_id": m.wsID, "user_id": caraID, "role": "member",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	private := "8d8d8d8d-0000-4000-8000-000000000001"
	m.seedChannel(private, "secret", "private")
	m.joinChannel(private, m.ownerID)
	if res := m.serve("POST", "/api/v2/messages", map[string]any{"channelId": private, "content": "hidden"}, m.ownerTok); res.status != http.StatusOK {
		t.Fatalf("private seed: %d %s", res.status, res.raw)
	}
	res = m.serve("GET", "/api/messages/channel/"+private, nil, caraTok)
	if res.status != http.StatusNotFound || res.body["error"] != "Channel not found or not visible" {
		t.Fatalf("no-relationship member history: %d %s", res.status, res.raw)
	}
	// Prior-relationship witnesses today are live rows (roster/follow/DM
	// pair); a hard-removed roster row leaves no witness, so the answer
	// stays the stranger-indistinguishable 404 (readstate adds the residue
	// witnesses later). A guest with a roster row keeps the honest 403:
	// the row is the prior relationship, the frozen guest gate denies read.
	m.joinChannel(private, caraID)
	if _, err := m.env.app.DB.Exec(`UPDATE workspace_memberships SET role = 'guest' WHERE workspace_id = ? AND user_id = ?`, m.wsID, caraID); err != nil {
		t.Fatal(err)
	}
	res = m.serve("GET", "/api/messages/channel/"+private, nil, caraTok)
	if res.status != http.StatusForbidden || res.body["error"] != "You do not have access to this channel" {
		t.Fatalf("guest-with-roster history: %d %s", res.status, res.raw)
	}
	// Hard removal of the roster row leaves no witness: 404, byte-identical.
	if _, err := m.env.app.DB.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, private, caraID); err != nil {
		t.Fatal(err)
	}
	res = m.serve("GET", "/api/messages/channel/"+private, nil, caraTok)
	if res.status != http.StatusNotFound || res.body["error"] != "Channel not found or not visible" {
		t.Fatalf("witnessless ex-member: %d %s", res.status, res.raw)
	}
}

func TestM4MessageThreadSummaryInPage(t *testing.T) {
	m := newM4MsgEnv(t)
	parent := m.send("thread root", nil)
	if parent.status != http.StatusOK {
		t.Fatalf("parent: %d %s", parent.status, parent.raw)
	}
	parentID := parent.body["message"].(map[string]any)["id"].(string)
	// Ensure the thread channel + first reply through the conversation
	// worker's route shape (direct store use keeps this suite independent of
	// that worker's HTTP file).
	thread := m.ensureThread(m.chanID, parentID, m.ownerID)
	reply := m.serve("POST", "/api/v2/messages", map[string]any{
		"channelId": thread, "content": "first reply",
	}, m.ownerTok)
	if reply.status != http.StatusOK {
		t.Fatalf("reply: %d %s", reply.status, reply.raw)
	}
	page := m.serve("GET", "/api/messages/channel/"+m.chanID, nil, m.ownerTok)
	if page.status != http.StatusOK {
		t.Fatalf("page: %d", page.status)
	}
	summaries := page.body["threadSummariesByParentMessageId"].(map[string]any)
	summary, ok := summaries[parentID].(map[string]any)
	if !ok {
		t.Fatalf("summary missing: %s", page.raw)
	}
	assertExactKeys(t, summary, []string{
		"threadChannelId", "replyCount", "lastReplyAt", "participantIds",
		"unreadCount", "firstUnreadMessageId", "latestReplies",
	}, "ThreadSummary")
	if summary["replyCount"] != float64(1) || summary["threadChannelId"] != thread {
		t.Fatalf("summary facts: %+v", summary)
	}
	latest := summary["latestReplies"].([]any)
	if len(latest) != 1 {
		t.Fatalf("latestReplies: %s", page.raw)
	}
	assertExactKeys(t, latest[0].(map[string]any), []string{
		"messageId", "seq", "preview", "senderId", "senderType",
		"senderName", "senderDisplayName", "senderAvatarUrl", "createdAt",
	}, "ThreadSummaryLatestReply")
}

// ensureThread creates the thread channel through the channel worker's
// locked API on the shared database (initial content is exercised by that
// worker's own suite; here the reply is posted through this surface).
func (m *m4MsgEnv) ensureThread(channelID, parentMessageID, userID string) string {
	m.t.Helper()
	var threadID string
	err := platformdb.WithWriteTx(m.env.t.Context(), m.env.app.DB, func(tx *sql.Tx) error {
		thread, err := m.handlers.Store.Channels().EnsureThreadTx(m.env.t.Context(), tx, m.wsID, channelID, parentMessageID, userID)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	})
	if err != nil {
		m.t.Fatal(err)
	}
	return threadID
}

func TestM4ReactionsFullSurface(t *testing.T) {
	m := newM4MsgEnv(t)
	target := m.send("react target", nil)
	msg := target.body["message"].(map[string]any)
	messageID := msg["id"].(string)

	// Owner reacts.
	res := m.serve("POST", "/api/messages/"+messageID+"/reactions", map[string]any{"emoji": "👍"}, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("add: %d %s", res.status, res.raw)
	}
	assertExactKeys(t, res.body, []string{
		"id", "seq", "channelId", "senderType", "senderId", "agentSendKey",
		"randomId", "messageType", "content", "actionMetadata", "searchText",
		"threadId", "taskStatus", "taskNumber", "taskAssigneeType",
		"taskAssigneeId", "taskClaimedAt", "taskCompletedAt", "createdAt",
		"updatedAt", "commentRef", "senderName", "senderHandle", "senderDescription",
		"senderMembershipStatus", "reactions", "mentions", "attachments", "reactionViewer",
	}, "reaction mutation response")
	viewer := res.body["reactionViewer"].(map[string]any)
	assertExactKeys(t, viewer, []string{"serverId", "messageId", "viewerVersion", "reactedEmojis"}, "reactionViewer")
	if viewer["serverId"] != m.wsID || viewer["messageId"] != messageID {
		t.Fatalf("viewer coordinates: %+v", viewer)
	}
	if emojis := viewer["reactedEmojis"].([]any); len(emojis) != 1 || emojis[0] != "👍" {
		t.Fatalf("viewer emojis: %+v", emojis)
	}
	if ver := viewer["viewerVersion"].(float64); ver <= 0 {
		t.Fatalf("viewer version: %v", ver)
	}
	reactions := res.body["reactions"].([]any)
	if len(reactions) != 1 {
		t.Fatalf("shared aggregate: %s", res.raw)
	}
	agg := reactions[0].(map[string]any)
	assertExactKeys(t, agg, []string{"emoji", "count", "reactorIds", "reactorNames"}, "reaction aggregate")
	if agg["count"] != float64(1) {
		t.Fatalf("aggregate count: %+v", agg)
	}

	// Member reacts; aggregate grows with real names.
	res = m.serve("POST", "/api/messages/"+messageID+"/reactions", map[string]any{"emoji": "👍"}, m.memberTk)
	if res.status != http.StatusOK {
		t.Fatalf("member add: %d %s", res.status, res.raw)
	}
	agg = res.body["reactions"].([]any)[0].(map[string]any)
	if agg["count"] != float64(2) || len(agg["reactorNames"].([]any)) != 2 {
		t.Fatalf("aggregate after two actors: %+v", agg)
	}

	// Viewer snapshot GET reflects the member's own state.
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/viewer", nil, m.memberTk)
	if res.status != http.StatusOK {
		t.Fatalf("viewer GET: %d %s", res.status, res.raw)
	}
	assertExactKeys(t, res.body, []string{"serverId", "messageId", "viewerVersion", "reactedEmojis"}, "viewer snapshot")

	// Actors listing: both reactors, ordered, no cursor at this size.
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/actors?emoji=👍", nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("actors: %d %s", res.status, res.raw)
	}
	assertExactKeys(t, res.body, []string{"discussion", "discussionVersion", "actors", "nextCursor"}, "actors response")
	discussion := res.body["discussion"].(map[string]any)
	assertExactKeys(t, discussion, []string{"root", "relation", "parentScope"}, "discussion")
	root := discussion["root"].(map[string]any)
	if root["kind"] != "message" || root["id"] != messageID || root["serverId"] != m.wsID {
		t.Fatalf("discussion root: %+v", root)
	}
	relation := discussion["relation"].(map[string]any)
	if relation["kind"] != "reactionActors" || relation["emoji"] != "👍" {
		t.Fatalf("discussion relation: %+v", relation)
	}
	scope := discussion["parentScope"].(map[string]any)
	assertExactKeys(t, scope, []string{"serverId", "scopeKind", "scopeId"}, "parentScope")
	if scope["scopeKind"] != "channel" || scope["scopeId"] != m.chanID {
		t.Fatalf("parentScope: %+v", scope)
	}
	actors := res.body["actors"].([]any)
	if len(actors) != 2 {
		t.Fatalf("actors: %s", res.raw)
	}
	actor := actors[0].(map[string]any)
	assertExactKeys(t, actor, []string{"actorRef", "name", "displayName"}, "actor")
	ref := actor["actorRef"].(map[string]any)
	if ref["kind"] != "user" {
		t.Fatalf("actorRef: %+v", ref)
	}
	if res.body["nextCursor"] != nil {
		t.Fatalf("nextCursor must be null when exhausted: %v", res.body["nextCursor"])
	}

	// Cursor paging with limit 1 + guard on mutation.
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/actors?emoji=%F0%9F%91%8D&limit=1", nil, m.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("actors paged: %d %s", res.status, res.raw)
	}
	cursor, _ := res.body["nextCursor"].(string)
	if cursor == "" {
		t.Fatalf("expected a cursor: %s", res.raw)
	}
	// A same-emoji mutation invalidates the cursor.
	res = m.serve("DELETE", "/api/messages/"+messageID+"/reactions", map[string]any{"emoji": "👍"}, m.memberTk)
	if res.status != http.StatusOK {
		t.Fatalf("remove: %d %s", res.status, res.raw)
	}
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/actors?emoji=%F0%9F%91%8D&limit=1&cursor="+cursor, nil, m.ownerTok)
	if res.status != http.StatusConflict || res.body["code"] != "reaction_discussion_version_changed" || res.body["rebaselineRequired"] != true {
		t.Fatalf("stale cursor: %d %s", res.status, res.raw)
	}

	// Bad emoji and limit.
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/actors", nil, m.ownerTok)
	if res.status != http.StatusBadRequest || res.body["code"] != "invalid_reaction_emoji" {
		t.Fatalf("missing emoji: %d %s", res.status, res.raw)
	}
	res = m.serve("GET", "/api/messages/"+messageID+"/reactions/actors?emoji=%F0%9F%91%8D&limit=0", nil, m.ownerTok)
	if res.status != http.StatusBadRequest || res.body["code"] != "invalid_reaction_actor_limit" {
		t.Fatalf("bad limit: %d %s", res.status, res.raw)
	}

	// Unknown message is a 404 without existence leakage.
	res = m.serve("GET", "/api/messages/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/reactions/viewer", nil, m.ownerTok)
	if res.status != http.StatusNotFound || res.body["error"] != "Message not found" {
		t.Fatalf("unknown message: %d %s", res.status, res.raw)
	}

	// Reaction mutation body without emoji.
	res = m.serve("POST", "/api/messages/"+messageID+"/reactions", map[string]any{}, m.ownerTok)
	if res.status != http.StatusBadRequest || res.body["error"] != "A valid emoji is required" {
		t.Fatalf("no emoji: %d %s", res.status, res.raw)
	}
}

func TestM4MessageRateLimitSharedBucket(t *testing.T) {
	m := newM4MsgEnv(t)
	// 60 admitted writes (sends + reactions share the bucket for the OWNER).
	sent := 0
	for i := 0; i < 54; i++ {
		res := m.send(fmt.Sprintf("burst-%d", i), nil)
		if res.status != http.StatusOK {
			t.Fatalf("burst %d: %d %s", i, res.status, res.raw)
		}
		sent++
	}
	seedRes := m.send("react target", nil)
	if seedRes.status != http.StatusOK {
		t.Fatalf("react target seed: %d %s", seedRes.status, seedRes.raw)
	}
	target := seedRes.body["message"].(map[string]any)["id"].(string)
	for i := 0; i < 5; i++ {
		res := m.serve("POST", "/api/messages/"+target+"/reactions", map[string]any{"emoji": fmt.Sprintf("e%d", i)}, m.ownerTok)
		if res.status != http.StatusOK {
			t.Fatalf("reaction %d should still be inside the bucket: %d %s", i, res.status, res.raw)
		}
	}
	// The 61st write is refused with the exact legacy body and headers.
	res := m.send("one too many", nil)
	if res.status != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d %s", res.status, res.raw)
	}
	if res.body["error"] != "Too many messages, please slow down" {
		t.Fatalf("429 body: %s", res.raw)
	}
	if res.header.Get("RateLimit-Limit") != "60" || res.header.Get("RateLimit-Remaining") != "0" {
		t.Fatalf("429 headers: %v", res.header)
	}
	// Reads never consume the bucket.
	if res := m.serve("GET", "/api/messages/channel/"+m.chanID, nil, m.ownerTok); res.status != http.StatusOK {
		t.Fatalf("reads must stay unlimited: %d", res.status)
	}
	// The member's own bucket is independent (per-user key).
	if res := m.sendAs("independent", m.memberTk); res.status != http.StatusOK {
		t.Fatalf("per-user bucket: %d %s", res.status, res.raw)
	}
	// A randomId replay still consumes the shared bucket: while exhausted it
	// gets the same 429 (retry keeps its key, never resends a new message).
	if res := m.send("replay", map[string]any{"randomId": "rl-1"}); res.status != http.StatusTooManyRequests {
		t.Fatalf("replay must not bypass the bucket: %d %s", res.status, res.raw)
	}
	// Advance the injected clock past the window; the retry now succeeds and
	// returns the idempotent original row.
	*m.rateNow = m.rateNow.Add(61 * time.Second)
	first := m.send("replay", map[string]any{"randomId": "rl-1"})
	if first.status != http.StatusOK {
		t.Fatalf("window reset: %d %s", first.status, first.raw)
	}
	again := m.send("replay", map[string]any{"randomId": "rl-1"})
	if again.status != http.StatusOK || again.body["message"].(map[string]any)["id"] != first.body["message"].(map[string]any)["id"] {
		t.Fatalf("retry after window must replay the original: %s", again.raw)
	}
	var count int
	_ = m.env.app.DB.QueryRow(`SELECT COUNT(*) FROM messages WHERE random_id = 'rl-1'`).Scan(&count)
	if count != 1 {
		t.Fatalf("one row for the retried key: %d", count)
	}
}

func (m *m4MsgEnv) sendAs(content, token string) response {
	m.t.Helper()
	return m.serve("POST", "/api/v2/messages", map[string]any{
		"channelId": m.chanID, "content": content,
	}, token)
}

func TestM4MessagePersistenceAcrossRestart(t *testing.T) {
	m := newM4MsgEnv(t)
	res := m.send("survive restart", map[string]any{"randomId": "rid-restart"})
	if res.status != http.StatusOK {
		t.Fatalf("send: %d %s", res.status, res.raw)
	}
	sentID := res.body["message"].(map[string]any)["id"].(string)
	seq := res.body["message"].(map[string]any)["seq"].(float64)

	// Reopen on the same data dir: facts and publications survive.
	reopened := m.reopen()
	res = reopened.serve("GET", "/api/messages/channel/"+reopened.chanID, nil, reopened.ownerTok)
	if res.status != http.StatusOK {
		t.Fatalf("history after restart: %d %s", res.status, res.raw)
	}
	messages := res.body["messages"].([]any)
	if len(messages) != 1 || messages[0].(map[string]any)["id"] != sentID {
		t.Fatalf("restart lost messages: %s", res.raw)
	}
	if messages[0].(map[string]any)["seq"].(float64) != seq {
		t.Fatalf("seq changed across restart")
	}
	// The same randomId still replays to the original message.
	replay := reopened.send("survive restart", map[string]any{"randomId": "rid-restart"})
	if replay.status != http.StatusOK || replay.body["message"].(map[string]any)["id"] != sentID {
		t.Fatalf("replay after restart: %d %s", replay.status, replay.raw)
	}
}

func (m *m4MsgEnv) reopen() *m4MsgEnv {
	m.t.Helper()
	env := m.env.reopen()
	store := message.NewStore(env.app.DB, channel.NewStore(env.app.DB))
	handlers := legacyweb.NewMessageHandlers(store, &legacyweb.ChannelHandlers{Store: store.Channels()})
	clone := &m4MsgEnv{
		t: m.t, env: env, handlers: handlers,
		wsID: m.wsID, ownerID: m.ownerID, ownerTok: m.ownerTok,
		memberID: m.memberID, memberTk: m.memberTk, chanID: m.chanID,
		rateNow: m.rateNow,
	}
	handlers.SetMessageRateClock(func() time.Time { return *clone.rateNow })
	clone.mux = http.NewServeMux()
	legacyweb.RegisterMessageRoutes(clone.mux, handlers, clone.gate())
	return clone
}

// TestM4SyncReadsSparseDatasetBehindAdversarialBulk drives the real HTTP
// surface over the two adversarial shapes (>20000 invisible rows, >512
// invisible channels): the original client's bare-array cursor protocol must
// eventually return the authorized rows — the invisible bulk is excluded by
// the reusable channel authority SQL before the LIMIT, never by a fixed
// quota the client would stall against forever.
func TestM4SyncReadsSparseDatasetBehindAdversarialBulk(t *testing.T) {
	m := newM4MsgEnv(t)
	// Invisible bulk: a private channel only the owner can stream, over the
	// old scan row budget, then the visible message.
	flood := "9e9e9e9e-0000-4000-8000-000000000001"
	m.seedChannel(flood, "flood", "private")
	m.joinChannel(flood, m.ownerID)
	db := m.env.app.DB
	const floodRows = 20001
	for chunk := 0; chunk < floodRows; chunk += 1000 {
		end := chunk + 1000
		if end > floodRows {
			end = floodRows
		}
		var b strings.Builder
		b.WriteString(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at) VALUES `)
		args := make([]any, 0, (end-chunk)*5)
		for i := chunk; i < end; i++ {
			if i > chunk {
				b.WriteString(",")
			}
			b.WriteString("(?,?,?, 'user', ?, ?, 'chat', ?, 1, 1)")
			args = append(args,
				fmt.Sprintf("f0000000-0000-4000-8000-%012d", i),
				m.wsID, flood, m.ownerID, "flood", fmt.Sprintf("d-%d", i))
		}
		if _, err := db.Exec(b.String(), args...); err != nil {
			t.Fatalf("flood seed chunk %d: %v", chunk, err)
		}
	}
	// >512 invisible distinct channels.
	for i := 0; i < 600; i++ {
		id := fmt.Sprintf("a0000000-0000-4000-8000-%012d", 100000+i)
		if _, err := db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?,?,?,?,1)`,
			id, m.wsID, fmt.Sprintf("c%d", i), "private"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at)
			VALUES (?,?,?, 'user', ?, ?, 'chat', ?, 1, 1)`,
			fmt.Sprintf("a0000000-0000-4000-8000-%012d", 200000+i),
			m.wsID, id, m.ownerID, "x", fmt.Sprintf("dc-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	visible := m.send("visible tail", nil)

	// The member pages the bare array with the original protocol (last
	// message seq as the next since_seq, continue while pages come full).
	syncPage := func(since float64) []map[string]any {
		m.t.Helper()
		res := m.serve("GET", fmt.Sprintf("/api/messages/sync?since_seq=%d&limit=200", int(since)), nil, m.memberTk)
		if res.status != http.StatusOK {
			m.t.Fatalf("sync page: %d %s", res.status, res.raw)
		}
		raw := strings.TrimSpace(string(res.raw))
		if !strings.HasPrefix(raw, "[") {
			m.t.Fatalf("bare array contract: %s", raw)
		}
		var msgs []map[string]any
		if err := json.Unmarshal([]byte(raw), &msgs); err != nil {
			m.t.Fatal(err)
		}
		return msgs
	}
	cursor := float64(0)
	var got []map[string]any
	for {
		page := syncPage(cursor)
		got = append(got, page...)
		if len(page) == 0 || len(page) < 200 {
			break
		}
		last := page[len(page)-1]["seq"].(float64)
		if last <= cursor {
			t.Fatalf("cursor stalled at %v", cursor)
		}
		cursor = last
	}
	found := false
	for _, msg := range got {
		if msg["channelId"] == flood {
			t.Fatalf("invisible channel leaked into the sync array")
		}
		if msg["id"] == visible.body["message"].(map[string]any)["id"] {
			found = true
		}
	}
	if !found {
		t.Fatalf("the authorized row never arrived: %d messages", len(got))
	}
}

// TestM4SyncRequiresCurrentMembership pins that an empty stream is never the
// same answer as "not a member": a valid verified human outside the
// workspace gets the membership refusal even for an empty workspace.
func TestM4SyncRequiresCurrentMembership(t *testing.T) {
	m := newM4MsgEnv(t)
	_, outsiderTok, _ := m.env.fullAccount("outsider3@m4.test", "m4outsider3")
	res := m.serve("GET", "/api/messages/sync?since_seq=0", nil, outsiderTok)
	if res.status != http.StatusForbidden || res.body["error"] != "Not a member of this server" {
		t.Fatalf("outsider sync: %d %s", res.status, res.raw)
	}
	// A real member of the (message-empty) public channel gets the honest
	// empty array, not a refusal.
	res = m.serve("GET", "/api/messages/sync?since_seq=0", nil, m.memberTk)
	if res.status != http.StatusOK || strings.TrimSpace(string(res.raw)) != "[]" {
		t.Fatalf("member empty sync: %d %s", res.status, res.raw)
	}
}

// TestM4NoInventedMessageSurfaces pins the honesty boundary: message text
// edit/delete and saved-message paths were never routes on the original
// backend, so they answer the plain 404/405 family, never a fabricated
// disabled-feature 501.
func TestM4NoInventedMessageSurfaces(t *testing.T) {
	m := newM4MsgEnv(t)
	target := m.send("target", nil).body["message"].(map[string]any)["id"].(string)

	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"PATCH", "/api/messages/" + target, http.StatusNotFound},
		{"DELETE", "/api/messages/" + target, http.StatusNotFound},
		{"GET", "/api/messages/" + target + "/saved", http.StatusNotFound},
		{"POST", "/api/messages/" + target + "/saved", http.StatusNotFound},
		{"GET", "/api/messages/unknown-subroute", http.StatusNotFound},
		{"PUT", "/api/messages/sync", http.StatusMethodNotAllowed},
		{"PUT", "/api/messages/channel/" + m.chanID, http.StatusMethodNotAllowed},
		{"PUT", "/api/messages/" + target + "/reactions", http.StatusMethodNotAllowed},
	} {
		res := m.serve(tc.method, tc.path, map[string]any{}, m.ownerTok)
		if res.status != tc.want {
			t.Fatalf("%s %s: got %d want %d (%s)", tc.method, tc.path, res.status, tc.want, res.raw)
		}
	}
	// Real legacy routes that M4 disables keep the explicit 501; a wrong
	// method on them answers 405 first.
	res := m.serve("GET", "/api/messages/forward", nil, m.ownerTok)
	if res.status != http.StatusMethodNotAllowed {
		t.Fatalf("forward method gate: %d", res.status)
	}
	res = m.serve("GET", "/api/messages/search?q=x", nil, m.ownerTok)
	if res.status != http.StatusNotImplemented || res.body["code"] != "feature_not_implemented" {
		t.Fatalf("search stays the explicit 501: %d %s", res.status, res.raw)
	}
	res = m.serve("POST", "/api/messages/forward", map[string]any{}, m.ownerTok)
	if res.status != http.StatusNotImplemented || res.body["code"] != "feature_not_implemented" {
		t.Fatalf("forward stays the explicit 501: %d %s", res.status, res.raw)
	}
}

// TestM4RestartStableProjectionAndResume reopens the process and asserts the
// projection/resume entry points the socket worker depends on stay stable
// and correct after a restart.
func TestM4RestartStableProjectionAndResume(t *testing.T) {
	m := newM4MsgEnv(t)
	sent := m.send("restart projection", nil)
	msg := sent.body["message"].(map[string]any)
	messageID := msg["id"].(string)

	reopened := m.reopen()
	store := reopened.handlers.Store
	claims := message.NewClaims(reopened.claimsFor(reopened.ownerID))
	proj, err := store.ProjectPublication(reopened.env.t.Context(), message.PublicationRef{
		WorkspaceID: reopened.wsID, ObjectType: "message", ObjectID: messageID,
		EventType: "message:new", Revision: 1,
	})
	if err != nil || proj == nil || proj.Message == nil {
		t.Fatalf("restart projection: %+v %v", proj, err)
	}
	if proj.Message.ID != messageID || proj.PrivacyClass != "shared" {
		t.Fatalf("projection facts: %+v", proj)
	}
	if proj.ConversationContext == nil || proj.ConversationContext.ChannelType != "channel" {
		t.Fatalf("conversation context after restart: %+v", proj.ConversationContext)
	}
	live, err := store.LiveEligibilityForChannel(reopened.env.t.Context(), reopened.wsID, reopened.chanID, reopened.ownerID)
	if err != nil || !live.Eligible || live.ViaFollow {
		t.Fatalf("live eligibility after restart: %+v %v", live, err)
	}
	page, err := store.ResumePage(reopened.env.t.Context(), claims, reopened.wsID, 0, message.ResumeOptions{})
	if err != nil {
		t.Fatalf("resume after restart: %v", err)
	}
	if len(page.Messages) != 1 || page.Messages[0].ID != messageID {
		t.Fatalf("resume payload after restart: %+v", page.Messages)
	}
	if page.CurrentSeq != int64(msg["seq"].(float64)) || page.HasMore {
		t.Fatalf("resume coverage after restart: %+v", page)
	}
}

// claimsFor rebuilds the verified-JWT claims shape for a seeded account by
// reading its live session family from the database (the register flow
// creates exactly one).
func (m *m4MsgEnv) claimsFor(userID string) auth.AccessTokenClaims {
	m.t.Helper()
	var familyID string
	var issued, expires int64
	if err := m.env.app.DB.QueryRow(`
		SELECT f.id, f.created_at, f.created_at + 3600000
		FROM session_families f WHERE f.user_id = ? AND f.revoked_at IS NULL
		ORDER BY f.created_at DESC LIMIT 1`, userID).Scan(&familyID, &issued, &expires); err != nil {
		m.t.Fatal(err)
	}
	return auth.AccessTokenClaims{
		Subject: userID, Type: "access", FamilyID: familyID,
		IssuedAt:  time.UnixMilli(issued).UTC(),
		ExpiresAt: time.UnixMilli(expires).UTC(),
	}
}
