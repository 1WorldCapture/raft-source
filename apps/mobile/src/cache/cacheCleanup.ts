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

// Reconciled against the async shared CacheRepo contract (task #8 / P2a) —
// implementations live in packages/shared/src/cacheReconcile.ts and are
// re-exported here so existing importers keep working.
export { reconcileChannels, reconcileAfterChannelRefresh } from "@botiverse/raft-shared/src/cacheReconcile.ts";
export type { LiveChannel, ReconcileReport } from "@botiverse/raft-shared/src/cacheReconcile.ts";

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
