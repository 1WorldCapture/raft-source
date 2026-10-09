// Channel list/detail/create projection tests over the REAL channelview
// read model (batched 0011/0010 fact readers on one pinned snapshot).
// Requests run through the real auth chain against a mux mounting the
// channel routes, using in-process recorders only.
package humanapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
	"raft.local/server-go/internal/workspace"
)

type m4ProjectionEnv struct {
	t        *testing.T
	env      *testkit.TestEnv
	handlers *humanapi.ChannelHandlers
	mux      *http.ServeMux
}

func newM4ProjectionEnv(t *testing.T) *m4ProjectionEnv {
	t.Helper()
	env := testkit.NewTestEnv(t)
	store := channel.NewStore(env.App.DB)
	msgs := message.NewStore(env.App.DB, store)
	states := readstate.NewStore(env.App.DB, store)
	view, err := channelview.NewService(store, states, msgs)
	if err != nil {
		t.Fatal(err)
	}
	handlers := &humanapi.ChannelHandlers{Store: store, View: view, Workspace: workspace.NewStore(env.App.DB)}
	m4 := &m4ProjectionEnv{t: t, env: env, handlers: handlers}
	m4.mux = http.NewServeMux()
	gate := m4.gate()
	humanapi.RegisterChannelRoutes(m4.mux, handlers, gate)
	return m4
}

func (m *m4ProjectionEnv) gate() *authn.AuthGate {
	return (&m4Env{t: m.t, env: m.env, refresh: map[string]string{}}).gate()
}

func (m *m4ProjectionEnv) Serve(method, path string, body any, bearer, serverID string) testkit.Response {
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

func TestM4ChannelListProjection(t *testing.T) {
	m := newM4ProjectionEnv(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seed(t)

	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	m.seedMessage(t, ws, "ch-town", ownerID, "first")
	secondAt := time.Now().UnixMilli()
	if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES ('msg-second', ?, 'ch-town', 'user', ?, 'second', 't', ?)`, ws, ownerID, secondAt); err != nil {
		t.Fatal(err)
	}
	// Real viewer state: read cursor, mute, display override.
	var firstSeq int64
	if err := m.env.App.DB.QueryRow(`SELECT seq FROM messages WHERE id = 'msg-second'`).Scan(&firstSeq); err != nil {
		t.Fatal(err)
	}
	m.setState(t, ws, memberID, "ch-town",
		`INSERT INTO user_channel_read_states (workspace_id,user_id,channel_id,last_read_seq,read_state_version,updated_at) VALUES (?,?,?,?,?,1)`,
		firstSeq, 5)
	m.setState(t, ws, memberID, "ch-town",
		`INSERT INTO user_channel_mute_states (workspace_id,user_id,channel_id,activity_muted,mute_from_seq,prefs_version,created_at,updated_at) VALUES (?,?,?,1,?,?,1,1)`,
		9, 3)
	m.setState(t, ws, memberID, "ch-town",
		`INSERT INTO user_channel_display_prefs (workspace_id,user_id,channel_id,collapse_long_messages,prefs_version,created_at,updated_at) VALUES (?,?,?,0,?,1,1)`,
		7)

	t.Run("list rows carry the real projection", func(t *testing.T) {
		res := m.Serve("GET", "/api/channels", nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("list: %d %s", res.Status, res.Raw)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.Raw, &rows); err != nil {
			t.Fatal(err)
		}
		var town map[string]json.RawMessage
		for _, row := range rows {
			if string(row["id"]) == `"ch-town"` {
				town = row
			}
		}
		if town == nil {
			t.Fatalf("town row missing: %s", res.Raw)
		}
		assertJSON(t, town["maxReadSeq"], firstSeq)
		assertJSON(t, town["readStateVersion"], 5)
		assertJSON(t, town["readState"], json.RawMessage(fmt.Sprintf(`{"kind":"present","readStateVersion":5,"maxReadSeq":"%d","latestActivity":{"messageId":"msg-second","seq":"%d"}}`, firstSeq, firstSeq)))
		assertJSON(t, town["activityMuted"], true)
		assertJSON(t, town["muteFromSeq"], 9)
		assertJSON(t, town["prefsVersion"], 3)
		assertJSON(t, town["collapseLongMessages"], false)
		assertJSON(t, town["displayPrefsVersion"], 7)
		assertJSON(t, town["lastMessageAt"], time.UnixMilli(secondAt).UTC().Format("2006-01-02T15:04:05.000Z"))
		if _, has := town["lastMessagePreview"]; has {
			t.Fatal("channels list must not carry a preview key")
		}
	})

	t.Run("toggle then refresh reflects the new truth", func(t *testing.T) {
		// Unmute (readstate owns the mutation; the list must reflect it).
		if _, err := m.env.App.DB.Exec(`UPDATE user_channel_mute_states
			SET activity_muted = 0, mute_from_seq = NULL, prefs_version = 4 WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ws, memberID, "ch-town"); err != nil {
			t.Fatal(err)
		}
		if _, err := m.env.App.DB.Exec(`UPDATE user_channel_read_states
			SET last_read_seq = 0, read_state_version = 6 WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ws, memberID, "ch-town"); err != nil {
			t.Fatal(err)
		}
		res := m.Serve("GET", "/api/channels", nil, memberToken, ws)
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.Raw, &rows); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if string(row["id"]) == `"ch-town"` {
				assertJSON(t, row["activityMuted"], false)
				assertJSON(t, row["muteFromSeq"], nil)
				assertJSON(t, row["prefsVersion"], 4)
				assertJSON(t, row["readStateVersion"], 6)
				assertJSON(t, row["readState"], json.RawMessage(`{"kind":"present","readStateVersion":6,"maxReadSeq":"0","latestActivity":{"messageId":"msg-second","seq":"2"}}`))
				return
			}
		}
		t.Fatal("town row missing after toggle")
	})

	t.Run("announcement default mute, #all absent cursor, no stale zeros", func(t *testing.T) {
		m.seedChannel(t, ws, "ch-announce", "announcement", "channel", "announcement")
		if _, err := m.env.App.DB.Exec(`DELETE FROM channels WHERE name = 'all' AND workspace_id = ?`, ws); err != nil {
			t.Fatal(err)
		}
		m.seedChannel(t, ws, "ch-all", "all", "channel", "all")
		res := m.Serve("GET", "/api/channels", nil, memberToken, ws)
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.Raw, &rows); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			switch string(row["id"]) {
			case `"ch-announce"`:
				assertJSON(t, row["activityMuted"], true)
				assertJSON(t, row["muteFromSeq"], 0)
				assertJSON(t, row["prefsVersion"], 0)
			case `"ch-all"`:
				assertJSON(t, row["readState"], json.RawMessage(`{"kind":"absent"}`))
				assertJSON(t, row["maxReadSeq"], 0)
				assertJSON(t, row["lastMessageAt"], nil)
			}
		}
	})

	_ = ownerToken
	_ = ownerID
}

func TestM4ChannelDetailAndCreateProjection(t *testing.T) {
	m := newM4ProjectionEnv(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seed(t)
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	m.seedMessage(t, ws, "ch-town", ownerID, "hello")
	m.setState(t, ws, memberID, "ch-town",
		`INSERT INTO user_channel_read_states (workspace_id,user_id,channel_id,last_read_seq,read_state_version,updated_at) VALUES (?,?,?,2,9,1)`)

	t.Run("detail carries state but never last-message keys", func(t *testing.T) {
		res := m.Serve("GET", "/api/channels/ch-town", nil, memberToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("detail: %d %s", res.Status, res.Raw)
		}
		assertJSON(t, res.Body["maxReadSeq"], float64(2))
		assertJSON(t, res.Body["readStateVersion"], float64(9))
		if _, has := res.Body["lastMessageAt"]; has {
			t.Fatal("detail exit must not carry lastMessageAt")
		}
		if _, has := res.Body["lastMessagePreview"]; has {
			t.Fatal("detail exit must not carry lastMessagePreview")
		}
	})

	t.Run("create states fresh-scope facts, not old-scope state", func(t *testing.T) {
		res := m.Serve("POST", "/api/channels", map[string]any{
			"name": "fresh-" + fmt.Sprint(time.Now().UnixNano()%100000), "visibility": "public",
		}, ownerToken, ws)
		if res.Status != http.StatusOK {
			t.Fatalf("create: %d %s", res.Status, res.Raw)
		}
		assertJSON(t, res.Body["readState"], map[string]any{"kind": "absent"})
		assertJSON(t, res.Body["maxReadSeq"], float64(0))
		assertJSON(t, res.Body["activityMuted"], false)
		assertJSON(t, res.Body["muteFromSeq"], nil)
		if _, has := res.Body["collapseLongMessages"]; has {
			t.Fatal("create exit never carries display prefs")
		}
		if _, has := res.Body["lastMessageAt"]; has {
			t.Fatal("create exit never carries last-message keys")
		}
	})
}

func TestM4ChannelProjectionCrossWorkspaceNoLeak(t *testing.T) {
	m := newM4ProjectionEnv(t)
	wsA, ownerID, ownerToken, _, _ := m.seed(t)
	m.seedChannel(t, wsA, "ch-a", "alpha", "channel", nil)
	m.seedMessage(t, wsA, "ch-a", ownerID, "workspace A message")

	// The owner also belongs to workspace B with its own channel.
	wsB := "wsm4-ws-b"
	if err := m.env.InsertWorkspace(wsB, "WS B", "ws-b", ownerID); err != nil {
		t.Fatal(err)
	}
	if err := m.env.InsertMembership(map[string]any{
		"workspace_id": wsB, "user_id": ownerID, "role": "owner",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	m.seedChannel(t, wsB, "ch-b", "beta", "channel", nil)
	// Read cursor exists only in workspace A.
	m.setState(t, wsA, ownerID, "ch-a",
		`INSERT INTO user_channel_read_states (workspace_id,user_id,channel_id,last_read_seq,read_state_version,updated_at) VALUES (?,?,?,42,3,1)`)

	res := m.Serve("GET", "/api/channels", nil, ownerToken, wsB)
	if res.Status != http.StatusOK {
		t.Fatalf("list B: %d %s", res.Status, res.Raw)
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(res.Raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("workspace B rows: %s", res.Raw)
	}
	assertJSON(t, rows[0]["readState"], json.RawMessage(`{"kind":"absent"}`))
	assertJSON(t, rows[0]["maxReadSeq"], 0)
	assertJSON(t, rows[0]["lastMessageAt"], nil)
	if string(rows[0]["id"]) != `"ch-b"` {
		t.Fatalf("foreign channel leaked: %s", res.Raw)
	}
}

func assertJSON(t *testing.T, got any, want any) {
	t.Helper()
	var gotValue, wantValue any
	switch v := got.(type) {
	case json.RawMessage:
		if err := json.Unmarshal(v, &gotValue); err != nil {
			t.Fatalf("unmarshal %s: %v", v, err)
		}
	default:
		gotValue = v
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantJSON, &wantValue); err != nil {
		t.Fatal(err)
	}
	gotNorm, _ := json.Marshal(gotValue)
	wantNorm, _ := json.Marshal(wantValue)
	if string(gotNorm) != string(wantNorm) {
		t.Fatalf("mismatch:\n got %s\nwant %s", gotNorm, wantNorm)
	}
}

func (m *m4ProjectionEnv) seed(t *testing.T) (wsID, ownerID, ownerToken, memberID, memberToken string) {
	t.Helper()
	e := &m4Env{t: t, env: m.env, refresh: map[string]string{}}
	return e.seedWorkspace(t)
}

func (m *m4ProjectionEnv) seedChannel(t *testing.T, wsID, id, name, channelType string, systemKind any) {
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

func (m *m4ProjectionEnv) seedMessage(t *testing.T, wsID, channelID, senderID, content string) {
	t.Helper()
	if _, err := m.env.App.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'proj-test', ?)`,
		m.msgUUID(t), wsID, channelID, senderID, content, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func (m *m4ProjectionEnv) setState(t *testing.T, wsID, userID, channelID, query string, args ...any) {
	t.Helper()
	if _, err := m.env.App.DB.Exec(query, append([]any{wsID, userID, channelID}, args...)...); err != nil {
		t.Fatal(err)
	}
}

func (m *m4ProjectionEnv) msgUUID(t *testing.T) string {
	t.Helper()
	return (&m4Env{t: t, env: m.env}).msgUUID(t)
}
