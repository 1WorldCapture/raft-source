# M4 current-authority admission contract

Implementation detail supplement to phase-4-messaging.md §8. This document describes the code contract, not a completed test report.

## Migration0012

`0012_authority_epochs.sql` appends `authority_clock`, `authority_epochs` and authority-change triggers. The migration initializes exactly ONE non-user fact: `authority_clock(id=1,value=0)`. This is an internal counter origin, not a membership, permission grant, message, receipt or fabricated activity. `authority_epochs` starts empty; existing M3 authority remains in its original tables and is validated normally. The counter is not a message seq or an externally visible recovery cursor. No existing row is backfilled or granted access.

Generation changes are written by the same SQLite transaction as a session-family revocation, relevant user-account mutation, workspace membership/role change, relevant workspace/channel mutation, channel human membership mutation, or thread follow/unfollow. Epoch rows intentionally have no FK: deleting a principal or workspace must retain its invalidation tombstone. Every counter has integer/nonnegative checks; overflow fails the transaction rather than converting to REAL or truncating.

## Ordering

`db.Open` applies the migration and initializes a local generation cache before exposing its handle. All application authority writers use `db.WithWriteTx`. It acquires the per-database admission fence, begins IMMEDIATE, executes its business callback once, captures changed generations in that same transaction, commits, updates the in-memory generation cache, then releases the fence. Rolled-back changes do not reach the cache or eviction listeners. Commit listeners and transport-eviction wakes run only after releasing it.

A final sender guard uses `db.WithAuthorityReadContext` for current identity/eligibility checking and bounded NONBLOCKING admission. No socket/network wait is allowed under this fence or a database transaction. A generation check without the guard is insufficient because a revocation can interleave between check and use. Transport closure promptly discards pending queues, but is not the only authorization defense.

Family generations are separate from user generations. A logout invalidates that family; password reset and account changes may invalidate all of a user's sessions. Workspace invalidation is conservative: affected workspace sockets may reconnect even when a specific user remains authorized. Reconnection obtains current membership and subscriptions rather than reusing old rooms. Message creation, reaction changes and ordinary read/prefs writes do not themselves increment authority generations, except when a message/thread use case also creates a new thread follow as described below.

Eviction wakes carry the committed positive generation. `Revocation.BeforeGeneration` matches only identities admitted BEFORE that generation; equal/newer identities already authenticated after the commit and survive delayed, duplicated or out-of-order wakes. The zero value remains an explicit unconditional revocation for internal callers, but an authority wake with generation zero is rejected. Family tombstones match the immutable session-family ID directly: a hard-deleted family does not require a subsequent owner lookup or a paired user-epoch update to close its old sockets.

### Deliberate thread-interest tradeoff

The current 0012 migration uses the user epoch for thread follow insertion, unfollow/refollow and deletion. This also covers automatic follows caused by first replies and thread creation: an affected user's OLD sockets in all workspaces and all login families are conservatively disconnected and recover through the original reconnect/snapshot/resume path. This is safe but may cause visible reconnect churn. The delayed-wake cutoff prevents repeatedly evicting freshly reauthenticated sockets; it does not remove the initial broad eviction. A narrower workspace/thread interest fence is a separate optimization, not silently claimed as implemented. No migration or client-protocol redesign is included in this closeout.

A socket is bound to its exact verified access-token proof, including IssuedAt/ExpiresAt. A newer token for the same family must not extend an older socket. The proof and actual live family ownership are rechecked where required; body fields cannot select a sender or family.

## Publication audience parity

Roster, workspace membership and thread-follow queries produce candidate sets, not content authorization. Before live delivery, each candidate is narrowed through `channel.AuthorizeConversationTx` on the same read snapshot. This applies the frozen disabled guest gate, current workspace membership, private/DM participation and valid nonnested thread-parent authority consistently with history and explicit join. Read/counting audiences and targeted channel-membership updates are filtered too. A retained follow after losing the private parent cannot restore content permission; a new socket admitted at the latest generation still must pass the current content policy. Infrastructure errors preserve the durable publication for retry rather than being interpreted as resource disappearance.

## Limits and fixtures

This is the declared single-Go-process, one application database-handle deployment. External writers bypassing the application are unsupported. An intentionally raw sql.Open M1 fixture has no realtime surface and does not enable M4 generation publication; production always uses db.Open. Test startup validates the migrated authority tables rather than silently ignoring their absence.

The guarantee is about new authorization/admission after a committed revocation. Bytes already admitted to the network under previously valid authority cannot be recalled. No claim of retracting data already received by a client is made.

Private Activity rows and change logs also cascade with their owning user/workspace scope (0011). None of these tables is an Agent delivery/ACK ledger.
