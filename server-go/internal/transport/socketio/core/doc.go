// Package core holds the transport-independent heart of the M4 Socket.IO
// layer: connection identity, the authorization fence, bounded outbound
// queues, inbound rate limiting, origin allowlisting, room indexing and
// goroutine lifetime management.
//
// Everything in this package compiles against the standard library only, so
// the backpressure/authorization semantics are unit- and race-tested without
// the Socket.IO protocol binding. The protocol binding lives in the parent
// package (Gateway) and ../zishang; it feeds events in and drains the
// outbound queues out.
//
// Wire contract sources, frozen from the repository's own locked packages
// (not re-derived by hand):
//
//   - Event names, single-payload consumption, resume request/response shape,
//     heartbeat payload and room naming: packages/server/src/socket/index.ts,
//     platformScope.ts and packages/web/src/store/socketBridge.ts:139-142.
//   - connect_error keyword surface (middleware Error message delivered
//     verbatim): socket.io@4.8.3 dist/namespace.js (socket._error({message})).
//   - transport close vs namespace disconnect: socket.io-client@4.8.3
//     build/esm/socket.js ("io server disconnect" leaves active=false and
//     does NOT auto-reconnect; "transport close" does).
package core
