# M3 MACHINEWS contract — legacy Daemon `/daemon/connect` transport

Status: constructor below is STABLE for the parent and the AGENT worker. Field
additions will be additive only; renamed/removed identifiers will be called out
in this file first.

Package: `raft.local/server-go/internal/transport/machinews` (MACHINEWS worker
owns this tree and its tests). Parent wires `Hub.ServeHTTP` on the shared mux at
exactly `/daemon/connect`. No migration is added by this slice: no persistent
transport generation/lease is needed (single-process Go replaces the TS Redis
replica lease; connection generations are in-memory and monotonic). All ready
facts persist to the EXISTING `machines` row from 0004 — no shadow catalog, no
new columns. `runtime_versions` stays connection-scoped memory exactly like the
TS owner-replica state (TS never persists it to `machines` either).

## Constructor (stable)

```go
package machinews

func NewHub(cfg Config) (*Hub, error)
```

`NewHub` validates inputs and returns an error when a required dependency is
missing. It performs no I/O; call it before serving.

```go
type Config struct {
    // Authenticator is REQUIRED and is satisfied by *computer.Store:
    //   Authenticate(ctx, key string) (computer.Principal, error)
    Authenticator Authenticator

    // DB is REQUIRED: the shared SQLite handle. Used only for owned machine
    // connection writes on the existing machines row (runtimes/hostname/os/
    // daemon_version, computer_version 24h refresh, last_heartbeat,
    // last_status/status_changed_at). Never held across a network write.
    DB *sql.DB

    // Clock is REQUIRED (use platform clock.Clock; tests pin a fake).
    Clock clock.Clock

    // Logger optional (defaults to slog.Default()). The raw API key and the
    // legacy ?key= query value are NEVER logged.
    Logger *slog.Logger

    // Agent-store callbacks, all optional (nil = no-op), all invoked with the
    // authenticated principal of the CURRENT connection generation:
    //   OnReady      - after the ready frame's machine facts are persisted
    //                  (raw ready JSON passed through verbatim)
    //   OnMessage    - every non-transport inbound frame (raw JSON verbatim),
    //                  called synchronously in per-machine frame order
    //   OnDisconnect - after the disconnect grace window with no replacement
    // Each returns error; errors are logged, never fake-acked. A non-nil
    // error from OnMessage means the message was NOT handled successfully —
    // machinews sends no success ack on the daemon's behalf.
    OnReady      func(ctx context.Context, p computer.Principal, ready json.RawMessage) error
    OnMessage    func(ctx context.Context, p computer.Principal, msg json.RawMessage) error
    OnDisconnect func(ctx context.Context, p computer.Principal) error

    // Bounds; zero values take the Defaults (see Parity table below).
    HeartbeatInterval   time.Duration // ping cadence
    HeartbeatTimeout    time.Duration // inbound liveness proof timeout
    DisconnectGrace     time.Duration // delayed offline projection window
    WriteTimeout        time.Duration // per outbound frame
    ReadLimit           int64         // max inbound frame bytes
    SendQueueDepth      int           // bounded outbound frames per connection
    ReadyRetryInterval  time.Duration // machine-facts persist retry cadence
    AuthRecheckInterval time.Duration // min spacing between key re-verifications
}

func (Config) WithDefaults() Config
```

`Config.WithDefaults()` is exported for the parent to inspect resolved bounds.

## Hub public API (exact, from the coordination seam)

```go
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request)
func (h *Hub) IsOnline(machineID string) bool
func (h *Hub) Status(machineID string) string // "online" | "offline" | "unknown"
func (h *Hub) Send(ctx context.Context, machineID string, payload any) error
func (h *Hub) Disconnect(machineID string) // invalidate active connection safely
func (h *Hub) Close() error                 // idempotent; joins all connection goroutines
```

- `Status`: `"online"` iff this hub holds a live registered connection;
  `"offline"` when no connection exists and the machines row exists;
  `"unknown"` when the machine row does not exist. The hub never reports
  `"online"` from persisted state alone (M2 rule: unprovable online-ness is
  not fabricated).
- `Send` serializes `payload` with encoding/json and enqueues it on the
  machine's CURRENT connection writer. Errors: `ErrMachineOffline`,
  `ErrHubClosed`, `ErrSendQueueFull` (bounded queue), `ErrMachineUnknown`
  (no machines row). Satisfies the AGENT gateway seam (`IsOnline` + `Send`).
- `Disconnect` closes the active connection (WebSocket 1000) and runs the
  standard disconnect pipeline (including the delayed offline projection),
  so revoke/unlink callers get agent-visible semantics for free.
- `Close` closes every connection with 1001 `going_away`, stops timers and
  waits for all goroutines. The hub refuses new handshakes afterwards.

## Authenticator seam (implemented against COMPUTER)

```go
// Satisfied by *computer.Store (documented COMPUTER seam).
type Authenticator interface {
    Authenticate(ctx context.Context, key string) (computer.Principal, error)
}

// Deny reasons. Errors returned by Authenticate should implement
// ReasonError; the Reason string becomes the Slock-Reason header verbatim
// when it is a member of the closed set below.
type ReasonError interface {
    error
    Reason() string
}
```

Closed `Slock-Reason` set (union of TS `AuthDenyReason` — values are
byte-identical to `packages/server/src/routes/daemon.ts`):

```
missing_key, invalid_key_format,
computer_not_found, computer_revoked, computer_machine_unlinked,
computer_key_hash_mismatch, server_not_found,
machine_not_found, machine_key_invalid, legacy_machine_key_migrated,
exception
```

- 401 + `Slock-Reason` for every reason above except `exception`.
- 500 (no reason header) when Authenticate fails without a set-member Reason
  (infrastructure). COMPUTER: please make Authenticate return ReasonError
  with set-member reasons for every deny; keep infrastructure failures
  distinct (any non-member Reason maps to 500/exception here).
- COMPUTER is expected to accept BOTH `sk_computer_*` (Principal.Kind
  `"computer"`) and legacy `sk_machine_`/`sk_daemon_` keys (Kind
  `"legacy_machine"`), performing the machine-link + server-liveness checks.
  machinews performs the pure-format classification itself (missing key /
  `invalid_key_format`) before calling Authenticate — exactly the TS stage
  split (`format` stage happens in the route; lookup stages in the service).
- `Principal.WorkspaceID` is the TS `serverId` (Go workspace id);
  `Principal.MachineID` is the machines row id.

## Wire behavior (traced from TS; byte parity where noted)

Handshake (`routes/daemon.ts` + `machineContext.ts`):

1. Path must be exactly `/daemon/connect`; anything else 404s.
2. Key: `Authorization: Bearer <key>` preferred; legacy `?key=` accepted for
   old daemons, never logged, never echoed.
3. Auth runs BEFORE the WebSocket upgrade; rejection is a plain HTTP 401 with
   `Slock-Reason` header (no upgrade, no close frame). This is what the
   original daemon's `connection.ts` matches on for the terminal
   `legacy_machine_key_migrated` stop.
4. Upgrade via coder/websocket with DEFAULT origin verification (no
   `InsecureSkipVerify`): daemons (no Origin header) connect; a browser
   Origin that does not match the request host is rejected 403. There is no
   browser Origin bypass.
5. First frame after upgrade, before anything else can send:
   `{"type":"machine:context","machineId":"<machine>","serverId":"<workspace>"}`
   Failure to write it closes 1011 `machine_context_send_failed` and never
   registers the machine.
6. Registration: machine-scoped generation counter increments; an existing
   connection for the same machine is closed (1000, like TS
   `clearMachineConnection` default) and its callbacks become inert; a
   pending offline projection for that machine is cancelled (reconnect inside
   the grace window keeps the machine online — TS
   `cancelPendingMachineDisconnect`). `last_status` records `online` with the
   TS continuity rule (a reconnect whose previous heartbeat is ≤3 min old
   keeps `status_changed_at`).

Transport frames handled INSIDE machinews (never forwarded):

- `ping` → reply `{"type":"ping"}` (TS replies ping-to-ping, not pong).
- `pong` → liveness proof; persists `machines.last_heartbeat = now`; also an
  auth re-verification point (see Revocation).
- `ready` → validate + persist facts (below), update connection state, then
  generation-fenced `OnReady(ctx, principal, rawReadyJSON)`.
- `machine:shutdown` → record `shutdownIntent{reason ∈ computer_stop |
  daemon_stop | unknown, receivedAt}` on the connection (parity with TS;
  Go M3 has no outage-occurrence tables, so the intent currently informs
  disconnect cause/logs only — noted gap, no fake suppression).

Every other frame (`agent:*`, `machine:*:*_result`, `computer:*`,
`reminder.*`, unknown types, …) is passed VERBATIM (raw JSON) to `OnMessage`.
machinews deliberately does not interpret or ack them — authorization to the
machine↔agent binding is the Agent store's job; unknown messages are never
treated as successful jobs. Invalid JSON is logged and dropped (TS parity).

Ready persistence (all to the REAL machines row; TS `updateMachineRuntimes` +
`recordMachineComputerVersion` semantics):

- `runtimes` (JSON array), `hostname`, `os`, `daemon_version` — each field is
  written only when the ready frame carries it (TS `!== undefined` semantics:
  an absent field never clobbers the previous value).
- `computer_version` (+`computer_version_reported_at`) — written only on
  version CHANGE or when the last report is ≥24 h old (exact TS refresh rule,
  null-safe comparison).
- `runtime_versions` — normalized with the exact TS rule (≤32 entries, keys
  must be reported runtimes, key ≤64 chars, value trimmed 1..128 chars) and
  kept on the connection only, like the TS in-memory owner state.
- Capabilities/hostKind/daemonVersion/computerVersion are validated+normalized
  (hostKind closed set `desktop_app|standalone`, missing → `standalone`) and
  kept as connection state for later readers.
- A failed facts write is retried by the server on `ReadyRetryInterval` until
  it lands or the connection is replaced (newest ready payload wins) — the
  TS `enqueueCapabilitiesPersist` convergence contract; no fake success.

Heartbeat (TS `startMachineHeartbeat`/`onMachineHeartbeatTick` parity):

- Ping `{"type":"ping"}` every 30 s (configurable).
- Liveness proof = max(lastPong, lastIngress). Proof older than 60 s →
  TCP-level terminate (`CloseNow`, the Go equivalent of ws `terminate()`),
  disconnect cause `heartbeat_timeout`.
- One observation time per frame: `lastIngress` updates once per accepted
  frame, before any handler runs.

Ingress rate limiting (TS `planDaemonIngressRateLimit` parity): the 8 legacy
lifecycle frame types are limited per machine+type (2000/10 s) and per machine
total (3000/10 s); over-limit frames are dropped with a throttled log. Not
applied to ping/pong/ready.

Revocation on ESTABLISHED connections (coordination seam requirement): the hub
re-runs `Authenticate` with the connection's key on every heartbeat tick and
on every inbound `pong`/`ready` frame, but at most once per
`AuthRecheckInterval` (default 30 s) so a busy activity stream cannot turn
into per-frame Argon2 work. A deny closes the connection: legacy keys denied
`legacy_machine_key_migrated` close 4002 `legacy_machine_key_migrated` (exact
TS fence code); other denies close 1008 with the deny reason. COMPUTER revoke
makes the very next tick/pong fatal. For immediate teardown, revoke callers
may also call `Hub.Disconnect(machineID)`.

Delayed disconnect projection (TS `MACHINE_DISCONNECT_PROJECTION_GRACE_MS`):

- Socket close/error → connection removed from the live map immediately
  (stale-socket frames are ignored by generation), then an offline projection
  is scheduled after 2 s grace.
- Reconnect inside the grace cancels the projection (no offline flap).
- The projection (generation-fenced): `last_status` ← `offline` at the
  DISCONNECT time (writes older than a stored newer since are dropped, exact
  TS `recordMachineStatusTransition` monotonic guard), then
  `OnDisconnect(ctx, principal)`.

Replacement/fencing: every registration bumps a hub-wide monotonic generation;
delayed projections, auth-recheck closes, ready-fact writes and all callbacks
re-check "am I still the current connection for this machine?" under the hub
lock before mutating anything. A replaced connection's late callbacks are
inert — they can neither fire OnDisconnect for the successor nor write facts.

Bounded resources: per-connection outbound queue (`SendQueueDepth`, default
1024; overflow returns `ErrSendQueueFull`, never blocks the caller or grows
without bound), single writer per connection with `WriteTimeout` (default
30 s), `ReadLimit` (default 100 MiB — the exact `ws` library default the TS
server ran with; configurable), heartbeat timers bounded by the injected
scheduler, one read loop per connection, `Close()` joins everything.

## What machinews does NOT do (honest boundary)

- No Socket.IO (`io.to(...)` web relays, `machine:status` socket events,
  cross-replica Redis lease/mirror) — Socket.IO is a separate M4 surface.
- No agent start dispatch, delivery, briefing, @delivery, ACK, migration
  transport, runtime account usage, cursor-sdk flows — those are M4/M5 and
  the Agent store's callbacks.
- No messages/delivery claims of any kind.
- No outage-occurrence recording (`recordComputer{Online,Offline}Transition`
  tables do not exist in the Go schema; disconnect cause is logged instead).
- Ready-frame `lifecycleAcks` are accepted but not acted on (no computer
  lifecycle operation tables in Go M3).
- `machine:shutdown` intent is recorded (connection state + logs) but cannot
  suppress outage transitions that don't exist yet.

## Parent wiring (suggested; ownership stays with parent)

```go
hub, err := machinews.NewHub(machinews.Config{
    Authenticator: computerStore,          // *computer.Store
    DB: handle, Clock: clock.Real{}, Logger: logger,
    OnReady: agentStore.MachineReady,       // or closures assigned pre-serve
    OnMessage: agentStore.MachineMessage,
    OnDisconnect: agentStore.MachineDisconnected,
})
mux.Handle("/daemon/connect", hub)          // exact path; hub 404s others
// app shutdown: hub.Close() before DB close
```

`Hub.Status` is the narrow injection the workspace setup probe needs (parent
owns exposing it); `IsOnline`+`Send` satisfy the AGENT gateway interface
without any wrapper.

## Tests (own suite, real transport)

`internal/transport/machinews/*_test.go`: real SQLite (platform db.Open on a
temp dir), real WebSocket dials against an httptest server (no fake
Socket.IO, no skipped handshake), pinned clock + manual scheduler (no flaky
sleeps). Coverage: handshake reason matrix incl. Slock-Reason bytes and the
legacy `?key=` form; first-frame machine:context contract; ping/pong;
ready fact persistence + partial-field semantics + 24 h computer-version
refresh; replacement + delayed disconnect + grace cancel; generation fences;
revocation on live connections; rate limiting; Send/Status/IsOnline;
Disconnect/Close joining.
