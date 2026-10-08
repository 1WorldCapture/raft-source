# M3 implementation coordination — completed backend handoff

**2026-10-08：M3 后端已完成集成并通过全量 `make check`。**
当前交付范围、执行证据、启动/升级说明和交给测试人员的 UI 清单见
[phase-3-backend-handoff.md](phase-3-backend-handoff.md)。下方保留实施期间的职责与接口约定；
这些 worker 均已结束，不表示仍有未运行的后台工作。UI 端到端测试本轮未执行。

Baseline: `4acd990` (M2 committed). Workspace `/Users/lyon/workspace/raft-source`, actual checkout. User requests COMPLETE phase 3 backend, browser/UI validation remains the collaborator's responsibility. Their M2 UI verification passed after replacing a stale running binary. Do not touch `gui-test-screenshots/`, any existing `var/`, running server, client code, TS code, package lockfiles, or global configuration. No commit/push. Work only in server-go. Preserve M1/M2 migrations 0001–0005 and behavior. No TS server/runtime dependency. One Go module, one SQLite DB. Parent owns integration, shared routes/Deps/config/app/main/README/Makefile, acceptance runner, general docs, dependency changes.

## Scope from architecture-and-phase-1.md §8

M3A: public/private channels, actual list/detail/create/profile/roster/join/leave/archive and basic channel authority/visibility. M3B: Agent identity and machine binding, Computer login/device authorization/attach, actual legacy Daemon credentials/registration/WebSocket connection/ready/heartbeat/reconnect/basic lifecycle, original Agent CLI read/identity contracts required for that slice. Agent identity != running process != transport connection.

Messages/history/unread calculation/browser Socket.IO are M4; durable @delivery/briefing/ACK are M5. Do not implement fake empty-success endpoints for these. Joint-channel workflows, cloud billing/marketplace/migrations and arbitrary remote filesystem features remain deferred. Full M3 does not mean the thousands of unrelated endpoints in the TS repo. However necessary original client bootstrap/ready/create dependencies MUST be traced and supported, not quietly skipped.

Parent will add exact reserved user-scoped route handling for `/api/servers/unread-summary` (clean unsupported 404, no `:id` fallthrough), build identity to diagnose stale binaries, and record the UI report and origin/proxy choices. UI collaborator later runs the original Web; no browser claims from backend fixtures.

## Ownership slots

1. CHANNEL worker: internal/channel/**; internal/transport/legacyweb/channel_*.go (new only); migration `0006_channel_core.sql`; docs/m3-channel-contract.md; own tests. Own all channel behavior, exact DTO/errors and role capabilities from full middleware+TS services. Do not edit routes.go/app.go. Export registration `RegisterChannelRoutes(mux *http.ServeMux, handlers *ChannelHandlers, gate *AuthGate)` in legacyweb. Parent wires it. Constructor/fields describe in your doc. Reuse existing channels/channel_humans; add necessary channel_agents and columns (no messages table). Preserve system-channel special behavior. Coordinate agents worker on channel_agents schema early through your doc.
2. COMPUTER worker: internal/computer/**; internal/transport/legacyweb/computer_*.go (new only); migration `0007_computer_admission.sql`; docs/m3-computer-contract.md; own tests. Trace original packages/computer login/attach/setup and routes agentLogin/deviceAuth/computerAttach/internalComputer. Implement user login grant + device lifecycle + secure Computer keys/attach/revoke and legacy machine creation/key rotation/register reads. Auth adapters may depend on auth service/session APIs; do not modify auth without parent agreement. Export registration `RegisterComputerRoutes(mux *http.ServeMux, handlers *ComputerHandlers, gate *AuthGate)`. Coordinate required internal routes with AGENT worker.
3. AGENT worker: internal/agent/**; internal/transport/legacyweb/agent_*.go (new only, do not overwrite M1 auth handlers); internal/transport/agentapi/**; migration `0008_agent_identity.sql`; docs/m3-agent-contract.md; own tests. Trace actual Web create Cindy/generic Agent and CLI bootstrap/config/identity reads (read packages/cli/AGENTS.md BEFORE reading CLI source). Identity, credentials, role/space/channel isolation, list/detail/settings, assignment, lifecycle start/stop/reset/delete within M3, official onboarding checkpoint in same SQLite serialization boundary as reset. No LLM call or fake launch/briefing. Machine command adapter interface below. Export `RegisterAgentRoutes(mux *http.ServeMux, handlers *AgentHandlers, gate *AuthGate)`; parent wires. Internal Agent credentials are NOT user JWT or Computer key.
4. MACHINEWS worker: internal/transport/machinews/**; migration `0009_machine_connections.sql` ONLY if persistent transport generation/lease needed; docs/m3-machinews-contract.md; own tests. Exact raw WebSocket `/daemon/connect` protocol from TS routes/daemon.ts, machineContext.ts and packages/daemon/src/connection/core.ts/shared wire types. Use github.com/coder/websocket v1.8.15 (parent adds dependency). Socket.IO is separate/deferred. Authenticate using Computer worker's exported Store.Authenticate; legacy query key accepted compatibly but not logged; no browser Origin bypass. Generation fences, replacement/delayed disconnect, bounded heartbeat/ready/read/write, revocation on established connections, persisted ready runtimes/version facts, shutdown joins. MachineToServer messages must be authorized to their binding, unknown messages not treated as successful jobs. Owned machine connection writes can be within this transport boundary; Agent status changes go through callbacks below.

## Cross-worker seams (publish actual signatures/schema promptly in your contract doc)

COMPUTER defines:
```
type Principal struct { Kind, ComputerID, MachineID, WorkspaceID, UserID string }
func (*Store) Authenticate(ctx context.Context, key string) (Principal, error)
```
Authentication errors expose safe closed-set `Reason` (for Slock-Reason); missing/revoked/invalid keys and infrastructure error distinct. Store constructor uses real SQLite handle and injected clock. Computer revoke invalidates DB key immediately; hub rechecks every inbound/heartbeat and optionally parent wires immediate revoke callback. Attach atomically creates actual machine + Computer and returns exact existing wire names (`serverMachineId` is Computer id, not machine id).

MACHINEWS hub public API:
```
func (*Hub) ServeHTTP(http.ResponseWriter, *http.Request)
func (*Hub) IsOnline(machineID string) bool
func (*Hub) Status(machineID string) string // online/offline/unknown per real connection
func (*Hub) Send(ctx context.Context, machineID string, payload any) error
func (*Hub) Disconnect(machineID string) // invalidate active connection safely
func (*Hub) Close() error
```
Hub config accepts the authenticator and agent callbacks `OnReady(ctx, computer.Principal, json.RawMessage) error`, `OnMessage(ctx, computer.Principal, json.RawMessage) error`, `OnDisconnect(ctx, computer.Principal) error`. Publish constructor promptly. Callback execution fenced by connection generation; old ready/message/disconnect may not mutate replacement state. Never hold SQLite tx across network writes. Ready metadata belongs in real machines row, not a shadow catalog.

AGENT defines a minimal gateway interface satisfied by Hub (`IsOnline`, `Send`). Export lifecycle callbacks matching above or describe wrapper required. Store needs gateway injected once at assembly, not racy SetGateway on active service. Parent can wire callbacks via closures assigned before serving. Agent start commands use actual TS wire payload/credentials expected by existing daemon; readiness/status responses are handled honestly. Channel agents roster uses 0006 schema; add only after verifying it.

Workspace setup probe currently private: parent will expose narrow injection for Hub.Status and update machine directory read projections. Existing `TransitionSetup`, `ResetSetup` and setter reconcile remain authoritative. Agent worker may add a narrowly named file in internal/workspace for transaction-based official checkpoint if necessary; ask parent via contract doc before touching existing files.

## Verification rules

Read exact relevant source before implementing. No guesses from endpoint names. Record requests, successful DTO, middleware ordering, errors, side effects, enabled local policy vector, and omitted capabilities. Write real SQLite behavior tests, HTTP tests, fault/rollback/auth/cross-space tests, and wire-level tests. Pin clocks and fixture times rather than flaky sleeps. Upgrades from true M2 must preserve IDs/keys/passwords/session tokens/memberships/preferences/avatars and system channels. Never create fallback test stub tables that mask missing migrations. UI remains untested here.

Use code edits/write tools for files. Shell only inspect/build/test/git/package operations; no ad-hoc script overwrites of project files. Format your OWN files only while workers run. Do not use `go get`/tidy to mutate shared go.mod: parent owns dependency changes. You may run all tests read-only but transient cross-worker compilation errors should be reported, not patched in others' files. No commits, no killing user processes, no modifying persistent data. Return precise results and gaps; don't claim total compatibility or completed tests not executed.
