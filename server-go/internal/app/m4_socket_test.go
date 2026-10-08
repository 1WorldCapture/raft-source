package app

// In-process M4 realtime protocol/state/negative tests. These drive the REAL
// gateway assembly (verified-JWT handshake, authority fence/guard, channel
// room barrier, resume, heartbeat, eviction wake, outbox publisher) through
// an injected Transport — the same code path production uses below the wire
// binding. The child sandbox denies local port binds, so the real
// socket.io-client interop against the zishang Engine.IO binding is run by
// the parent (tests/acceptance/m4-socket-poc.mjs); the pre-library HTTP
// guards of the real binding ARE exercised here with a recorder.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Fixed identities (same shape as the sibling worker fixtures).
const (
	rtAlice   = "11111111-1111-4111-8111-111111111111"
	rtBob     = "22222222-2222-4222-8222-222222222222"
	rtCara    = "33333333-3333-4333-8333-333333333333"
	rtWS      = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	rtWS2     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	rtFamA    = "fa111111-1111-4111-8111-111111111111"
	rtFamB    = "fa222222-2222-4222-8222-222222222222"
	rtFamC    = "fa333333-3333-4333-8333-333333333333"
	rtGeneral = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	rtSecret  = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

const rtSecretKey = "rt-test-secret-0123456789abcdef0123456789abcdef"

var rtFamilies = map[string]string{rtAlice: rtFamA, rtBob: rtFamB, rtCara: rtFamC}

// recordingTransport implements socketio.Transport for the in-process
// harness: frames land in per-connection buffers, close-requests are counted
// and fail subsequent emits (the drainer then exits, exactly like a real
// transport going away).
type recordingTransport struct {
	mu      sync.Mutex
	emitted map[string][]core.Frame
	closed  map[string]int
	dead    map[string]bool
}

func newRecordingTransport() *recordingTransport {
	return &recordingTransport{
		emitted: map[string][]core.Frame{},
		closed:  map[string]int{},
		dead:    map[string]bool{},
	}
}

func (f *recordingTransport) CanAccept(string) bool { return true }

func (f *recordingTransport) Emit(id string, fr core.Frame) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dead[id] {
		return false
	}
	f.emitted[id] = append(f.emitted[id], fr)
	return true
}

func (f *recordingTransport) CloseTransport(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed[id]++
	f.dead[id] = true
}

func (f *recordingTransport) CloseAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id := range f.emitted {
		f.dead[id] = true
		f.closed[id]++
	}
}

func (f *recordingTransport) frames(id string) []core.Frame {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]core.Frame(nil), f.emitted[id]...)
}

func (f *recordingTransport) events(id string) []string {
	var out []string
	for _, fr := range f.frames(id) {
		out = append(out, fr.Event)
	}
	return out
}

func (f *recordingTransport) payloads(id, event string) []json.RawMessage {
	var out []json.RawMessage
	for _, fr := range f.frames(id) {
		if fr.Event == event {
			out = append(out, fr.Payload)
		}
	}
	return out
}

func (f *recordingTransport) closeCount(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed[id]
}

// rtFixture is one temp database with the real migration set, the real m4
// runtime (channel/message/readstate stores) and the assembled realtime
// surface over the recording transport.
type rtFixture struct {
	t         *testing.T
	handle    *sql.DB
	runtime   *m4Runtime
	signer    *auth.TokenSigner
	rt        *m4Realtime
	transport *recordingTransport
}

func newRTFixture(t *testing.T, mutate func(*m4RealtimeConfig)) *rtFixture {
	t.Helper()
	handle, err := db.Open(t.TempDir() + "/raft.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStoreWithOptions(handle, channel.Options{})
	runtime, err := buildM4(handle, channels, keys.NewRoot([]byte(rtSecretKey)))
	if err != nil {
		t.Fatalf("buildM4: %v", err)
	}
	signer := auth.NewTokenSigner([]byte(rtSecretKey), 15*time.Minute)
	logDest := io.Discard
	if os.Getenv("RT_TEST_LOGS") != "" {
		logDest = os.Stderr
	}
	cfg := m4RealtimeConfig{Logger: slog.New(slog.NewTextHandler(logDest, nil)), Origins: []string{"https://app.example"}}
	if mutate != nil {
		mutate(&cfg)
	}
	transport := newRecordingTransport()
	rt, err := assembleM4Realtime(runtime, signer, cfg, transport)
	if err != nil {
		t.Fatalf("assembleM4Realtime: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	f := &rtFixture{t: t, handle: handle, runtime: runtime, signer: signer, rt: rt, transport: transport}
	f.seed()
	return f
}

func (f *rtFixture) seed() {
	f.t.Helper()
	now := time.Now().UnixMilli()
	// Seeding goes through db.WithWriteTx like every production authority
	// writer, so the seed-time authority epochs are captured by the fence
	// watermark instead of surfacing as "fresh" changes on the first test
	// commit (which would evict unrelated sockets).
	err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		for _, u := range []struct{ id, name string }{
			{rtAlice, "alice"}, {rtBob, "bob"}, {rtCara, "cara"},
		} {
			if _, err := tx.Exec(`INSERT INTO users (id, email, name, display_name, password_hash, email_verified, created_at, updated_at)
				VALUES (?,?,?,?,?,1,?,?)`, u.id, u.name+"@example.test", u.name, u.name, "x", now, now); err != nil {
				return err
			}
		}
		for userID, family := range rtFamilies {
			if _, err := tx.Exec(`INSERT INTO session_families (id, user_id, created_at) VALUES (?,?,?)`,
				family, userID, now); err != nil {
				return err
			}
		}
		for _, ws := range []struct{ id, slug, owner string }{{rtWS, "alpha", rtAlice}, {rtWS2, "beta", rtBob}} {
			if _, err := tx.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
				ws.id, "WS "+ws.slug, ws.slug, ws.owner, now); err != nil {
				return err
			}
		}
		for _, m := range []struct{ ws, user, role string }{
			{rtWS, rtAlice, "owner"}, {rtWS, rtBob, "member"}, {rtWS, rtCara, "member"},
			{rtWS2, rtBob, "owner"},
		} {
			if _, err := tx.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
				VALUES (?,?,?,0,?)`, m.ws, m.user, m.role, now); err != nil {
				return err
			}
		}
		for _, c := range []struct {
			id, name, kind string
			members        []string
		}{
			{rtGeneral, "general", "channel", []string{rtAlice, rtBob, rtCara}},
			{rtSecret, "secret", "private", []string{rtAlice, rtBob}},
		} {
			if _, err := tx.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?,?,?,?,?)`,
				c.id, rtWS, c.name, c.kind, now); err != nil {
				return err
			}
			for _, m := range c.members {
				if _, err := tx.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?,?,'member',?)`,
					c.id, m, now); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		f.t.Fatalf("seed: %v", err)
	}
}

// token signs a real access token for the seeded user.
func (f *rtFixture) token(user string) string {
	f.t.Helper()
	tok, err := f.signer.SignAccessToken(user, rtFamilies[user])
	if err != nil {
		f.t.Fatal(err)
	}
	return tok
}

func rtClaims(user string) auth.AccessTokenClaims {
	family := rtFamilies[user]
	return auth.AccessTokenClaims{Subject: user, Type: "access", FamilyID: family,
		IssuedAt: time.Now().Add(-time.Minute), ExpiresAt: time.Now().Add(14 * time.Minute)}
}

// connect admits + opens one connection and waits for the authorized room
// barrier (workspace-bound connections only).
func (f *rtFixture) connect(connID, user, workspace string) core.Identity {
	f.t.Helper()
	authObj := map[string]any{"token": f.token(user), "clientKind": "web", "serverId": nil}
	if workspace != "" {
		authObj["serverId"] = workspace
	}
	req := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
	identity, err := f.rt.gateway.Admit(context.Background(), connID, req, authObj)
	if err != nil {
		f.t.Fatalf("admit %s: %v", connID, err)
	}
	f.rt.gateway.Opened(connID)
	if workspace != "" {
		// Wait well past the server's own barrier budget (10s fail-closed):
		// this checkout is shared with actively compiling workers, and a
		// machine-wide CPU spike must not be misread as a hang; the server
		// still enforces its own bound and drops wedged connections.
		rtWaitUntil(f.t, 25*time.Second, func() bool {
			return slicesContains(f.transport.events(connID), core.EventRoomsJoined)
		}, "rooms:joined barrier for "+connID)
	}
	return *identity
}

// admit attempts a handshake and returns its error.
func (f *rtFixture) admitErr(connID string, authObj map[string]any) error {
	req := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
	_, err := f.rt.gateway.Admit(context.Background(), connID, req, authObj)
	return err
}

// send sends one raw client event.
func (f *rtFixture) send(connID, event string, payload any) {
	f.t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		f.t.Fatal(err)
	}
	f.rt.gateway.InboundEvent(context.Background(), connID, event, []json.RawMessage{raw})
}

// create sends a real message through the message store (commit listener
// wakes the outbox worker on return).
func (f *rtFixture) create(user, channelID, content string) *message.Message {
	f.t.Helper()
	created, err := f.runtime.messages.Create(context.Background(), rtClaims(user), rtWS,
		message.CreateInput{ChannelID: channelID, Content: content})
	if err != nil {
		f.t.Fatalf("create message: %v", err)
	}
	return created.Message
}

func slicesContains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func rtWaitUntil(t *testing.T, timeout time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", msg)
}

// ---- handshake -----------------------------------------------------------

func TestM4RealtimeHandshakeAdmitsMemberAndJoinsRooms(t *testing.T) {
	f := newRTFixture(t, nil)
	id := f.connect("c1", rtBob, rtWS)
	if id.UserID != rtBob || id.WorkspaceID != rtWS || id.ServerRole != "member" {
		t.Fatalf("identity: %+v", id)
	}
	if id.TokenExpiresAt.IsZero() || !id.TokenExpiresAt.After(time.Now()) {
		t.Fatalf("token proof not frozen: %+v", id)
	}
	// The barrier joins the current subscription rooms (public channel for a
	// member; private channel by roster). rooms:joined arrives exactly after.
	events := f.transport.events("c1")
	joined := false
	for _, ev := range events {
		if ev == core.EventRoomsJoined {
			joined = true
		}
	}
	if !joined {
		t.Fatalf("rooms:joined missing: %v", events)
	}
	stats := f.rt.Stats()
	if stats.Gateway.Admitted != 1 || stats.Gateway.RejectedAuth != 0 {
		t.Fatalf("gateway stats: %+v", stats.Gateway)
	}
}

func TestM4RealtimeAccountLevelConnectionGetsNoWorkspaceStream(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("acct", rtBob, "")
	// No serverId: user rooms only, never a resume stream. Give the barrier
	// goroutine a moment to (wrongly) emit, then assert it did not.
	time.Sleep(50 * time.Millisecond)
	for _, ev := range f.transport.events("acct") {
		if ev == core.EventRoomsJoined {
			t.Fatalf("account-level connection must not receive rooms:joined: %v", f.transport.events("acct"))
		}
	}
	// sync:resume from an account-level connection is ignored.
	f.send("acct", core.EventSyncResume, map[string]any{"lastSeq": 0})
	time.Sleep(20 * time.Millisecond)
	if got := f.transport.payloads("acct", core.EventSyncResumeResp); len(got) != 0 {
		t.Fatalf("account-level resume served: %v", got)
	}
}

func TestM4RealtimeHandshakeClassification(t *testing.T) {
	f := newRTFixture(t, nil)

	// Validly signed token of the wrong purpose (type != access): the
	// original client's refresh trigger, derived only from a verified JWT.
	wrongType, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": rtBob, "type": "refresh", "iss": "raft-go", "aud": "raft-web",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(rtSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.admitErr("x1", map[string]any{"token": wrongType, "clientKind": "web", "serverId": rtWS}); err == nil || err.Error() != core.ReasonInvalidTokenType {
		t.Fatalf("wrong type: %v", err)
	}

	// Expired access token.
	expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": rtBob, "type": "access", "iss": "raft-go", "aud": "raft-web",
		"familyId": rtFamB, "iat": time.Now().Add(-time.Hour).Unix(), "exp": time.Now().Add(-time.Minute).Unix(),
	}).SignedString([]byte(rtSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.admitErr("x2", map[string]any{"token": expired, "clientKind": "web", "serverId": rtWS}); err == nil || err.Error() != core.ReasonInvalidOrExpiredToken {
		t.Fatalf("expired: %v", err)
	}

	// Foreign signature.
	if err := f.admitErr("x3", map[string]any{"token": "not-a-jwt", "clientKind": "web", "serverId": rtWS}); err == nil || err.Error() != core.ReasonInvalidOrExpiredToken {
		t.Fatalf("garbage: %v", err)
	}

	// Well-formed token, workspace the user does not belong to.
	otherWS, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": rtCara, "type": "access", "iss": "raft-go", "aud": "raft-web",
		"familyId": rtFamC, "iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(rtSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.admitErr("x4", map[string]any{"token": otherWS, "clientKind": "web", "serverId": rtWS2}); err == nil || err.Error() != core.ReasonNotAMember {
		t.Fatalf("non-member: %v", err)
	}

	// Revoked session family: ValidateHumanTx fails inside Authenticate.
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`, time.Now().UnixMilli(), rtFamC)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	revoked, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": rtCara, "type": "access", "iss": "raft-go", "aud": "raft-web",
		"familyId": rtFamC, "iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(rtSecretKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.admitErr("x5", map[string]any{"token": revoked, "clientKind": "web", "serverId": rtWS}); err == nil || err.Error() != core.ReasonInvalidOrExpiredToken {
		t.Fatalf("revoked family: %v", err)
	}
}

func TestM4RealtimePerConnectionTokenExpiry(t *testing.T) {
	f := newRTFixture(t, nil)
	// A token that expires almost immediately still admits (it is valid
	// now). The connection then dies at its OWN expiry — the enqueue-time
	// token check closes it on the next authorized publish, and a newer
	// token for the same family does not extend it. This does not race the
	// room barrier: expiry is enforced on the publish path itself.
	shortSigner := auth.NewTokenSigner([]byte(rtSecretKey), 2*time.Second)
	tok, err := shortSigner.SignAccessToken(rtBob, rtFamB)
	if err != nil {
		t.Fatal(err)
	}
	authObj := map[string]any{"token": tok, "clientKind": "web", "serverId": rtWS}
	req := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
	if _, err := f.rt.gateway.Admit(context.Background(), "short", req, authObj); err != nil {
		t.Fatalf("admit short token: %v", err)
	}
	f.rt.gateway.Opened("short")

	// Let the connection's own proof expire; issue a brand-new (longer-lived)
	// token for the same family — the old connection must still die.
	time.Sleep(2300 * time.Millisecond)
	if _, err := f.signer.SignAccessToken(rtBob, rtFamB); err != nil {
		t.Fatal(err)
	}

	// Any authorized publish to the workspace now finds the expired
	// connection: enqueue refuses (exact token expiry) and the transport is
	// closed instead of silently starved.
	deliverAndWait := func() {
		audience, exists, err := f.rt.pub.resolveConversationAudience(context.Background(), rtWS, rtGeneral)
		if err != nil || !exists {
			t.Fatalf("audience: %v %v", exists, err)
		}
		f.rt.pub.deliver(audience, rtWS, core.EventHeartbeat, map[string]any{"seq": 0})
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if f.transport.closeCount("short") > 0 {
			return // closed at its own token expiry, not extended
		}
		deliverAndWait()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("connection with an expired token was never closed (newer-token bypass?)")
}

func TestM4RealtimeFamilyRevocationEvictsOnlyThatFamily(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob", rtBob, rtWS)
	f.connect("cara", rtCara, rtWS)

	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`, time.Now().UnixMilli(), rtFamB)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 5*time.Second, func() bool { return f.transport.closeCount("bob") > 0 }, "bob evicted after family revocation")
	// Family isolation: other users' families keep their sockets.
	time.Sleep(100 * time.Millisecond)
	if f.transport.closeCount("alice") != 0 || f.transport.closeCount("cara") != 0 {
		t.Fatalf("family isolation broken: alice=%d cara=%d", f.transport.closeCount("alice"), f.transport.closeCount("cara"))
	}
	// The eviction is not the only defense: the fence closed publish
	// eligibility too (admission of a fresh handshake with the revoked
	// family must fail).
	if err := f.admitErr("bob2", map[string]any{"token": f.token(rtBob), "clientKind": "web", "serverId": rtWS}); err == nil || err.Error() != core.ReasonInvalidOrExpiredToken {
		t.Fatalf("re-admit with revoked family: %v", err)
	}
}

func TestM4RealtimeWorkspaceAuthorityChangeEvictsWorkspaceSockets(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("alice", rtAlice, rtWS)
	f.connect("bob-ws2", rtBob, rtWS2)

	// A channel mutation inside the workspace bumps the workspace epoch.
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE channels SET name = 'general-renamed' WHERE id = ?`, rtGeneral)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 5*time.Second, func() bool { return f.transport.closeCount("alice") > 0 }, "workspace sockets evicted")
	if f.transport.closeCount("bob-ws2") != 0 {
		t.Fatalf("other workspace affected: %d", f.transport.closeCount("bob-ws2"))
	}
}

func TestM4RealtimeThreadUnfollowEvictsUserSockets(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		thread, err := f.runtime.channels.EnsureThreadTx(context.Background(), tx, rtWS, rtGeneral, parent.ID, rtAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.connect("bob", rtBob, rtWS)
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		return f.runtime.channels.SetThreadFollowTx(context.Background(), tx, rtWS, threadID, rtBob, true, false)
	}); err != nil {
		t.Fatal(err)
	}
	rtWaitUntil(t, 5*time.Second, func() bool { return f.transport.closeCount("bob") > 0 },
		"follow-change authority bump evicts the user's sockets (conservative by design)")
}

// ---- join / resume / heartbeat -------------------------------------------

func TestM4RealtimeJoinChannelAuthorization(t *testing.T) {
	f := newRTFixture(t, nil)
	f.connect("bob", rtBob, rtWS)

	f.send("bob", core.EventJoinChannel, rtGeneral)                              // public channel: allowed
	f.send("bob", core.EventJoinChannel, rtSecret)                               // private channel, roster member: allowed
	f.send("bob", core.EventJoinChannel, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee") // unknown: denied
	before := f.rt.Stats().Gateway
	if before.JoinAllowed != 2 || before.JoinDenied != 1 {
		t.Fatalf("join stats: %+v", before)
	}
}

func TestM4RealtimeResumeServesVisiblePagesWithByteBudget(t *testing.T) {
	f := newRTFixture(t, nil)
	// Long CJK bodies: each ~90000 UTF-8 bytes, so a 500-message page would
	// dwarf the 1 MiB queue budget and the provider must cut a truthful
	// byte-bounded prefix.
	body := strings.Repeat("界", 30000)
	var lastSeq int64
	first := f.create(rtAlice, rtGeneral, body)
	for i := 0; i < 12; i++ {
		m := f.create(rtAlice, rtGeneral, body)
		lastSeq = m.Seq
	}
	f.connect("bob", rtBob, rtWS)
	// lastSeq 0 is deliberately ignored by the gateway (never replay from an
	// unverified cursor); resume from the first committed seq.
	f.send("bob", core.EventSyncResume, map[string]any{"lastSeq": first.Seq})

	var page struct {
		Messages   []map[string]any `json:"messages"`
		CurrentSeq int64            `json:"currentSeq"`
		HasMore    bool             `json:"hasMore"`
	}
	rtWaitUntil(t, 5*time.Second, func() bool {
		pages := f.transport.payloads("bob", core.EventSyncResumeResp)
		if len(pages) == 0 {
			return false
		}
		if err := json.Unmarshal(pages[len(pages)-1], &page); err != nil {
			t.Fatalf("resume page: %v", err)
		}
		return true
	}, "first resume page")
	if len(page.Messages) < 1 || len(page.Messages) > 11 {
		t.Fatalf("byte budget not honored: %d messages", len(page.Messages))
	}
	if !page.HasMore {
		t.Fatalf("cut page must report hasMore (12 backlogged, %d delivered)", len(page.Messages))
	}
	if page.CurrentSeq <= 0 || page.CurrentSeq >= lastSeq {
		t.Fatalf("currentSeq must be the last INCLUDED row's seq: %d (last %d)", page.CurrentSeq, lastSeq)
	}
	for _, m := range page.Messages {
		// The resume surface mirrors the original syncMessages enrichment:
		// storage-only columns are present but sealed to null for human
		// messages (the strict key-absent sealing applies to the
		// message:new/message:updated events, asserted in the publication
		// tests).
		if m["searchText"] != nil || m["agentSendKey"] != nil {
			t.Fatalf("storage columns must be sealed to null on resume rows")
		}
		if _, ok := m["seq"]; !ok {
			t.Fatalf("canonical seq missing from resume row")
		}
	}

	// The client continues from currentSeq and completes the backlog.
	f.send("bob", core.EventSyncResume, map[string]any{"lastSeq": page.CurrentSeq})
	rtWaitUntil(t, 5*time.Second, func() bool {
		pages := f.transport.payloads("bob", core.EventSyncResumeResp)
		if len(pages) < 2 {
			return false
		}
		var next struct {
			Messages   []map[string]any `json:"messages"`
			CurrentSeq int64            `json:"currentSeq"`
			HasMore    bool             `json:"hasMore"`
		}
		if err := json.Unmarshal(pages[len(pages)-1], &next); err != nil {
			return false
		}
		return next.CurrentSeq == lastSeq && !next.HasMore
	}, "second resume page completes to the workspace high-water")
}

func TestM4RealtimeResumeExcludesUninterestingThreads(t *testing.T) {
	f := newRTFixture(t, nil)
	parent := f.create(rtAlice, rtGeneral, "thread root")
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		thread, err := f.runtime.channels.EnsureThreadTx(context.Background(), tx, rtWS, rtGeneral, parent.ID, rtAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		// Alice's parent authorship follows automatically inside ensure.
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	channelMsg := f.create(rtAlice, rtGeneral, "public message")
	threadMsg := f.create(rtAlice, threadID, "reply only alice follows")
	f.connect("bob", rtBob, rtWS) // bob does NOT follow the thread
	f.send("bob", core.EventSyncResume, map[string]any{"lastSeq": parent.Seq})
	var page struct {
		Messages   []map[string]any `json:"messages"`
		CurrentSeq int64            `json:"currentSeq"`
		HasMore    bool             `json:"hasMore"`
	}
	rtWaitUntil(t, 5*time.Second, func() bool {
		pages := f.transport.payloads("bob", core.EventSyncResumeResp)
		if len(pages) == 0 {
			return false
		}
		_ = json.Unmarshal(pages[len(pages)-1], &page)
		return !page.HasMore
	}, "resume completes")
	for _, m := range page.Messages {
		if m["channelId"] == threadID {
			t.Fatalf("unfollowed thread leaked into bob's resume stream: %v", m["id"])
		}
	}
	found := false
	for _, m := range page.Messages {
		if m["id"] == channelMsg.ID {
			found = true
		}
		if m["id"] == threadMsg.ID {
			t.Fatalf("thread reply visible to non-follower")
		}
	}
	if !found {
		t.Fatalf("public channel message missing from resume")
	}
	if page.CurrentSeq < threadMsg.Seq {
		t.Fatalf("currentSeq must advance over holes: %d < %d", page.CurrentSeq, threadMsg.Seq)
	}
}

func TestM4RealtimeHeartbeatCarriesCommittedWorkspaceSeq(t *testing.T) {
	f := newRTFixture(t, func(c *m4RealtimeConfig) { c.HeartbeatInterval = 25 * time.Millisecond })
	m := f.create(rtAlice, rtGeneral, "beat")
	f.connect("bob", rtBob, rtWS)
	rtWaitUntil(t, 5*time.Second, func() bool {
		for _, raw := range f.transport.payloads("bob", core.EventHeartbeat) {
			var hb struct {
				Seq int64 `json:"seq"`
				TS  int64 `json:"ts"`
			}
			if err := json.Unmarshal(raw, &hb); err != nil {
				t.Fatalf("heartbeat: %v", err)
			}
			if hb.Seq == m.Seq && hb.TS > 0 {
				return true
			}
		}
		return false
	}, "heartbeat with committed workspace seq")
}

// ---- real wire binding HTTP guards ---------------------------------------

func TestM4RealtimeHandlerRejectsPollingAndDisallowedOrigins(t *testing.T) {
	f := newRTFixture(t, nil)
	// Exercise the REAL zishang wire binding's pre-library guards (they run
	// before any Engine.IO work, so no listener is needed).
	real, err := assembleM4Realtime(f.runtime, f.signer, m4RealtimeConfig{
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Origins: []string{"https://app.example"},
	}, nil)
	if err != nil {
		t.Fatalf("real assembly: %v", err)
	}
	defer func() { _ = real.Close() }()
	handler := real.Handler()

	polling := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=polling", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, polling)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("polling refusal: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "websocket") {
		t.Fatalf("polling refusal body: %q", rec.Body.String())
	}

	badOrigin := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
	badOrigin.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, badOrigin)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("origin refusal: %d", rec.Code)
	}
	stats := real.Stats()
	if stats.Gateway.RejectedOrigin != 1 {
		t.Fatalf("origin rejections: %d", stats.Gateway.RejectedOrigin)
	}
}

// ---- lifecycle ------------------------------------------------------------

func TestM4RealtimeCloseIsIdempotentAndStopsSurfaces(t *testing.T) {
	f := newRTFixture(t, func(c *m4RealtimeConfig) { c.HeartbeatInterval = 20 * time.Millisecond })
	f.connect("alice", rtAlice, rtWS)
	f.create(rtAlice, rtGeneral, "before close")
	if err := f.rt.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := f.rt.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	// Every hijacked connection was reaped by CloseAll.
	if f.transport.closeCount("alice") == 0 {
		t.Fatalf("hijacked socket not reaped on Close")
	}
	// The handshake barrier is closed: new admissions fail.
	if err := f.admitErr("late", map[string]any{"token": f.token(rtAlice), "clientKind": "web", "serverId": rtWS}); err == nil {
		t.Fatalf("admission after Close must fail")
	}
}

func TestM4RealtimeAssemblyRejectsMissingSigner(t *testing.T) {
	f := newRTFixture(t, nil)
	if _, err := assembleM4Realtime(f.runtime, nil, m4RealtimeConfig{}, nil); err == nil {
		t.Fatalf("nil signer must be refused")
	}
}

func TestM4RealtimeCloseRacingAuthorityCommits(t *testing.T) {
	// A commit that captured the authority-listener callback before Close
	// unsubscribes it may still offer into the wake queue while/after Close
	// runs. The queue is never closed; termination is signalled — no
	// send-on-closed-channel panic, no deadlock, Close still joins cleanly.
	f := newRTFixture(t, func(c *m4RealtimeConfig) { c.HeartbeatInterval = 20 * time.Millisecond })
	f.connect("alice", rtAlice, rtWS)
	var wg sync.WaitGroup
	commits := make(chan struct{})
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-commits
			for j := 0; j < 5; j++ {
				_ = db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
					_, err := tx.Exec(`UPDATE channels SET name = ? WHERE id = ?`,
						fmt.Sprintf("general-%d-%d", i, j), rtGeneral)
					return err
				})
			}
		}(i)
	}
	close(commits)
	time.Sleep(5 * time.Millisecond) // let some commits capture the callback
	if err := f.rt.Close(); err != nil {
		t.Fatalf("close during commits: %v", err)
	}
	wg.Wait()
	// Any in-flight callback after unsubscribe must not panic; give them a
	// beat to land (the test process itself is the crash detector).
	_ = db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE channels SET name = 'general-after' WHERE id = ?`, rtGeneral)
		return err
	})
	time.Sleep(50 * time.Millisecond)
}
