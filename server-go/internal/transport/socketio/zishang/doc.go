// Package zishang binds the M4 Socket.IO gateway to the protocol library
// github.com/zishang520/socket.io (module servers/socket/v3, pinned
// candidate v3.0.6, Go 1.26).
//
// Every call in engine.go below was written against the ACTUAL cached
// upstream sources at
// /Users/lyon/go/pkg/mod/github.com/zishang520/socket.io/*/@v3.0.6 — not
// guessed. Load-bearing facts verified there (sources noted inline):
//
//   - Socket.Disconnect(true) routes through Client._disconnect(), which
//     FIRST sends a namespace DISCONNECT packet (the original client then
//     treats the close as "io server disconnect" and NEVER auto
//     reconnects) and only then closes the transport. Revocation therefore
//     must NOT use Disconnect: it closes the raw Engine.IO connection via
//     Client.Conn().Close(true) instead, which the client sees as
//     "transport close" and reconnects + re-authenticates.
//   - The upstream write path is doubly unbounded (engine socket
//     writeBuffer is a plain slice; the websocket transport enqueues into
//     a never-blocking queue.Queue) and the websocket writer sets no write
//     deadline. The gateway's drainer therefore gates emission on
//     Transport().Writable() and raw-closes with discard after
//     WriteStallTimeout.
//   - middleware rejection next(types.NewExtendedError(msg, nil)) is
//     delivered to Engine.IO v4 clients as {"message": msg} (namespace.go
//     run(): _error(map{"message": err.Error(), ...})), matching the
//     original web client's connect_error keyword matching verbatim.
//   - Socket.Emit(ev, json.RawMessage(...)) embeds the pre-serialized
//     payload as a raw JSON value (encoder preprocessData passes
//     json.RawMessage through; json.Marshal then inlines it), so the
//     gateway's single-payload contract holds on the wire.
//
// The binding still requires the parent-owned main go.mod to require the
// library modules (see docs/m4-socket-worker-report.md §dependencies);
// until then this package compiles only via a temporary -modfile.
package zishang
