// M4 composition-root wiring tests. These exercise the REAL app assembly
// (app.Build + messaging.register) — not hand-built handler doubles — so each
// one fails if its wiring is dropped from m4.go:
//
//   - the thread-reply read hook (the replier's own frontier advances in the
//     same commit as the reply),
//   - the DM readState seam (exact #632 union on the DM list/create exits),
//   - the M4ChannelProjector (real prefs/read/last-message snapshots on the
//     actual channel list/detail/create exits registered by app.Build).
//
// Everything runs through in-process recorders against real accounts,
// workspaces and channels — no TCP listener, so the suite also executes in
// sandboxes that forbid local binds.
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/mail"
)

type m4wEnv struct {
	t   *testing.T
	app *App
}

func newM4wEnv(t *testing.T) *m4wEnv {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	built, err := Build(Options{Config: testConfig(t, t.TempDir()), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = built.Close() })
	if _, err := os.Stat(built.Config.OutboxDir); err != nil {
		t.Fatalf("outbox not created: %v", err)
	}
	return &m4wEnv{t: t, app: built}
}

type m4wResponse struct {
	status int
	body   map[string]any
	raw    []byte
}

func (e *m4wEnv) serveMux(handler http.Handler, method, path string, body any, bearer, serverID string) m4wResponse {
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
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if serverID != "" {
		req.Header.Set("X-Server-Id", serverID)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") {
		_ = json.Unmarshal(rec.Body.Bytes(), &parsed)
	}
	return m4wResponse{status: rec.Code, body: parsed, raw: rec.Body.Bytes()}
}

// serve drives one request through the fully assembled app handler.
func (e *m4wEnv) serve(method, path string, body any, bearer, serverID string) m4wResponse {
	e.t.Helper()
	return e.serveMux(e.app.Handler, method, path, body, bearer, serverID)
}

// fullAccount registers + verifies + completes a profile through the real
// HTTP account flow and returns (userID, accessToken).
func (e *m4wEnv) fullAccount(email, username string) (string, string) {
	e.t.Helper()
	res := e.serve("POST", "/api/auth/register", map[string]any{
		"email":          email,
		"password":       "password-123",
		"acceptTerms":    true,
		"termsVersion":   auth.TermsVersionCurrent,
		"privacyVersion": auth.PrivacyVersionCurrent,
	}, "", "")
	if res.status != http.StatusOK {
		e.t.Fatalf("register %s: %d %s", email, res.status, res.raw)
	}
	userID := res.body["user"].(map[string]any)["id"].(string)
	accessToken := res.body["accessToken"].(string)
	ver := e.serve("POST", "/api/auth/verify-email", map[string]any{"token": e.verifyToken()}, "", "")
	if ver.status != http.StatusOK {
		e.t.Fatalf("verify-email %s: %d %s", email, ver.status, ver.raw)
	}
	cp := e.serve("POST", "/api/auth/me/complete-profile", map[string]any{
		"name": username, "displayName": "Display " + username,
	}, accessToken, "")
	if cp.status != http.StatusOK {
		e.t.Fatalf("complete-profile %s: %d %s", email, cp.status, cp.raw)
	}
	return userID, accessToken
}

// verifyToken reads the newest outbox verification link.
func (e *m4wEnv) verifyToken() string {
	e.t.Helper()
	entries, err := mail.ReadOutbox(e.app.Config.OutboxDir, 5)
	if err != nil || len(entries) == 0 {
		e.t.Fatalf("no outbox entries: %v", err)
	}
	for _, entry := range entries {
		for _, link := range entry.Links() {
			if idx := strings.Index(link, "?verify="); idx >= 0 {
				return link[idx+len("?verify="):]
			}
		}
	}
	e.t.Fatal("no verification link in outbox")
	return ""
}

// seedWorkspace seeds a real workspace row with an owner and a member.
func (e *m4wEnv) seedWorkspace(ownerID, memberID string) string {
	e.t.Helper()
	wsID := "m4w-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if _, err := e.app.DB.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
		wsID, "M4 Wiring Space", "m4w-space-"+wsID, ownerID, time.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
	if err := e.seedMembership(wsID, ownerID, "owner"); err != nil {
		e.t.Fatal(err)
	}
	if memberID != "" {
		if err := e.seedMembership(wsID, memberID, "member"); err != nil {
			e.t.Fatal(err)
		}
	}
	return wsID
}

func (e *m4wEnv) seedMembership(wsID, userID, role string) error {
	_, err := e.app.DB.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?,?,?,?,?)`,
		wsID, userID, role, 0, time.Now().UnixMilli())
	return err
}

// seedAnnouncement seeds the workspace's announcement system channel (the M3
// list path lazily ensures system channels; the M4 list path reads without
// ensure, so tests seed the row the migrations would have).
func (e *m4wEnv) seedAnnouncement(wsID string) string {
	e.t.Helper()
	id := "m4w-ann-" + wsID
	if _, err := e.app.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?,?,?,?,?,?)`, id, wsID, "announcement", "channel", "announcement", time.Now().UnixMilli()); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *m4wEnv) createChannel(token, wsID, name string) string {
	e.t.Helper()
	res := e.serve("POST", "/api/channels", map[string]any{"name": name, "visibility": "public"}, token, wsID)
	if res.status != http.StatusOK {
		e.t.Fatalf("create channel %s: %d %s", name, res.status, res.raw)
	}
	return res.body["id"].(string)
}

func (e *m4wEnv) joinChannel(token, wsID, channelID string) {
	e.t.Helper()
	res := e.serve("POST", "/api/channels/"+channelID+"/join", nil, token, wsID)
	if res.status != http.StatusOK {
		e.t.Fatalf("join channel: %d %s", res.status, res.raw)
	}
}

// sendMessage posts via the real v2 surface and returns the message object.
func (e *m4wEnv) sendMessage(token, wsID, channelID, content string) map[string]any {
	e.t.Helper()
	res := e.serve("POST", "/api/v2/messages", map[string]any{
		"channelId": channelID, "content": content,
	}, token, wsID)
	if res.status != http.StatusOK {
		e.t.Fatalf("send message: %d %s", res.status, res.raw)
	}
	msg, ok := res.body["message"].(map[string]any)
	if !ok {
		e.t.Fatalf("v2 send missing message envelope: %s", res.raw)
	}
	return msg
}

func (e *m4wEnv) readAll(token, wsID, channelID string) {
	e.t.Helper()
	res := e.serve("POST", "/api/channels/"+channelID+"/read-all", nil, token, wsID)
	if res.status != http.StatusOK {
		e.t.Fatalf("read-all: %d %s", res.status, res.raw)
	}
}

// readCursorOf reads one viewer cursor through the REAL readstate store of
// the REAL assembly, on one pinned snapshot.
func (e *m4wEnv) readCursorOf(userID, wsID, channelID string) int64 {
	e.t.Helper()
	var cursor int64
	err := db.WithReadSnapshot(context.Background(), e.app.DB, func(ex db.Executor) error {
		var err error
		cursor, err = e.app.chat.readstate.ReadCursorTx(context.Background(), ex, wsID, userID, channelID)
		return err
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return cursor
}

// m4wArray parses a bare JSON array response body.
func m4wArray(t *testing.T, res m4wResponse) []map[string]any {
	t.Helper()
	var rows []map[string]any
	if err := json.Unmarshal(res.raw, &rows); err != nil {
		t.Fatalf("expected a JSON array body: %v (%s)", err, res.raw)
	}
	return rows
}

// m4wRowsByID indexes an array body by row id.
func m4wRowsByID(t *testing.T, res m4wResponse) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, row := range m4wArray(t, res) {
		id, ok := row["id"].(string)
		if !ok {
			t.Fatalf("row without id: %v", row)
		}
		out[id] = row
	}
	return out
}

// m4wSeqString renders a JSON-number seq as the decimal string the #632
// union carries (maxReadSeq/latestActivity.seq are decimal strings).
func m4wSeqString(t *testing.T, v any) string {
	t.Helper()
	return strconv.FormatFloat(m4wNum(t, v), 'f', -1, 64)
}

func m4wNum(t *testing.T, v any) float64 {
	t.Helper()
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("expected JSON number, got %T %v", v, v)
	}
	return f
}

func m4wMap(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("expected JSON object, got %T %v", v, v)
	}
	return m
}

// TestM4WiringAssemblyCompleteness asserts the composition root cannot come
// up without its cross-module use cases: the messaging service (whose send
// step structurally pairs a NEW thread reply with the replier's own read
// advance in one transaction — there is no unwired seam anymore) and the
// channelview read model behind the list/detail/create exits. buildChat fails
// closed when either fact owner is missing; this guards against a silent
// regression back to optional seams.
func TestM4WiringAssemblyCompleteness(t *testing.T) {
	env := newM4wEnv(t)
	if env.app.chat == nil {
		t.Fatal("messaging runtime missing from the real assembly")
	}
	if env.app.chat.messaging == nil {
		t.Fatal("messaging use cases missing from the real assembly: a human reply would leave the replier's thread unread")
	}
	if env.app.chat.channelView == nil {
		t.Fatal("channelview read model missing from the real assembly: list/detail/create would have no viewer projection")
	}
}

// TestM4WiringThreadReplyAdvancesReplierCursor drives the full product path:
// Alice opens a thread with her first reply, Bob replies afterwards. The
// original pipeline pairs the replied auto-follow with markReadLatest
// (messageService.ts:2653/2759), so BOTH repliers' own frontiers advance to
// their own reply's seq — in the same commit as the reply. Without the wired
// hook, Bob's cursor stays 0 and Alice's earlier reply reads as his unread;
// with it, Bob's unread is 0 and Alice's frontier covers exactly her own
// reply (never Bob's).
func TestM4WiringThreadReplyAdvancesReplierCursor(t *testing.T) {
	env := newM4wEnv(t)
	aliceID, aliceToken := env.fullAccount("alice@m4w.test", "m4walice")
	bobID, bobToken := env.fullAccount("bob@m4w.test", "m4wbob")
	wsID := env.seedWorkspace(aliceID, bobID)

	channelID := env.createChannel(aliceToken, wsID, "wiring-lab")
	root := env.sendMessage(aliceToken, wsID, channelID, "root message")

	threadRes := env.serve("POST", "/api/channels/"+channelID+"/threads", map[string]any{
		"parentMessageId": root["id"], "content": "alice first reply",
	}, aliceToken, wsID)
	if threadRes.status != http.StatusOK {
		t.Fatalf("create thread: %d %s", threadRes.status, threadRes.raw)
	}
	threadID := threadRes.body["threadChannelId"].(string)
	aliceReplySeq := int64(m4wNum(t, env.serve("GET", "/api/messages/channel/"+threadID+"?limit=10", nil, aliceToken, wsID).body["messages"].([]any)[0].(map[string]any)["seq"]))

	// Bob joins the parent channel (posting requires real roster membership)
	// and replies in the thread.
	env.joinChannel(bobToken, wsID, channelID)
	bobReply := env.sendMessage(bobToken, wsID, threadID, "bob reply")
	bobReplySeq := int64(m4wNum(t, bobReply["seq"]))

	// Bob's frontier advanced to his own reply, covering Alice's earlier
	// reply: zero unread on the thread for Bob, on both the durable cursor
	// and the product thread-summary surface.
	if got := env.readCursorOf(bobID, wsID, threadID); got != bobReplySeq {
		t.Fatalf("bob thread cursor = %d, want his reply seq %d (reply must advance the replier's own frontier)", got, bobReplySeq)
	}
	bobSummary := env.threadSummary(bobToken, wsID, channelID, root["id"].(string))
	if got := m4wNum(t, bobSummary["unreadCount"]); got != 0 {
		t.Fatalf("bob thread unread = %v, want 0 after his own reply advanced the frontier", got)
	}

	// Alice's frontier covers exactly her own reply — her hook fired for HER
	// reply, and Bob's later reply must NOT advance her cursor (his unread).
	if got := env.readCursorOf(aliceID, wsID, threadID); got != aliceReplySeq {
		t.Fatalf("alice thread cursor = %d, want her own reply seq %d (never another user's)", got, aliceReplySeq)
	}
	aliceSummary := env.threadSummary(aliceToken, wsID, channelID, root["id"].(string))
	if got := m4wNum(t, aliceSummary["unreadCount"]); got != 1 {
		t.Fatalf("alice thread unread = %v, want 1 (bob's reply stays unread for her)", got)
	}
}

// threadSummary fetches one parent's ThreadSummary through the real surface.
func (e *m4wEnv) threadSummary(token, wsID, channelID, parentMessageID string) map[string]any {
	e.t.Helper()
	res := e.serve("GET", "/api/channels/"+channelID+"/threads?parentMessageIds="+parentMessageID, nil, token, wsID)
	if res.status != http.StatusOK {
		e.t.Fatalf("thread summaries: %d %s", res.status, res.raw)
	}
	byParent := m4wMap(e.t, res.body)
	summary, ok := byParent[parentMessageID].(map[string]any)
	if !ok {
		e.t.Fatalf("thread summary missing parent %s: %s", parentMessageID, res.raw)
	}
	return summary
}

// TestM4WiringDMReadStateUnion drives the DM list/create exits through the
// real app: without the DMReadState wiring the readState key is omitted
// entirely; with it, the row carries the exact #632 union — absent before any
// read, present (version number, decimal-string maxReadSeq, same-source
// latestActivity pair) after read-all.
func TestM4WiringDMReadStateUnion(t *testing.T) {
	env := newM4wEnv(t)
	aliceID, aliceToken := env.fullAccount("dmalice@m4w.test", "m4wdmalice")
	bobID, bobToken := env.fullAccount("dmbob@m4w.test", "m4wdmbob")
	wsID := env.seedWorkspace(aliceID, bobID)

	// Auth seam first: the DM surface stays behind the real gate.
	if res := env.serve("GET", "/api/channels/dm", nil, "", wsID); res.status != http.StatusUnauthorized {
		t.Fatalf("DM list without token = %d, want 401", res.status)
	}

	create := env.serve("POST", "/api/channels/dm", map[string]any{"userId": bobID}, aliceToken, wsID)
	if create.status != http.StatusOK {
		t.Fatalf("create DM: %d %s", create.status, create.raw)
	}
	dmID := create.body["id"].(string)
	if rs, ok := create.body["readState"]; !ok || m4wMap(t, rs)["kind"] != "absent" {
		t.Fatalf("created DM readState = %v, want exact absent union", create.body["readState"])
	}

	msg := env.sendMessage(aliceToken, wsID, dmID, "hello bob")

	// Bob has not read yet: his DM row stays structurally absent.
	list := env.serve("GET", "/api/channels/dm", nil, bobToken, wsID)
	if list.status != http.StatusOK {
		t.Fatalf("bob DM list: %d %s", list.status, list.raw)
	}
	bobRows := m4wRowsByID(t, list)
	bobRow, ok := bobRows[dmID]
	if !ok {
		t.Fatalf("bob DM list missing the dm row: %s", list.raw)
	}
	if rs, ok := bobRow["readState"]; !ok || m4wMap(t, rs)["kind"] != "absent" {
		t.Fatalf("unread DM readState = %v, want exact absent union", bobRow["readState"])
	}

	// After read-all, Bob's DM row carries the present union with the
	// same-source latestActivity pair.
	env.readAll(bobToken, wsID, dmID)
	list = env.serve("GET", "/api/channels/dm", nil, bobToken, wsID)
	if list.status != http.StatusOK {
		t.Fatalf("bob DM list after read: %d %s", list.status, list.raw)
	}
	found := false
	for _, row := range m4wRowsByID(t, list) {
		if row["id"] != dmID {
			continue
		}
		found = true
		rs, ok := row["readState"].(map[string]any)
		if !ok {
			t.Fatalf("read DM row missing readState (DMReadState seam not wired): %s", list.raw)
		}
		if rs["kind"] != "present" {
			t.Fatalf("read DM readState kind = %v, want present", rs["kind"])
		}
		if got, want := rs["maxReadSeq"], m4wSeqString(t, msg["seq"]); got != want {
			t.Fatalf("read DM maxReadSeq = %v (%T), want the read message seq %s", got, got, want)
		}
		if v := m4wNum(t, rs["readStateVersion"]); v < 1 {
			t.Fatalf("read DM readStateVersion = %v, want >= 1", v)
		}
		latest := m4wMap(t, rs["latestActivity"])
		if latest["messageId"] != msg["id"] {
			t.Fatalf("read DM latestActivity.messageId = %v, want %v", latest["messageId"], msg["id"])
		}
		if latest["seq"] != m4wSeqString(t, msg["seq"]) {
			t.Fatalf("read DM latestActivity.seq = %v, want %v", latest["seq"], m4wSeqString(t, msg["seq"]))
		}
	}
	if !found {
		t.Fatalf("bob DM list after read missing the dm row: %s", list.raw)
	}
}

// TestM4WiringChannelProjectionExits asserts the projector's real snapshots
// on the list/detail/create exits: real read frontier and versions, real
// mute/display values (including the announcement default mute and the
// muted boundary's null/number distinction), the list-only last-message
// facts, the create exit's fresh-scope empty state without display or
// last-message keys, and cross-workspace isolation of viewer residue.
// Unwired (M3 fallback) or a broken projector fails these: the muted channel
// would read activityMuted:false and lastMessageAt:null over real state.
func TestM4WiringChannelProjectionExits(t *testing.T) {
	env := newM4wEnv(t)
	aliceID, aliceToken := env.fullAccount("projalice@m4w.test", "m4wprojalice")
	bobID, _ := env.fullAccount("projbob@m4w.test", "m4wprojbob")
	wsID := env.seedWorkspace(aliceID, bobID)

	generalID := env.createChannel(aliceToken, wsID, "general")
	quietID := env.createChannel(aliceToken, wsID, "quiet")
	announcementID := env.seedAnnouncement(wsID)

	lastMsg := env.sendMessage(aliceToken, wsID, generalID, "latest in general")
	env.readAll(aliceToken, wsID, generalID)

	// Real mute and display facts through the real PATCH surfaces.
	muteRes := env.serve("PATCH", "/api/channels/"+generalID+"/notification-settings",
		map[string]any{"activityMuted": true}, aliceToken, wsID)
	if muteRes.status != http.StatusOK {
		t.Fatalf("mute general: %d %s", muteRes.status, muteRes.raw)
	}
	displayRes := env.serve("PATCH", "/api/channels/"+generalID+"/message-display-settings",
		map[string]any{"collapseLongMessages": false}, aliceToken, wsID)
	if displayRes.status != http.StatusOK {
		t.Fatalf("display general: %d %s", displayRes.status, displayRes.raw)
	}

	// List: real projections on one pinned snapshot.
	list := env.serve("GET", "/api/channels", nil, aliceToken, wsID)
	if list.status != http.StatusOK {
		t.Fatalf("channel list: %d %s", list.status, list.raw)
	}
	rows := m4wRowsByID(t, list)
	if len(rows) < 3 {
		t.Fatalf("channel list must include general/quiet/announcement: %s", list.raw)
	}

	general := rows[generalID]
	if rs := m4wMap(t, general["readState"]); rs["kind"] != "present" {
		t.Fatalf("general readState = %v, want present after read-all", general["readState"])
	} else if rs["maxReadSeq"] != m4wSeqString(t, lastMsg["seq"]) {
		t.Fatalf("general maxReadSeq = %v, want %v", rs["maxReadSeq"], m4wSeqString(t, lastMsg["seq"]))
	}
	if v := m4wNum(t, general["readStateVersion"]); v < 1 {
		t.Fatalf("general readStateVersion = %v, want >= 1", v)
	}
	if v := m4wNum(t, general["maxReadSeq"]); int64(v) != int64(m4wNum(t, lastMsg["seq"])) {
		t.Fatalf("general legacy maxReadSeq = %v, want %v", v, lastMsg["seq"])
	}
	if muted := general["activityMuted"]; muted != true {
		t.Fatalf("general activityMuted = %v, want true (real muted state, not the M3 default)", muted)
	}
	if from := general["muteFromSeq"]; from == nil || from == "null" {
		t.Fatalf("general muteFromSeq = %v, want the real boundary number", from)
	} else if _, err := strconv.ParseFloat(fmt.Sprint(from), 64); err != nil {
		t.Fatalf("general muteFromSeq = %v, want a number: %v", from, err)
	}
	if v := m4wNum(t, general["prefsVersion"]); v < 1 {
		t.Fatalf("general prefsVersion = %v, want >= 1", v)
	}
	if general["collapseLongMessages"] != false {
		t.Fatalf("general collapseLongMessages = %v, want false (real display state)", general["collapseLongMessages"])
	}
	if v := m4wNum(t, general["displayPrefsVersion"]); v < 1 {
		t.Fatalf("general displayPrefsVersion = %v, want >= 1", v)
	}
	if lma, ok := general["lastMessageAt"].(string); !ok || !strings.HasSuffix(lma, "Z") {
		t.Fatalf("general lastMessageAt = %v, want an ISO millis timestamp", general["lastMessageAt"])
	}

	quiet := rows[quietID]
	if rs := m4wMap(t, quiet["readState"]); rs["kind"] != "absent" {
		t.Fatalf("quiet readState = %v, want absent", quiet["readState"])
	}
	if v := m4wNum(t, quiet["maxReadSeq"]); v != 0 {
		t.Fatalf("quiet legacy maxReadSeq = %v, want 0", v)
	}
	if quiet["activityMuted"] != false {
		t.Fatalf("quiet activityMuted = %v, want false", quiet["activityMuted"])
	}
	if quiet["muteFromSeq"] != nil && quiet["muteFromSeq"] != "null" {
		// json.RawMessage("null") unmarshals to a nil any with presence; both
		// shapes are acceptable, a real boundary number is not.
		t.Fatalf("quiet muteFromSeq = %v (%T), want null/omitted", quiet["muteFromSeq"], quiet["muteFromSeq"])
	}
	if quiet["lastMessageAt"] != nil && quiet["lastMessageAt"] != "null" {
		t.Fatalf("quiet lastMessageAt = %v, want null (no messages)", quiet["lastMessageAt"])
	}

	ann := rows[announcementID]
	if ann["activityMuted"] != true {
		t.Fatalf("announcement activityMuted = %v, want the legacy default mute true", ann["activityMuted"])
	}
	if from := ann["muteFromSeq"]; fmt.Sprint(from) != "0" {
		t.Fatalf("announcement muteFromSeq = %v, want 0 (boundary zero, not null)", from)
	}
	if v := m4wNum(t, ann["prefsVersion"]); v != 0 {
		t.Fatalf("announcement prefsVersion = %v, want 0", v)
	}

	// Detail: viewer state present, list-only last-message key absent.
	detail := env.serve("GET", "/api/channels/"+generalID, nil, aliceToken, wsID)
	if detail.status != http.StatusOK {
		t.Fatalf("channel detail: %d %s", detail.status, detail.raw)
	}
	detailRow := detail.body
	if rs := m4wMap(t, detailRow["readState"]); rs["kind"] != "present" {
		t.Fatalf("detail readState = %v, want present", detailRow["readState"])
	}
	if detailRow["activityMuted"] != true {
		t.Fatalf("detail activityMuted = %v, want true", detailRow["activityMuted"])
	}
	if _, has := detailRow["lastMessageAt"]; has {
		t.Fatal("detail must not carry the list-only lastMessageAt key")
	}

	// Create: fresh-scope empty state, no display or last-message keys.
	createRes := env.serve("POST", "/api/channels", map[string]any{"name": "fresh", "visibility": "public"}, aliceToken, wsID)
	if createRes.status != http.StatusOK {
		t.Fatalf("create via wired exits: %d %s", createRes.status, createRes.raw)
	}
	created := createRes.body
	if rs := m4wMap(t, created["readState"]); rs["kind"] != "absent" {
		t.Fatalf("created readState = %v, want absent", created["readState"])
	}
	if v := m4wNum(t, created["maxReadSeq"]); v != 0 {
		t.Fatalf("created maxReadSeq = %v, want 0", v)
	}
	if created["activityMuted"] != false {
		t.Fatalf("created activityMuted = %v, want false", created["activityMuted"])
	}
	for _, key := range []string{"collapseLongMessages", "displayPrefsVersion", "lastMessageAt", "lastMessagePreview"} {
		if _, has := created[key]; has {
			t.Fatalf("created exit must not carry %s", key)
		}
	}

	// Cross-workspace isolation: alice's read/mute residue in ws1 never
	// projects into another workspace's rows.
	ws2 := "m4w2-" + fmt.Sprintf("%06d", time.Now().UnixNano()%1000000)
	if _, err := env.app.DB.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
		ws2, "M4 Wiring Space 2", "m4w-space-2-"+ws2, aliceID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := env.seedMembership(ws2, aliceID, "owner"); err != nil {
		t.Fatal(err)
	}
	ws2Channel := env.createChannel(aliceToken, ws2, "other-space")
	list2 := env.serve("GET", "/api/channels", nil, aliceToken, ws2)
	if list2.status != http.StatusOK {
		t.Fatalf("ws2 channel list: %d %s", list2.status, list2.raw)
	}
	for _, row := range m4wRowsByID(t, list2) {
		if row["id"] != ws2Channel {
			continue
		}
		if rs := m4wMap(t, row["readState"]); rs["kind"] != "absent" {
			t.Fatalf("ws2 row readState = %v, want absent (ws1 residue must not leak)", row["readState"])
		}
		if row["activityMuted"] != false {
			t.Fatalf("ws2 row activityMuted = %v, want false", row["activityMuted"])
		}
	}
}
