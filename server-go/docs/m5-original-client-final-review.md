# M5 final original-client acceptance review

Date: 2026-10-09 (America/Los_Angeles).
Scope: `tests/acceptance/m5-original-clients/index.mjs`, `fixtures/daemon-core-drive.mjs`, and `fixtures/cli-drive.mjs`. Original Web, CLI, Daemon, shared sources, dependencies and frozen fixtures are unchanged. No browser/UI or paid model was used.

## Review findings closed

### Automatic startup recovery, not a manual Start shortcut

The earlier driver posted a mention and then called the human `POST /api/agents/:id/start` route. Its receipt/tool-loop results were useful, but did not prove automatic recovery without that extra action. It also inferred absence of a business wake from model requests instead of checking the actual start frame.

The first stricter test rejected a start observed before its mention. Inspection of `humanapi/agent_handlers.go` confirmed that the real create route intentionally auto-starts a bound managed Agent. That was a false assumption in the proposed test, not a production defect. A fresh Agent created through this route cannot honestly be described as having no prior start attempt.

The final scenario therefore injects a precisely labelled network loss:

1. Start the original DaemonCore against the real disposable Go server and wait for its real `ready`.
2. Temporarily discard incoming `agent:start` frames at the harness's WebSocket observation boundary. Create the builtin Agent through the real API; record the discarded auto-start without delivering it to DaemonCore. Do not synthesize an ACK or session.
3. Commit a real human structured mention while the daemon is still unstarted, then stop discarding starts. Do not call the human Start route and do not replay the captured frame.
4. Observe a new start sent by the server's periodic recovery. Require the same persisted `launchId` and `startDispatchId` as the discarded initial frame.
5. Check both initial and recovered start frames for absence of `wakeMessage`, `resumeMessages`, `resumePrompt` and `unreadSummary`. Require a real original-daemon session on that launch and no tracked delivery before that session report.
6. Complete the original reported receipt followed by the separate builtin bash/original CLI check/read/send tool loop. Human content must occur in the check/read tool results, not the content-free receipt wake. Public HTTP history contains exactly one Agent reply.

This proves real-client recovery of a lost start frame without manual Start or reconnect. The no-existing-launch reservation path remains covered by the real-store/fake-gateway cold-start tests; it is not falsely attributed to this public-create scenario.

### Reconnect claims match actual observations

The socket-drop leg posts a **new message**, waits for the same DaemonCore process to reconnect, and now requires an actual incoming delivery and outgoing ACK with the new message seq, Agent/machine identity and unchanged launch/session. Its occurrence must differ from the first message's occurrence.

The result label is now `R-reconnect-delivery`, with explicit `lost-ack-retry=not-tested` and `daemon-crash=not-tested`. An empty replay list is no longer presented as proof of same-occurrence retransmission. Store-level identity-drift and uncertain-delivery tests remain separate evidence.

### Unsupported CLI surfaces fail closed

Only two specifically known deferred surfaces may produce `API-BLOCKER`:

- `GET /internal/agent-api/messages/{id}/resolve` (the broader messages family).
- `GET /internal/agent-api/attachment-upload-capabilities` (the prerequisite hit by the original attachment command before channel resolution).

The CLI must actually render a not-implemented failure, and an authenticated direct probe of the exact route must independently return HTTP 501 with code `not_implemented` and the expected error text. Other failures, including generic capability errors, unexpected upload exits, authorization failures and resolution errors, fail the driver. The parent harness has an exact two-line allowlist; a passing tracked ACK no longer suppresses arbitrary blockers.

This does not claim full attachment support or full CLI command-family compatibility. M5's send/read/claim/ACK legs still must all pass independently.

## Executed verification

`make test-m5-original-clients` passed with exit 0 after these changes, on the tree with both registered M5 migrations and the recovery-pagination fix. Selected exact output:

```
PASS m5-daemon-core R-cold-start-session runtime=builtin provider=deterministic-local initial-start-loss=true recovery=same-launch-and-dispatch manual-start=false start-wire-observed=true wakeMessage=absent launch-matches-session=true deliver-before-session=false bodyInModelTurns=false
PASS m5-daemon-core R-builtin-tool-consumption runtime=builtin tool=bash cli=packages/cli/src/index.ts proxy=daemon-local check-section-has-human-marker=true read-section-has-human-marker=true send-tool=raft-message-send web-count=1 semantics=model-tool-consumption live-llm=false receipt-phase=separate
PASS m5-daemon-core R-reconnect-delivery same-process-reconnect=true new-message-deliver-and-ack=true identity=unchanged lost-ack-retry=not-tested daemon-crash=not-tested exactly-once=not-claimed
SUMMARY m5-original-clients complete
PASS graceful shutdown and credential-safe process output
```

Self-hosted original CLI claim/reclaim/ACK/duplicate ACK, legacy check, send/idempotent send and read also passed; managed-proxy send/idempotent send passed. Each of the three tested Agent reply markers appeared exactly once in public HTTP history. Both driver temporary directories were removed.

The source pin remained HEAD `336b5c81b8d67c1c5d3cec2ef7e6fcb0bd2fed1c`, CLI tree `6a21bafbabbcec72f6373d5262895daa1ac49c01`, Daemon tree `722599605c716b1daf7e815de630f5b339a7113d`, with the original client worktrees clean.

The first stricter-test failure described above is retained as a failed experiment, not counted as green evidence. Final whole-tree gate results are recorded in [M5 backend finalization](m5-backend-closeout.md).

## Boundaries

The original builtin runtime and original CLI are real processes. The model/provider is the labelled deterministic loopback fixture, not a live commercial LLM. A Daemon ACK is not model consumption or exactly-once execution. Socket reconnect is not daemon-process crash recovery. HTTP history and original client protocol checks are not browser UI acceptance; UI remains owned separately.
