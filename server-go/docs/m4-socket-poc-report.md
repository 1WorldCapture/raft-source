# M4 P0 Socket.IO compatibility spike — executed evidence

Date: 2026-10-08. Reference checkout: `bc65213b377a992c381e809c72ba50ca9af367fd` plus the uncommitted M4 implementation. This is **backend protocol verification**, not browser/UI acceptance and not yet proof of the full application publisher/authentication integration.

## Candidate and reproducibility

The parent executed the isolated runner against the repository's actual `socket.io-client@4.8.3`, websocket-only:

```sh
cd server-go
RAFT_M4_SOCKET_CANDIDATE_VERSION=v3.0.6 node tests/acceptance/m4-socket-poc.mjs
```

The runner creates a temporary Go module, binary and TWO dynamic loopback listeners, runs the locked original JS client, requires clean SIGINT shutdown, then reaps children and deletes its own directory. It does not touch the running4301/5175 services, var*, client source/lockfiles or browser state. No TS server, Redis or PostgreSQL is started. The candidate is now pinned in the main Go module after this test passed.

Verified candidate identity:

```text
path:     github.com/zishang520/socket.io/servers/socket/v3
version:  v3.0.6
sum:      h1:UyTQLH337I1rApCt18U8ZVn4aPb0xW6uNKKqGuWSrdI=
goModSum: h1:FPkhS1sOBp/zpkpuhjHttNppkPX18Zs5oFNn3xgG91s=
```

The engine, socket parser, engine parser and shared root/v3 modules are also pinned to v3.0.6. The candidate module requires Go1.26.0; the project keeps its existing Go1.26.0 baseline and Go1.27.1 toolchain. Runtime transport is explicitly websocket-only; transitive WebTransport/QUIC packages do not imply enabling those listeners or promising support for them.

## Actual results

- Candidate CGO-free compilation: **PASS**.
- Original JS client protocol assertions: **27 PASS, 0 FAIL**.
- Clean shutdown and owned-process cleanup: **PASS**.
- Main-module `go mod tidy -diff`: no differences.
- Main-module `go mod verify`: all modules verified.
- `go test -count=1 -race ./internal/transport/socketio/...`: gateway/core pass; zishang binding compiles (network behavior is covered by the spike rather than a no-op binding unit test).

The27 assertions cover handshake/auth passthrough, rooms:joined after setup, single message payload, application heartbeat, two-page authorized recovery (500+300 out of1200 records with400 invisible), join/leave behavior, unknown events, raw-transport close and actual automatic reauthentication, revoked user reconnect denial, exact expiry/nonmember/missing/wrong-purpose errors, namespace-disconnect contrast, Origin rejection and explicitly permitted originless native client behavior. Unsupported polling separately returns400 instead of a fake handshake.

## Failures found and corrected before the passing run

1. The first compile used the obsolete/nonexistent `github.com/zishang520/socket.io/types`. Actual v3 common types are in `github.com/zishang520/socket.io/v3/pkg/types`; all binding APIs were checked against cached v3.0.6 primary source, then compiled.
2. `Socket.Disconnect(true)` emits a Socket.IO namespace disconnect first, disabling the JS client's automatic reconnect. Actual revocation uses the underlying Engine.IO `Client.Conn().Close(true)` discard/transport close. Both behaviors were exercised rather than inferred from method names.
3. The first fixture expected two500-message pages even though only800 messages were visible. The test now asserts500+300 and verifies no invisible records; no data was invented to satisfy the test.
4. The first disconnect assertions compared the two-argument `disconnect(reason,description)` result to a string. The corrected assertions inspect the reason argument while retaining the general helper's multi-argument behavior for payload tests. Actual observed reasons were already `transport close` and `io server disconnect`; this was a test-shape error, not a server behavior change.
5. Reconnect listeners are attached before the triggering close so the rooms barrier cannot be missed. The old fixed-port/write-in-repository shell runner was removed in favor of the parent-owned temporary runner.

## Remaining application-level gates

These results prove the selected library can carry the original wire contract. Full Go-server tests must still demonstrate real database identity/session expiry, current channel/DM/thread audiences, transaction-generation revocation during handshake/enqueue/dequeue, the durable publication worker, private viewer/read/prefs events, long-message/byte-bounded recovery, slow-consumer handling, process restart and integrated graceful shutdown.

The library has internal unbounded buffers and no default websocket write deadline. The gateway adapter adds bounded admission, a transport writability window and a write-stall close; these mechanisms require integrated slow-client/race validation. A successful spike is not a declaration that arbitrary upstream buffering is safe.

Browser/UI sign-off remains explicitly assigned to the user's separate tester.
