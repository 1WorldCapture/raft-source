# M5 backend continuation and closeout

Date: 2026-10-09 (America/Los_Angeles)
Status: **integration in progress — not a completed milestone claim**

## Scope and preservation

Continue the existing dirty `feat/go-server` checkout from `336b5c8` under `m5-execution-lock.md`. The Web UI is assigned independently. No commit/push, production instance restart, original client source/lock edits, frozen migration 0001–0013 edits, golden regeneration, `var*/` changes, or screenshot changes are part of this work. Executable acceptance uses owned temporary data and dynamic loopback ports.

## Parent changes

- Added authenticated HEAD rejection for the state-changing Agent inbox drain/claim routes. Go GET patterns otherwise also invoke these handlers for HEAD; a response-less probe must not acknowledge a delivery or reserve an unseen claim. Authentication/capability checks still precede 405.
- Bounded events/history numeric query limits before float-to-integer conversion and rejected overflowing/NaN/infinite `since` cursors. Added `events_safety_test.go`.
- Added real humanapi composition/security tests for authenticated claim/ACK, revoked credentials, separately scoped Agent DMs with the same human peer, DM thread authority and private inbox visibility. Tests use the original Agent target DSL (`dm:@peer` / thread suffix), not invented raw-ID targets.
- Updated legacy M4 negative tests only where the implemented M5 capability supersedes an artificial 501. Unknown Agent identities still fail atomically; new assertions verify no durable recipient on rejection and no Agent UUID in the human-only DM pair table.
- Added a process-composition regression for the empty dispatcher self-wake loop. One empty commit must not produce an unbounded cycle of reconcile/prepare/finalize commits.
- Migration inventory now follows the actual `migrations/*.sql` embed boundary for nonmatching real tooling directories while continuing to reject every unknown top-level file, symlink, and `.sql` directory. The existing `.claude` metadata directory is untouched. Added negative selftests for unindexed files, same-byte symlink replacement and `.sql` directories; frozen/addition hash checks remain exact.
- Strengthened M4→M5 upgrade acceptance: implemented Agent routes are asserted, not merely printed; migrated Agent credentials must complete a persisted input/claim/reclaim/duplicate-ACK/reply loop across process restarts, with idempotent visible replies and private readstate.
- Registered `test-m5-original-clients` in the Makefile and default `RAFT_GO_TEST_SUITE=all` process gate. No conditional green skip for missing original clients or unwired services.

## Observed verification, not final same-tree signoff

Executed successfully during continuation:

- `go test -count=1 ./internal/transport/httpapi/agentapi`
- `go test -count=1 ./internal/platform/db`
- `go test -count=1 ./internal/channel ./internal/message ./internal/application/messaging`
- `go test -count=1 ./internal/application/onboarding ./internal/workspace ./internal/readstate`
- `go test -count=1 ./tests/architecture` after production wiring/dependency direction fixes
- `node tests/acceptance/client-contracts.mjs`: 36 executable selftests; 12 frozen fixtures, 13 frozen migrations, 1 hash-pinned addition
- `make test-reference test-m4-reference`: 1,216 M2 reference comparisons; 7 M4 suites, 173 assertions; old frozen contracts unchanged
- Original scaffold `make test-m5-upgrade` passed migration/restart/cold-backup checks, but only logged unwired M5 HTTP routes. That scaffold pass **does not count** for the strengthened final upgrade gate.

An intermediate full `go test -count=1 -timeout 90s ./...` passed the domain modules, app tests and architecture, but failed real humanapi composition on delayed external claims and dispatcher self-wake, plus old stage assertions and direct test fault-injection writes competing with the new pump. Those are integration findings to resolve, not accepted failures.

## Active integration findings / required final closure

1. Managed scanner must never delay or starve external claim delivery, including mixed managed/external backlogs. A preliminary “scan only when any managed work exists” precheck is not sufficient by itself for mixed backlogs.
2. Dispatcher own write commits must not indefinitely self-wake. Cancellation and shutdown must join the worker before DB close.
3. Use the real control constructor and current-identity ACK adapter; no nil placeholder for the briefing control receipt in production.
4. Wire the delivery-domain query/partial-ACK/notice receipt fixes when the claim worker lands. No unsupported `since` fallback or invisible/unacknowledgeable briefing receipt.
5. Original runtime acceptance must distinguish (a) content-free wake and reported ACK, (b) original CLI read/check/claim/ACK/send compatibility, and (c) a scripted local provider tool-call chain through the unmodified builtin runtime that actually reads the marker and writes a persisted Agent reply. A manually driven CLI reply or fixed assistant text alone is not evidence of (c).
6. Run final same-tree `make check`, cross-build, diff/format checks and independent safety review; record exact outcomes and genuine remaining client/runtime boundaries.

## Guarantee boundary

The original Daemon can report ACK for startup buffering/content-free inbox notification. Reported receipt is not model consumption and does not imply exactly-once execution. Original CLI claim ACK carries only three ID arrays; a delayed same-Agent/same-message ACK cannot identify a particular lease generation. The local deterministic provider is not a live external LLM and backend/CLI wire acceptance is not browser UI signoff.
