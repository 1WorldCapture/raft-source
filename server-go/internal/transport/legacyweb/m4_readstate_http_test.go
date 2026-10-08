// HTTP tests for the M4 readstate surface. Requests run through the real
// auth chain (gate + X-Server-Id scope) against a mux mounting only this
// worker's routes — the same registration the parent integrates — using an
// in-process recorder, so the suite also runs in sandboxes that forbid local
// binds. No browser, no TCP listener, no live data.
package legacyweb

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

const (
	rsAlice = "11111111-1111-4111-8111-111111111111"
	rsBob   = "22222222-2222-4222-8222-222222222222"
	rsWS    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	rsWS2   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	rsGen   = "cccccccc-cccc-4ccc-8ccc-cccccccccc01"
	rsPriv  = "cccccccc-cccc-4ccc-8ccc-cccccccccc02"
	rsDM    = "cccccccc-cccc-4ccc-8ccc-cccccccccc03"
)

type readstateEnv struct {
	t      *testing.T
	db     *sql.DB
	mux    *http.ServeMux
	store  *readstate.Store
	fixed  *clock.Fixed
	tokens map[string]string
}

func newReadstateEnv(t *testing.T) *readstateEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	// Apply the readstate schema draft (what the parent copies to 0011).
	draft, err := readDraftSchema(t)
	if err != nil {
		t.Fatalf("read draft: %v", err)
	}
	if _, err := handle.Exec(draft); err != nil {
		t.Fatalf("apply draft: %v", err)
	}
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	channels := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner([]byte("test-secret-0123456789abcdef0123456789abcdef"), 15*time.Minute)
	// Align the signer with the store's fixed clock so the shared identity
	// predicate (IssuedAt/ExpiresAt vs the in-transaction now) is stable.
	signer.SetClock(func() time.Time { return fixed.T })
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}
	store := readstate.NewStore(handle, channels)
	store.SetClock(func() time.Time { return fixed.T })
	handlers := &ReadstateHandlers{Store: store}
	mux := http.NewServeMux()
	RegisterReadstateRoutes(mux, handlers, gate)
	env := &readstateEnv{t: t, db: handle, mux: mux, store: store, fixed: fixed, tokens: map[string]string{}}
	env.seed(signer)
	return env
}

func readDraftSchema(t *testing.T) (string, error) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "m4-readstate-schema.sql"))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func (e *readstateEnv) seed(signer *auth.TokenSigner) {
	e.t.Helper()
	now := e.fixed.T.UnixMilli()
	for _, u := range []struct{ id, name string }{
		{rsAlice, "alice"}, {rsBob, "bob"},
	} {
		if _, err := e.db.Exec(`INSERT INTO users (id, email, name, display_name, password_hash,
			email_verified, profile_setup_completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'x', 1, ?, ?, ?)`, u.id, u.name+"@rs.test", u.name, u.name, now, now, now); err != nil {
			e.t.Fatal(err)
		}
		familyID := u.id + "-fam"
		if _, err := e.db.Exec(`INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)`,
			familyID, u.id, now); err != nil {
			e.t.Fatal(err)
		}
		token, err := signer.SignAccessToken(u.id, familyID)
		if err != nil {
			e.t.Fatal(err)
		}
		e.tokens[u.id] = token
	}
	for _, ws := range []struct{ id, slug string }{{rsWS, "alpha"}, {rsWS2, "beta"}} {
		if _, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
			VALUES (?, ?, ?, ?, ?)`, ws.id, "WS "+ws.slug, ws.slug, rsAlice, now); err != nil {
			e.t.Fatal(err)
		}
	}
	for _, m := range []struct{ ws, user, role string }{
		{rsWS, rsAlice, "owner"}, {rsWS, rsBob, "member"}, {rsWS2, rsAlice, "owner"},
	} {
		if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, ?)`, m.ws, m.user, m.role, now); err != nil {
			e.t.Fatal(err)
		}
	}
	for _, c := range []struct{ id, name, ctype string }{
		{rsGen, "general", "channel"}, {rsPriv, "private", "private"}, {rsDM, "dm", "dm"},
	} {
		if _, err := e.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
			VALUES (?, ?, ?, ?, ?)`, c.id, rsWS, c.name, c.ctype, now); err != nil {
			e.t.Fatal(err)
		}
	}
	for _, membership := range []struct{ channel, user string }{
		{rsGen, rsAlice}, {rsGen, rsBob}, {rsPriv, rsAlice}, {rsPriv, rsBob},
		{rsDM, rsAlice}, {rsDM, rsBob},
	} {
		if _, err := e.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
			VALUES (?, ?, 'member', 1, ?)`, membership.channel, membership.user, now); err != nil {
			e.t.Fatal(err)
		}
	}
	if _, err := e.db.Exec(`INSERT INTO direct_messages (workspace_id, user_low, user_high, channel_id)
		VALUES (?, ?, ?, ?)`, rsWS, rsAlice, rsBob, rsDM); err != nil {
		e.t.Fatal(err)
	}
}

// serve drives one JSON request through the worker's mux.
func (e *readstateEnv) serve(method, path string, body any, token, serverID string) (int, map[string]any) {
	e.t.Helper()
	var reader *strings.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = strings.NewReader(string(buf))
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if serverID != "" {
		req.Header.Set("X-Server-Id", serverID)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	var decoded map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
	}
	return rec.Code, decoded
}

func (e *readstateEnv) message(channelID, sender, content string, mentioned ...string) int64 {
	e.t.Helper()
	now := e.fixed.T.UnixMilli()
	e.fixed.T = e.fixed.T.Add(10 * time.Millisecond)
	id := "rs-" + content
	res, err := e.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'chat', 'd', ?)`,
		id, rsWS, channelID, sender, content, now)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, target := range mentioned {
		if _, err := e.db.Exec(`INSERT INTO message_mentions (message_id, user_id, workspace_id)
			VALUES (?, ?, ?)`, id, target, rsWS); err != nil {
			e.t.Fatal(err)
		}
	}
	seq, err := res.LastInsertId()
	if err != nil {
		e.t.Fatal(err)
	}
	return seq
}

// TestReadstateAuthChain: no token 401; wrong scope membership 403; the
// read-mutation domain answers the honest 501 for authorized callers.
func TestReadstateAuthChain(t *testing.T) {
	env := newReadstateEnv(t)
	code, body := env.serve("GET", "/api/channels/inbox", nil, "", rsWS)
	if code != http.StatusUnauthorized || body["code"] != "auth_required" {
		t.Fatalf("no token = %d %+v", code, body)
	}
	code, body = env.serve("GET", "/api/channels/inbox", nil, env.tokens[rsBob], rsWS2)
	if code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("wrong scope = %d %+v", code, body)
	}
	code, body = env.serve("POST", "/api/read-mutations", map[string]any{}, env.tokens[rsAlice], rsWS)
	if code != http.StatusNotImplemented || body["code"] != "feature_not_implemented" {
		t.Fatalf("read-mutations = %d %+v", code, body)
	}
	code, _ = env.serve("GET", "/api/read-mutations/frontier", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusNotImplemented {
		t.Fatalf("read-mutations frontier = %d", code)
	}
}

// TestReadstateHTTPDoneMatrix: the route-level 412/400 frontier identity
// matrix, byte-identical with the legacy bodies.
func TestReadstateHTTPDoneMatrix(t *testing.T) {
	env := newReadstateEnv(t)
	seq := env.message(rsGen, rsBob, "one")

	// Value without identity: 412 with the refresh code.
	code, body := env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "throughActivitySeq": "1",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusPreconditionFailed || body["code"] != "DONE_FRONTIER_SPACE_REQUIRED" {
		t.Fatalf("412 matrix = %d %+v", code, body)
	}
	// Unsupported identity: 400 UNMAPPABLE.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "throughActivitySeq": "1", "frontierSpace": "display",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["code"] != "DONE_FRONTIER_UNMAPPABLE" {
		t.Fatalf("400 matrix = %d %+v", code, body)
	}
	// Missing channelId.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{}, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "channelId is required" {
		t.Fatalf("missing id = %d %+v", code, body)
	}
	// Explicit storage value within bounds.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "throughActivitySeq": "1", "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("storage done = %d %+v", code, body)
	}
	// Beyond latest: 409 with the legacy code.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "throughActivitySeq": itoaHTTP(seq + 9), "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusConflict || body["code"] != "DONE_FRONTIER_BEYOND_LATEST" {
		t.Fatalf("beyond = %d %+v", code, body)
	}
	// Thread scope on the chat route stays the merged 404.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": "cccccccc-cccc-4ccc-8ccc-cccccccccc09", "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusNotFound || body["error"] != "Chat not found" {
		t.Fatalf("missing chat = %d %+v", code, body)
	}
	// Null value on the strict path: 400 REQUIRED.
	code, body = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "throughActivitySeq": nil, "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["code"] != "DONE_FRONTIER_REQUIRED" {
		t.Fatalf("null strict = %d %+v", code, body)
	}
}

func itoaHTTP(v int64) string {
	if v == 0 {
		return "0"
	}
	digits := []byte{}
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	return string(digits)
}

// TestReadstateHTTPReadFamily: read/read-all/unread wire shapes and the
// residue-only receipt.
func TestReadstateHTTPReadFamily(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "one")
	env.message(rsGen, rsBob, "two")

	code, body := env.serve("POST", "/api/channels/"+rsGen+"/read", map[string]any{"seq": 1},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["ok"] != true || body["maxReadSeq"] != float64(1) || body["readStateVersion"] != float64(1) {
		t.Fatalf("read = %d %+v", code, body)
	}
	code, body = env.serve("POST", "/api/channels/"+rsGen+"/read", map[string]any{},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "seq is required" {
		t.Fatalf("read no seq = %d %+v", code, body)
	}
	code, body = env.serve("POST", "/api/channels/"+rsGen+"/read-all", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["seq"] != float64(2) {
		t.Fatalf("read-all = %d %+v", code, body)
	}
	code, body = env.serve("POST", "/api/channels/"+rsGen+"/unread", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["unreadCount"] != float64(1) {
		t.Fatalf("unread = %d %+v", code, body)
	}
	// Agent receiver delegation is refused this phase.
	code, body = env.serve("POST", "/api/channels/"+rsGen+"/read-all",
		map[string]any{"receiver": map[string]any{"kind": "agent", "id": rsBob}},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusForbidden || body["error"] != "Read receiver is not authorized" {
		t.Fatalf("agent receiver = %d %+v", code, body)
	}
	// Malformed receiver shape.
	code, body = env.serve("POST", "/api/channels/"+rsGen+"/read-all",
		map[string]any{"receiver": map[string]any{"kind": "human"}},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "Invalid read receiver" {
		t.Fatalf("bad receiver = %d %+v", code, body)
	}
}

// TestReadstateHTTPInboxReadAll: the bulk read-all envelope carries real
// marked counts and scope versions.
func TestReadstateHTTPInboxReadAll(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "one")
	env.message(rsPriv, rsBob, "two")

	code, body := env.serve("POST", "/api/channels/inbox/read-all", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("read-all = %d %+v", code, body)
	}
	if body["ok"] != true || body["markedCount"] != float64(2) {
		t.Fatalf("read-all body = %+v", body)
	}
	scopes := body["scopes"].([]any)
	if len(scopes) != 2 {
		t.Fatalf("scopes = %+v", scopes)
	}
	scope := scopes[0].(map[string]any)
	if scope["scopeId"] == "" || scope["readStateVersion"] != float64(1) {
		t.Fatalf("scope = %+v", scope)
	}
}

// TestReadstateHTTPUnreadAndSummary: map and summary envelope shapes.
func TestReadstateHTTPUnreadAndSummary(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "one")

	code, body := env.serve("GET", "/api/channels/unread", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("unread = %d", code)
	}
	if body[rsGen] != float64(1) {
		t.Fatalf("unread map = %+v", body)
	}
	code, body = env.serve("GET", "/api/channels/unread?summary=1", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("summary = %d", code)
	}
	channels := body["channels"].(map[string]any)
	entry := channels[rsGen].(map[string]any)
	if entry["unreadCount"] != float64(1) || entry["hasMention"] != false {
		t.Fatalf("summary entry = %+v", entry)
	}
	readState := entry["readState"].(map[string]any)
	if readState["kind"] != "absent" {
		t.Fatalf("readState = %+v", readState)
	}

	// The account summary is user-scoped (no X-Server-Id header needed).
	req, err := http.NewRequest("GET", "/api/servers/unread-summary", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+env.tokens[rsAlice])
	rec := httptest.NewRecorder()
	env.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("server summary = %d %s", rec.Code, rec.Body.String())
	}
	var entries []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("server entries = %+v", entries)
	}
	if entries[0]["serverId"] != rsWS || entries[0]["unreadCount"] != float64(1) {
		t.Fatalf("server entry = %+v", entries[0])
	}
	if _, ok := entries[0]["activityUnreadCount"]; !ok {
		t.Fatalf("activityUnreadCount must be attached when known: %+v", entries[0])
	}
}

// TestReadstateHTTPPrefs: both preference pairs persist with their exact
// response shapes and independent version domains.
func TestReadstateHTTPPrefs(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "one")

	code, body := env.serve("PATCH", "/api/channels/"+rsGen+"/notification-settings",
		map[string]any{"activityMuted": true}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["activityMuted"] != true || body["prefsVersion"] != float64(1) || body["muteFromSeq"] != float64(2) {
		t.Fatalf("mute = %d %+v", code, body)
	}
	code, body = env.serve("PATCH", "/api/channels/"+rsGen+"/notification-settings",
		map[string]any{"activityMuted": "yes"}, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "activityMuted must be a boolean" {
		t.Fatalf("mute type = %d %+v", code, body)
	}
	code, body = env.serve("GET", "/api/channels/"+rsGen+"/notification-settings", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["activityMuted"] != true || body["activityMuteSupported"] != true {
		t.Fatalf("mute read = %d %+v", code, body)
	}
	code, body = env.serve("PATCH", "/api/channels/"+rsGen+"/message-display-settings",
		map[string]any{"collapseLongMessages": false}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["collapseLongMessages"] != false || body["prefsVersion"] != float64(1) {
		t.Fatalf("display = %d %+v", code, body)
	}
	// Unknown channel id keeps the merged 404.
	code, _ = env.serve("GET", "/api/channels/cccccccc-cccc-4ccc-8ccc-cccccccccc99/notification-settings",
		nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusNotFound {
		t.Fatalf("unknown channel prefs = %d", code)
	}
}

// TestReadstateHTTPActivity: the activity reads' exact validation sentences
// and wire bodies.
func TestReadstateHTTPActivity(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "one")

	code, body := env.serve("GET", "/api/channels/activity/snapshot", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "requestId is required and windowId must be main" {
		t.Fatalf("snapshot no requestId = %d %+v", code, body)
	}
	code, body = env.serve("GET", "/api/channels/activity/snapshot?requestId=r&filter=bogus", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "filter must be all, unread, or mentions" {
		t.Fatalf("snapshot filter = %d %+v", code, body)
	}
	code, body = env.serve("GET", "/api/channels/activity/snapshot?requestId=r&windowId=other", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest {
		t.Fatalf("snapshot window = %d", code)
	}
	code, body = env.serve("GET", "/api/channels/activity/snapshot?requestId=r", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["type"] != "snapshot" {
		t.Fatalf("snapshot = %d %+v", code, body)
	}
	scope := body["scope"].(map[string]any)
	if scope["serverId"] != rsWS || scope["principalId"] != rsAlice || scope["filter"] != "all" || scope["windowId"] != "main" {
		t.Fatalf("scope = %+v", scope)
	}
	if body["epoch"] != "1" || body["activityVersion"] != body["watermark"] {
		t.Fatalf("epoch/version = %+v", body)
	}
	window := body["window"].(map[string]any)
	rows := window["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	row := rows[0].(map[string]any)
	if row["rowId"] != rsGen || row["latestActivitySeq"] != "1" || row["maxReadSeq"] != "0" {
		t.Fatalf("row = %+v", row)
	}

	code, body = env.serve("GET", "/api/channels/activity/difference?requestId=r", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest ||
		body["error"] != "requestId, canonical uint64 epoch/afterWatermark, and windowId=main are required" {
		t.Fatalf("difference validation = %d %+v", code, body)
	}
	code, body = env.serve("GET", "/api/channels/activity/difference?requestId=r&epoch=1x&afterWatermark=0",
		nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest {
		t.Fatalf("difference malformed epoch = %d", code)
	}
	watermark := body2String(body, "watermark")
	_ = watermark
	code, body = env.serve("GET",
		"/api/channels/activity/difference?requestId=r&epoch=1&afterWatermark=0&windowId=main",
		nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["type"] != "difference" {
		t.Fatalf("difference = %d %+v", code, body)
	}
	if body["fromSeq"] != "1" || body["nextFromSeq"] != nil {
		t.Fatalf("difference body = %+v", body)
	}
	code, body = env.serve("GET",
		"/api/channels/activity/difference?requestId=r&epoch=2&afterWatermark=0",
		nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusConflict || body["snapshotRequired"] != true {
		t.Fatalf("snapshotRequired = %d %+v", code, body)
	}
}

func body2String(body map[string]any, key string) string {
	if v, ok := body[key].(string); ok {
		return v
	}
	return ""
}

// TestReadstateHTTPInbox: the inbox envelope with real items/counts.
func TestReadstateHTTPInbox(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsBob, "hello")

	code, body := env.serve("GET", "/api/channels/inbox", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("inbox = %d", code)
	}
	items := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	item := items[0].(map[string]any)
	if item["channelId"] != rsGen || item["unreadCount"] != float64(1) || item["channelType"] != "channel" {
		t.Fatalf("item = %+v", item)
	}
	readState := item["readState"].(map[string]any)
	if readState["kind"] != "absent" {
		t.Fatalf("readState = %+v", readState)
	}
	if body["totalCount"] != float64(1) || body["totalUnreadCount"] != float64(1) || body["activeUnreadCount"] != float64(1) {
		t.Fatalf("counts = %+v", body)
	}
	groups := body["groups"].([]any)
	if len(groups) != 1 {
		t.Fatalf("groups = %+v", groups)
	}
	group := groups[0].(map[string]any)
	if group["channelId"] != rsGen || group["count"] != float64(1) {
		t.Fatalf("group = %+v", group)
	}

	// The Done/undone pair round-trips through the history list.
	code, _ = env.serve("POST", "/api/channels/inbox/done", map[string]any{
		"channelId": rsGen, "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("done = %d", code)
	}
	code, body = env.serve("GET", "/api/channels/inbox/done", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("done list = %d", code)
	}
	if items := body["items"].([]any); len(items) != 1 {
		t.Fatalf("done items = %+v", items)
	}
	code, _ = env.serve("POST", "/api/channels/inbox/undone", map[string]any{"channelId": rsGen},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusOK {
		t.Fatalf("undone = %d", code)
	}
	code, body = env.serve("GET", "/api/channels/inbox/done", nil, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || len(body["items"].([]any)) != 0 {
		t.Fatalf("done list after undone = %+v", body)
	}
}

// TestReadstateHTTPThreadDone: the thread Done route keeps its own matrix
// sentences and the residue receipt on the wire.
func TestReadstateHTTPThreadDone(t *testing.T) {
	env := newReadstateEnv(t)
	// Seed a thread with a parent message in #general.
	now := env.fixed.T.UnixMilli()
	if _, err := env.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, request_digest, created_at)
		VALUES ('rs-parent', ?, ?, 'user', ?, 'parent', 'chat', 'd', ?)`,
		rsWS, rsGen, rsAlice, now); err != nil {
		t.Fatal(err)
	}
	threadID := "cccccccc-cccc-4ccc-8ccc-cccccccccc09"
	if _, err := env.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
		VALUES (?, ?, 't', 'thread', 'rs-parent', ?)`, threadID, rsWS, now); err != nil {
		t.Fatal(err)
	}
	seq := env.message(threadID, rsBob, "reply")
	if _, err := env.db.Exec(`INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id,
		parent_message_id, followed_at, revision) VALUES (?, ?, ?, 'rs-parent', ?, 1)`,
		rsWS, rsAlice, threadID, now); err != nil {
		t.Fatal(err)
	}

	code, body := env.serve("POST", "/api/channels/threads/done", map[string]any{
		"threadChannelId": threadID,
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("thread done canonical = %d %+v", code, body)
	}
	// The Done thread still returns ok on the strict path within bounds.
	code, body = env.serve("POST", "/api/channels/threads/done", map[string]any{
		"threadChannelId": threadID, "throughActivitySeq": itoaHTTP(seq), "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("thread done strict = %d %+v", code, body)
	}
	// Non-thread scope.
	code, body = env.serve("POST", "/api/channels/threads/done", map[string]any{
		"threadChannelId": rsGen, "throughActivitySeq": "1", "frontierSpace": "storage",
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["code"] != "NOT_A_THREAD" {
		t.Fatalf("not a thread = %d %+v", code, body)
	}
	// Undone restores.
	code, body = env.serve("POST", "/api/channels/threads/undone", map[string]any{
		"threadChannelId": threadID,
	}, env.tokens[rsAlice], rsWS)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("thread undone = %d %+v", code, body)
	}
	// Missing id sentence.
	code, body = env.serve("POST", "/api/channels/threads/undone", map[string]any{},
		env.tokens[rsAlice], rsWS)
	if code != http.StatusBadRequest || body["error"] != "threadChannelId is required" {
		t.Fatalf("thread undone missing = %d %+v", code, body)
	}
}

// TestReadstateHTTPCrossWorkspace: a channel from another workspace keeps the
// merged 404 on every readstate route.
func TestReadstateHTTPCrossWorkspace(t *testing.T) {
	env := newReadstateEnv(t)
	// A channel in ws2 alice owns.
	if _, err := env.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccc77', ?, 'other', 'channel', 0)`, rsWS2); err != nil {
		t.Fatal(err)
	}
	code, body := env.serve("POST", "/api/channels/cccccccc-cccc-4ccc-8ccc-cccccccccc77/read",
		map[string]any{"seq": 1}, env.tokens[rsAlice], rsWS)
	if code != http.StatusNotFound || body["error"] != "Channel not found" {
		t.Fatalf("cross-workspace read = %d %+v", code, body)
	}
}

// TestReadstateHTTPMutedUnreadFilterRepro: the parent's group-11 repro at
// the HTTP layer — Bob fully read, muted at H+1, an ordinary new message:
// filter=unread must NOT include the channel while GET /channels/unread
// still reports the catch-up unread, and unmute never backfills.
func TestReadstateHTTPMutedUnreadFilterRepro(t *testing.T) {
	env := newReadstateEnv(t)
	env.message(rsGen, rsAlice, "history one")
	env.message(rsGen, rsAlice, "history two")

	code, body := env.serve("POST", "/api/channels/"+rsGen+"/read-all", nil, env.tokens[rsBob], rsWS)
	if code != http.StatusOK {
		t.Fatalf("read-all = %d %+v", code, body)
	}
	code, body = env.serve("PATCH", "/api/channels/"+rsGen+"/notification-settings",
		map[string]any{"activityMuted": true}, env.tokens[rsBob], rsWS)
	if code != http.StatusOK || body["muteFromSeq"] != float64(3) {
		t.Fatalf("mute = %d %+v", code, body)
	}
	env.message(rsGen, rsAlice, "ordinary while muted")

	code, body = env.serve("GET", "/api/channels/inbox?filter=unread", nil, env.tokens[rsBob], rsWS)
	if code != http.StatusOK {
		t.Fatalf("unread inbox = %d", code)
	}
	if items := body["items"].([]any); len(items) != 0 {
		t.Fatalf("muted ordinary message entered the unread Inbox: %+v", items)
	}
	if body["totalCount"] != float64(0) || body["totalUnreadCount"] != float64(0) {
		t.Fatalf("unread counts = %+v", body)
	}
	code, body = env.serve("GET", "/api/channels/unread", nil, env.tokens[rsBob], rsWS)
	if code != http.StatusOK || body[rsGen] != float64(1) {
		t.Fatalf("catch-up unread = %d %+v (must stay 1)", code, body)
	}

	// Unmute: still no Activity fact for the suppressed message.
	code, _ = env.serve("PATCH", "/api/channels/"+rsGen+"/notification-settings",
		map[string]any{"activityMuted": false}, env.tokens[rsBob], rsWS)
	if code != http.StatusOK {
		t.Fatalf("unmute = %d", code)
	}
	code, body = env.serve("GET", "/api/channels/inbox?filter=unread", nil, env.tokens[rsBob], rsWS)
	if code != http.StatusOK {
		t.Fatalf("post-unmute unread = %d", code)
	}
	if items := body["items"].([]any); len(items) != 0 {
		t.Fatalf("unmute backfilled suppressed facts: %+v", items)
	}
	// A NEW message after the unmute is an eligible fact again.
	env.message(rsGen, rsAlice, "after unmute")
	code, body = env.serve("GET", "/api/channels/inbox?filter=unread", nil, env.tokens[rsBob], rsWS)
	if code != http.StatusOK {
		t.Fatalf("post-unmute unread #2 = %d", code)
	}
	items := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("post-unmute eligible fact missing: %+v", items)
	}
	item := items[0].(map[string]any)
	if item["channelId"] != rsGen || item["unreadCount"] != float64(1) {
		t.Fatalf("post-unmute row = %+v", item)
	}
}
