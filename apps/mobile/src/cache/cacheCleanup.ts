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

export type ReconcileReport = {
  removed: string[];
};

/**
 * Drop cached channels that are absent from the live list. Call after a
 * successful channel-list refresh (task #2's home wiring): whatever the
 * server no longer returns — archived channels stay in the list until
 * unarchived, so absence means revoked access or deletion — must not stay
 * readable from the local cache.
 */
export async function reconcileChannels(
  repo: CacheRepo,
  scopeId: number,
  liveChannelIds: readonly string[],
): Promise<ReconcileReport> {
  const live = new Set(liveChannelIds);
  const removed: string[] = [];
  for (const channel of repo.getChannels(scopeId)) {
    if (!live.has(channel.id)) {
      await repo.deleteChannel(scopeId, channel.id);
      removed.push(channel.id);
    }
  }
  return { removed };
}

// ---- history pruning ----------------------------------------------------------

/**
 * plan → messageHistoryDays, mirroring packages/shared's limits table
 * (free = 30 days, everything above = unlimited). Drift risk noted as a
 * known open question: the authoritative cutoff should eventually ship on
 * GET /servers so the client never guesses.
 */
export function historyDaysForPlan(plan: string | null | undefined): number {
  return plan === "free" ? 30 : -1;
}

/**
 * Prune local messages older than the plan's history window. No-op when the
 * plan is unlimited (-1).
 */
export async function pruneToHistoryLimit(
  repo: CacheRepo,
  scopeId: number,
  plan: string | null | undefined,
  now: Date = new Date(),
): Promise<{ pruned: boolean; cutoffIso: string | null }> {
  const days = historyDaysForPlan(plan);
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
