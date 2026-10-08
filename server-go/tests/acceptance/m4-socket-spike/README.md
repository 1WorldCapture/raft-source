# M4 Socket.IO protocol spike (P0)

Purpose: verify the candidate Go protocol library
`github.com/zishang520/socket.io` **v3.0.6** (servers/socket/v3 modules,
Go 1.26.0) against the repository's locked original client
`socket.io-client@4.8.3`, **websocket-only**, in an isolated temporary
module — before any dependency lands in `server-go/go.mod`.

## Run (parent-owned runner; no fixed ports, no repo dirtying)

    cd server-go
    node tests/acceptance/m4-socket-poc.mjs            # full protocol run
    node tests/acceptance/m4-socket-poc.mjs --compile-only

The runner copies `main.go` into a private tmp module (it writes its own
`go.mod`; note the candidate requires go >= 1.26.0, so the runner's
`go 1.25` declaration must be raised first), resolves the candidate,
builds CGO-free, starts two servers on dynamic ports, asserts the polling
refusal (HTTP 400), then drives `client.mjs` — which imports the locked
socket.io-client@4.8.3 straight from `node_modules/.pnpm` (zero install,
zero lockfile changes) — and finally asserts clean SIGINT shutdown.

## What this spike proves or refutes (exit criteria)

1. websocket-only handshake with auth `{token, serverId, clientKind}`
   passed through verbatim; bad/expired token, non-member serverId,
   missing token and wrong token type rejected with the exact
   connect_error strings the web client's keyword matching depends on.
2. `rooms:joined` only after the authorized room set is joined (barrier);
   identity echo proves auth passthrough; single-payload `message:new`;
   `heartbeat {seq,ts}`; `join:channel`/`leave:channel` with a bare string
   argument.
3. `sync:resume` pagination: the fixture has 1200 messages with every 3rd
   in u2-only `ch-secret`, so u1 sees exactly **800** — page 1 = 500
   (hasMore), page 2 = **300** (complete, currentSeq = last delivered
   seq, below the 2200 global high-water because of the visibility holes).
4. **Raw Engine.IO close** (`Client.Conn().Close(true)`): the original
   client sees reason "transport close", auto-reconnects and
   re-authenticates — the revocation close path.
5. **Namespace disconnect** (`Socket.Disconnect(false)`): the client sees
   "io server disconnect", `active === false`, and does NOT auto
   reconnect — proving revocation must never use the Socket.IO-level
   disconnect (v3.0.6 `Client._disconnect()` sends the namespace packet
   even for `Disconnect(true)`).
6. Revocation flow: live socket evicted via raw close AND the reconnect
   rejected ("Invalid or expired token").
7. Origin allowlist enforced at the HTTP layer (403) on the restricted
   instance; origin-less (Node) clients pass.
8. Unknown/oversized events ignored honestly; polling refused with 400.
9. SIGINT: all sockets closed and the process exits 0 (hijacked-socket
   reaping).
