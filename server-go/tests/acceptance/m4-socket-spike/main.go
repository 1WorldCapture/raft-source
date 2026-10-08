// M4 Socket.IO protocol spike server: exercises the candidate library
// github.com/zishang520/socket.io v3.0.6 with the exact wire contract the
// repository's original web client expects (socket.io-client@4.8.3,
// websocket-only).
//
// Run via the parent-owned runner tests/acceptance/m4-socket-poc.mjs,
// which copies this file into an isolated temporary module with dynamic
// ports and strict cleanup. Do not use fixed ports or the live 4301/5175.
//
// Every call below matches the cached upstream sources (verified while
// writing the production binding in
// server-go/internal/transport/socketio/zishang/engine.go):
//
//   - raw transport close = Client.Conn().Close(true): discards pending
//     upstream buffers and closes the connection WITHOUT a namespace
//     DISCONNECT packet, so the original client auto-reconnects
//     ("transport close"). Socket.Disconnect(*) always sends the namespace
//     packet first ("io server disconnect": the client stays dead) — the
//     spike asserts that difference on purpose.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	socket "github.com/zishang520/socket.io/servers/socket/v3"
	"github.com/zishang520/socket.io/v3/pkg/types"
)

// ---- in-memory fixture state ------------------------------------------

type userRec struct {
	id      string
	memberW map[string]bool
}

var (
	// token -> user. "wrongtype-token" decodes as a non-access token,
	// "expired-token" is an invalid/expired session.
	users = map[string]*userRec{
		"good-token":      {id: "u1", memberW: map[string]bool{"ws1": true}},
		"u2-token":        {id: "u2", memberW: map[string]bool{"ws1": true}},
		"wrongtype-token": nil,
	}
	revokedMu sync.RWMutex
	revoked   = map[string]bool{}

	// channel -> member user IDs ("*" = everyone in ws1).
	channels = map[string][]string{
		"ch1":       {"*"},
		"ch2":       {"u1"},
		"ch-secret": {"u2"},
	}

	// Mock history for resume: seq 1001..2200 (1200 messages), every 3rd
	// (i%3==0) in ch-secret which u1 cannot see => u1-visible = 800
	// messages exactly. With the 500/page limit: page 1 = 500 hasMore,
	// page 2 = 300 complete. The u1-visible set is what the original
	// client's sync:resume:response contract exercises (holes included).
	messages []mockMsg
)

type mockMsg struct {
	ID      string `json:"id"`
	Channel string `json:"channelId"`
	Content string `json:"content"`
	Seq     int64  `json:"seq"`
}

func init() {
	seq := int64(1000)
	for i := 0; i < 1200; i++ {
		seq++
		var ch string
		switch {
		case i%3 == 0:
			ch = "ch-secret" // invisible to u1 (400 messages)
		case i%2 == 0:
			ch = "ch1"
		default:
			ch = "ch2"
		}
		messages = append(messages, mockMsg{
			ID: "m" + strconv.FormatInt(seq, 10), Channel: ch,
			Content: "msg-" + strconv.FormatInt(seq, 10), Seq: seq,
		})
	}
}

func visibleAfter(userID string, lastSeq int64, limit int) ([]mockMsg, bool) {
	out := make([]mockMsg, 0, limit)
	for _, m := range messages {
		if m.Seq <= lastSeq {
			continue
		}
		if !userCanSee(userID, m.Channel) {
			continue
		}
		out = append(out, m)
		if len(out) >= limit {
			return out, true
		}
	}
	return out, false
}

func userCanSee(userID, channel string) bool {
	for _, m := range channels[channel] {
		if m == "*" || m == userID {
			return true
		}
	}
	return false
}

// ---- handshake auth: exact TS parseSocketHandshakeAuth semantics ------

type parsedAuth struct {
	token      string
	serverID   *string
	clientKind string
}

func parseAuth(v any) (*parsedAuth, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	tok, _ := m["token"].(string)
	if tok == "" {
		return nil, false
	}
	p := &parsedAuth{token: tok}
	raw, present := m["serverId"]
	if present && raw != nil {
		s, ok := raw.(string)
		if !ok || s == "" {
			return nil, false
		}
		p.serverID = &s
	}
	switch k := m["clientKind"].(type) {
	case nil:
		p.clientKind = "web"
	case string:
		switch k {
		case "web", "mobile", "desktop", "cli":
			p.clientKind = k
		default:
			return nil, false
		}
	default:
		return nil, false
	}
	return p, true
}

func main() {
	addr := flag.String("addr", "127.0.0.1:4399", "listen address (runner overrides)")
	origin := flag.String("origins", "*", `comma-separated Origin allowlist ("*" allows all)`)
	heartbeat := flag.Int("heartbeat-ms", 1000, "application heartbeat interval (test: 1s; prod: 15000)")
	flag.Parse()

	opts := socket.DefaultServerOptions()
	opts.SetTransports(types.NewSet(socket.WebSocket)) // websocket-only, honestly
	opts.SetServeClient(false)
	opts.SetPath("/socket.io/")
	opts.SetPingInterval(25 * time.Second)
	opts.SetPingTimeout(20 * time.Second)
	opts.SetMaxHttpBufferSize(1_000_000)

	srv := socket.NewServer(nil, opts)
	ns := srv.Of("/", nil)

	// Admission middleware — exact connect_error keyword contract.
	srv.Use(func(client *socket.Socket, next func(*types.ExtendedError)) {
		hs := client.Handshake()
		authObj := any(hs.Auth)
		if !originAllowed(hs, *origin) {
			next(types.NewExtendedError("Origin not allowed", nil))
			return
		}
		p, ok := parseAuth(authObj)
		if !ok {
			next(types.NewExtendedError("Authentication required", nil))
			return
		}
		if p.token == "wrongtype-token" {
			next(types.NewExtendedError("Invalid token type", nil))
			return
		}
		revokedMu.RLock()
		blocked := revoked[p.token]
		revokedMu.RUnlock()
		u := users[p.token]
		if blocked || u == nil {
			next(types.NewExtendedError("Invalid or expired token", nil))
			return
		}
		if p.serverID != nil && !u.memberW[*p.serverID] {
			next(types.NewExtendedError("Not a member of this server", nil))
			return
		}
		next(nil)
	})

	srv.On("connection", func(clients ...any) {
		client := clients[0].(*socket.Socket)
		id := string(client.Id())
		hs := client.Handshake()
		p, _ := parseAuth(any(hs.Auth))
		u := users[p.token]

		client.On("join:channel", func(args ...any) {
			if len(args) != 1 {
				return
			}
			ch, ok := args[0].(string)
			if !ok || ch == "" || p.serverID == nil || u == nil {
				return
			}
			if !userCanSee(u.id, ch) {
				return // fail closed, silently (TS semantics)
			}
			client.Join(socket.Room("channel:" + ch))
		})
		client.On("leave:channel", func(args ...any) {
			if len(args) == 1 {
				if ch, ok := args[0].(string); ok && ch != "" {
					client.Leave(socket.Room("channel:" + ch))
				}
			}
		})
		client.On("sync:resume", func(args ...any) {
			if len(args) != 1 || p.serverID == nil || u == nil {
				return
			}
			obj, ok := args[0].(map[string]any)
			if !ok {
				return
			}
			last, ok := obj["lastSeq"].(float64) // strict JSON number
			if !ok || last <= 0 || last != float64(int64(last)) {
				return
			}
			missed, hasMore := visibleAfter(u.id, int64(last), 500)
			current := int64(last)
			if n := len(missed); n > 0 {
				current = missed[n-1].Seq
			}
			_ = client.Emit("sync:resume:response", map[string]any{
				"messages": missed, "currentSeq": current, "hasMore": hasMore,
			})
		})

		// spike-only control events (never part of the production wire).
		client.On("spike:publish-channel", func(args ...any) {
			if len(args) != 1 {
				return
			}
			req, ok := args[0].(map[string]any)
			if !ok {
				return
			}
			ch, _ := req["channelId"].(string)
			event, _ := req["event"].(string)
			ns.To(socket.Room("channel:"+ch)).Emit(event, req["payload"])
		})
		client.On("spike:close-transport", func(args ...any) {
			// RAW Engine.IO close with discard: no namespace DISCONNECT is
			// sent, so the original client sees "transport close" and
			// auto-reconnects. This is the revocation close path.
			if conn := client.Client().Conn(); conn != nil {
				conn.Close(true)
			}
		})
		client.On("spike:namespace-disconnect", func(args ...any) {
			// Contrast case: namespace disconnect leaves the original
			// client dead (reason "io server disconnect", no auto
			// reconnect) — proving revocation must NOT use it.
			client.Disconnect(false)
		})
		client.On("spike:revoke-user", func(args ...any) {
			if len(args) != 1 {
				return
			}
			req, ok := args[0].(map[string]any)
			if !ok {
				return
			}
			target, _ := req["userId"].(string)
			for tok, rec := range users {
				if rec != nil && rec.id == target {
					revokedMu.Lock()
					revoked[tok] = true
					revokedMu.Unlock()
				}
			}
			// Evict every live socket of that user with the RAW close so
			// the client auto-reconnects into the (now failing) handshake.
			ns.Sockets().Range(func(_ socket.SocketId, s *socket.Socket) bool {
				if hp, ok := parseAuth(any(s.Handshake().Auth)); ok {
					if rec := users[hp.token]; rec != nil && rec.id == target {
						if conn := s.Client().Conn(); conn != nil {
							conn.Close(true)
						}
					}
				}
				return true
			})
		})

		// Identity echo (assertion 01): prove auth reached the server
		// verbatim, before the room barrier signal.
		sid := any(nil)
		if p.serverID != nil {
			sid = *p.serverID
		}
		_ = client.Emit("spike:identity", map[string]any{
			"userId": u.id, "serverId": sid, "clientKind": p.clientKind,
		})

		// Authorized room setup BEFORE rooms:joined (barrier).
		if p.serverID != nil {
			client.Join(socket.Room("server:" + *p.serverID))
			client.Join(socket.Room("user:" + u.id + ":server:" + *p.serverID))
			for ch := range channels {
				if userCanSee(u.id, ch) {
					client.Join(socket.Room("channel:" + ch))
				}
			}
		}
		_ = client.Emit("rooms:joined") // payload-less: 2["rooms:joined"]

		// Heartbeat, test cadence from the flag.
		stop := make(chan struct{})
		go func() {
			t := time.NewTicker(time.Duration(*heartbeat) * time.Millisecond)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					_ = client.Emit("heartbeat", map[string]any{"seq": 2200, "ts": time.Now().UnixMilli()})
				case <-stop:
					return
				}
			}
		}()
		client.On("disconnect", func(reason ...any) {
			select {
			case <-stop:
			default:
				close(stop)
			}
		})
		log.Printf("spike: connected id=%s user=%s", id, u.id)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/socket.io/", func(w http.ResponseWriter, r *http.Request) {
		if !httpOriginAllowed(r, *origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		if r.URL.Query().Get("transport") != "websocket" {
			// Honest refusal: M4 promises websocket-only (runner asserts 400).
			http.Error(w, "only the websocket transport is supported", http.StatusBadRequest)
			return
		}
		srv.ServeHandler(nil).ServeHTTP(w, r)
	})

	log.Printf("spike server on %s origins=%s", *addr, *origin)
	httpSrv := &http.Server{Addr: *addr, Handler: mux}
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("spike: shutting down")
	// Server.Close walks sockets with "server shutting down", then the
	// engine closes every client with discard — reaping the hijacked
	// sockets net/http Server.Shutdown cannot reach.
	srv.Close(nil)
	_ = httpSrv.Close()
	log.Printf("spike: bye")
}

// originAllowed checks the Engine.IO handshake's Origin header against the
// allowlist (Handshake.Headers is types.IncomingHttpHeaders; Header()
// converts to http.Header).
func originAllowed(hs *socket.Handshake, allow string) bool {
	origin := hs.Headers.Header().Get("Origin")
	if origin == "" {
		return true // non-browser clients send no Origin
	}
	return allow == "*" || origin == allow
}

func httpOriginAllowed(r *http.Request, allow string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	return allow == "*" || origin == allow
}

// silence unused-warning paths in shrink-wrapped builds.
var _ = json.Marshal
