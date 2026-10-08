# Parent realtime assembly review — required corrections

Live implementation review, not acceptance. Keep ownership limited to your m4_socket/m4_publications files/tests/report. Parent will wire app.go once ready.

## 1. Audience snapshot TOCTOU (security blocker)

`resolveConversationDelivery` computes public/private/follower classification outside the final guard, then `deliver` trusts either PublishChannel or a captured user set. A connection admitted AFTER a permission change has the NEW valid generation and can pass the gateway fence against an OLD audience snapshot. Example: public thread classified roomScoped; root turns private; new authorized-but-unfollowed explicit viewer joins; old roomScoped publication delivers private-thread content despite the required follower rule. A per-connection generation check alone does not bind the payload/audience snapshot to its authority version.

Parent will expose `db.AuthoritySerial(handle) uint64` (global cached committed authority_clock; cheap memory only, updated before fence release). Capture it BEFORE projecting/classifying audiences; require it unchanged after all projection reads and INSIDE every final guarded publish predicate. Any mismatch must retain the intent for reprojection/retry, not mark published. PublishWhere must apply this predicate also for room-scoped delivery (the room is only subscription interest). Partial sends before a later mismatch are allowed, with stable-id replay; after a mismatch no new stale-audience send is admitted. A conservative global serial is acceptable for single-process M4, even when unrelated-workspace mutations cause retry. Alternatively prove an equivalent atomic current-policy revalidation with exact snapshot epochs; do not merely repeat room membership or cached identity checks.

Private payloads must additionally be current user+workspace intersection. Shared thread:updated cannot include one receiver's unreadCount/firstUnreadMessageId/readState; inspect exact original projector and strip receiver-private values. Invalid read-state/parent visibility must not be masked as nil+processed if there is a real DB failure.

## 2. Close/listener race

`RegisterAuthorityListener` unsubscribe removes future lookups but an in-flight commit may have ALREADY copied the callback. Closing wakeCh after unsubscribe can panic when that captured callback sends. Do not close a channel that asynchronous callbacks may send into. Use cancellation/done for wakeWorker termination; the callback selects done/default and a permanently open bounded wake queue, or add an actual callback-drain barrier. Test a commit captured before unsubscribe completing while Close runs; full race test must not panic/deadlock/leak.

Family hard-delete must promptly evict by SessionFamilyID alone or predicate even when the family row no longer exists. Do not perform an unbounded context.Background familyOwner DB read in shutdown; errors must not log raw SQL values via err.Error. The existing gateway Revocation permits custom Match; use it. Callback remains nonblocking and never does network work.

## 3. Missing surfaces / lifecycle

Readstate worker is adding exact scope_read:updated and a publication projector; subscribe rather than duplicating a second ad-hoc read-model implementation. Add dm:new {channelId} for real DM message activity to both actual participants (original messageService.ts:2872 etc), not only initial creation/revive; otherwise a passive hidden/unsubscribed peer may never refresh DM. Include thread:followers-updated relationship-level intent ScopeID. Unknown supported publication types must not accumulate forever.

Parent needs exact assembly Handler/Close constructor stable, tests and report. Do not call P0 mock authentication parity an actual app live test; actual tests/acceptance/m4-realtime.mjs is now present and parent will run it after app wiring. Socket library+main module already pinned v3.0.6; go mod tidy-diff/verify and27 original JS protocol assertions passed. No UI/browser/live service or data changes.
