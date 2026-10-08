# Parent channel integration review

Live coordination, not acceptance. Additional concrete cross-slice gap found in the first actual M4 HTTP acceptance run:

`HasPriorChannelRelationshipTx` currently checks channel_humans/thread_follows/direct_messages only and still says readstate residue will arrive later. Actual0011 readstate tables now exist; this function must include those bounded receiver-owned witnesses as specified by original channelService.ts:4670-4749. The TS comment explicitly says deleted channel_humans membership is NOT historical evidence. Add real `user_channel_read_states`, `user_channel_done_states`, `user_mention_suppressions` probes (include target_kind and resolve workspace from the same channel snapshot, preserve scope) to the shared witness function; do not expose another user's residue.

The original history anti-oracle split is: current access ->200; no access + receiver residue ->403; no access + no residue ->404. Merely doing GET history creates no read cursor. The acceptance test is being corrected to first exercise removed-with-no-residue404, then re-add+actual read/write cursor -> remove ->403. No fabricated membership history or forced403 for everyone.

The send route has a DIFFERENT contract: original messages.ts:1694-1705 same-workspace existence then canPost false ->403 with exact join-before-post sentence, even for a never-member private channel. Parent corrected that one test expectation, not product code.

Other ongoing second-turn requests remain: atomic MarkReadLatestTx hook for explicit follow, relationship-specific publication keys and domain-owned auto-follow publication, actual DM revive event, approved #all write boundary, hiddenDmIds compatibility. Schema0010/0011/0012 and shared helpers are now present and tested.
