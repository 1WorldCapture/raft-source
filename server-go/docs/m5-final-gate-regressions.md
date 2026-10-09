# M5 final-gate regressions and fixes

Date: 2026-10-09 (America/Los_Angeles). These issues were found while repeatedly running the unchanged full backend gate, after the original 0014/0015 integration. Failed attempts are recorded here rather than counted as passing evidence. No UI tests, original client changes, dependency changes, golden regeneration or existing-instance mutation were involved.

## Startup wake admission before the worker runs

The full ordinary suite exposed `TestDispatcherDuplicateStartOneRecoveryAndScan` with `commits = 6, want 4`. The expected four commits are the held fixture transaction, one expired-lease recovery, and the initial reconcile/finalize scan. Six commits indicate an extra scan.

`Dispatcher.Start` registered the commit listener and returned before the new worker necessarily ran. Wake suppression was enabled only at the beginning of `run`. A commit in that scheduling interval could therefore queue a wake behind the initial full scan, repeating work already covered by startup.

New `start_wake_test.go` regression `TestDispatcherStartSuppressesWakeBeforeWorkerRuns` reproduced the defect before the fix: `Start left 1 redundant wakes queued before startup recovery`. It uses one Go scheduler processor, a held database write fence, and a direct Start/Wake call to exercise the interval before the worker gets CPU time. The processor setting is restored.

The fix enables the existing suppression flag in `Start`, before registering the listener. Worker ownership, cancellation, Start/Close locking and the periodic fallback remain unchanged. No lock is held over recovery or a network operation. The original exact four-commit assertion was not weakened.

Executed after the fix:

```
go test -count=100 -timeout 90s -run '^TestDispatcherStartSuppressesWakeBeforeWorkerRuns$' ./internal/application/agentdelivery/
# PASS, 2.348s

go test -race -count=50 -timeout 120s -run '^TestDispatcherStartSuppressesWakeBeforeWorkerRuns$' ./internal/application/agentdelivery/
# PASS, 24.633s

go test -count=10 -timeout 120s -run '^TestDispatcherDuplicateStartOneRecoveryAndScan$' ./internal/application/agentdelivery/
# PASS, 20.650s

go test -race -count=10 -timeout 120s -run '^TestDispatcherDuplicateStartOneRecoveryAndScan$' ./internal/application/agentdelivery/
# PASS, 26.598s
```

## DM fault-schema replacement and restoration

The full race suite failed `TestStabilizationDMProjectionFailureHTTP` during teardown: restoring the original `user_channel_read_states` table reported an existing table/index name. The test installed and restored a conditional poison view using separate pooled DDL transactions while the assembled app's dispatcher was active.

`stabExecDDL` now installs the rename/view pair and restores the drop/rename pair atomically, each on one write transaction and connection. This removes the externally visible intermediate schema and connection-switching window. It does not change the fault: the malformed JSON is still evaluated only after the new DM and participant facts exist in the request's write transaction. The exact 500, complete rollback, absence of a partial DM and successful later retry assertions remain intact. This is test-fixture synchronization, not a workaround that disables the dispatcher or the projection failure.

```
go test -count=20 -timeout 120s -run '^TestStabilizationDMProjectionFailureHTTP$' ./tests/acceptance/
# PASS, 2.418s

go test -race -count=30 -timeout 180s -run '^TestStabilizationDMProjectionFailureHTTP$' ./tests/acceptance/
# PASS, 42.861s
```

## Existing trigger-based HTTP fixtures versus the live dispatcher

A subsequent full race run failed `TestProfileWriteFailureDoesNotInvalidateTheSession` before exercising its request: raw `CREATE TRIGGER` returned `SQLITE_BUSY`. The whole-app testkit now runs a real delivery pump, so setup writes must obey the same application write fence as production writes.

New test-only `TestEnv.ExecFixture` executes a fixture statement inside `platformdb.WithWriteTx`. The profile fault trigger and account-delete setup use it, as do the existing avatar and onboarding-preference fault triggers with the same pattern. It does not change HTTP execution, response expectations or application error handling; it must not be called inside another write transaction/fence.

```
go test -race -count=20 -timeout 180s -run 'TestProfileWriteFailureDoesNotInvalidateTheSession|TestDeletedAccountStillReturnsAuthoritative401' ./internal/transport/httpapi/
# PASS, 30.612s

go test -race -count=10 -timeout 120s -run 'TestServerAvatarDatabaseFailureIsNotFakeSuccess|TestPatchOnboardingSettingsIsAtomic' ./internal/transport/httpapi/humanapi/
# PASS, 16.389s
```

## Final outcome

After all these fixes, the unmodified full `make check` target passed with exit 0: architecture, formatting, vet, all ordinary tests, all race tests, frozen references/contracts, full M1–M5 HTTP/original-client/upgrade acceptance and release build. The final humanapi race run completed in 149.343s. Build time was `2026-10-09T11:02:08Z`, stage remains `m3`.

Final cross-build, govulncheck, module verification/tidy-diff and diff whitespace checks also passed. Exact scope and remaining product/protocol boundaries are in [M5 backend finalization](m5-backend-closeout.md).
