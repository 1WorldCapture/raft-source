# M5 startup-recovery fairness closeout

Date: 2026-10-09 (America/Los_Angeles).
Scope: `internal/application/agentdelivery/dispatcher.go` and `cold_start_fairness_test.go`.

## Reproduced defect

The cold-start recovery query returned only the oldest 64 machines. A failed send leaves a launch `reserved` and does not update `last_dispatch_at`. Offline machines likewise retain their ordering keys. Retry spacing was applied after the SQL limit, in memory. Consequently, repeated scans could revisit the same first 64 machines forever, skipping those in their backoff window without ever fetching later machines.

A regression using real migrated SQLite, real Agent/delivery services and a bounded fake machine gateway reproduced the problem before the fix:

```
go test -count=1 -timeout 90s -run '^TestColdStartRecoveryScansBeyondFailedFirstPage$' ./internal/application/agentdelivery/
FAIL: recovery attempted 64/71 machines; a failed first page must not starve the rest
```

The fixture reserves 71 launches while offline, then exposes an online gateway whose sends fail. All launch creation timestamps are equal to exercise the machine-ID tie-breaker rather than relying on wall-clock timing. No original client, UI, model, existing instance or user data is involved in this regression.

## Fix

Recovery keeps a keyset cursor over `(oldest_attempt, machine_id)`. Each query still fetches at most 64 machines and each recovery pass still calls the Agent service at most 16 times. The cursor advances for examined machines, including those still cooling down; it never advances over an unexamined machine when the call budget is exhausted. A full examined page schedules another pass even when it performed no sends.

The cursor resets after the sweep reaches the end. The next wake or periodic scan therefore revisits newly due rows and rows inserted before the previous cursor. Finishing a sweep also removes expired in-memory spacing entries, including those for machines that have since disappeared from the pending-launch set.

The cursor and spacing map share the existing short mutex. No database operation, Agent service call or machine send runs while it is held. The change does not add a migration, alter launch identity, change retry timing, or hold a database transaction across network I/O. The existing same-launch/startDispatch replay and waiting-for-confirmed-session rules remain intact.

## Regression coverage and executed results

The final regression verifies:

- One recovery pass attempts exactly the configured 16-machine maximum.
- A complete scan reaches all 71 machines, beyond the original 64-machine limit.
- Each attempted start uses the original reserved launch and contains no business wake payload.
- An immediate full rescan does not retry any machine inside the backoff window.
- A completed sweep resets its cursor and removes an expired spacing entry for an absent machine.
- Every failed launch remains `reserved`, with `dispatch_count = 0` and no fabricated confirmed session.

Executed after the pagination fix:

```
go test -count=1 -timeout 120s -run 'TestColdStart|TestDispatcher|TestHoldAdmission' ./internal/application/agentdelivery/
# PASS, 18.075s

go test -race -count=1 -timeout 180s -run 'TestColdStart|TestDispatcher|TestHoldAdmission' ./internal/application/agentdelivery/
# PASS, 26.121s
```

After adding the explicit per-pass bound and expired-spacing assertions:

```
go test -count=20 -timeout 120s -run '^TestColdStartRecoveryScansBeyondFailedFirstPage$' ./internal/application/agentdelivery/
# PASS, 1.888s

go test -race -count=10 -timeout 180s -run '^TestColdStartRecoveryScansBeyondFailedFirstPage$' ./internal/application/agentdelivery/
# PASS, 14.159s
```

The full final-tree backend gate is recorded separately in [M5 backend finalization](m5-backend-closeout.md). Passing this bounded fake-gateway regression is not original-Daemon, live-model, browser or load-test evidence.
