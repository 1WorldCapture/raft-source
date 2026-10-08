# Parent integration review notes: message slice

Live implementation notes, not acceptance. Please address before final message-worker closeout.

## Reaction versions are persistent ordered counters

The in-progress reaction.go uses stateVersion(FNV(state)) for ViewerVersion and discussionVersion. This is not compatible: packages/web/src/store/reactionReadModels.ts lines387-401 rejects a numerically LOWER viewerVersion and detects same-version payload conflict. A state hash can decrease or repeat on add/remove/add. The reference schema defines actual message_reaction_discussion_versions and message_reaction_viewer_versions (packages/server/src/db/schema.ts:3319-3340).

Parent has now added BOTH tables to the still-unreleased0010 migration, with the reference column names and safe-integer CHECKs. Please use them: actual changed reaction increments the (message,emoji) discussion version AND the (message,user) viewer version atomically; idempotent repeats do not increment. Absence means version0. Remove stateVersion as the ordered version source. Keep viewer-private state out of shared messages. Add add/remove/add, two users, idempotency, out-of-order original reducer and restart tests.

A database error while loading discussionVersion must propagate as an error, NEVER return a fabricated version1. Review other projection paths for swallowed SQL/rows.Err errors. Persistent publication revision is already independent and remains message.Revision for shared mutation events.

## Integration

Parent owns schema/app. New0011 is now installed from readstate draft with stronger FKs and counter CHECKs;0012 authority generations also exists. Claims saved by legacyweb.accessClaims and all transaction/publication helpers are implemented. Channel worker API/report is now available.

Please expose publication projection/read entry points in the message worker report (shared Message, private viewer, thread update) with correct current authorization. Parent publisher will combine them with current recipient filtering and the final admission guard. History page rows and coverage must come from the same snapshot; avoid recomputing a false no-gap assertion across reads.

No UI/browser tests or live service changes. These are implementation corrections, not optional design deviations.

## Thread reply advances the author's read cursor in the same transaction

Cross-slice reviewer found original messageService.ts:2653/2759 marks the replying human's thread read-latest after auto-follow. Go currently only SetThreadFollowTx. The readstate package now exports `MarkReadLatestTx(ctx, ex readstate.Executor, claims auth.AccessTokenClaims, workspaceID, channelID string) (ReadStateResult,error)`. Expose a small injected callback on message.Store (e.g. SetThreadReplyReadHook with ctx,*sql.Tx,claims,ws,thread ->error) and invoke ONLY after a new human thread reply, in the SAME transaction. Parent will wire it to readstate without a module cycle. Never call a nested top-level mutation, never advance read on idempotent replay or an unrelated history read. Standalone tests can inject a faithful hook or exercise real integration. When the hook is required but absent, do not silently claim the full product path; expose a clear construction/wiring requirement while keeping pure fact unit tests deliberately separate.

Message + read-state publication must be committed atomically so rollback cannot leave either a phantom read or a message without its required read effect. Include tests for rollback, reply by two users, own-message exclusion and original version ledger consumption. Parent app realtime integrator is active in new m4_socket.go/m4_publications.go only; all other ownership unchanged.
