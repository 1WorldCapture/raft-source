# M5 dispatcher lifecycle closeout

Date: 2026-10-09. Scope is the managed-wire pump lifecycle only.

## What changed

`agentdelivery.Dispatcher` Start/Close setup is now one mutex. `cancel`, `stopListen`, `started`, and `closed` are read and written only under that mutex. `Wake` does not take it.

`Start` returns immediately when the pump is already started or already closed. A second `Start` does not register another commit listener and does not launch another goroutine, so `done` is closed once. `Start` after `Close` does not launch a worker.

`Close` still returns immediately when the pump never started, and a second `Close` still waits on the same `done` channel. The join happens after the mutex is released. `Close` can therefore cancel a worker that is blocked in startup lease recovery; it does not wait for a lifecycle lock held across the database fence.

Startup `RecoverExpiredLeases` moved onto the worker, on the cancellable child of the `Start` parent. The worker then runs one scan cycle before the ticker is created. Both the recovery transaction and that scan cycle set `suppressWake`, so their commits are not queued as another cycle. After suppression drops, the ticker period is still `delivery.WaitingRecheckBackoff`, and the first tick is one period later. A wake that arrives after suppression drops is an external edge. A wake dropped while suppression is on is still covered by the durable rows and that ticker.

The lifecycle mutex is not held while acquiring a write transaction or the authority fence. Commit listeners still run only after the fence is released. The send path is unchanged: machine slot, then authority fence, then enqueue.

`PrepareManagedDispatches` no longer defers external claim rows by rewriting `next_attempt_at`. It skips non-managed agents and keeps a separate keyset cursor (`delivery/dispatch.go`, `delivery/store.go`). The old comments in `pass` and `managedWireDue` that said a managed scan hides pull-path mail, and that a mixed sweep still defers claim rows, were stale and are corrected. The precheck that skips `PrepareManagedDispatches` when no non-external row is due remains: it avoids a write transaction on an idle or claim-only database. It is not the mechanism that keeps external pull eligibility stable.

When a non-external row is due, that scan's `PrepareManagedDispatches` still normalizes expired leases inside the store transaction. That is the existing scan, not a second `Start`. The dispatcher calls `RecoverExpiredLeases` once per successful `Start`, including when the precheck skips the managed write, so expired claim leases are still recovered.

## Tests

From `server-go`:

- `go test -count=1 -timeout 120s -run 'TestHoldAdmission|TestDispatcher' ./internal/application/agentdelivery/` — pass, 7.042s
- `go test -race -count=1 -timeout 180s -run 'TestHoldAdmission|TestDispatcher' ./internal/application/agentdelivery/` — pass, 10.154s
- `go test -count=1 -timeout 180s -run 'TestM5IdleDispatcherDoesNotWakeItselfForever' ./internal/transport/httpapi/humanapi/` — pass, 1.689s

The new regressions use a real migrated database, the real delivery store, and the real authority fence:

- duplicate `Start` while recovery is blocked on the fence produces one recovery plus one scan cycle (4 commits: the fence transaction, `RecoverExpiredLeases`, reconcile, finalize) and does not keep writing
- `Close` then `Start` does not resurrect a worker
- concurrent `Start`/`Close` joins any worker that started, and a later write does not scan
- `Close` during fence-blocked startup recovery returns, `done` is closed, and releasing the fence does not resume the worker

## Left in place

No other production file, no test outside `dispatcher_test.go`, no client, lock, golden, migration, UI, running instance, or `var` data. No commit or push. Parent still owns full `make check` / cross-build.
