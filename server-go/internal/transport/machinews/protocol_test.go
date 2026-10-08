package machinews

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// dialLegacy seeds one workspace plus one REAL legacy machine key, connects,
// and consumes the machine:context first frame.
func dialLegacy(t *testing.T, env *testEnv) (machineID, apiKey string, ws *websocket.Conn) {
	t.Helper()
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	machineID, apiKey = env.seedLegacyMachine("w1", "u1", "proto-machine")
	ws = env.dial(apiKey)
	readFrameExpect(t, ws, "machine:context")
	return machineID, apiKey, ws
}

func closeQuietly(ws *websocket.Conn) {
	_ = ws.Close(websocket.StatusNormalClosure, "")
}

func TestProtocolPingAnswersPing(t *testing.T) {
	_, _, ws := dialLegacy(t, newTestEnv(t, nil))
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"ping"}`)
	// The TS server replies to an application ping with ping, never pong.
	readFrameExpect(t, ws, "ping")
}

func TestProtocolPongPersistsHeartbeat(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)

	wantAt := env.clock.Now().UnixMilli()
	sendFrame(t, ws, `{"type":"pong"}`)
	env.waitCond("last_heartbeat persisted", func() bool {
		row := env.machineRow(machineID)
		return row.lastHeartbeat.Valid && row.lastHeartbeat.Int64 == wantAt
	})
}

func TestProtocolReadyPersistsFactsAndPartialSemantics(t *testing.T) {
	env := newTestEnv(t, func(cfg *Config) {
		cfg.AuthRecheckInterval = 1000 * time.Hour
	})
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)

	sendFrame(t, ws, `{"type":"ready","runtimes":["claude","codex"],"runtimeVersions":{"claude":"1.2.3","codex":"0.9","bogus":"9.9"},"runningAgents":[],"hostname":"mbp.local","os":"darwin arm64","daemonVersion":"1.4.0","computerVersion":"2.0.0"}`)
	env.waitFor("OnReady", func() bool { return env.readyCount() == 1 })

	row := env.machineRow(machineID)
	if got := row.runtimes.String; got != `["claude","codex"]` {
		t.Fatalf("runtimes = %s", got)
	}
	if row.hostname.String != "mbp.local" || row.os.String != "darwin arm64" {
		t.Fatalf("hostname/os = %q/%q", row.hostname.String, row.os.String)
	}
	if row.daemonVersion.String != "1.4.0" {
		t.Fatalf("daemon_version = %q", row.daemonVersion.String)
	}
	if row.computerVersion.String != "2.0.0" || !row.computerVersionReported.Valid {
		t.Fatalf("computer version = %q reported=%v", row.computerVersion.String, row.computerVersionReported)
	}

	// Runtime versions are a normalized live snapshot, not durable host
	// metadata. Only versions from the current ready/runtimes survive.
	snap := env.hub.Snapshot(machineID)
	if snap == nil {
		t.Fatal("no live snapshot")
	}
	if v, ok := snap.RuntimeVersions["claude"]; !ok || v != "1.2.3" {
		t.Fatalf("runtimeVersions[claude] = %q %v", v, ok)
	}
	if _, ok := snap.RuntimeVersions["bogus"]; ok {
		t.Fatal("runtime version for unreported runtime survived")
	}

	// Absent durable fields never clobber: a ready without hostname/os keeps them.
	env.advance(time.Second)
	sendFrame(t, ws, `{"type":"ready","runtimes":["grok"],"runningAgents":[],"daemonVersion":"1.5.0"}`)
	env.waitFor("second ready", func() bool { return env.readyCount() == 2 })
	env.waitCond("facts updated", func() bool {
		row := env.machineRow(machineID)
		return row.runtimes.String == `["grok"]` && row.daemonVersion.String == "1.5.0"
	})
	row = env.machineRow(machineID)
	if row.hostname.String != "mbp.local" || row.os.String != "darwin arm64" {
		t.Fatalf("absent hostname/os were clobbered: %q/%q", row.hostname.String, row.os.String)
	}

	// The second ready omits runtimeVersions and reports a different
	// runtime set. Match TS normalization; do not advertise stale versions.
	snap = env.hub.Snapshot(machineID)
	if snap == nil {
		t.Fatal("no live snapshot after second ready")
	}
	if len(snap.RuntimeVersions) != 0 {
		t.Fatalf("stale runtime versions survived a new ready: %v", snap.RuntimeVersions)
	}
	if snap.DaemonVersion != "1.5.0" {
		t.Fatalf("snapshot daemon version = %q", snap.DaemonVersion)
	}
	if snap.HostKind != "standalone" {
		t.Fatalf("hostKind = %q, want standalone default", snap.HostKind)
	}
}

func TestProtocolComputerVersionRefreshRule(t *testing.T) {
	env := newTestEnv(t, func(cfg *Config) {
		cfg.HeartbeatInterval = 12 * time.Hour
		cfg.HeartbeatTimeout = 48 * time.Hour
		cfg.AuthRecheckInterval = 1000 * time.Hour
	})
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)

	sendFrame(t, ws, `{"type":"ready","runtimes":[],"runningAgents":[],"computerVersion":"2.0.0"}`)
	env.waitFor("ready1", func() bool { return env.readyCount() == 1 })
	firstReport := env.machineRow(machineID).computerVersionReported.Int64

	// Same version inside 24h: no refresh.
	env.advance(23 * time.Hour)
	sendFrame(t, ws, `{"type":"ready","runtimes":[],"runningAgents":[],"computerVersion":"2.0.0"}`)
	env.waitFor("ready2", func() bool { return env.readyCount() == 2 })
	if got := env.machineRow(machineID).computerVersionReported.Int64; got != firstReport {
		t.Fatalf("reported_at refreshed inside 24h window: %d != %d", got, firstReport)
	}

	// Same version after 24h: refreshed.
	env.advance(2 * time.Hour)
	sendFrame(t, ws, `{"type":"ready","runtimes":[],"runningAgents":[],"computerVersion":"2.0.0"}`)
	env.waitFor("ready3", func() bool { return env.readyCount() == 3 })
	env.waitCond("reported_at refreshed", func() bool {
		return env.machineRow(machineID).computerVersionReported.Int64 == env.clock.Now().UnixMilli()
	})

	// A version change writes immediately.
	env.advance(time.Minute)
	sendFrame(t, ws, `{"type":"ready","runtimes":[],"runningAgents":[],"computerVersion":"2.1.0"}`)
	env.waitFor("ready4", func() bool { return env.readyCount() == 4 })
	env.waitCond("version changed", func() bool {
		return env.machineRow(machineID).computerVersion.String == "2.1.0"
	})
}

func TestProtocolOnReadyReceivesRawFrameAndPrincipal(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, apiKey, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	raw := `{"type":"ready","runtimes":["claude"],"runningAgents":["ag1"],"daemonVersion":"9.9"}`
	sendFrame(t, ws, raw)
	env.waitFor("OnReady", func() bool { return env.readyCount() == 1 })
	env.mu.Lock()
	capture := env.ready[0]
	env.mu.Unlock()
	if capture.principal.MachineID != machineID {
		t.Fatalf("principal machine = %q", capture.principal.MachineID)
	}
	if capture.principal.Kind != "legacy_machine" {
		t.Fatalf("principal kind = %q", capture.principal.Kind)
	}
	var back map[string]any
	if err := json.Unmarshal(capture.raw, &back); err != nil {
		t.Fatalf("raw ready not JSON: %v", err)
	}
	if back["daemonVersion"] != "9.9" {
		t.Fatalf("raw frame altered: %v", back)
	}
	_ = apiKey
}

func TestProtocolOnMessageReceivesVerbatimFrames(t *testing.T) {
	env := newTestEnv(t, nil)
	_, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"agent:status","agentId":"ag1","status":"running"}`)
	env.waitFor("agent message", func() bool { return env.messageCount() == 1 })
	env.mu.Lock()
	msg := env.messages[0]
	env.mu.Unlock()
	if string(msg.raw) != `{"type":"agent:status","agentId":"ag1","status":"running"}` {
		t.Fatalf("message not verbatim: %s", msg.raw)
	}

	// Unknown frame types are forwarded too, never faked as success.
	sendFrame(t, ws, `{"type":"future:unknown:frame","x":1}`)
	env.waitFor("unknown message", func() bool { return env.messageCount() == 2 })
}

func TestProtocolInvalidJSONTolerated(t *testing.T) {
	env := newTestEnv(t, nil)
	_, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{not json`)
	sendFrame(t, ws, `{"no_type":true}`)
	sendFrame(t, ws, `{"type":"ping"}`)
	readFrameExpect(t, ws, "ping")
	if env.messageCount() != 0 {
		t.Fatal("invalid frames must not reach OnMessage")
	}
}

func TestProtocolInvalidReadyDroppedButConnectionLives(t *testing.T) {
	env := newTestEnv(t, nil)
	_, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"ready","runtimes":["ok"],"runtimeVersions":{"ok":1},"runningAgents":[],"hostname":"`+strings.Repeat("h", 300)+`"}`)
	sendFrame(t, ws, `{"type":"ping"}`)
	readFrameExpect(t, ws, "ping")
	if env.readyCount() != 0 {
		t.Fatal("oversized ready must be dropped before OnReady")
	}
}

func TestProtocolShutdownIntentRecorded(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)
	sendFrame(t, ws, `{"type":"machine:shutdown","reason":"daemon_stop"}`)
	env.waitCond("shutdown intent", func() bool {
		s := env.hub.Snapshot(machineID)
		return s != nil && s.ShutdownIntent != nil && s.ShutdownIntent.Reason == "daemon_stop"
	})
	// Unknown reasons normalize.
	sendFrame(t, ws, `{"type":"machine:shutdown","reason":"because"}`)
	env.waitCond("normalized intent", func() bool {
		s := env.hub.Snapshot(machineID)
		return s != nil && s.ShutdownIntent != nil && s.ShutdownIntent.Reason == "unknown"
	})
}

func TestProtocolIngressRateLimit(t *testing.T) {
	env := newTestEnv(t, nil)
	_, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)

	// rateLimitMaxPerType + 1 agent:activity frames inside the window; the
	// overflow is dropped (OnMessage count pinned at the limit). Unlisted
	// frame types stay unlimited.
	for i := 0; i <= rateLimitMaxPerType; i++ {
		sendFrame(t, ws, `{"type":"agent:activity","agentId":"a","detail":"x"}`)
	}
	// A completed socket write does not prove the reader processed the
	// overflow frame. Fence ingress before advancing the clock, otherwise
	// that frame can enter the new window and make the count flaky.
	sendFrame(t, ws, `{"type":"ping"}`)
	readFrameExpect(t, ws, "ping")
	env.waitCond("rate limit reached", func() bool {
		return env.messageCount() == rateLimitMaxPerType
	})
	// The window resets after 10s.
	env.advance(rateLimitWindow + time.Second)
	sendFrame(t, ws, `{"type":"agent:activity","agentId":"a","detail":"x"}`)
	env.waitFor("window reset", func() bool { return env.messageCount() == rateLimitMaxPerType+1 })
}

func TestProtocolReadyFactsRetryConverges(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, _, ws := dialLegacy(t, env)
	defer closeQuietly(ws)

	env.hub.facts.testFailReady.Store(1)
	sendFrame(t, ws, `{"type":"ready","runtimes":["claude"],"runningAgents":[]}`)
	env.waitCond("retry armed", func() bool { return readyRetryArmed(env.hub, machineID) })
	if env.readyCount() != 0 {
		t.Fatal("OnReady fired before the ready facts committed")
	}
	if row := env.machineRow(machineID); row.runtimes.Valid {
		t.Fatalf("failed ready committed runtimes %s", row.runtimes.String)
	}
	env.advance(DefaultReadyRetryInterval)
	env.waitFor("OnReady after retry", func() bool { return env.readyCount() == 1 })
	env.waitCond("retry landed", func() bool {
		row := env.machineRow(machineID)
		return row.runtimes.Valid && row.runtimes.String == `["claude"]`
	})
}

func readyRetryArmed(h *Hub, machineID string) bool {
	s := h.slotExisting(machineID)
	if s == nil {
		return false
	}
	s.Lock()
	c := s.conn
	s.Unlock()
	if c == nil {
		return false
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.pendingReady != nil && c.factsRetryStop != nil
}
