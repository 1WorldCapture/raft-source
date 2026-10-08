# M3 parent security review — implementation findings and closeout

2026-10-08 closeout: the findings below are retained as implementation history.
Current execution evidence and operational boundaries are in `phase-3-backend-handoff.md`.
UI E2E remains unexecuted.

## COMPUTER / keys.go: malformed verifier and unbounded derivation

Parent added `internal/computer/security_closeout_test.go` and ran `go test ./internal/computer -run TestCloseoutEmptyArgonDigestNeverVerifies -count=1`.

Observed actual failure: the stored PHC string `$argon2id$v=19$m=16,t=1,p=1$MTIzNDU2Nzg5MDEyMzQ1Ng$` (empty digest) reaches `argon2.IDKey(...,keyLen=0)` and PANICS in blake2b. This is corrupt-data handling, not a claim that remote callers can modify database verifier values. Must reject before derivation.

Other source findings in this helper: uint32 manual parser silently overflows; uint8 casts wrap; duplicate/omitted parameter names are not canonically rejected; stored hash controls unbounded memory/iterations/output lengths; public device/attach/WS verification has no process-wide hash semaphore. Do not run malicious huge-allocation test inputs against the unfixed code.

Suggested fix: reuse the M1 auth.PasswordHasher strict `Verify(raw,encoded)` (it already validates canonical PHC, 8..262144 KiB, iterations1..10, parallelism1..8, salt8..64/digest16..64 and bounded concurrency). Hashes for newly created machine/device keys may use the configured params under a SHARED process-wide derivation semaphore (a new hasher per call with its own semaphore is NOT a bound). Validate configured writer parameters before derivation, retain cheap test params16KiB where explicitly injected. Raw key format and database schema do not change. Add negative canonical/overflow/empty salt/digest/max parameter tests only after rejection is in place. Fix and rerun the regression, not a recover() that conceals invalid verifier handling.

## Original shared concerns (closeout below)

Read docs/m3-integration-notes.md: immediate established-connection revocation, generation fences, callbacks not under a lock that Send reacquires, actual runner mint/revoke endpoints required by original Daemon, request middleware upgrade support, origin/proxy proof and truthful runtime/version projections.

RunnerAccess extension worker now owns only `internal/agent/runner_access.go`, `runner_access_test.go`, `legacyweb/runner_*.go`, docs/m3-runner-contract.md. Main AGENT worker must not duplicate those files; parent will wire shared credentials and lifecycle services once both slices land. This dependency is M3 launch identity, not M5 message delivery.

## Closeout resolution

- Computer verification rejects empty/oversized/noncanonical PHC fields, overflow and invalid parameters before allocation. Key derivation uses the bounded shared hashing budget, not a fresh semaphore for each request. The previously failing empty-digest regression and the complete Computer package pass.
- Agent callbacks and Runner authorize/mint/revoke/read paths carry the original authenticated principal, including verifier revision. `computer.ValidatePrincipalTx` runs on the actual transaction; rotation or revocation between HTTP authentication, hashing and commit cannot mint a new Agent key. Legacy Computer aliases exist only at the DTO boundary.
- Machine ready, heartbeat and status writes validate inside their transaction. Per-machine serialization and generation-bound callback contexts prevent a delayed callback from writing over, or sending to, a replacement. Ready/offline retry and joined shutdown are covered with real SQLite and WebSocket tests. A failed reconnect restores, rather than loses, the previously suspended offline projection.
- Rotate/delete callbacks and workspace setup reset after-commit callbacks actively retire affected connections. A rollback does not disconnect a still-authorized Computer. Immediate revocation is also enforced on later frames/outbound writes; it does not depend solely on a long Argon refresh interval.
- Channel mutations re-read current workspace eligibility, role, capability and channel/member binding within the committing transaction. Demotion, membership deletion, workspace movement, private membership and DM participant regressions pass under race detection.
- Request middleware supports real WebSocket upgrades and avoids logging key-bearing raw paths. Preflight lists actual Runner and Agent CLI routes. Direct and same-origin-proxy tests use the unmodified Computer/Daemon clients.
- Live online status comes from the connection map. Stored `last_status` is only the last authorized persisted observation: revoked credentials cannot make additional writes, and shutdown does not flush an offline event for every machine. M3 queue admission is not a durable delivery acknowledgment; that belongs to M5.

Full `make check`, dependency verification, 1,216 TS projector cases and cross-compilation results are recorded in the handoff. These checks do not certify browser behavior, real providers or production load. The module-level govulncheck note is retained there instead of claiming every dependency has no advisory.
