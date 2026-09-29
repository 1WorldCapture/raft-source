// Channel reconciliation against the async CacheRepo contract
// (client-data-cache task #8 / P2a). Promoted from the mobile cleanup module
// so every cache implementation (mobile SQLite, Web IndexedDB) drops cached
// channels through one guarded code path.
//
// Semantics: the repo's deleteChannel cascades to the channel's thread
// channels, overlays and read states, so a single reconcile pass is enough
// to make a disappeared channel fully unreadable offline.

import type { CacheRepo } from "./cacheRepoContract.ts";

export type LiveChannel = { id: string; archivedAt?: string | null };

export type ReconcileReport = {
  removed: string[];
};

/**
 * Drop cached channels that must not stay readable: absent from the live
 * list (revoked access / deleted) OR archived (requirement: 「归档的删除，
 * 其余的都保留」 — an archived channel disappears from the rail even though
 * the server keeps returning it until unarchived).
 *
 * CONTRACT — call this ONLY with a complete list: /channels AND /channels/dm
 * both succeeded with full results AND the scope has not switched since the
 * fetches started. A failed, timed-out or partial fetch must skip the
 * reconcile entirely — one network hiccup must never wipe the whole cache.
 * Use reconcileAfterChannelRefresh below for a guarded entry point.
 */
export async function reconcileChannels(
  repo: CacheRepo,
  scopeId: number,
  live: readonly LiveChannel[],
): Promise<ReconcileReport> {
  const keep = new Set(live.filter((channel) => !channel.archivedAt).map((channel) => channel.id));
  const removed: string[] = [];
  for (const channel of await repo.getChannels(scopeId)) {
    if (!keep.has(channel.id)) {
      await repo.deleteChannel(scopeId, channel.id);
      removed.push(channel.id);
    }
  }
  return { removed };
}

/**
 * Guarded reconcile entry for the home-refresh wiring: fetches BOTH channel
 * lists, and reconciles only when both succeeded AND the scope is unchanged.
 * Any throw (network error, timeout) skips the reconcile entirely — one
 * failed refresh must never wipe the cache.
 */
export async function reconcileAfterChannelRefresh(
  repo: CacheRepo,
  scopeId: number,
  fetch: () => Promise<{ channels: readonly LiveChannel[]; dms: readonly LiveChannel[] }>,
  opts?: { stillActive?: () => boolean },
): Promise<{ reconciled: boolean; removed: string[] }> {
  let lists: { channels: readonly LiveChannel[]; dms: readonly LiveChannel[] };
  try {
    lists = await fetch();
  } catch {
    return { reconciled: false, removed: [] };
  }
  if (opts?.stillActive && !opts.stillActive()) {
    return { reconciled: false, removed: [] };
  }
  const report = await reconcileChannels(repo, scopeId, [...lists.channels, ...lists.dms]);
  return { reconciled: true, removed: report.removed };
}
