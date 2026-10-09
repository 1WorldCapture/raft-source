# M5 backend finalization

Date: 2026-10-09 (America/Los_Angeles).
Status: **BACKEND COMPLETE — the final unchanged full `make check` passed after all production fixes and acceptance strengthening. UI and existing-instance deployment remain assigned separately.**

## Scope and preservation

Continuation of the existing dirty `feat/go-server` checkout at `336b5c81b8d67c1c5d3cec2ef7e6fcb0bd2fed1c`. Existing work is preserved. No original Web/CLI/Daemon source or lockfile edits, frozen migrations 0001–0013 changes, golden regeneration, UI/browser testing, existing instance restart, `var*/` mutation, commit or push is part of this continuation. Acceptance uses disposable data and dynamic loopback ports. The release build is `bin/raft-server`; build stage remains `m3`, not a claim of UI or deployment signoff.

This is the authoritative integration status. Worker reports describe their own earlier snapshots. In particular, earlier statements that migration 0015 was unregistered, the builtin loop had timed out, or the full race run was still missing are historical, not the state verified by the first full gate below.

## Integrated M5 work verified in the checkout

### Original message envelope and reply authority

`internal/protocol/client/agent_messages.go` omits absent `parent_channel_name` and `parent_channel_type`, matching the original optional-string schema. Root channel/DM rows no longer expose incompatible nulls; thread parent fields remain present. Agent wire and browser actor projections remain distinct.

`agentconversation.Service.AuthorizeDeliveryTx` uses channel-owned read-and-post authorization for preparation, claim/drain/ACK and final managed enqueue admission. Archive/remove-Agent regressions cover all three HTTP receipt paths without conflating readable public history with permission to receive and reply. Cancellation does not fabricate acknowledgement.

### Launch, terminal state and lifecycle closure

The integrated launch fix separates the saved resume pointer from a session genuinely reported for the current launch. Additive migration `0015_launch_session.sql` is registered by exact hash/size alongside `0014_delivery.sql`. Machine reassignment supersedes old open launch generations, including acked launches; delayed recovery cannot cancel a newly reserved generation on the new machine.

Cancelled or blocked attempts no longer retain an Agent's single in-flight slot. Explicit requeue creates a new occurrence instead of immediately reblocking on stale receipt evidence. The dispatcher has idempotent/concurrent Start/Close handling, cancellation and worker join before DB close, periodic recovery and suppression of its own commit wakes. Startup recovery runs before preparation moves a due input into identity backoff.

Detailed earlier evidence: [managed terminal state](m5-managed-terminal-closeout.md), [launch/session fencing](m5-launch-session-closeout.md), [dispatcher lifecycle](m5-dispatcher-lifecycle-closeout.md), [cold-start scheduling](m5-cold-start-closeout.md), and [inbox projection atomicity](m5-inbox-projection-closeout.md).

## New defect reproduced and fixed in this continuation

### Recovery starvation beyond 64 machines

The cold-start recovery query always returned the first 64 machines. Failed or offline reserved launches do not update their ordering timestamps, so in-memory backoff could keep skipping that same page while later machines were never visited.

`TestColdStartRecoveryScansBeyondFailedFirstPage` reproduced **64/71 machines attempted** before the fix. Recovery now advances a bounded keyset cursor, preserves the 64-row fetch and 16-machine call limits, continues past cooling-down pages, resets at the end of a sweep, and removes expired spacing entries. No migration, client protocol, business wake payload or lock-order change was needed.

The regression verifies all 71 original launch identities, per-pass bounds, no immediate duplicate retry, unchanged reserved/dispatch/session facts after failed sends, cursor reset and expired-entry cleanup. It passed 20 ordinary repetitions and 10 race repetitions. Full commands and evidence are in [recovery fairness closeout](m5-recovery-fairness-closeout.md).

## Independent review and original-client acceptance

The acceptance review confirmed the original client source pins, immutable fixture/migration set, exact registration of both additions, and inclusion of M5 original clients plus upgrade in the unweakened `make check` target. The independent production-code review found no P0/P1 blocker in the reviewed identity, receipt, terminal-slot and lifecycle paths. It also identified the first-64-machine starvation, which was reproduced and fixed; a separate narrow review of the final pagination change found no blocker.

The acceptance review found a manual Start shortcut in the previous original-Daemon harness and overbroad reconnect/unsupported-route claims. These are now closed. Because the actual public create route auto-starts an Agent, the final harness deliberately loses the initial start frame, commits a human mention before any session exists, and requires the real dispatcher to resend the same launch/dispatch without manual Start or reconnect. It checks the actual incoming start frames, then completes the original builtin/CLI check/read/send loop. The no-existing-launch reservation case remains separately covered by the cold-start store/gateway tests; it is not mislabeled as what the public-create scenario proved.

The same-process reconnect test now requires matching incoming delivery and outgoing ACK for a new message, with unchanged machine/launch/session and the correct message sequence. It explicitly does not claim lost-ACK retransmission or daemon-process crash coverage. The two deferred CLI routes must independently return exact authenticated 501 responses; arbitrary capability/upload failures now fail acceptance. The strengthened suite passed both standalone and in the final full gate. See [final original-client review](m5-original-client-final-review.md).

A nonblocking review observation remains: an in-flight slot with an incomplete/dead identity can wait until its existing lease expires before reclassification. The current bound is the lease TTL (5 seconds, doubling up to 5 minutes) plus the 5-second recheck. This is not permanent starvation and is not presented as immediate failover.

## Additional final-gate fixes

Full-suite repetition exposed two more classes of failure rather than merely reconfirming the first green run. `Dispatcher.Start` now enables wake suppression before registering its commit listener, closing the pre-worker interval that could schedule a redundant startup scan. A new regression reproduced one queued wake before the fix; it passed 100 ordinary and 50 race repetitions afterward, and the original exact four-commit lifecycle assertion remained unchanged and passed 10 ordinary plus 10 race repetitions.

The whole-app DM fault test now installs/restores its temporary poison view atomically on one connection, instead of exposing a split-DDL schema window. Existing profile/avatar/preference trigger fixtures use a shared test-only write-fence helper to avoid raw DDL racing the live pump. No failure assertions were removed and no dispatcher was disabled. The DM test passed 20 ordinary and 30 race repetitions; profile/account and avatar/preferences passed 20 and 10 race repetitions respectively. Exact failed runs, fixes and commands are in [final-gate regressions](m5-final-gate-regressions.md).

## Executed verification

### Final same-tree gate: PASS

After **all** pagination, startup-wake, harness and fixture changes, `make check` completed with exit 0 using the unchanged Makefile and full `SUITE=all`. All ordinary Go tests and the complete race suite passed (humanapi race: 149.343s). Frozen contracts/references, real Go wire, full M1–M5 HTTP acceptance, the strengthened original builtin/CLI automatic recovery/tool loop, both M5 migration upgrade/rollback matrices, and the release build all passed in this single run.

The resulting executable reports revision `336b5c81b8d67c1c5d3cec2ef7e6fcb0bd2fed1c`, `modified: true`, Go `go1.27.2`, build time `2026-10-09T11:02:08Z` (04:02:08 America/Los_Angeles), and stage `m3`. The dirty flag is expected: work is intentionally left uncommitted.

Following that run, `make cross-build vuln`, `go mod verify`, `go mod tidy -diff`, and `git diff --check` all passed. Original `packages/` and `apps/`, client lockfiles, `go.mod`/`go.sum`, tracked frozen migrations and contracts had no diff. The two additions remained verified by the strict hash/inventory gate. Existing data directories were not opened or migrated by these disposable tests.

### First full integration gate: PASS (historical checkpoint)

`make check` completed with exit 0 on the integrated 0014+0015 tree, before the new fairness regression/fix and the final original-client harness strengthening. It ran the unchanged full target, not a reduced SUITE:

- Architecture AST/import/SQL contracts, formatting, vet, all ordinary Go tests and the full `go test -race -count=1 ./...` suite passed. The humanapi race package completed in 150.893s; it was not cut off at the earlier external 150-second limit.
- Frozen contracts: 36/36 malformed-manifest selftests; 12 frozen fixtures, 13 frozen migrations and 2 hash-pinned additive migrations verified without regeneration.
- M2 reference: 1,216 executed original TS/Go projector comparisons passed. M4 reference: 7 suites, 173 assertions and 7 pinned contract fixtures; fresh Go wire passed original reducers/schema without rewriting evidence.
- Full HTTP acceptance passed: M1–M4 regression, persistence/restart, real Socket.IO client recovery, original client direct/proxy legs, builtin Daemon plus original CLI check/read/send tool loop, self-hosted claim/reclaim/ACK/idempotent ACK, and managed-proxy send.
- The real M4→M5 process upgrade explicitly tested both `0014_delivery.sql` and `0015_launch_session.sql`. Original credentials and pending input/open claims survived restart, ACK and Agent reply were idempotent, DM history/unread stayed participant-scoped, the old binary refused the new schema, and the matching cold backup restored a writable old instance.
- Release build passed with `CGO_ENABLED=0`; the harness reported graceful shutdown and credential-safe output. No browser was launched.

### Additional executed checks

- `make architecture-check fmt-check vet test-client-contracts`: passed before the first full gate.
- `make cross-build vuln`: passed after the first gate. Linux/amd64 and Windows/amd64 are compilation evidence only. Govulncheck found **0 affected call paths and 0 imported-package vulnerabilities**, plus **6 module-level advisories on paths not called by this code** (five x/net HTTP/2 advisories and the unused x/crypto/openpgp advisory). This is not a claim that dependencies are advisory-free; dependencies were not upgraded.
- `git diff --check`: passed at that checkpoint.
- Fairness fix: cold-start/dispatcher/admission ordinary and race groups passed; the strengthened fairness regression then passed 20 ordinary runs and 10 race runs.
- `go mod verify`: all modules verified. `go mod tidy -diff`: exit 0 with no diff; no dependency file changes.

The final gate above supersedes these intermediate checkpoints. Earlier interrupted runs and the three full-suite failures that led to the final-gate fixes remain recorded as failed/interrupted attempts; none is counted as passing evidence.

## Guarantee and delivery boundaries

A Daemon receipt, including startup buffering, is a reported receipt, not model consumption or exactly-once execution. Original CLI claim ACK is three ID arrays and cannot bind an ACK to a particular lease generation. Legacy `GET /events` can lose its HTTP response after its acknowledgement transaction commits. A scripted deterministic local provider is a protocol/tool-loop fixture, not a live external LLM.

The supported original runtime evidence is builtin. Other runtimes, actual commercial LLM providers, daemon-process crash with arbitrary tool side effects, public TLS/proxy deployment, SMTP providers, production load and Linux/Windows runtime execution are not implied by the backend gate.

Original CLI `message resolve` and the attachment-capability prerequisite for `resolve-channel` retain known unsupported surfaces; attachment transfer and the broader messages family are not silently implemented or treated as universal success. The direct Agent API resolve path used by M5 is a separate supported contract.

UI remains owned by the independent UI collaborator. Backend/browser-wire acceptance is not browser UI signoff. Existing instance deployment and stage promotion remain separate; no existing data directory was migrated by this continuation.
