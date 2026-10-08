package zishang

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	engine "github.com/zishang520/socket.io/servers/engine/v3"
	socket "github.com/zishang520/socket.io/servers/socket/v3"
	"github.com/zishang520/socket.io/v3/pkg/types"

	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Options tunes the protocol binding. Zero values select the M4 policy:
// websocket transport only, default namespace "/", no client bundle
// serving, Engine.IO keepalive matching the original JS server.
type Options struct {
	Logger *slog.Logger
	// Path is the Engine.IO mount path; the original client hard-codes
	// /socket.io/. Empty → "/socket.io/".
	Path string
	// PingInterval/PingTimeout override Engine.IO keepalive. Zero keeps
	// the upstream defaults (25s/20s), which match the JS server.
	PingInterval time.Duration
	PingTimeout  time.Duration
	// MaxHttpBufferSize bounds one Engine.IO packet (JS default 1e6).
	MaxHttpBufferSize int64
}

func (o Options) withDefaults() Options {
	out := o
	if out.Path == "" {
		out.Path = "/socket.io/"
	}
	if out.Logger == nil {
		out.Logger = slog.Default()
	}
	return out
}

// Engine is the gateway's Transport over the zishang520 library: it maps
// gateway connection ids to live library sockets, runs the admission
// middleware and forwards client events.
type Engine struct {
	g    *socketio.Gateway
	opts Options

	mu    sync.RWMutex
	conns map[string]*socket.Socket
	srv   *socket.Server
}

// New creates the library server, registers the admission middleware and
// the connection/disconnect/event handlers, and binds itself as the
// gateway's transport.
func New(g *socketio.Gateway, o Options) (*Engine, error) {
	e := &Engine{g: g, opts: o.withDefaults(), conns: make(map[string]*socket.Socket)}

	opts := socket.DefaultServerOptions()
	// Websocket-only: the original web client pins transports:
	// ["websocket"] and M4 explicitly does not promise Engine.IO polling
	// (phase-4 design §7.1). Polling/WebTransport handshakes fail here
	// honestly (config/server-options.go SetTransports).
	opts.SetTransports(types.NewSet(socket.WebSocket))
	opts.SetServeClient(false)
	opts.SetPath(e.opts.Path)
	// Engine.IO otherwise leaves Gorilla's Host-based same-origin default
	// active, rejecting the configured Web origin behind a proxy. Reuse the
	// gateway policy for this second check; never replace it with wildcard
	// CORS or derive authority from the incoming Host header.
	opts.SetCors(&types.Cors{Origin: func(origin string) bool {
		r := &http.Request{Header: make(http.Header)}
		r.Header.Set("Origin", origin)
		return g.OriginAllowed(r)
	}})
	if o.PingInterval > 0 {
		opts.SetPingInterval(o.PingInterval)
	}
	if o.PingTimeout > 0 {
		opts.SetPingTimeout(o.PingTimeout)
	}
	if o.MaxHttpBufferSize > 0 {
		opts.SetMaxHttpBufferSize(o.MaxHttpBufferSize)
	}

	srv := socket.NewServer(nil, opts) // nil: serve via ServeHandler, not an *types.HttpServer
	e.srv = srv

	// Admission middleware: the ONLY place a handshake becomes a
	// namespace connection. Rejections carry the gateway's verbatim
	// reason; namespace.go wraps it into {"message": ...} for EIO4
	// clients, which is exactly the original client's connect_error
	// surface.
	srv.Use(func(client *socket.Socket, next func(*types.ExtendedError)) {
		e.admit(client, next)
	})

	srv.On("connection", func(args ...any) {
		if len(args) == 0 {
			return
		}
		client, ok := args[0].(*socket.Socket)
		if !ok {
			return
		}
		id := string(client.Id())
		e.mu.Lock()
		e.conns[id] = client
		e.mu.Unlock()
		e.g.Opened(id)

		client.On("disconnect", func(reason ...any) {
			e.mu.Lock()
			delete(e.conns, id)
			e.mu.Unlock()
			e.g.Closed(id)
		})

		// Client events the gateway validates semantically. Args arrive
		// as decoded JSON values (strings stay string; objects are
		// map[string]any; numbers float64 — decoder.go), re-marshaled
		// here so the gateway's []json.RawMessage validation is exact.
		for _, name := range []string{core.EventJoinChannel, core.EventLeaveChannel, core.EventSyncResume} {
			eventName := name
			client.On(eventName, func(args ...any) {
				e.g.InboundEvent(context.Background(), id, eventName, rawArgs(args))
			})
		}
	})

	if err := g.UseTransport(e); err != nil {
		return nil, err
	}
	return e, nil
}

// admit runs the gateway handshake for one pending socket. The handshake's
// original *http.Request comes from Client.Request().Request()
// (types.HttpContext keeps the engine.io upgrade request).
func (e *Engine) admit(client *socket.Socket, next func(*types.ExtendedError)) {
	id := string(client.Id())
	req := &http.Request{Method: http.MethodGet, RequestURI: e.opts.Path}
	if ctx := client.Client().Request(); ctx != nil && ctx.Request() != nil {
		req = ctx.Request()
	}
	authObj := any(client.Handshake().Auth) // map[string]any (socket.go Handshake)

	if _, err := e.g.Admit(context.Background(), id, req, authObj); err != nil {
		next(types.NewExtendedError(err.Error(), nil))
		return
	}
	next(nil)
}

// rawArgs converts emitted arguments (decoded JSON values) back to
// json.RawMessage for the gateway's strict shape validation.
func rawArgs(args []any) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(args))
	for _, a := range args {
		b, err := json.Marshal(a)
		if err != nil {
			continue
		}
		out = append(out, b)
	}
	return out
}

// CanAccept implements the emission-window probe: the upstream engine
// socket only moves its (unbounded) writeBuffer into the (never-blocking)
// websocket write queue while the transport reports itself writable
// (engine socket.go flush() + transports/websocket.go Send()).
func (e *Engine) CanAccept(connID string) bool {
	client := e.lookup(connID)
	if client == nil {
		return false
	}
	conn := client.Client().Conn()
	if conn == nil {
		return false
	}
	return conn.Transport().Writable()
}

// Emit implements socketio.Transport: delivers one frame as a
// single-payload event. json.RawMessage is passed through the encoder
// verbatim (parsers/socket encoder preprocessData → json.Marshal inlines
// it), so the wire shows one JSON value — the original client's bridge
// only consumes the first argument.
func (e *Engine) Emit(connID string, f core.Frame) bool {
	client := e.lookup(connID)
	if client == nil {
		return false
	}
	if len(f.Payload) == 0 {
		_ = client.Emit(f.Event) // payload-less (rooms:joined): 2["event"]
		return true
	}
	_ = client.Emit(f.Event, json.RawMessage(f.Payload))
	return true
}

// CloseTransport implements socketio.Transport with a RAW Engine.IO close:
// Conn().Close(true) discards any pending upstream buffers and closes the
// underlying transport WITHOUT emitting a namespace DISCONNECT packet.
// The original client therefore sees reason "transport close" and
// auto-reconnects + re-authenticates. (Socket.Disconnect(true) would FIRST
// send a namespace disconnect — client.go _disconnect() — leaving the
// client dead; never use it for revocation. engine socket.go Close(true)
// is the discard path.)
func (e *Engine) CloseTransport(connID string) {
	if client := e.lookup(connID); client != nil {
		if conn := client.Client().Conn(); conn != nil {
			conn.Close(true)
		}
	}
}

// CloseAll implements socketio.Transport: shutdown reaping. Server.Close
// walks every namespace socket with "server shutting down" and then closes
// the engine, whose BaseServer.Close() discards every open client
// connection — the hijacked sockets net/http Server.Shutdown cannot reach.
func (e *Engine) CloseAll() {
	if e.srv != nil {
		e.srv.Close(nil)
	}
	e.mu.Lock()
	e.conns = make(map[string]*socket.Socket)
	e.mu.Unlock()
}

func (e *Engine) lookup(connID string) *socket.Socket {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.conns[connID]
}

// ServeHTTP mounts the Engine.IO endpoint: origin enforcement and the
// honest polling refusal happen BEFORE the library touches the request.
func (e *Engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !e.g.OriginAllowed(r) {
		e.g.RecordOriginRejected()
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	// Engine.IO v4 websocket-only: refuse polling honestly instead of
	// letting it half-handshake. SetTransports(websocket) also rejects it
	// inside the library; this guard keeps the failure explicit and cheap.
	if r.URL.Query().Get("transport") != "websocket" {
		http.Error(w, "only the websocket transport is supported", http.StatusBadRequest)
		return
	}
	e.srv.ServeHandler(nil).ServeHTTP(w, r)
}

var (
	_ socketio.Transport = (*Engine)(nil)
	_ http.Handler       = (*Engine)(nil)
	// engine import is retained for documentation and future option wiring.
	_ engine.TransportCtor = socket.WebSocket
)
