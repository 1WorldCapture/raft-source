# M3 MACHINEWS closeout

Package: `raft.local/server-go/internal/transport/machinews`.
No migration. Ready and status writes stay on the existing `machines` row.
`runtime_versions` stay on the live connection only.

Parent code in `app/m3.go` constructs the hub with
`Authenticator: computers` and explicit `ValidatePrincipal: computers.ValidatePrincipal`.
The fallback described below remains available to other callers. Machine
rotation/deletion and committed workspace setup reset are wired to actively
retire the affected socket; neither callback runs inside its SQL transaction.

## Parent hook

```go
ValidatePrincipal func(ctx context.Context, p computer.Principal) error
```

`NewHub` resolves it in this order:

1. `Config.ValidatePrincipal` when it is non-nil.
2. Otherwise `Authenticator.ValidatePrincipal(context.Context, computer.Principal) error`
   when the authenticator has that method. `*computer.Store` does.
3. Otherwise `NewHub` returns `machinews: Config.ValidatePrincipal is required`.

This check is a cheap revision, revocation, workspace and binding read.
It is not Argon2. Handshake `Authenticate` is what proves
`Principal.CredentialRevision`.

`computer.ValidatePrincipalTx(ctx, tx, p)` is called by machinews inside
the same transaction as each ready, heartbeat and online/offline write.
There is no separate TX hook for the parent to wire. Agent and runner
writers keep calling `ValidatePrincipalTx` themselves.

Callback signatures are unchanged. The `ctx` they receive is now bound
to that connection generation:

```go
OnReady      func(ctx context.Context, p computer.Principal, ready json.RawMessage) error
OnMessage    func(ctx context.Context, p computer.Principal, msg json.RawMessage) error
OnDisconnect func(ctx context.Context, p computer.Principal) error
```

`Hub.Send(ctx, machineID, payload)` delivers to the current connection
when `ctx` has no generation. When `ctx` is a callback context, or any
child of one (`context.WithoutCancel` included), Send delivers only to
that generation. A replaced generation returns `ErrMachineOffline` and
does not enqueue on the new socket. Agent `OnReady` / `OnMessage`
already pass this `ctx` into `gateway.Send`. A callback that drops the
context and calls `Send(context.Background(), machineID, ...)` is not
generation-fenced.

`OnReady` and `OnMessage` contexts are children of the socket context.
They cancel when that generation is retired or `Hub.Close` runs.
`OnDisconnect` uses its own context, parented on the hub, because the
socket context is already canceled when the grace timer fires. That
context cancels when the projection is superseded or the hub closes.

## What the fence does

Each machine has its own lock. The hub map lock is not held across
SQLite or socket writes. While a generation is inside ready, pong,
shutdown, an inbound message, heartbeat revalidation, or the offline
projection, that lock is held across the cheap principal check, the
facts transaction, and the callback. Replacement and `Disconnect` wait.
The socket write itself runs on the connection's writer after enqueue,
without that lock.

Ready retries keep the newest payload and fire again on each
`ReadyRetryInterval` until the write commits, the generation is
replaced, the principal is denied, or the hub closes. A denied
principal retires the socket (legacy migration uses close code 4002;
other denials use 1008) and does not run the callback. An
infrastructure error does not run the callback and does not commit;
ready and offline try again. Offline is not applied after a reconnect
has claimed the machine, including when the grace timer was already
inside its fence.

`Hub.Close` cancels handshake, socket, callback and offline contexts,
stops timers, and waits until those goroutines leave. During global shutdown,
published and pending transports are forcibly closed rather than waiting for
each peer's graceful close handshake after cancellation. This prevents a client
that is not reading from consuming a network timeout per machine. Normal
replacement and credential-denial paths retain their protocol-specific close frames.

The callback-cancellation/close, other Close cases, and failed-reconnect regression
passed 20 consecutive runs under `-race -timeout=120s` after this shutdown fix.

## Tests

```text
go test -count=1 -timeout 180s ./internal/transport/machinews/
ok  raft.local/server-go/internal/transport/machinews  1.210s

go test -count=1 -race -timeout 300s ./internal/transport/machinews/
ok  raft.local/server-go/internal/transport/machinews  16.169s
```

Those worker runs cover the whole machinews package on the real SQLite migration
chain, real `computer.Store.Authenticate` / `ValidatePrincipal`, and real WebSocket
pipes. Parent subsequently ran the full repository `make check`; see
`phase-3-backend-handoff.md` for assembled HTTP, race and build evidence.

Covered here, in addition to the existing handshake and protocol suite:
replacement blocked inside the ready transaction; replacement winning
the ready and offline fence gaps; ready retry repeating until commit
and not committing after replacement; revoked computer and migrated
legacy keys retiring the established socket on the next frame; a
delayed callback `Send` with the old generation context not reaching
the replacement; reconnect canceling the delayed offline projection;
infrastructure validation failing closed and then retrying; `Close`
joining a blocked offline callback and stopping an armed ready retry;
repeated replacement with concurrent snapshot reads. Connection
principals used in those tests carry a real `CredentialRevision` that
`ValidatePrincipal` accepts until the verifier changes.

Preserved from the parent: `waitFor` delegates to `waitCond`, the
second ready clears stale `runtimeVersions`, and the ingress rate-limit
test reads the ping barrier before advancing the window.

## Parent follow-up: failed reconnect recovery

`claim` now suspends an already scheduled offline projection in `displaced`
instead of canceling its context. Successful publish discards it; a context-frame
or publish failure restores it through `abandon`. This prevents a failed reconnect
from permanently losing the previous disconnect callback/status transition.
`TestFailedReconnectRestoresPendingOfflineProjection` drives a real connection,
a real disconnect, a blocked then canceled new handshake, and the restored timer.

The regression plus reconnect-cancel and blocked-ready replacement tests passed
10 consecutive runs under `-race` (`-timeout=90s`). It complements, rather than
replaces, the full package and application checks.

## Remaining operational semantics and boundaries

- A revoked, rotated or migrated principal cannot update
  `machines.last_status`. The offline projection then skips both the
  row write and `OnDisconnect`. `IsOnline` / `Status` still report
  offline from the live map. The stored `last_status` can remain
  `online`.
- `Send` is generation-fenced only for contexts derived from the
  callback context. A background context still targets the connection
  that is current at enqueue time.
- `Send` can return nil after enqueue, and the writer can then drop
  that frame if a later cheap revalidation hits an infrastructure
  error. An auth denial retires the socket and does not write the frame.
- `Hub.Close` cancels offline projections instead of flushing them.
  Shutdown does not emit `OnDisconnect`.
- A callback that ignores `ctx.Done()` holds the machine lock until it
  returns, so replacement and `Close` wait with it.
- `Config.AuthRecheckInterval` is still applied as a default and is not
  used to skip checks.
- `machine:shutdown` is stored on the live connection and logged.
  There is still no outage-occurrence table to suppress.
- No UI or browser end-to-end run.
