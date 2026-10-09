# M5 inbox projection closeout

Claim and legacy drain now render the visible page on the same write executor that leases it, and a legacy drain acknowledges that page only after the render returns nil. A projection or current-principal failure aborts the transaction. That is not the original lost-response window. The lost-response window remains only after this transaction commits and the HTTP body is then dropped.

## APIs

`delivery.ClaimProjector` is `func(ctx, ex Executor, page *ClaimResult) error`. It is optional on `ClaimInput.Project` and `LegacyDrainQuery.Project`. Nil keeps the previous store methods usable by existing tests: they still lease and, for a drain, acknowledge without an in-transaction render. A non-nil projector runs after the page is leased and before `claimTx` returns, which is before `ackClaimTx`. It must not call `WithWriteTx` or `WithReadSnapshot`.

`ClaimResult.HasMore` is true only when another authorized eligible row exists beyond the returned page. An exactly full final page is false. The extra row is not leased and is not added to the receipt, so a drain cannot acknowledge it.

`delivery.DeliveryOnExecutor(ctx, ex, id)` reads one delivery on the caller's executor.

`agentconversation.MessageFacts` keeps its signature and still opens one read snapshot for callers outside a claim transaction (the managed-wire dispatcher). `MessageFactsTx(ctx, ex, workspaceID, channelID, messageID, agentID)` and `ChannelSnapshotTx` read the message, channel names, and mention fact on `ex` and do not open another transaction or snapshot. The claim path validates the current principal with `ValidatePrincipalTx` on that same executor immediately before rendering.

`agentdelivery.InboxEvent` is the message/notice union. `ClaimedBatch.Events` is `[]InboxEvent`. A message arm is `*agentconversation.MessageFacts`. A notice arm is `*ControlNotice` filled from `onboarding.BriefingTx`: seq 0, `NoticeID` equal to the delivery id, system sender, channel reply context, and the private briefing body. No `messages` row is inserted and unread/read state is not written. `ErrProjectionRejected` wraps a malformed or unreadable page; `BriefingTx` and `MessageFactsTx` errors also abort the transaction.

Positive-seq rows set `AckSeqs` only. Briefings set `AckMessageIDs` to the delivery id. Seq 0 is never an ack seq. Partial, cross-list, and unknown ack behavior is unchanged.

`agentapi` maps a notice onto the existing agent message facts (`sender_type=system`, `message_id` = delivery id, seq 0). The frozen envelope tag `json:"seq,omitempty"` omits a zero seq, so the HTTP event is seq-less and the ack array carries the notice id. This package does not change that tag.

`SinceSeq` is unchanged: nil is latest; a non-nil value keeps `messages.seq > since` and omits seq-0 notices. Omitted rows stay pending or leased and are not acknowledged.

## Tests

`go test -count=1 -timeout 120s ./internal/delivery/ -run 'TestClaimProjection' -v`

- `TestClaimProjectionFailureAckIsNotDurable` PASS (0.02s). The projector observes `leased` and `acknowledged_at` NULL, then returns an error. The drain error is that error, `removed=0`, and the row is `pending` with no `acknowledged_at`, no `ACKED` attempt, and no acked claim. A later claim leases the same seq; the next claim reissues the same claim id without a second budget charge. A second failing drain leaves that lease in place, and the following claim reissues it again.
- `TestClaimProjectionHasMoreDoesNotLeaseOmittedRows` PASS (0.04s). Two due rows with limit 2 report `HasMore` false. Three due rows with limit 2 report `HasMore` true and leave the third `pending`. Draining that page acknowledges 2 and leaves the third `pending`. The next claim is the one remaining row with `HasMore` false.
- `TestClaimProjectionNoticeAndSinceDoNotAckUnseen` PASS (0.05s). A notice-only claim has empty `seqs`, `message_ids=[delivery id]`, event seq 0, and no new `messages` row after ack. A mixed claim puts the positive seq only in `seqs` and the briefing id only in `message_ids`. `since=<low seq>` drains and acknowledges only the higher seq; the older message and the briefing stay `pending` and are both returned by the next latest claim.

`go test -count=1 -timeout 240s ./internal/delivery/ ./internal/application/agentdelivery/ ./internal/transport/httpapi/agentapi/` PASS.

`go test -count=1 -timeout 300s ./internal/transport/httpapi/humanapi/ -run 'TestM5ProjectionAtomicity|TestAgentDMHTTPReplyReadstateAndClaimCompose|TestM5ManagedBacklogCannotDelayExternalClaim'` PASS, including:

- `TestM5ProjectionAtomicityFailureReissuesAndRendersNotice` (0.14s). Real credential, real `#all` handoff briefing, and a real mention. The notice claim renders the private handoff text as `sender_type=system` with `message_id` equal to the delivery id, ack `message_ids` containing that id, no public messages row, and unchanged human unread/history. After that notice is acknowledged, a message claim is leased, then the message channel is moved so `MessageFactsTx` cannot read it. `GET /events` returns 500. The message stays `leased` / `in_flight` with `acknowledged_at` NULL and the attempt is not `ACKED`. Restoring the channel and claiming again returns the same body on the same open claim id, still unacknowledged.
- `TestM5ProjectionAtomicityHasMoreAndSince` (0.19s). Three real mentions: limit 2 has `has_more=true` and the third stays `pending` through the page ack; the next claim has `has_more=false` and that third seq. `since` equal to the older seq returns only the newer message, leaves the older message and the briefing `pending`, and the following latest claim returns both unseen bodies. The restored receipt uses the older seq and the notice id, not seq 0.

## Left in place

`delivery/dispatch.go` mixed external scheduling and the dispatcher lifecycle were not edited. The machinecontrol receipt adapter remains the canonical sink; no `agentdelivery` receipt sink was added. Original-client harness, migrations, and live servers were not touched.
