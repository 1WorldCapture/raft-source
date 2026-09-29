// Per-boot overlay coverage (desktop-data-cache task #7). Which channel seq
// ranges already carry this boot's dynamic data (reactions, edits, thread
// summaries) because a network page proved them. The overlay refresh fills
// gaps; the message store's own network loads (open, catch-up drain, older
// history) record their pages here too, so the refresh does not fetch the
// same rows a second time. No store imports: both sides depend on this file.

import { activeWebCache } from "./messageCache";

export type Coverage = { fromSeq: number; throughSeq: number };

// Keys are `${scopeId}:${generation}:${channelId}`.
const covered = new Map<string, Coverage[]>();
const pendingLoads = new Map<string, Set<Promise<void>>>();
const scopeResetListeners = new Set<() => void>();
let disconnectEpoch = 0;
let stateScopeKey: string | null = null;

/** Current disconnect epoch; a page that straddles a disconnect marks nothing. */
export function overlayEpoch(): number {
  return disconnectEpoch;
}

/** Drop state from another scope attachment; returns this scope's key prefix. */
export function syncOverlayScope(): string | null {
  const cache = activeWebCache();
  if (!cache) return null;
  const scopeKey = `${cache.scopeId}:${cache.generation}`;
  if (stateScopeKey !== scopeKey) {
    covered.clear();
    pendingLoads.clear();
    stateScopeKey = scopeKey;
    for (const listener of scopeResetListeners) listener();
  }
  return scopeKey;
}

/** Other per-scope state (failures, in-flight fetches) resets with coverage. */
export function onOverlayScopeReset(listener: () => void): void {
  scopeResetListeners.add(listener);
}

export function isSeqCovered(key: string, seq: number): boolean {
  return (covered.get(key) ?? []).some((span) => seq >= span.fromSeq && seq <= span.throughSeq);
}

/** Add a proven span, merging overlapping or touching ones. */
export function addCoverage(key: string, span: Coverage): void {
  if (span.throughSeq < span.fromSeq) return;
  const spans = [...(covered.get(key) ?? []), span].sort((a, b) => a.fromSeq - b.fromSeq);
  const merged: Coverage[] = [];
  for (const next of spans) {
    const last = merged.at(-1);
    if (last && next.fromSeq <= last.throughSeq + 1) {
      last.throughSeq = Math.max(last.throughSeq, next.throughSeq);
    } else {
      merged.push({ ...next });
    }
  }
  covered.set(key, merged);
}

export type ChannelNetworkLoad = {
  /**
   * Record a page the load fetched. `after`: an after=<seq> page (proves
   * after+1 through its last row, or the channel end when short). `latest`:
   * the newest page (proves its first row through the channel end).
   * `before`: a before=<seq> page (proves its first row through before-1).
   */
  page(
    kind: { after: number } | { latest: true } | { before: number },
    seqs: readonly number[],
    full: boolean,
  ): void;
  end(): void;
};

/**
 * Start tracking a message-store network load for `channelId`. Synchronous:
 * adds no await before the caller's request. The overlay refresh waits for
 * tracked loads before planning, so the open refresh sees their coverage.
 */
export function beginChannelNetworkLoad(channelId: string): ChannelNetworkLoad {
  const scope = syncOverlayScope();
  const epoch = disconnectEpoch;
  const key = scope ? `${scope}:${channelId}` : null;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  if (key) {
    const set = pendingLoads.get(key) ?? new Set<Promise<void>>();
    set.add(settled);
    pendingLoads.set(key, set);
  }
  const current = () => key !== null && epoch === disconnectEpoch && syncOverlayScope() === scope;
  return {
    page(kind, seqs, full) {
      if (!current() || !key) return;
      const valid = seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0);
      if ("after" in kind) {
        const through = !full ? Number.MAX_SAFE_INTEGER : Math.max(kind.after + 1, ...valid);
        addCoverage(key, { fromSeq: kind.after + 1, throughSeq: through });
      } else if ("latest" in kind) {
        if (valid.length > 0) addCoverage(key, { fromSeq: Math.min(...valid), throughSeq: Number.MAX_SAFE_INTEGER });
      } else if (valid.length > 0 || !full) {
        const from = full ? Math.min(...valid) : 1;
        addCoverage(key, { fromSeq: from, throughSeq: kind.before - 1 });
      }
    },
    end() {
      settle();
      if (!key) return;
      const set = pendingLoads.get(key);
      set?.delete(settled);
      if (set && set.size === 0) pendingLoads.delete(key);
    },
  };
}

/** Wait (bounded) for tracked store loads of this channel to finish. */
export async function whenChannelLoadsSettled(key: string, timeoutMs: number): Promise<void> {
  const set = pendingLoads.get(key);
  if (!set || set.size === 0) return;
  await Promise.race([
    Promise.all([...set]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Disconnect: coverage is no longer proof of freshness. */
export function bumpOverlayEpoch(): void {
  disconnectEpoch += 1;
  covered.clear();
}

/** @internal reset module state between tests. */
export function resetOverlayCoverageForTest(): void {
  covered.clear();
  pendingLoads.clear();
  disconnectEpoch = 0;
  stateScopeKey = null;
}
