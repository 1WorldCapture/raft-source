# M3 integration notes — historical checks and final wiring

2026-10-08: M3 backend assembly and full `make check` are complete. Current scope,
executed results and UI handoff are in `phase-3-backend-handoff.md`. The questions
and worker ownership below record the implementation sequence, not active tasks.

Read together with m3-implementation-coordination.md and each worker's own contract. Parent integration changes:

- Reserved /api/servers/unread-summary and join-community are independently rejected as unsupported 404 behind human auth, never interpreted as workspace ids. order keeps GET/PATCH and 405. No new slug prohibition.
- statusRecorder now exposes Unwrap() for coder/websocket (verified using a real upgrade through RequestID+SecurityHeaders, including no raw query key in logs).
- workspace.Options now has MachineStatusProbe func(context.Context,string)(bool,error), stored per instance; no mutable global test/runtime seam. Parent wires Hub.IsOnline and ctx check. M2 nil-provider default remains for domain tests. Machine directory status reads the same provider; GET never manufactures status timestamps.
- /version + CLI version + response build headers expose embedded process identity (not git state read at request time); parent owns main/health/Makefile. Does not restart user processes.
- Source verification: original deviceAuthService.isDeviceAuthSurfaceEnabled defaults TRUE, separate from DB feature flag missing=false policy. Parent config must reflect this difference. Verification URI uses cfg.WebOrigin; do not trust inbound Host for credential-bearing links.
- Original Web vite.config.ts already proxies /api and /internal with changeOrigin+xfwd and /daemon with ws:true (lines ~209-212). We should test Computer HTTP+WS through an isolated proxy before calling the 5175 origin an actual code bug. Direct Go address remains valid configured alternative.

## Cross-worker integration requirements (implemented and verified)

1. MACHINEWS ReasonError requires Reason() string, while COMPUTER early doc has AuthError.Reason field. A Go type cannot have field+method same name. Parent will bridge with an error wrapper if workers do not converge; invalid credentials MUST yield 401, not an accidental 500.
2. Required original Computer runner mint/revoke/list/stop endpoints in internalComputer.ts must be owned by AGENT worker (credentials tied to actual computer/machine/agent, not user JWT); preflight registry must truthfully include registered endpoints. They are part of launch/identity M3, not the M5 message delivery queue.
3. Revoke/reset/rotate/delete of machine credentials must stop authorization on ESTABLISHED connections. Hub expensive Argon2 rechecks at 30-second spacing are not sufficient authorization for each subsequent agent mutation. Use cheap principal/binding/revocation checks or synchronously wire immediate disconnect for all writers plus transaction-level binding checks in Agent callbacks. Do not allow queued old-generation messages to mutate after reset/rotation/reassignment. Test it.
4. Bound API key hashing concurrency and reject pathological encoded-hash parameters before allocation, reusing auth hash limits when possible. No Argon/network waiting inside write transactions. Public device authorize/token must be throttled; callback/liveness events must not make thousands of Argon calls per second.
5. Parent will wire real Hub shutdown BEFORE SQLite closes and preserve HTTP hijack lifecycle. No goroutines using closed DB, no stale disconnect overwriting replacement state.
6. Default full ready frame 100MiB TS ws budget is unnecessary for M3 metadata. Parent may choose a documented tighter M3 ingress cap, with errors/tests, rather than allocate 100MiB for arbitrary credentials holders. Outbound queues, ready retries, duplicate connections and clock/timers all need bounded behavior.
7. M2 default machine metadata runtimeVersions/computerVersion is deliberately unknown. Hub should expose an immutable live snapshot accessor for directory enrichment; present only reported metadata for the current live generation. Do not infer current versions from pre-restart DB rows alone. Source-present but local cloud upgrade authority absent maps to TS no_broadcast/hands_unavailable (not false source_missing), with desktop app-managed/version/platform guard branches retained as appropriate. No automatic upgrades/cloud calls required.
8. Current M2 /machines method fallback advertises only GET. Parent updates Allow when the POST register route is wired, without introducing conflicting ServeMux patterns.

## Parent seams now implemented (use these in integration)

- `computer.Principal.CredentialRevision string` (json:-) is the SHA256 digest of the stored verifier proved by Authenticate, not the presented key. Both Computer and legacy machine Authenticate return it.
- `computer.Store.ValidatePrincipal(ctx,p) error` cheap revalidation checks current stored verifier revision, revoke/migration, workspace and current machine binding. It requires a nonempty verified revision. Parent injects it into Hub; no Argon for every frame.
- `computer.ValidatePrincipalTx(ctx,tx,p) error` is the SAME check on a domain write transaction. Agent callbacks / runner mint writers must call it so late old-key frames cannot commit after rotation. RunnerBinding must carry the original proven Principal (including revision/UserID), not reduce it to only machine IDs before the write guard.
- Parent fixed `computer/keys.go` malformed PHC parser and shared derivation budget; all computer tests + new negative-verifier and principal-state race tests pass. Do not restore the old parser.
- Runner name limits from TS use UTF-16 string.length, not Go rune count; test emoji boundaries when editing `ValidateRunnerName`.
- Parent owns Computer base store/model/keys/principal_state now; `agt_17165935` owns machine.go/management-only methods and computer_machines.go/computer_handlers.go with callbacks. Other workers must not edit those files.

## Final assembly

`app/m3.go` registers Channel, Computer, Agent, Runner and RuntimeCatalog with the real machine hub; Agent handlers have RuntimeCatalog and AvatarDir, and preflight includes `IdentityInternalRoutes`. The hub receives the cheap `ValidatePrincipal` hook. Rotate/delete and committed setup reset retire affected sockets. Agent and Runner writes preserve the real principal through their commit guard. `execution.Close` runs before the database is closed.

The acceptance runner now includes original clients in direct/proxy modes and the nine creation-read-model groups. Full ordinary/race tests, HTTP/WS, M1/M2 preservation and real M2-to-M3 upgrade pass. Failed reconnect recovery also passes repeated race regressions. Callbacks must preserve their generation context, stored `last_status` is not an online authority, and M3 send admission is not M5 durable delivery; see `m3-machinews-closeout.md`.

No worker remains active for this delivery. UI/browser E2E is not executed and remains assigned to testers.
