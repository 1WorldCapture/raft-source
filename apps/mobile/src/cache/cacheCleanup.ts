// Offline read-only support and cache cleanup (client-data-cache task #4).
//
// Pure data-layer pieces, all unit-testable against a real node:sqlite repo:
//   - reconcileChannels: drop cached channels that disappeared from the live
//     channel list (archived for good, or membership revoked) — the repo's
//     deleteChannel cascades to thread channels, overlays and read states.
//   - pruneToHistoryLimit: cut local messages older than the plan's history
//     window (server-side authoritative; the plan→days mapping mirrors
//     packages/shared's limits table because the mobile red line forbids
//     importing the shared package root).
//   - offline store: the single source of truth for "network unavailable"
//     that #5's UI (banner, disabled send) reads; the session layer feeds it
//     from socket connectivity / AppState.

import { create } from "zustand";
import type { CacheRepo } from "./repo";

// ---- channel reconciliation -------------------------------------------------

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
 * The wiring (task #2 home refresh) owns that guard.
 */
export async function reconcileChannels(
  repo: CacheRepo,
  scopeId: number,
  live: readonly LiveChannel[],
): Promise<ReconcileReport> {
  const keep = new Set(live.filter((channel) => !channel.archivedAt).map((channel) => channel.id));
  const removed: string[] = [];
  for (const channel of repo.getChannelsSync(scopeId)) {
    if (!keep.has(channel.id)) {
      await repo.deleteChannel(scopeId, channel.id);
      removed.push(channel.id);
    }
  }
  return { removed };
}

/**
 * Guarded reconcile entry for the home-refresh wiring (#2 合并后一行接入):
 * fetches BOTH channel lists, and reconciles only when both succeeded AND
 * the scope is unchanged. Any throw (network error, timeout) skips the
 * reconcile entirely — review r1: one failed refresh must never wipe the
 * cache.
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

// ---- history pruning ----------------------------------------------------------

/**
 * plan → messageHistoryDays fallback, mirroring packages/shared's limits table
 * (free = 30 days, everything above = unlimited). Only used when the server
 * does not send its authoritative `messageHistoryDays` (older servers).
 */
export function historyDaysForPlan(plan: string | null | undefined): number {
  return plan === "free" ? 30 : -1;
}

/** History policy source: a bare plan, or a server row from GET /servers. */
export type HistoryPolicySource =
  | string
  | null
  | undefined
  | { plan?: string | null; messageHistoryDays?: number | null };

/**
 * Resolve the history window in days (-1 = unlimited). The server-provided
 * `messageHistoryDays` wins; the plan table is only the fallback.
 */
export function resolveHistoryDays(source: HistoryPolicySource): number {
  if (source !== null && typeof source === "object") {
    if (typeof source.messageHistoryDays === "number" && Number.isInteger(source.messageHistoryDays)) {
      return source.messageHistoryDays < 0 ? -1 : source.messageHistoryDays;
    }
    return historyDaysForPlan(source.plan);
  }
  return historyDaysForPlan(source);
}

/**
 * Prune local messages older than the server's history window. No-op when the
 * window is unlimited (-1).
 */
export async function pruneToHistoryLimit(
  repo: CacheRepo,
  scopeId: number,
  source: HistoryPolicySource,
  now: Date = new Date(),
): Promise<{ pruned: boolean; cutoffIso: string | null }> {
  const days = resolveHistoryDays(source);
  if (days === -1) return { pruned: false, cutoffIso: null };
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  await repo.pruneMessages(scopeId, cutoffIso);
  return { pruned: true, cutoffIso };
}

// ---- offline state (read by #5's UI) -------------------------------------------

interface OfflineState {
  offline: boolean;
  /** Reason tag for the banner copy (#5): "network" vs "server". */
  cause: "network" | "server" | null;
  setOffline: (offline: boolean, cause?: "network" | "server") => void;
}

export const useOfflineStore = create<OfflineState>((set) => ({
  offline: false,
  cause: null,
  setOffline: (offline, cause) => set({ offline, cause: offline ? (cause ?? "network") : null }),
}));
