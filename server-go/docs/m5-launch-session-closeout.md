# M5 launch/session generation closeout

Date: 2026-10-09. Scope owned here: `internal/agent/**`, new migration `internal/platform/db/migrations/0015_launch_session.sql`, and this note. No other application or transport files, no migration 0014 or earlier, no `migration-additions.json`, no fixtures, clients, locks, goldens, Makefile, instances, or data. Not committed.

`application/agentdelivery/dispatcher.go` is untouched. The dispatcher already copies `ManagedDispatchFacts` field-for-field. It does not need a code change for this fence. The dependencies below are for that worker and for the parent hash registration.

## What was wrong

`ManagedDispatchFactsTx` treated the newest open `agent_launches` row and `agents.session_id` as one identity. Stop keeps `agents.session_id` so the next `agent:start` can resume. Start then reserves launch L2. Before the new `agent:session` callback, facts reported `(L2, old S1)` and a managed lease could be created for that crossed pair.

`currentLaunchOn` also ignored `launch.machine_id` versus `agents.machine_id`, so a launch left on the previous machine still counted as current.

`AssignMachine` was a raw `UPDATE` outside `platformdb.WithWriteTx`. It did not re-read the agent, workspace, or target machine, and it did not supersede open launches. The dispatcher’s `identityWaitCandidates` query skips `EnsureStartLaunch` while any `reserved`/`dispatched`/`acked` launch exists, so the old launch both kept the old generation admissible and blocked a start on the new machine.

## Schema (0015)

File: `internal/platform/db/migrations/0015_launch_session.sql`

- sha256: `58ba9791d8ea684877dace3ebf813aa8564e051254ab8b4bcbeb8d1c29441353`
- bytes: `567`
- One statement. No INSERT, no UPDATE, no backfill, no new table, no index, no check, no rewrite of 0001–0014.

```sql
ALTER TABLE agent_launches ADD COLUMN confirmed_session_id TEXT;
```

SQLite appends the column. Final `agent_launches` column order:

`id`, `start_dispatch_id`, `workspace_id`, `agent_id`, `machine_id`, `state`, `queue_state`, `dispatch_count`, `last_dispatch_at`, `acked_at`, `terminal_code`, `revision`, `created_at`, `updated_at`, `confirmed_session_id`.

`confirmed_session_id` is nullable TEXT with no default. Existing and newly inserted launches leave it NULL. NULL means “this launch has not reported a session.” Empty string is not written.

`NewLaunchStore` now fails construction when this column is missing (`requires migration 0015`), after the existing 0014 table check.

Parent registration, not done here. `contracts/client/migration-additions.json` must gain this entry and `expectedCount` must become 2. Until that lands, `node tests/acceptance/client-contracts.mjs` fails `migration-inventory` / hash drift on purpose:

```json
{
  "file": "0015_launch_session.sql",
  "sha256": "58ba9791d8ea684877dace3ebf813aa8564e051254ab8b4bcbeb8d1c29441353",
  "bytes": 567,
  "introducedBy": "docs/m5-launch-session-closeout.md",
  "capability": "M5 per-launch confirmed session binding (nullable agent_launches.confirmed_session_id, no backfill)"
}
```

`go test ./internal/platform/db/ -run 'TestM5UpgradeChangesAreAdditiveAndDocumented|TestM5UnconfirmedDeliveryIntentsSurviveReopen'` passed against this file. The column is on a table created by 0014, not on an M4 table, and the migration writes no row.

## Identity rule

Dispatch session is `agent_launches.confirmed_session_id` of the newest non-terminal launch whose `machine_id` equals the live `agents.machine_id`. `ManagedDispatchFacts.SessionID` and `CurrentControlIdentity` both use that pair. They do not read `agents.session_id`.

`agents.session_id` stays the resume pointer. Stop, a failed start, machine move, and unbind do not clear it. `NewStartCommand` / `NewStartDispatchCommand` still put it on `config.sessionId`. No wake or resume payload was added. No wire field was added.

The confirmed column is written only by `LaunchStore.ConfirmSessionTx`, called from the authenticated `agent:session` path after `AcceptSessionFrameTx` accepts the current launch, inside that same `WithBoundAgent` transaction. `ClearConfirmedSessionTx` runs only from the matching `agent:session:invalidate` transaction. A start ack does not set it. Reserve inserts omit it. Nothing copies `agents.session_id` into it.

A frame that names a launch id, or that arrives while a current launch exists, is decided on this fence. A launch-less frame for an agent with no durable launch still falls through to the M3 in-memory path. Original daemons that never echo `launchId` and were not started through a persisted launch keep that path. A stale `launchId` after stop, restart, or move does not update the resume pointer and does not confirm a binding.

`currentLaunchOn` joins `agents` and requires `agents.machine_id = agent_launches.machine_id` and a live agent. `ReserveStartLaunchTx` still supersedes every open launch on a different machine before deduping the same-machine launch, so a later reserve cannot leave the old generation open.

## Assignment

`Store.AssignMachine` runs in `WithWriteTx` (authority fence + IMMEDIATE). In that transaction it re-reads the agent and workspace, rejects a deleted agent, a workspace mismatch, a deleted workspace, an external runtime, and a machine that is missing or in another workspace. It then supersedes every open launch whose machine is not the resulting machine, including when the agent row already names that machine, and then updates `agents.machine_id`. Same-machine launches stay, so a repeat assign does not kill the current generation. Unbind (`null` / blank) supersedes every open launch. `agents.session_id` and `agent_credentials` are not modified.

The HTTP handler was not changed. It still returns 400 for the checks it already does before the store call, and 200 on store success. A store-side refusal (the in-transaction recheck) is still mapped by that handler to 500, which is the same client outcome as the old FK failure.

## Dispatcher dependencies (do not edit dispatcher.go for this)

Facts field names and types are unchanged. `SessionID == ""` still means `waiting_identity`. After this change that empty value includes “launch exists, resume pointer exists, callback has not confirmed this launch.”

`identityWaitCandidates` is correct if every move goes through `AssignMachine`: a superseded launch no longer matches `state IN ('reserved','dispatched','acked')`, so the next scan may call `EnsureStartLaunch`. Do not treat an `acked` launch with NULL `confirmed_session_id` as absent. That row is the current generation waiting for `agent:session`. Starting another launch there races the daemon.

A raw `agents.machine_id` write still leaves the old launch open. Facts will not admit it (`currentLaunchOn` requires the same machine), but `EnsureStartLaunch` will not run until something supersedes that row. Production assignment is `AssignMachine`, which does. `ReserveStartLaunchTx` also supersedes other-machine launches when a start is actually attempted.

No new method is required on the dispatcher. Optional recovery, separate from this fence: see below.

## Start-dispatch errors and what still cannot recover by itself

Manual `Service.Start` again matches the M3 client result: `gateway.Send` failure returns 504 `daemon_timeout` and does not mark the agent active. The reserved row and its `startDispatchId` stay. A retry of Start resends that same id. `config.sessionId` is still the resume pointer. `RecordStartDispatch` failure after a successful send does not fail Start; the row stays `reserved`, and the next Start or `RecoverPendingStarts` resends the same id. The daemon dedups on `startDispatchId`.

`EnsureStartLaunch` is unchanged on failure: the error is logged, the reserved launch is returned, and the caller treats that as a durable wake. `ensureStartLaunches` will not call it again while that row exists. The resend owner is `RecoverPendingStarts`, which today runs from `OnReady` (and from whatever parent scan calls it). If the socket stays up and the one `Send` failed, nothing in `internal/agent` retries until that call. The dispatcher ticker does not. Calling `RecoverPendingStarts` for online machines from that ticker, or letting `EnsureStartLaunch` run again for a `reserved` launch, closes this. Do not implement that by ignoring `acked` rows.

A failed manual Start of a still-stopped agent leaves status `stopped` and a `reserved` launch. The next `RecoverPendingStarts` cancels that launch (`binding_lost`) because it will not start a stopped agent. The operator retries Start. That is recoverable. It is not an automatic wake.

Deliveries already leased under the old crossed pair `(L2, agents.session_id)` are not rewritten here. While facts report no confirmed session, `PrepareManagedDispatches` marks `waiting_identity` and returns before its drift/supersede branch, so that in-flight attempt stays open. Admission then disagrees with the snapshot (`identity_drift`, recoverable) if a send is still attempted. After a real callback, an unreceived mismatched attempt is superseded by the existing lease path; an attempt that already has received/pending/drained evidence follows A’s existing `uncertain_delivery` block. New leases are not created until this launch’s callback commits. `RecoverExpiredLeases` remains the owner for a lease that never reaches admission.

A runtime that never emits `agent:session` stays `waiting_identity`. That cold-start boundary is unchanged. This slice still does not invent a wake message.

## Tests

```sh
cd server-go
gofmt -w internal/agent/*.go
go test -count=1 -timeout 180s ./internal/agent/
go test -race -count=1 -timeout 180s ./internal/agent/ -run 'TestStopStartDoesNotLeasePreviousSession|TestAssignMachineDropsStaleGeneration|TestAssignMachineRacesSessionCallback|TestManualStartSendFailureStaysReserved|TestManagedDispatchFacts|TestStartAck|TestReserveStartLaunch|TestManualStart|TestReportedAck|TestEnsureStart'
go vet ./internal/agent/
go test -count=1 -timeout 120s ./internal/platform/db/ -run 'TestM5UpgradeChangesAreAdditiveAndDocumented|TestM5UnconfirmedDeliveryIntentsSurviveReopen'
```

All of those passed.

Regressions in `launch_session_fence_test.go`:

- Stop then Start does not expose `(L2, old S1)` before the callback. A running ack does not either. The resume pointer remains, and `agent:start` `config.sessionId` still carries it.
- The callback whose `launchId` is L2 makes facts and `CurrentControlIdentity` eligible for the reported session. A callback naming L1 does not.
- Move does not admit the old launch or the old session. The old computer principal’s session and start-ack do not rewrite the binding or the resume pointer. The agent credential is not revoked. A same-machine assign keeps the current generation. A cross-workspace machine and an external runtime are refused. Unbind clears dispatch identity and keeps the resume pointer. After assign, `EnsureStartLaunch` can reserve a new unbound-session launch on the new machine.
- A raw `machine_id` update is not admitted as identity, and the following `AssignMachine` to that machine supersedes the stale launch.
- Twenty racing assign-versus-`agent:session` rounds leave no open launch and no dispatch session on the destination machine.
- A failed manual Start stays `reserved`, returns `daemon_timeout`, preserves resume, and the retry reuses the dispatch id.
