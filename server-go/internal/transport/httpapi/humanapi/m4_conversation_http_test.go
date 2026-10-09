// HTTP tests for the M4 conversation surface. Requests run through the real
// auth chain (accounts registered/verified/completed on the app handler)
// against a mux mounting only this worker's routes — the same registration
// the parent integrates — using an in-process recorder, so the suite runs in
// sandboxes that forbid local binds. Cross-worker seams (first reply poster,
// read cursor) are exercised through test doubles shaped exactly like the
// frozen message/readstate signatures.
package humanapi_test

import (
	"context"
	crand "crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/tests/testkit"
	"strings"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
	"raft.local/server-go/internal/transport/presenter"
	"raft.local/server-go/internal/workspace"
)

type m4Env struct {
	t         *testing.T
	env       *testkit.TestEnv
	handlers  *humanapi.ConversationHandlers
	mux       *http.ServeMux
	store     *channel.Store
	readstate *readstate.Store
	messaging *messaging.Service
	refresh   map[string]string // email → refresh token (logout/revocation tests)
}

// newM4Worker builds the real cross-module services over the app's database:
// the conversation surface no longer has per-handler seams to stub.
func (m *m4Env) buildHandlers() {
	db := m.env.App.DB
	msgs := message.NewStore(db, m.store)
	states := readstate.NewStore(db, m.store)
	svc, err := messaging.NewService(m.store, msgs, states)
	if err != nil {
		m.t.Fatal(err)
	}
	_ = err
	m.readstate = states
	m.messaging = svc
	m.handlers = &humanapi.ConversationHandlers{
		Channels:   m.store,
		Workspaces: workspace.NewStore(db),
		Messaging:  svc,
	}
}

func newM4Env(t *testing.T) *m4Env {
	t.Helper()
	env := testkit.NewTestEnv(t)
	m4 := &m4Env{t: t, env: env, refresh: map[string]string{}}
	m4.store = channel.NewStore(env.App.DB)
	m4.buildHandlers()
	m4.mux = http.NewServeMux()
	humanapi.RegisterConversationRoutes(m4.mux, m4.handlers, m4.gate())
	return m4
}

// gate rebuilds the auth gate over the app's database with the same signing
// secret, so tokens issued by the app's own register/refresh endpoints verify.
func (m *m4Env) gate() *authn.AuthGate {
	m.t.Helper()
	cfg := m.env.App.Config
	store := auth.NewStore(m.env.App.DB)
	signer := auth.NewTokenSigner(cfg.JWTSecret, cfg.AccessTokenTTL)
	root := keys.NewRoot(cfg.JWTSecret)
	receiptKey, err := root.RefreshReceiptKey()
	if err != nil {
		m.t.Fatal(err)
	}
	sessions := auth.NewSessionService(m.env.App.DB, store, signer, receiptKey,
		cfg.RefreshTokenTTL, cfg.RefreshReplayGrace, cfg.DurableReplayTTL)
	return &authn.AuthGate{Signer: signer, Sessions: sessions, Users: authn.UserLookup(store.UserByID)}
}

// serve drives one request through this worker's mux.
func (m *m4Env) Serve(method, path string, body any, bearer, serverID string) testkit.Response {
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
	if serverID != "" {
		req.Header.Set("X-Server-Id", serverID)
	}
	rec := httptest.NewRecorder()
	m.mux.ServeHTTP(rec, req)
	return testkit.ParseResponse(rec)
}

// seedWorkspace creates two fully-verified members of one workspace through
// the real account flows plus SQL seeds for the workspace itself.
func (m *m4Env) seedWorkspace(t *testing.T) (wsID, ownerID, ownerToken, memberID, memberToken string) {
	t.Helper()
	var ownerRefresh, memberRefresh string
	ownerID, ownerToken, ownerRefresh = m.env.FullAccount("owner@m4.test", "m4owner")
	memberID, memberToken, memberRefresh = m.env.FullAccount("member@m4.test", "m4member")
	m.refresh["owner@m4.test"] = ownerRefresh
	m.refresh["member@m4.test"] = memberRefresh
	wsID = "wsm4-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if err := m.env.InsertWorkspace(wsID, "M4 Space", "m4-space", ownerID); err != nil {
		t.Fatal(err)
	}
	if err := m.env.InsertMembership(map[string]any{
		"workspace_id": wsID, "user_id": ownerID, "role": "owner",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.env.InsertMembership(map[string]any{
		"workspace_id": wsID, "user_id": memberID, "role": "member",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	return
}

// seedChannel inserts one channel row directly (the channel CRUD surface is
// M3-owned; these tests only need conversation rows).
func (m *m4Env) seedMessage(t *testing.T, wsID, channelID, senderID, content string) string {
	t.Helper()
	id := m.msgUUID(t)
	if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?,?,?, 'user', ?, ?, 'http-test', ?)`,
		id, wsID, channelID, senderID, content, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	return id
}

func (m *m4Env) seedChannel(t *testing.T, wsID, id, name, channelType string, systemKind any) {
	t.Helper()
	var kind any
	if s, ok := systemKind.(string); ok {
		kind = s
	}
	if _, err := m.env.App.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?,?,?,?,?,?)`, id, wsID, name, channelType, kind, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

// msgUUID mints stable UUIDv4-shaped ids: the original route parsers
// (parentMessageIds, context anchors) validate the UUID shape.
func (m *m4Env) msgUUID(t *testing.T) string {
	t.Helper()
	m.t.Helper()
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		m.t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10x
	return fmt.Sprintf("%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
		b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9],
		b[10], b[11], b[12], b[13], b[14], b[15])
}

func TestM4CreateAndListDMs(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)

	t.Run("self DM and pair DM are canonical", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": ownerID}, ownerToken, ws)
		if res.Status != http.StatusOK || res.Body["peerId"] != ownerID {
			t.Fatalf("self dm: %d %v", res.Status, res.Body)
		}
		if res.Body["peerType"] != "user" || res.Body["type"] != "dm" {
			t.Fatalf("self dm shape: %v", res.Body)
		}
		selfID := res.Body["id"].(string)

		res = m.Serve("POST", "/api/channels/dm", map[string]any{"userId": memberID}, ownerToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("pair dm: %d %s", res.Status, res.Raw)
		}
		pairID := res.Body["id"].(string)
		// The peer sees the same conversation.
		res = m.Serve("POST", "/api/channels/dm", map[string]any{"userId": ownerID}, memberToken, ws)
		if res.Status != http.StatusOK || res.Body["id"] != pairID {
			t.Fatalf("reverse pair: %d %v", res.Status, res.Body)
		}
		var rows int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM direct_messages`).Scan(&rows); err != nil || rows != 2 {
			t.Fatalf("direct_messages rows: %d %v", rows, err)
		}

		res = m.Serve("GET", "/api/channels/dm", nil, ownerToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("list: %d %s", res.Status, res.Raw)
		}
		_ = selfID
		// parseResponse targets objects; arrays are re-parsed from raw bytes.
		var dmList []map[string]any
		if err := json.Unmarshal(res.Raw, &dmList); err != nil {
			t.Fatal(err)
		}
		if len(dmList) != 2 {
			t.Fatalf("dm list length: %d", len(dmList))
		}
		for _, dm := range dmList {
			if dm["peerGravatarHash"] == "" || dm["peerName"] == "" {
				t.Fatalf("peer projection incomplete: %v", dm)
			}
			if _, ok := dm["createdAt"]; !ok {
				t.Fatalf("createdAt missing: %v", dm)
			}
		}
	})

	t.Run("body shape errors", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/dm", map[string]any{}, ownerToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "Either agentId or userId is required" {
			t.Fatalf("empty body: %d %v", res.Status, res.Body)
		}
		res = m.Serve("POST", "/api/channels/dm", map[string]any{"agentId": "a", "userId": "b"}, ownerToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "Cannot provide both agentId and userId" {
			t.Fatalf("both ids: %d %v", res.Status, res.Body)
		}
	})

	t.Run("target eligibility", func(t *testing.T) {
		_, strangerToken, _ := m.env.FullAccount("stranger@m4.test", "m4stranger")
		res := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": "user-does-not-exist"}, ownerToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "User is not a member of this server" {
			t.Fatalf("missing target: %d %v", res.Status, res.Body)
		}
		res = m.Serve("POST", "/api/channels/dm", map[string]any{"userId": memberID}, strangerToken, ws)
		if res.Status != http.StatusForbidden { // not a member of this server at all
			t.Fatalf("stranger actor: %d %v", res.Status, res.Body)
		}
	})

	t.Run("agent branch validates identity and preserves typed canonical pair", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/dm", map[string]any{"agentId": "agent-does-not-exist"}, ownerToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Agent not found in this server" {
			t.Fatalf("missing agent: %d %v", res.Status, res.Body)
		}
		if err := platformdb.WithWriteTx(context.Background(), m.env.App.DB, func(tx *sql.Tx) error {
			_, err := tx.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
				VALUES ('agent-live', ?, 'clara', 'active', 'claude', 1, 1)`, ws)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		res = m.Serve("POST", "/api/channels/dm", map[string]any{"agentId": "agent-live"}, ownerToken, ws)
		if res.Status != http.StatusOK || res.Body["peerType"] != "agent" || res.Body["peerId"] != "agent-live" {
			t.Fatalf("typed Agent DM: %d %v", res.Status, res.Body)
		}
		dmID, _ := res.Body["id"].(string)
		if dmID == "" {
			t.Fatal("Agent DM has no canonical channel ID")
		}
		repeat := m.Serve("POST", "/api/channels/dm", map[string]any{"agentId": "agent-live"}, ownerToken, ws)
		if repeat.Status != http.StatusOK || repeat.Body["id"] != dmID {
			t.Fatalf("Agent DM create must be idempotent: %d %v", repeat.Status, repeat.Body)
		}
		var channels int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM channels WHERE workspace_id = ? AND type = 'dm' AND name = 'clara'`, ws).Scan(&channels); err != nil || channels != 1 {
			t.Fatalf("Agent DM must create exactly one channel: count=%d error=%v", channels, err)
		}
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM direct_messages WHERE channel_id = ?`, dmID).Scan(&channels); err != nil || channels != 0 {
			t.Fatalf("Agent identity must not enter the human-only pair table: count=%d error=%v", channels, err)
		}
	})

	t.Run("scope and auth gates", func(t *testing.T) {
		res := m.Serve("GET", "/api/channels/dm", nil, ownerToken, "")
		if res.Status != http.StatusBadRequest {
			t.Fatalf("missing server header: %d", res.Status)
		}
		otherWSOwner, otherToken, _ := m.env.FullAccount("other-ws@m4.test", "m4other")
		otherWS := "wsm4-other"
		if err := m.env.InsertWorkspace(otherWS, "Other", "other", otherWSOwner); err != nil {
			t.Fatal(err)
		}
		if err := m.env.InsertMembership(map[string]any{
			"workspace_id": otherWS, "user_id": otherWSOwner, "role": "owner",
			"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
		}); err != nil {
			t.Fatal(err)
		}
		res = m.Serve("GET", "/api/channels/dm", nil, otherToken, ws)
		if res.Status != http.StatusForbidden || res.Body["error"] != "Not a member of this server" {
			t.Fatalf("foreign scope: %d %v", res.Status, res.Body)
		}
		res = m.Serve("GET", "/api/channels/dm", nil, "", ws)
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("anonymous: %d", res.Status)
		}
	})
}

func TestM4ThreadLifecycle(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	parentMsg := m.seedMessage(t, ws, "ch-town", ownerID, "root message")

	t.Run("ensure without content needs no message worker", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("ensure: %d %s", res.Status, res.Raw)
		}
		if res.Body["threadChannelId"] == nil || res.Body["replyCount"] != float64(0) {
			t.Fatalf("ensure body: %v", res.Body)
		}
		if _, ok := res.Body["participantIds"]; !ok {
			t.Fatalf("participantIds missing: %v", res.Body)
		}
		threadID := res.Body["threadChannelId"].(string)
		var projected sql.NullString
		if err := m.env.App.DB.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parentMsg).Scan(&projected); err != nil || !projected.Valid || projected.String != threadID {
			t.Fatalf("parent projection: %+v %v", projected, err)
		}
		// Re-ensure returns the same thread.
		res = m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{"parentMessageId": parentMsg}, ownerToken, ws)
		if res.Status != http.StatusOK || res.Body["threadChannelId"] != threadID {
			t.Fatalf("re-ensure: %d %v", res.Status, res.Body)
		}
		// Opening must not follow the opener; the author is auto-followed.
		var openerFollows int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ?`, memberID, threadID).Scan(&openerFollows); err != nil || openerFollows != 0 {
			t.Fatalf("opener followed: %d %v", openerFollows, err)
		}
		var authorFollows int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`, ownerID, threadID).Scan(&authorFollows); err != nil || authorFollows != 1 {
			t.Fatalf("author not followed: %d %v", authorFollows, err)
		}
	})

	t.Run("first reply runs through the messaging send step in one transaction", func(t *testing.T) {
		otherMsg := m.seedMessage(t, ws, "ch-town", ownerID, "another root")
		// Posting requires real roster membership (the original seam test
		// bypassed this with a raw SQL insert; the real send path enforces it).
		if _, err := m.env.App.DB.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES ('ch-town', ?, 'member', 1)`, memberID); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{
			"parentMessageId": otherMsg, "content": "first reply",
		}, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("ensure+reply: %d %s", res.Status, res.Raw)
		}
		if res.Body["replyCount"] != float64(1) {
			t.Fatalf("reply count: %v", res.Body)
		}
		participants, _ := res.Body["participantIds"].([]any)
		if len(participants) != 1 || participants[0] != memberID {
			t.Fatalf("participants: %v", participants)
		}
		// The NEW reply advanced the replier's own read frontier in the SAME
		// commit (the original replied-auto-follow + markReadLatest pairing),
		// and both the reply fact and the follow row exist.
		var threadID string
		if err := m.env.App.DB.QueryRow(`SELECT id FROM channels WHERE type = 'thread' AND parent_message_id = ?`, otherMsg).Scan(&threadID); err != nil {
			t.Fatal(err)
		}
		var maxRead int64
		if err := m.env.App.DB.QueryRow(`SELECT last_read_seq FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`, ws, memberID, threadID).Scan(&maxRead); err != nil {
			t.Fatalf("replier read frontier missing: %v", err)
		}
		if maxRead == 0 {
			t.Fatalf("replier read frontier not advanced: %d", maxRead)
		}
		var follows int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows
			WHERE user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`, memberID, threadID).Scan(&follows); err != nil || follows != 1 {
			t.Fatalf("replier follow: %d %v", follows, err)
		}
	})

	t.Run("nested, announcement and archived guards", func(t *testing.T) {
		threadID := m.mustThreadID(t, ws, "ch-town", parentMsg)
		res := m.Serve("POST", "/api/channels/"+threadID+"/threads", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "Cannot create a thread inside a thread" {
			t.Fatalf("nested: %d %v", res.Status, res.Body)
		}
		m.seedChannel(t, ws, "ch-announce", "announcement", "channel", "announcement")
		annMsg := m.seedMessage(t, ws, "ch-announce", ownerID, "one way")
		res = m.Serve("POST", "/api/channels/ch-announce/threads", map[string]any{"parentMessageId": annMsg}, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["code"] != "announcement_no_threads" {
			t.Fatalf("announcement: %d %v", res.Status, res.Body)
		}
		m.seedChannel(t, ws, "ch-archived", "archivedtown", "channel", nil)
		if _, err := m.env.App.DB.Exec(`UPDATE channels SET archived_at = 1 WHERE id = 'ch-archived'`); err != nil {
			t.Fatal(err)
		}
		archMsg := m.seedMessage(t, ws, "ch-archived", ownerID, "old")
		res = m.Serve("POST", "/api/channels/ch-archived/threads", map[string]any{"parentMessageId": archMsg}, memberToken, ws)
		if res.Status != http.StatusConflict || res.Body["code"] != "channel_archived" {
			t.Fatalf("archived: %d %v", res.Status, res.Body)
		}
	})

	t.Run("parent message guards", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{}, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "parentMessageId is required" {
			t.Fatalf("missing parent id: %d %v", res.Status, res.Body)
		}
		res = m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{"parentMessageId": "msg-nope"}, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Parent message not found" {
			t.Fatalf("missing parent: %d %v", res.Status, res.Body)
		}
		// A message of another channel must not anchor a thread here.
		m.seedChannel(t, ws, "ch-other", "other", "channel", nil)
		foreign := m.seedMessage(t, ws, "ch-other", ownerID, "elsewhere")
		res = m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{"parentMessageId": foreign}, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Parent message not found" {
			t.Fatalf("cross-channel parent: %d %v", res.Status, res.Body)
		}
	})

	t.Run("summaries and single-thread info", func(t *testing.T) {
		threadID := m.mustThreadID(t, ws, "ch-town", parentMsg)
		if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
			VALUES ('msg-thread-reply', ?, ?, 'user', ?, 'a reply', 't', 3)`, ws, threadID, memberID); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("GET", "/api/channels/ch-town/threads?parentMessageIds="+parentMsg, nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("summaries: %d %s", res.Status, res.Raw)
		}
		var summaries map[string]map[string]any
		if err := json.Unmarshal(res.Raw, &summaries); err != nil {
			t.Fatal(err)
		}
		s, ok := summaries[parentMsg]
		if !ok {
			t.Fatalf("summary missing: %v", summaries)
		}
		if s["threadChannelId"] != threadID || s["replyCount"] != float64(1) {
			t.Fatalf("summary content: %v", s)
		}
		replies, _ := s["latestReplies"].([]any)
		if len(replies) != 1 {
			t.Fatalf("latest replies: %v", s)
		}
		res = m.Serve("GET", "/api/channels/ch-town/threads?parentMessageIds=not-a-uuid", nil, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "Invalid parentMessageIds" {
			t.Fatalf("invalid ids: %d %v", res.Status, res.Body)
		}
		res = m.Serve("GET", "/api/channels/ch-town/threads/"+parentMsg, nil, memberToken, ws)
		if res.Status != http.StatusOK || res.Body["threadChannelId"] != threadID {
			t.Fatalf("thread info: %d %v", res.Status, res.Body)
		}
		res = m.Serve("GET", "/api/channels/ch-town/threads/msg-nope", nil, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "No thread found for this message" {
			t.Fatalf("missing thread info: %d %v", res.Status, res.Body)
		}
	})

	t.Run("strangers never learn existence", func(t *testing.T) {
		m.seedChannel(t, ws, "ch-private", "private", "private", nil)
		privMsg := m.seedMessage(t, ws, "ch-private", ownerID, "secret root")
		strangerID, strangerToken, _ := m.env.FullAccount("privstranger@m4.test", "m4privstranger")
		if err := m.env.InsertMembership(map[string]any{
			"workspace_id": ws, "user_id": strangerID, "role": "member",
			"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
		}); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("POST", "/api/channels/ch-private/threads", map[string]any{"parentMessageId": privMsg}, strangerToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Channel not found or not visible" {
			t.Fatalf("private stranger: %d %v", res.Status, res.Body)
		}
		// Prior relationship keeps the honest 403 (thread_follows witness).
		threadID := m.mustThreadID(t, ws, "ch-town", parentMsg)
		if _, err := m.env.App.DB.Exec(`INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at, unfollowed_at, revision)
			VALUES (?, ?, ?, ?, 1, 1, 1)`, ws, strangerID, threadID, parentMsg); err != nil {
			t.Fatal(err)
		}
		// The stranger cannot read the parent channel, so the summaries route
		// denies with the plain 404 body (no roster row on a public channel is
		// fine — use the private one they never joined).
		res = m.Serve("GET", "/api/channels/ch-private/threads?parentMessageIds="+privMsg, nil, strangerToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Channel not found or not visible" {
			t.Fatalf("private summaries stranger: %d %v", res.Status, res.Body)
		}
		// 405 carries the real Allow set.
		res = m.Serve("DELETE", "/api/channels/ch-town/threads", nil, memberToken, ws)
		if res.Status != http.StatusMethodNotAllowed || res.Header.Get("Allow") != "GET, POST" {
			t.Fatalf("method not allowed: %d %q", res.Status, res.Header.Get("Allow"))
		}
	})
}

func TestM4FollowInterest(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	parentMsg := m.seedMessage(t, ws, "ch-town", ownerID, "root message")

	t.Run("follow ensures the thread and returns its id", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
		if res.Status != http.StatusOK || res.Body["ok"] != true || res.Body["threadChannelId"] == nil {
			t.Fatalf("follow: %d %s", res.Status, res.Raw)
		}
		threadID := res.Body["threadChannelId"].(string)
		var active int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows
			WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
			ws, memberID, threadID).Scan(&active); err != nil || active != 1 {
			t.Fatalf("follow row: %d %v", active, err)
		}
	})

	t.Run("followed list carries real facts", func(t *testing.T) {
		threadID := m.mustThreadID(t, ws, "ch-town", parentMsg)
		if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
			VALUES ('msg-reply-a', ?, ?, 'user', ?, 'a reply', 't', 5)`, ws, threadID, ownerID); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("GET", "/api/channels/threads/followed", nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("followed: %d %s", res.Status, res.Raw)
		}
		threads, _ := res.Body["threads"].([]any)
		if len(threads) != 1 {
			t.Fatalf("followed rows: %d", len(threads))
		}
		row := threads[0].(map[string]any)
		if row["threadChannelId"] != threadID || row["replyCount"] != float64(1) {
			t.Fatalf("row facts: %v", row)
		}
		if seq, ok := row["latestActivitySeq"].(string); !ok || !strings.HasPrefix(seq, "") || seq == "" {
			t.Fatalf("frontier seq: %v", row["latestActivitySeq"])
		}
		if row["latestActivityPreview"] != "a reply" {
			t.Fatalf("activity preview: %v", row["latestActivityPreview"])
		}
		// The author's automatic follow shows for the owner as well.
		res = m.Serve("GET", "/api/channels/threads/followed", nil, ownerToken, ws)
		threads, _ = res.Body["threads"].([]any)
		if len(threads) != 1 {
			t.Fatalf("author followed rows: %d", len(threads))
		}
	})

	t.Run("follow guards", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/threads/follow", map[string]any{}, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "parentMessageId is required" {
			t.Fatalf("missing id: %d %v", res.Status, res.Body)
		}
		res = m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": "msg-none"}, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Message not found" {
			t.Fatalf("missing message: %d %v", res.Status, res.Body)
		}
		// A member of the workspace who cannot read the parent gets the same
		// collapsed 404 (existence oracle closed).
		m.seedChannel(t, ws, "ch-priv2", "priv2", "private", nil)
		privMsg := m.seedMessage(t, ws, "ch-priv2", ownerID, "hidden root")
		res = m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": privMsg}, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Message not found" {
			t.Fatalf("unreadable parent: %d %v", res.Status, res.Body)
		}
	})

	t.Run("unfollow keeps history and content access", func(t *testing.T) {
		threadID := m.mustThreadID(t, ws, "ch-town", parentMsg)
		res := m.Serve("POST", "/api/channels/threads/unfollow", map[string]any{"threadChannelId": threadID}, memberToken, ws)
		if res.Status != http.StatusOK || res.Body["ok"] != true {
			t.Fatalf("unfollow: %d %s", res.Status, res.Raw)
		}
		var history int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows
			WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NOT NULL`,
			ws, memberID, threadID).Scan(&history); err != nil || history != 1 {
			t.Fatalf("unfollow history: %d %v", history, err)
		}
		res = m.Serve("GET", "/api/channels/threads/followed", nil, memberToken, ws)
		threads, _ := res.Body["threads"].([]any)
		if len(threads) != 0 {
			t.Fatalf("unfollowed thread still listed: %v", threads)
		}
		// History of the thread itself stays readable.
		res = m.Serve("GET", "/api/channels/ch-town/threads/"+parentMsg, nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("history after unfollow: %d", res.Status)
		}
		// Unfollow guards.
		res = m.Serve("POST", "/api/channels/threads/unfollow", map[string]any{}, memberToken, ws)
		if res.Status != http.StatusBadRequest || res.Body["error"] != "threadChannelId is required" {
			t.Fatalf("missing thread id: %d %v", res.Status, res.Body)
		}
		res = m.Serve("POST", "/api/channels/threads/unfollow", map[string]any{"threadChannelId": "ch-town"}, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Thread not found" {
			t.Fatalf("non-thread id: %d %v", res.Status, res.Body)
		}
	})
}

func TestM4ReadCursorFactsDriveUnread(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, _, memberID, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	parentMsg := m.seedMessage(t, ws, "ch-town", ownerID, "root message")
	ensure := m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
	if ensure.Status != http.StatusOK {
		t.Fatalf("ensure: %d %s", ensure.Status, ensure.Raw)
	}
	threadID := ensure.Body["threadChannelId"].(string)
	if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES ('msg-r1', ?, ?, 'user', ?, 'r1', 't', 5), ('msg-r2', ?, ?, 'user', ?, 'r2', 't', 6)`,
		ws, threadID, ownerID, ws, threadID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err := platformdb.WithWriteTx(context.Background(), m.env.App.DB, func(tx *sql.Tx) error {
		return m.store.SetThreadFollowTx(context.Background(), tx, ws, threadID, memberID, true, false)
	}); err != nil {
		t.Fatal(err)
	}
	// Seed the member's real read row through the first reply's seq: only one
	// unread remains (the followed read model reads readstate-owned rows).
	var firstReplySeq int64
	if err := m.env.App.DB.QueryRow(`SELECT seq FROM messages WHERE id = 'msg-r1'`).Scan(&firstReplySeq); err != nil {
		t.Fatal(err)
	}
	if _, err := m.env.App.DB.Exec(`INSERT INTO user_channel_read_states
		(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
		VALUES (?, ?, ?, ?, 1, 1)`, ws, memberID, threadID, firstReplySeq); err != nil {
		t.Fatal(err)
	}
	res := m.Serve("GET", "/api/channels/threads/followed", nil, memberToken, ws)
	if res.Status != http.StatusOK {
		t.Fatalf("followed: %d %s", res.Status, res.Raw)
	}
	threads, _ := res.Body["threads"].([]any)
	if len(threads) != 1 {
		t.Fatalf("rows: %d", len(threads))
	}
	row := threads[0].(map[string]any)
	if row["unreadCount"] != float64(1) {
		t.Fatalf("unread with cursor: %v", row["unreadCount"])
	}
	if row["firstUnreadMessageId"] != "msg-r2" {
		t.Fatalf("first unread: %v", row["firstUnreadMessageId"])
	}
	if row["maxReadSeq"] != float64(firstReplySeq) {
		t.Fatalf("max read seq: %v", row["maxReadSeq"])
	}
}

func TestM4RevokedSessionAndRestartPersistence(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, _, _, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	parentMsg := m.seedMessage(t, ws, "ch-town", ownerID, "root message")

	res := m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
	if res.Status != http.StatusOK {
		t.Fatalf("follow: %d %s", res.Status, res.Raw)
	}
	threadID := res.Body["threadChannelId"].(string)

	t.Run("logout revokes the family and fails closed", func(t *testing.T) {
		out := m.env.Do("POST", "/api/auth/logout", map[string]any{"refreshToken": m.refresh["member@m4.test"]}, memberToken)
		if out.Status != http.StatusOK {
			t.Fatalf("logout: %d %s", out.Status, out.Raw)
		}
		res := m.Serve("GET", "/api/channels/threads/followed", nil, memberToken, ws)
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("revoked token accepted: %d", res.Status)
		}
	})

	t.Run("facts survive a restart", func(t *testing.T) {
		reopened := m.env.Reopen()
		m2 := &m4Env{t: t, env: reopened}
		m2.store = channel.NewStore(reopened.App.DB)
		m2.buildHandlers()
		m2.mux = http.NewServeMux()
		humanapi.RegisterConversationRoutes(m2.mux, m2.handlers, m2.gate())
		// Re-login the member on the reopened app.
		login := reopened.Do("POST", "/api/auth/login", map[string]any{
			"email": "member@m4.test", "password": "password-123",
		}, "")
		if login.Status != http.StatusOK {
			t.Fatalf("relogin: %d %s", login.Status, login.Raw)
		}
		fresh := login.Body["accessToken"].(string)
		res := m2.Serve("GET", "/api/channels/threads/followed", nil, fresh, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("followed after restart: %d %s", res.Status, res.Raw)
		}
		threads, _ := res.Body["threads"].([]any)
		if len(threads) != 1 || threads[0].(map[string]any)["threadChannelId"] != threadID {
			t.Fatalf("thread follow lost: %v", threads)
		}
		var projected sql.NullString
		if err := reopened.App.DB.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parentMsg).Scan(&projected); err != nil || !projected.Valid || projected.String != threadID {
			t.Fatalf("projection lost: %+v", projected)
		}
		res = m2.Serve("GET", "/api/channels/dm", nil, fresh, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("dm list after restart: %d", res.Status)
		}
	})
}

func TestM4ConcurrentDMEnsure(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, _ := m.seedWorkspace(t)
	const workers = 6
	ids := make([]string, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": memberID}, ownerToken, ws)
			if res.Status != http.StatusOK {
				t.Errorf("worker %d: %d %s", i, res.Status, res.Raw)
				return
			}
			ids[i] = res.Body["id"].(string)
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] {
			t.Fatalf("diverging dm channels: %v", ids)
		}
	}
	low, high := ownerID, memberID
	if low > high {
		low, high = high, low
	}
	var rows int
	if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM direct_messages WHERE user_low = ? AND user_high = ?`, low, high).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("pair rows: %d %v", rows, err)
	}
}

func TestM4AnnouncementFollowRefused(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, _, _, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-announce", "announcement", "channel", "announcement")
	annMsg := m.seedMessage(t, ws, "ch-announce", ownerID, "one way")
	res := m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": annMsg}, memberToken, ws)
	if res.Status != http.StatusBadRequest || res.Body["code"] != "announcement_no_threads" {
		t.Fatalf("announcement follow: %d %v", res.Status, res.Body)
	}
}

// mustThreadID resolves the thread channel of one parent message directly
// from storage (the tests assert durable facts, not rec echoes).
func (m *m4Env) mustThreadID(t *testing.T, ws, channelID, parentMessageID string) string {
	t.Helper()
	var id string
	if err := m.env.App.DB.QueryRow(
		`SELECT id FROM channels WHERE workspace_id = ? AND type = 'thread' AND parent_message_id = ?`,
		ws, parentMessageID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	_ = channelID
	return id
}

// TestM4RoutesCoexistWithChannelDispatcher proves the registration contract
// the parent integrates: mounting the existing M3 channel dispatcher and this
// worker's routes on one mux neither panics nor lets the deferred 501 swallow
// the implemented paths, while unrelated deferred paths keep their 501.
func TestM4RoutesCoexistWithChannelDispatcher(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, _, _ := m.seedWorkspace(t)
	combined := http.NewServeMux()
	channelHandlers := &humanapi.ChannelHandlers{
		Store: m.store, Workspace: workspace.NewStore(m.env.App.DB),
	}
	humanapi.RegisterChannelRoutes(combined, channelHandlers, m.gate())
	humanapi.RegisterConversationRoutes(combined, m.handlers, m.gate())

	get := func(path string) testkit.Response {
		req, err := http.NewRequest(http.MethodGet, path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		req.Header.Set("X-Server-Id", ws)
		rec := httptest.NewRecorder()
		combined.ServeHTTP(rec, req)
		return testkit.ParseResponse(rec)
	}

	if res := get("/api/channels/dm"); res.Status != http.StatusOK {
		t.Fatalf("dm list through combined mux: %d %s", res.Status, res.Raw)
	}
	// The implemented {id}/threads summary wins over the dispatcher's 501.
	m.seedChannel(t, ws, "ch-combined", "combined", "channel", nil)
	if res := get("/api/channels/ch-combined/threads"); res.Status != http.StatusOK {
		t.Fatalf("thread summaries through combined mux: %d %s", res.Status, res.Raw)
	}
	// Unimplemented methods on my paths answer 405, not the deferred 501.
	req, _ := http.NewRequest(http.MethodPut, "/api/channels/dm", nil)
	req.Header.Set("Authorization", "Bearer "+ownerToken)
	req.Header.Set("X-Server-Id", ws)
	rec := httptest.NewRecorder()
	combined.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("dm 405: %d %q", rec.Code, rec.Header().Get("Allow"))
	}
	// Deferred surfaces keep their honest 501 through the dispatcher.
	if res := get("/api/channels/saved"); res.Status != http.StatusNotImplemented {
		t.Fatalf("saved still deferred: %d", res.Status)
	}
	_ = ownerID
}

func TestM4FollowAdvancesReadInSameTransaction(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	parentMsg := m.seedMessage(t, ws, "ch-town", ownerID, "root message")

	t.Run("follow commits the follow row and the read frontier together", func(t *testing.T) {
		// The thread must hold at least one reply for a nonzero frontier:
		// following a bare root creates an empty thread whose honest
		// mark-read-latest is 0. Seed the owner's roster membership and one
		// real reply first.
		if _, err := m.env.App.DB.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES ('ch-town', ?, 'member', 1)`, ownerID); err != nil {
			t.Fatal(err)
		}
		replyRes := m.Serve("POST", "/api/channels/ch-town/threads", map[string]any{
			"parentMessageId": parentMsg, "content": "owner reply",
		}, ownerToken, ws)
		if replyRes.Status != http.StatusOK {
			t.Fatalf("owner reply: %d %s", replyRes.Status, replyRes.Raw)
		}
		var replySeq int64
		if err := m.env.App.DB.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM messages`).Scan(&replySeq); err != nil {
			t.Fatal(err)
		}

		res := m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": parentMsg}, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("follow: %d %s", res.Status, res.Raw)
		}
		threadID, _ := res.Body["threadChannelId"].(string)
		if threadID == "" {
			t.Fatalf("thread id missing: %v", res.Body)
		}
		var following int
		if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM thread_follows
			WHERE user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`, memberID, threadID).Scan(&following); err != nil || following != 1 {
			t.Fatalf("follow committed: %d %v", following, err)
		}
		// The follower's own read frontier advanced in the SAME commit,
		// covering the reply that existed at follow time.
		var maxRead int64
		if err := m.env.App.DB.QueryRow(`SELECT last_read_seq FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`, ws, memberID, threadID).Scan(&maxRead); err != nil {
			t.Fatalf("read frontier missing after follow: %v", err)
		}
		if maxRead < replySeq {
			t.Fatalf("read frontier %d below reply seq %d", maxRead, replySeq)
		}
	})

	_ = ownerToken
}

func TestM4DMReadStateVerbatimFromOwner(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, _, _ := m.seedWorkspace(t)

	t.Run("create and list embed the readstate-owned frontier verbatim", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": ownerID}, ownerToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("self dm: %d %s", res.Status, res.Raw)
		}
		dmID, _ := res.Body["id"].(string)
		if dmID == "" {
			t.Fatalf("dm id missing: %v", res.Body)
		}
		// The expected bytes come from the owning projection itself, computed
		// on a separate snapshot: the exit must embed them verbatim.
		var expected []byte
		if err := platformdb.WithReadSnapshot(context.Background(), m.env.App.DB, func(ex platformdb.Executor) error {
			frontier, ferr := m.readstate.DMReadFrontierTx(context.Background(), ex, ws, ownerID, dmID)
			if ferr != nil {
				return ferr
			}
			expected = presenter.ReadFrontierUnion(frontier)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if expected == nil {
			t.Fatal("owner projection returned no frontier")
		}
		var row struct {
			ReadState json.RawMessage `json:"readState"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &row); err != nil {
			t.Fatal(err)
		}
		if string(row.ReadState) != string(expected) {
			t.Fatalf("create readState not verbatim: %s want %s", row.ReadState, expected)
		}
		list := m.Serve("GET", "/api/channels/dm", nil, ownerToken, ws)
		if list.Status != http.StatusOK {
			t.Fatalf("list: %d", list.Status)
		}
		var rows []struct {
			ReadState json.RawMessage `json:"readState"`
		}
		if err := json.Unmarshal(list.Raw, &rows); err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 {
			t.Fatalf("rows: %d", len(rows))
		}
		if string(rows[0].ReadState) != string(expected) {
			t.Fatalf("list readState not verbatim: %s want %s", rows[0].ReadState, expected)
		}
	})
}

func TestM4TwoAccountDMLifecycle(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)

	// Owner opens the conversation; the passive peer hides it until activity.
	res := m.Serve("POST", "/api/channels/dm", map[string]any{"userId": memberID}, ownerToken, ws)
	if res.Status != http.StatusOK {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	dmID := res.Body["id"].(string)

	// Both participants see the same channel and peer identity.
	list := m.Serve("GET", "/api/channels/dm", nil, memberToken, ws)
	var memberList []map[string]any
	if err := json.Unmarshal(list.Raw, &memberList); err != nil {
		t.Fatal(err)
	}
	if len(memberList) != 1 || memberList[0]["id"] != dmID || memberList[0]["peerId"] != ownerID {
		t.Fatalf("member view: %v", memberList)
	}

	// Real activity moves the conversation for both sides.
	if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES ('msg-dm-life', ?, ?, 'user', ?, 'hello', 't', 5)`, ws, dmID, ownerID); err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{ownerToken, memberToken} {
		list := m.Serve("GET", "/api/channels/dm", nil, tok, ws)
		var rows []map[string]any
		if err := json.Unmarshal(list.Raw, &rows); err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 || rows[0]["lastMessageAt"] == nil {
			t.Fatalf("activity projection: %v", rows)
		}
	}

	// Soft-delete then re-open: same canonical channel, fresh dm:new intent
	// (create-time key must not suppress the revive).
	if _, err := m.env.App.DB.Exec(`UPDATE channels SET deleted_at = 1 WHERE id = ?`, dmID); err != nil {
		t.Fatal(err)
	}
	res = m.Serve("POST", "/api/channels/dm", map[string]any{"userId": memberID}, ownerToken, ws)
	if res.Status != http.StatusOK || res.Body["id"] != dmID {
		t.Fatalf("revive: %d %v", res.Status, res.Body)
	}
	var intents int
	if err := m.env.App.DB.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE event_type = 'dm:new' AND object_id = ?`, dmID).Scan(&intents); err != nil || intents != 2 {
		t.Fatalf("dm:new intents after revive: %d %v", intents, err)
	}
	// The passive peer's hidden id is not duplicated by the revive.
	var hiddenCount int
	if err := m.env.App.DB.QueryRow(`SELECT json_array_length(COALESCE(hidden_dm_ids, '[]'))
		FROM workspace_member_preferences WHERE workspace_id = ? AND user_id = ?`, ws, memberID).Scan(&hiddenCount); err != nil {
		t.Fatal(err)
	}
	if hiddenCount > 1 {
		t.Fatalf("hidden ids duplicated: %d", hiddenCount)
	}
}

func TestM4RemovedMemberResidueSplit(t *testing.T) {
	m := newM4Env(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seedWorkspace(t)
	m.seedChannel(t, ws, "ch-privres", "privres", "private", nil)
	// The member was in the private channel, then was removed.
	if _, err := m.env.App.DB.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES ('ch-privres', ?, 'member', 1, 1)`, memberID); err != nil {
		t.Fatal(err)
	}
	privMsg := m.seedMessage(t, ws, "ch-privres", ownerID, "secret root")
	threadRes := m.Serve("POST", "/api/channels/threads/follow", map[string]any{"parentMessageId": privMsg}, memberToken, ws)
	if threadRes.Status != http.StatusOK {
		t.Fatalf("follow while member: %d %s", threadRes.Status, threadRes.Raw)
	}
	threadID := threadRes.Body["threadChannelId"].(string)
	if _, err := m.env.App.DB.Exec(`DELETE FROM channel_humans WHERE channel_id = 'ch-privres' AND user_id = ?`, memberID); err != nil {
		t.Fatal(err)
	}

	t.Run("read residue keeps the honest 403 without frontier data", func(t *testing.T) {
		// Residue on the channel being probed (read while still a member).
		if _, err := m.env.App.DB.Exec(`INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
			VALUES (?, ?, 'ch-privres', 4, 2, 1)`, ws, memberID); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("GET", "/api/channels/threads/followed", nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("followed list is workspace-scoped: %d", res.Status)
		}
		// A private-parent thread whose roster row is gone is filtered from
		// the followed list itself (parent chain rule). Denial split check:
		res = m.Serve("GET", "/api/channels/ch-privres/threads?parentMessageIds="+privMsg, nil, memberToken, ws)
		if res.Status != http.StatusForbidden || res.Body["error"] != "Access denied" {
			t.Fatalf("residue 403: %d %v", res.Status, res.Body)
		}
		// The 403 body carries the sentence only — no seq/version/frontier.
		if len(res.Body) != 1 {
			t.Fatalf("residue 403 leaked data: %v", res.Body)
		}
	})

	t.Run("no residue at all keeps the byte-identical 404", func(t *testing.T) {
		if _, err := m.env.App.DB.Exec(`DELETE FROM thread_follows WHERE user_id = ? AND thread_channel_id = ?`, memberID, threadID); err != nil {
			t.Fatal(err)
		}
		if _, err := m.env.App.DB.Exec(`DELETE FROM user_channel_read_states WHERE user_id = ?`, memberID); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("GET", "/api/channels/ch-privres/threads?parentMessageIds="+privMsg, nil, memberToken, ws)
		if res.Status != http.StatusNotFound || res.Body["error"] != "Channel not found or not visible" {
			t.Fatalf("no-residue 404: %d %v", res.Status, res.Body)
		}
	})
	_ = ownerToken
}
