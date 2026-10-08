// M4 channel list/detail/create projection tests. The projector under test is
// a reference implementation over the real 0011/0010 tables on the caller's
// pinned executor — the same contract the readstate slice's exported method
// will implement; wiring swaps the function, not the seam. Requests run
// through the real auth chain against a mux mounting the M3 channel routes
// with the M4 projector injected, using in-process recorders only.
package legacyweb_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/transport/legacyweb"
)

// m4TestProjector is the reference M4ChannelProjector: one batched read per
// fact family on the supplied executor, mirroring the original attachment
// rules (legacy 0-coalesce, announcement default mute, muteFromSeq null when
// unmuted, display defaults, latest message by seq).
func m4TestProjector(ctx context.Context, ex channel.Executor, serverID, userID string, channels []channel.Channel, includeLastMessage bool) (map[string]legacyweb.M4ChannelProjection, error) {
	out := make(map[string]legacyweb.M4ChannelProjection, len(channels))
	if len(channels) == 0 {
		return out, nil
	}
	ids := make([]any, 0, len(channels))
	placeholders := ""
	for i, c := range channels {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		ids = append(ids, c.ID)
	}
	inList := "(" + placeholders + ")"

	// Read state (0011): legacy scalars coalesce to 0, union rendered by the
	// owning slice — here the reference rendering.
	readRows, err := ex.QueryContext(ctx, `SELECT channel_id, last_read_seq, read_state_version
		FROM user_channel_read_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	readByChannel := make(map[string][2]int64)
	for readRows.Next() {
		var channelID string
		var seq, version int64
		if err := readRows.Scan(&channelID, &seq, &version); err != nil {
			readRows.Close()
			return nil, err
		}
		readByChannel[channelID] = [2]int64{seq, version}
	}
	readRows.Close()

	muteRows, err := ex.QueryContext(ctx, `SELECT channel_id, activity_muted, mute_from_seq, prefs_version
		FROM user_channel_mute_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	type muteState struct {
		muted bool
		from  sql.NullInt64
		prefs int64
	}
	muteByChannel := map[string]muteState{}
	for muteRows.Next() {
		var channelID string
		var muted int
		var from sql.NullInt64
		var prefs int64
		if err := muteRows.Scan(&channelID, &muted, &from, &prefs); err != nil {
			muteRows.Close()
			return nil, err
		}
		muteByChannel[channelID] = muteState{muted: muted != 0, from: from, prefs: prefs}
	}
	muteRows.Close()

	displayRows, err := ex.QueryContext(ctx, `SELECT channel_id, collapse_long_messages, prefs_version
		FROM user_channel_display_prefs WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	type displayState struct {
		collapse bool
		version  int64
	}
	displayByChannel := map[string]displayState{}
	for displayRows.Next() {
		var channelID string
		var collapse int
		var version int64
		if err := displayRows.Scan(&channelID, &collapse, &version); err != nil {
			displayRows.Close()
			return nil, err
		}
		displayByChannel[channelID] = displayState{collapse: collapse != 0, version: version}
	}
	displayRows.Close()

	var lastByChannel map[string]int64
	if includeLastMessage {
		lastRows, err := ex.QueryContext(ctx, `SELECT m.channel_id, MAX(m.created_at)
			FROM messages m WHERE m.workspace_id = ? AND m.channel_id IN `+inList+` GROUP BY m.channel_id`,
			append([]any{serverID}, ids...)...)
		if err != nil {
			return nil, err
		}
		lastByChannel = map[string]int64{}
		for lastRows.Next() {
			var channelID string
			var createdAt int64
			if err := lastRows.Scan(&channelID, &createdAt); err != nil {
				lastRows.Close()
				return nil, err
			}
			lastByChannel[channelID] = createdAt
		}
		lastRows.Close()
	}

	for _, c := range channels {
		var p legacyweb.M4ChannelProjection
		readState := json.RawMessage(`{"kind":"absent"}`)
		maxRead, version := int64(0), int64(0)
		if rv, ok := readByChannel[c.ID]; ok {
			maxRead, version = rv[0], rv[1]
			readState = json.RawMessage(fmt.Sprintf(
				`{"kind":"present","readStateVersion":%d,"maxReadSeq":"%d","latestActivity":null}`,
				version, maxRead))
		}
		p.ReadState = readState
		p.MaxReadSeq = &maxRead
		p.ReadStateVersion = &version

		muted, fromSeq, prefs := false, any(json.RawMessage("null")), int64(0)
		if m, ok := muteByChannel[c.ID]; ok {
			muted = m.muted && m.from.Valid
			prefs = m.prefs
			if muted {
				fromSeq = m.from.Int64
			}
		} else if c.SystemKind != nil && *c.SystemKind == "announcement" && c.Type == channel.TypeChannel {
			muted, fromSeq, prefs = true, int64(0), 0
		}
		p.ActivityMuted = &muted
		p.MuteFromSeq = fromSeq
		p.PrefsVersion = &prefs
		supported := channel.SupportsActivityMute(c.Type)
		p.ActivityMuteSupported = &supported

		collapse, displayVersion := true, int64(0)
		if d, ok := displayByChannel[c.ID]; ok {
			collapse, displayVersion = d.collapse, d.version
		}
		p.CollapseLongMessages = &collapse
		p.DisplayPrefsVersion = &displayVersion

		if includeLastMessage {
			if createdAt, ok := lastByChannel[c.ID]; ok {
				p.LastMessageAt = time.UnixMilli(createdAt).UTC().Format("2006-01-02T15:04:05.000Z")
			} else {
				p.LastMessageAt = json.RawMessage("null")
			}
		}
		out[c.ID] = p
	}
	return out, nil
}

type m4ProjectionEnv struct {
	t        *testing.T
	env      *testEnv
	handlers *legacyweb.ChannelHandlers
	mux      *http.ServeMux
}

func newM4ProjectionEnv(t *testing.T) *m4ProjectionEnv {
	t.Helper()
	env := newTestEnv(t)
	handlers := &legacyweb.ChannelHandlers{Store: channel.NewStore(env.app.DB)}
	m4 := &m4ProjectionEnv{t: t, env: env, handlers: handlers}
	m4.mux = http.NewServeMux()
	gate := m4.gate()
	legacyweb.RegisterChannelRoutes(m4.mux, handlers, gate)
	return m4
}

func (m *m4ProjectionEnv) gate() *legacyweb.AuthGate {
	return (&m4Env{t: m.t, env: m.env, refresh: map[string]string{}}).gate()
}

func (m *m4ProjectionEnv) serve(method, path string, body any, bearer, serverID string) response {
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
	return parseResponse(rec)
}

func TestM4ChannelListProjection(t *testing.T) {
	m := newM4ProjectionEnv(t)
	ws, ownerID, ownerToken, memberID, memberToken := m.seed(t)
	m.handlers.M4 = m4TestProjector

	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	m.seedMessage(t, ws, "ch-town", ownerID, "first")
	secondAt := time.Now().UnixMilli()
	if _, err := m.env.app.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES ('msg-second', ?, 'ch-town', 'user', ?, 'second', 't', ?)`, ws, ownerID, secondAt); err != nil {
		t.Fatal(err)
	}
	// Real viewer state: read cursor, mute, display override.
	var firstSeq int64
	if err := m.env.app.DB.QueryRow(`SELECT seq FROM messages WHERE id = 'msg-second'`).Scan(&firstSeq); err != nil {
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
		res := m.serve("GET", "/api/channels", nil, memberToken, ws)
		if res.status != http.StatusOK {
			t.Fatalf("list: %d %s", res.status, res.raw)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.raw, &rows); err != nil {
			t.Fatal(err)
		}
		var town map[string]json.RawMessage
		for _, row := range rows {
			if string(row["id"]) == `"ch-town"` {
				town = row
			}
		}
		if town == nil {
			t.Fatalf("town row missing: %s", res.raw)
		}
		assertJSON(t, town["maxReadSeq"], firstSeq)
		assertJSON(t, town["readStateVersion"], 5)
		assertJSON(t, town["readState"], json.RawMessage(fmt.Sprintf(`{"kind":"present","readStateVersion":5,"maxReadSeq":"%d","latestActivity":null}`, firstSeq)))
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
		if _, err := m.env.app.DB.Exec(`UPDATE user_channel_mute_states
			SET activity_muted = 0, mute_from_seq = NULL, prefs_version = 4 WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ws, memberID, "ch-town"); err != nil {
			t.Fatal(err)
		}
		if _, err := m.env.app.DB.Exec(`UPDATE user_channel_read_states
			SET last_read_seq = 0, read_state_version = 6 WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ws, memberID, "ch-town"); err != nil {
			t.Fatal(err)
		}
		res := m.serve("GET", "/api/channels", nil, memberToken, ws)
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.raw, &rows); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if string(row["id"]) == `"ch-town"` {
				assertJSON(t, row["activityMuted"], false)
				assertJSON(t, row["muteFromSeq"], nil)
				assertJSON(t, row["prefsVersion"], 4)
				assertJSON(t, row["readStateVersion"], 6)
				assertJSON(t, row["readState"], json.RawMessage(`{"kind":"present","readStateVersion":6,"maxReadSeq":"0","latestActivity":null}`))
				return
			}
		}
		t.Fatal("town row missing after toggle")
	})

	t.Run("announcement default mute, #all absent cursor, no stale zeros", func(t *testing.T) {
		m.seedChannel(t, ws, "ch-announce", "announcement", "channel", "announcement")
		if _, err := m.env.app.DB.Exec(`DELETE FROM channels WHERE name = 'all' AND workspace_id = ?`, ws); err != nil {
			t.Fatal(err)
		}
		m.seedChannel(t, ws, "ch-all", "all", "channel", "all")
		res := m.serve("GET", "/api/channels", nil, memberToken, ws)
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(res.raw, &rows); err != nil {
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
	m.handlers.M4 = m4TestProjector
	m.seedChannel(t, ws, "ch-town", "town", "channel", nil)
	m.seedMessage(t, ws, "ch-town", ownerID, "hello")
	m.setState(t, ws, memberID, "ch-town",
		`INSERT INTO user_channel_read_states (workspace_id,user_id,channel_id,last_read_seq,read_state_version,updated_at) VALUES (?,?,?,2,9,1)`)

	t.Run("detail carries state but never last-message keys", func(t *testing.T) {
		res := m.serve("GET", "/api/channels/ch-town", nil, memberToken, ws)
		if res.status != http.StatusOK {
			t.Fatalf("detail: %d %s", res.status, res.raw)
		}
		assertJSON(t, res.body["maxReadSeq"], float64(2))
		assertJSON(t, res.body["readStateVersion"], float64(9))
		if _, has := res.body["lastMessageAt"]; has {
			t.Fatal("detail exit must not carry lastMessageAt")
		}
		if _, has := res.body["lastMessagePreview"]; has {
			t.Fatal("detail exit must not carry lastMessagePreview")
		}
	})

	t.Run("create states fresh-scope facts, not old-scope state", func(t *testing.T) {
		res := m.serve("POST", "/api/channels", map[string]any{
			"name": "fresh-" + fmt.Sprint(time.Now().UnixNano()%100000), "visibility": "public",
		}, ownerToken, ws)
		if res.status != http.StatusOK {
			t.Fatalf("create: %d %s", res.status, res.raw)
		}
		assertJSON(t, res.body["readState"], map[string]any{"kind": "absent"})
		assertJSON(t, res.body["maxReadSeq"], float64(0))
		assertJSON(t, res.body["activityMuted"], false)
		assertJSON(t, res.body["muteFromSeq"], nil)
		if _, has := res.body["collapseLongMessages"]; has {
			t.Fatal("create exit never carries display prefs")
		}
		if _, has := res.body["lastMessageAt"]; has {
			t.Fatal("create exit never carries last-message keys")
		}
	})
}

func TestM4ChannelProjectionCrossWorkspaceNoLeak(t *testing.T) {
	m := newM4ProjectionEnv(t)
	wsA, ownerID, ownerToken, _, _ := m.seed(t)
	m.handlers.M4 = m4TestProjector
	m.seedChannel(t, wsA, "ch-a", "alpha", "channel", nil)
	m.seedMessage(t, wsA, "ch-a", ownerID, "workspace A message")

	// The owner also belongs to workspace B with its own channel.
	wsB := "wsm4-ws-b"
	if err := m.env.insertWorkspace(wsB, "WS B", "ws-b", ownerID); err != nil {
		t.Fatal(err)
	}
	if err := m.env.insertMembership(map[string]any{
		"workspace_id": wsB, "user_id": ownerID, "role": "owner",
		"server_push_muted": 0, "joined_at": time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	m.seedChannel(t, wsB, "ch-b", "beta", "channel", nil)
	// Read cursor exists only in workspace A.
	m.setState(t, wsA, ownerID, "ch-a",
		`INSERT INTO user_channel_read_states (workspace_id,user_id,channel_id,last_read_seq,read_state_version,updated_at) VALUES (?,?,?,42,3,1)`)

	res := m.serve("GET", "/api/channels", nil, ownerToken, wsB)
	if res.status != http.StatusOK {
		t.Fatalf("list B: %d %s", res.status, res.raw)
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(res.raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("workspace B rows: %s", res.raw)
	}
	assertJSON(t, rows[0]["readState"], json.RawMessage(`{"kind":"absent"}`))
	assertJSON(t, rows[0]["maxReadSeq"], 0)
	assertJSON(t, rows[0]["lastMessageAt"], nil)
	if string(rows[0]["id"]) != `"ch-b"` {
		t.Fatalf("foreign channel leaked: %s", res.raw)
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
	if _, err := m.env.app.DB.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?,?,?,?,?,?)`, id, wsID, name, channelType, kind, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func (m *m4ProjectionEnv) seedMessage(t *testing.T, wsID, channelID, senderID, content string) {
	t.Helper()
	if _, err := m.env.app.DB.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'proj-test', ?)`,
		m.msgUUID(t), wsID, channelID, senderID, content, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
}

func (m *m4ProjectionEnv) setState(t *testing.T, wsID, userID, channelID, query string, args ...any) {
	t.Helper()
	if _, err := m.env.app.DB.Exec(query, append([]any{wsID, userID, channelID}, args...)...); err != nil {
		t.Fatal(err)
	}
}

func (m *m4ProjectionEnv) msgUUID(t *testing.T) string {
	t.Helper()
	return (&m4Env{t: t, env: m.env}).msgUUID(t)
}
