# M5 cold-start scheduling closeout

Date: 2026-10-09. Scope is the managed-wire pump's launch trigger and unconfirmed-start recovery.

Follow-up: the fixed first-page recovery scan described below had a starvation case when 64 older machines remained reserved after offline/failed sends. The continuation reproduced and fixed it with bounded keyset pagination; see [M5 recovery fairness closeout](m5-recovery-fairness-closeout.md). This document preserves the earlier cold-start implementation evidence, not the final pagination behavior. Final same-tree verification is recorded in [M5 backend finalization](m5-backend-closeout.md).

Owned files: `internal/application/agentdelivery/dispatcher.go`, `internal/application/agentdelivery/cold_start_test.go`, this document. `dispatcher_test.go` was not edited. `internal/agent` and migration 0015 were not edited.

## Observed bug

`Dispatcher.pass` called `PrepareManagedDispatches` and then `ensureStartLaunches`.

`PrepareManagedDispatches` (`delivery/dispatch.go` `markWaitingTx`) moves a reachable managed input with no launch or confirmed session to `waiting_identity` and sets `next_attempt_at = now + WaitingRecheckBackoff` (5s). It does not consume retry budget.

`startLaunchCandidates` (previously `identityWaitCandidates`) only returns rows with `next_attempt_at <= now`. On the pass that classifies the input, the timestamp is already in the future, so the candidate set is empty. On every later pass the row is due again, prepare pushes `next_attempt_at` forward, and the candidate query runs after that write. A managed input with no launch never reaches `EnsureStartLaunch`.

`Service.RecoverPendingStarts` is what `EnsureStartLaunch` and `docs/m5-lifecycle-worker-contract.md` §7.3 name as the resend path for a reserved or dispatched launch (lost queue accept, lost start ack). `OnReady` calls it on reconnect. The dispatcher never did. A machine that stayed connected was not retried.

## What the pump does now

`pass` still reconciles briefings, prepares managed dispatches only when a non-external row is due, sends leased plans through `SendWithAdmission`, and finalizes. Start work is in front of prepare, and both finish before any gateway call:

1. `recoverUnconfirmedStarts` reads machines that have a `reserved` or `dispatched` launch for a non-external agent. A `dispatched` row is included only when `last_dispatch_at` is null or older than `agent.StartResendBackoffMS`. The query is closed, then `Service.RecoverPendingStarts` is called. That method reads, skips or cancels, then `gateway.Send`. This pump does not hold a write transaction or the authority fence across that call, and it does not take `startRecoverMu` across it.
2. `ensureStartLaunches` reads due `pending`, `waiting_machine`, and `waiting_identity` rows for a live, non-stopped, non-external agent with a machine and with no `reserved`/`dispatched`/`acked` launch. It reloads the agent and calls `Service.EnsureStartLaunch`. An `acked` launch with a null `confirmed_session_id` still counts as the current generation.
3. Prepare runs after that. The same pass can both reserve the launch and move the delivery to `waiting_identity` with `next_attempt_at` 5s ahead. The launch row is what blocks the next reservation, not the delivery timestamp.

`EnsureStartLaunch` sends only a `reserved` launch, and only when `gateway.IsOnline`. `RecoverPendingStarts` resends the same `launchId` and `startDispatchId`. Neither path writes `confirmed_session_id` or a wake message.

Spacing: after a recovery call or a successful `EnsureStartLaunch`, the pump records `now + agent.StartResendBackoffMS` for that machine in memory. `RecoverPendingStarts` has no backoff for `reserved` rows, because `last_dispatch_at` is written only after Send is accepted (`RecordStartDispatch`). The in-memory mark is what stops a queue error from being resent on every wake. A process restart has an empty map, so the first scan retries a reserved launch once, then spaces further attempts. Dispatched rows are also skipped inside `RecoverPendingStarts` until `StartResendBackoffMS` has elapsed since `last_dispatch_at`.

One pass calls `RecoverPendingStarts` for at most 16 machines, from a fetch of 64 ordered by the oldest attempt. Start reservation is capped at 16 agents. A pass that reserved or recovered returns to the same scan for the next page. The following pass sees the launch or the spacing mark and stops. Own commits stay under `suppressWake`. An idle database still returns false from `pass`, so reconcile does not wake the pump.

`Start`/`Close` are the completed lifecycle patch: one mutex for setup, duplicate `Start` and `Start` after `Close` are no-ops, `Close` joins after releasing that mutex, startup `RecoverExpiredLeases` stays on the worker. The new spacing mutex is not that mutex.

Stopped, deleted, and reassigned agents are not sent the launch they no longer own. `RecoverPendingStarts` cancels those `reserved`/`dispatched` rows (`binding_lost`) and does not call Send for them. A due input on the agent's current machine can still reserve a new launch there. An external runtime is not selected. An `acked` launch is not in the recovery query.

## Guarantees the tests observed

Real migrated SQLite, real delivery store, real agent service and launch store, bounded fake gateway (`IsOnline`/`Send` only). No UI, model, production process, client, lock, golden, or migration edit.

- A due `pending` managed input on an online bound machine: one pass leaves the delivery `waiting_identity` with `next_attempt_at` in the future, and one `dispatched` launch on that machine. `confirmed_session_id` is null. The start frame is `agent:start` with that launch's ids, no `wakeMessage` / `resumeMessages` / `resumePrompt` / `unreadSummary`, and a null config `sessionId`.
- A `waiting_identity` row that is already due and has no launch (the state the old order left behind after backoff): one pass reserves and dispatches one launch, and does not add a launch for an agent that already has one.
- `scan` once, then five immediate passes with the delivery made due again: one launch id, one `startDispatchId`, one Send.
- `Start`, a wake, `Close`, then another `scan`: one launch and one Send. The gateway stayed online.
- Queue error (`Send` returns, gateway stays online): the launch stays `reserved`, `dispatch_count` 0, one attempt. Five immediate passes do not Send again. After `StartResendBackoffMS` the same launch and dispatch id are sent, the row becomes `dispatched` with `dispatch_count` 1, and the gap is at least 5s. Five more immediate passes do not Send.
- Lost start ack, still online, no reconnect: after another backoff window the same ids are sent again (`dispatch_count` 2). `confirmed_session_id` stays null. The gap from the previous accepted send is at least 5s.
- Stopped agent and external runtime, due input: no launch and no Send.
- Deleted agent with a `reserved` launch: that launch becomes `cancelled`, no Send.
- Agent moved off the launch's machine, old launch `dispatched` and already outside the backoff: that launch becomes `cancelled` and is not sent. The due input reserves a new launch on the current machine only.

## Seam for the launch-session worker (`internal/agent`, migration 0015)

No new agent API is required for this pump. It calls `EnsureStartLaunch`, `RecoverPendingStarts`, and `GetAgent`, and it reads `agent_launches` / `agent_deliveries` / `agents`. It does not write `confirmed_session_id`.

Keep these facts, or this pump will start the wrong generation or never start the new one:

- `ManagedDispatchFactsTx.SessionID` stays that launch's `confirmed_session_id`. `agents.session_id` remains the resume pointer on `agent:start` and is not a delivery credential. This pump will not lease until facts report a session, and it will not copy the resume pointer into the launch.
- Any `reserved`, `dispatched`, or `acked` launch for the agent suppresses `EnsureStartLaunch`, including an `acked` row whose `confirmed_session_id` is null. The predicate does not compare `agent_launches.machine_id` to `agents.machine_id`. A stale **acked** launch on the previous machine still blocks a new reservation. This pump's recovery list is only `reserved` and `dispatched`, which `RecoverPendingStarts` cancels when the agent is stopped, deleted, or no longer on that machine. Production assignment has to supersede the old generation, including `acked`, or a raw `machine_id` update that leaves only an acked row will not be started here.

Not changed in agent, and not required for one process: `RecoverPendingStarts` applies `StartResendBackoffMS` only when `state = dispatched` and `last_dispatch_at` is set. A `reserved` launch (Send failed, or Send was accepted and `RecordStartDispatch` failed) is resent on every call. This pump spaces those calls in memory. A failed-attempt timestamp on the launch row would make the same bound durable across processes. Launch persistence stays in agent, so that write was not added here.

## Tests

From `server-go`:

- `go test -count=1 -timeout 180s -run 'TestHoldAdmission|TestDispatcher|TestColdStart' ./internal/application/agentdelivery/` — pass, 17.932s. About 10.6s of that is two intentional `StartResendBackoffMS` waits in `TestColdStartLostStartRecoversWithoutReconnect`.
- `go test -race -count=1 -timeout 240s -run 'TestHoldAdmission|TestDispatcher|TestColdStart' ./internal/application/agentdelivery/` — pass, 24.525s.
- `go test -count=1 -timeout 180s -run 'TestM5IdleDispatcherDoesNotWakeItselfForever' ./internal/transport/httpapi/humanapi/` — pass, 1.784s.

`TestDispatcherDuplicateStartOneRecoveryAndScan` still sees one startup recovery and one scan cycle (4 commits) on an empty database. The extra start queries do not commit when there is nothing to reserve or retry.

## Left in place

No edit to `dispatcher_test.go`, `internal/agent`, migration 0015, other production files, clients, locks, goldens, UI, running instances, or `var` data. No commit or push.
