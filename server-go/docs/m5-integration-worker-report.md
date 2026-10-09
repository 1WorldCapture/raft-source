# M5 integration worker report (G)

Date: 2026-10-09. Branch `feat/go-server` left dirty. No commit, no push.

## Assembled

Production `app.Build` now has one path:

- Persistent `agent.NewLaunchStore` on the control plane, passed into `agent.NewService`.
- `delivery.NewStore` shared by messaging (B constructs its own store on the same handle inside `messaging.NewService`), the dispatcher, onboarding, and the receipt sink.
- `onboarding.NewService(workspaceStore, channelStore, deliveryStore)`.
- `agentdelivery.NewService` plus `Dispatcher`. The pump recovers expired leases on start, reconciles briefings, prepares managed dispatches only when a non-external row is due, ensures start launches for `waiting_identity` agents with no open launch, sends through `SendWithAdmission`, and records `SendOutcome`.
- Lock order for that send: machine slot, then authority fence, then enqueue. Final Agent, channel, and launch checks run inside the fence. `DispatchDelivery` / `Hub.Send` are not treated as authorization.
- Dispatcher commits (reconcile, prepare) do not re-wake the pump. The 5s recovery ticker still scans. Close joins the worker, including Close before Start.
- Agent API: `agentapi.NewDomainAdapter` implements send, writable target, history, and events. All four ports are passed to `NewHandlers`. No 501 fallback on this surface.
- `channelId:<uuid>` send targets and history refs authorize through `agentconversation` (posting for send, read for history). Named DSL (`#name`, `dm:@peer`, threads) stays on `messaging.ResolveAgentTarget`.
- Claim and legacy drain pass `SinceSeq` into A's transaction filter. Positive-seq rows ack by seq only. Notice-only rows ack by delivery id and are not rendered as chat messages.
- Seq-0 control receipts call `delivery.Store.AcknowledgeControl` after the current launch/session is checked under the authority fence. The fence is released before that write.
- Human DM JSON uses `DMView.PeerType` (`user` or `agent`). Agent peers clear gravatar.
- Preflight lists the seven implemented Agent methods under `sk_agent`. The route manifest lists those seven plus the seven method-not-allowed mounts.

Application packages no longer import `transport/presenter` or `machinews`. Facts stay in `agentconversation`. `app/admission.go` is the hub adapter. `domain_adapter.go` is the only new Agent API file.

## Commands and results

From `server-go`, last run:

```
go test -count=1 -timeout 300s \
  ./internal/application/agentdelivery/ \
  ./internal/application/agentconversation/ \
  ./internal/app/ \
  ./internal/transport/httpapi/agentapi/ \
  ./internal/transport/httpapi/humanapi/ \
  ./tests/architecture/
```

| Package | Result |
|---|---|
| `internal/application/agentdelivery` | pass |
| `internal/application/agentconversation` | no test files |
| `internal/app` | pass (includes delivery composition and close) |
| `internal/transport/httpapi/agentapi` | pass |
| `tests/architecture` | pass |
| `internal/transport/httpapi/humanapi` | fail, one test |

`TestStabilizationDependencyDirection` and `TestHTTPRouteManifestCoversActualMounts` passed. Tests were not exempted.

## Blocker (A)

`TestM5ManagedBacklogCannotDelayExternalClaim` fails:

```
managed scan delayed or hid the external recipient: 200 {"events":[],...}
```

The managed agent does reach `waiting_machine`, so the scanner ran. The external recipient's claim then returns an empty batch.

Cause, left in A's files:

- `dispatch.go` `deferScanTx` sets the external row's `next_attempt_at` to `now + WaitingRecheckBackoff` (5s) while leaving it `pending`.
- `claim.go` `loadClaimableTx` only selects `pending` / `waiting_*` rows with `next_attempt_at <= now`.

One `PrepareManagedDispatches` call both moves the managed agent to `waiting_machine` and hides the external row from claim for the backoff. G cannot split that scan without reimplementing A's state machine or writing `agent_deliveries`. External-only passes skip `PrepareManagedDispatches` so a claim-only inbox is not deferred; a mixed sweep still has to call it.

Not changed: `internal/delivery/**`, channel, message, messaging, agent lifecycle, readstate, Makefile, migrations `0001`–`0013`, goldens, `packages/`, `apps/`.
