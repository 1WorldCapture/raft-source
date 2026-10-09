# M5 managed terminal closeout

A cancelled or blocked managed intent no longer occupies its Agent's single outstanding slot. Explicit requeue of an uncertain intent mints a new occurrence. A stale five-tuple of the old occurrence does not complete that replacement, and it is not recorded as `ACKED`.

## What was starving the Agent

`agentHasOtherInFlightTx` treated every `in_flight` managed attempt as the Agent's one outstanding slot, including attempts whose logical delivery was already `cancelled` or `blocked`.

Two producers left those attempts open:

- `PrepareManagedDispatches` authorization failure cancelled the intent and left the occurrence `in_flight`. After lease expiry the recovered row is `pending` with the old attempt still open, so a revoked first message held the slot and the sibling never leased.
- Identity drift after a `received` / `pending` / `drained` observation blocks the intent as `uncertain_delivery` and keeps that attempt `in_flight`. The same counter then skipped every later message for that Agent.

`RequeueBlocked` put the blocked intent back to `pending` and cleared the budget, but the observed attempt was still open. The next prepare saw the same observation plus the new launch/session and blocked `uncertain_delivery` again.

## Slot and terminal rules

The single slot is one `in_flight` `managed_wire` attempt in the same workspace and Agent whose logical delivery is still `pending`, `waiting_machine`, `waiting_identity`, or `leased`. `cancelled` and `blocked` parents do not count. External claim attempts do not count. A same-identity resend of a still-live occurrence still occupies the slot and reuses that occurrence.

Authorization failure in a managed prepare terminal-closes the open attempt as `CANCELLED` in the same transaction as the intent cancel. `CancelDeliveries` uses the same close. `CANCELLED` is not a receipt: `received_at` / `pending_at` / `drained_reported_at` stay, `acked_at` is not invented, and the identity snapshot is not rewritten. A later five-tuple may set `acked_at` as an audit fact. It does not change the terminal code to `ACKED`, does not resurrect the intent, and does not complete a sibling attempt.

Observed identity drift still blocks the intent as `uncertain_delivery` and does not mint a replacement. The attempt stays `in_flight` so a genuine five-tuple of that occurrence can still acknowledge that blocked intent. `AcknowledgeManaged` does that only while the attempt is `in_flight`, and that method is outside this change. The open row does not hold the slot, because the parent is `blocked`. Closing it at block time would turn that genuine receipt into audit-only and leave the intent blocked.

`RequeueBlocked` is the explicit redrive. It terminal-closes any still-open attempt as `SUPERSEDED` before resetting the intent to `pending` and the budget to 0. That is not an ACK. The next prepare, once the Agent's slot is free, inserts a new attempt number and occurrence under the current launch/session. A stale five-tuple names the superseded occurrence: `acked_at` is recorded there, `terminal_code` stays `SUPERSEDED`, and the leased replacement is not acknowledged. A foreign machine, Agent, or workspace ACK of the replacement writes nothing. The replacement's own five-tuple still acknowledges it.

An acknowledged sibling receipt is left as it was. Managed prepares still do not change an external intent's state, revision, retry count, or next-attempt time. External claim receipts stay the original shape: a positive message seq is returned only in `seqs`, with `message_ids` empty. No claim token was added.

## Tests

Ordinary, from `server-go`:

`go test -count=1 -timeout 120s -v ./internal/delivery/ -run 'TestObservedDriftBlocksWithoutStarvingSameAgent|TestUnauthorizedAfterLeaseExpiryReleasesSlot|TestRequeueBlockedMintsOccurrenceAndRefusesStaleAck|TestExpiredSameIdentityAttemptStillOccupiesSlot'`

- `TestObservedDriftBlocksWithoutStarvingSameAgent` PASS (0.05s). First message is `received`, lease expires, identity drifts: intent `blocked` / `uncertain_delivery`, attempt stays `in_flight` with the original snapshot and no `acked_at`. The same Agent's second message leases. Another Agent leases. The external row is unchanged and claims as `seqs=[message seq]`, `message_ids` empty. ACK of the blocked occurrence acknowledges only that intent.
- `TestUnauthorizedAfterLeaseExpiryReleasesSlot` PASS (0.03s). After lease expiry the revoked first attempt is `CANCELLED` with `received_at` kept and `acked_at` unset. The sibling leases. A late ACK audits `acked_at` on the cancelled attempt, leaves it `CANCELLED`, and does not complete the sibling.
- `TestRequeueBlockedMintsOccurrenceAndRefusesStaleAck` PASS (0.02s). Requeue supersedes the observed attempt without `ACKED`. The next prepare leases attempt N+1 on the new launch/session. Foreign machine, Agent, and workspace ACKs do not change it. The stale five-tuple does not acknowledge the replacement. The replacement's own five-tuple does.
- `TestExpiredSameIdentityAttemptStillOccupiesSlot` PASS (0.02s). After lease expiry the same launch/session reuses the occurrence, and the sibling stays `pending`.

`go test -count=1 -timeout 240s ./internal/delivery/` PASS (1.848s).

Race, from `server-go`:

`go test -count=1 -race -timeout 300s ./internal/delivery/` PASS (41.978s).

## Left in place

No edits to receipt admission, claim projection, inbox adapters, migrations, original clients, locks, goldens, UI, or existing server data. Nothing was committed or pushed.
