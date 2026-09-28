// App-level cacheSync instance (#client-data-cache task #2 review fix #4:
// wire refreshOverlayPageOncePerBoot for the visible message page).
//
// The session layer registers its ApiClient once; MessagePane then uses the
// singleton for the once-per-boot overlay refresh. Anna's #3 wiring owns the
// realtime event side and can reuse this instance (same repo, same runtime).
// fetchSyncPage here is a plain REST mapping so syncAll works standalone
// even before #3's socket-driven scheduling lands.

import { createCacheSync, type CacheSync, type SyncWireMessage } from "./cacheSync";
import { getCacheRuntime } from "./runtime";
import { rawPageForCache } from "./boot";
import { parseThreadSummaries } from "../model/messages";
import type { ApiClient } from "../api/client";

let client: ApiClient | null = null;
let instance: CacheSync | null = null;

/** Session registers its client once per process (re-registration is a no-op pattern). */
export function setCacheSyncClient(next: ApiClient): void {
  client = next;
}

export function getAppCacheSync(): CacheSync | null {
  if (client === null) return null;
  if (instance === null) {
    instance = createCacheSync({
      repo: getCacheRuntime().repo,
      fetchSyncPage: async (sinceSeq, limit) => {
        const data = await client!.get<unknown>(`/messages/sync?since_seq=${sinceSeq}&limit=${limit}`);
        if (!Array.isArray(data)) return [];
        return data.flatMap((item) => {
          if (
            item && typeof item === "object" && typeof (item as { seq?: unknown }).seq === "number"
            && typeof (item as { id?: unknown }).id === "string"
            && typeof (item as { channelId?: unknown }).channelId === "string"
          ) {
            return [{ seq: (item as { seq: number }).seq, id: (item as { id: string }).id, channelId: (item as { channelId: string }).channelId, raw: item as Record<string, unknown> }];
          }
          return [];
        }) satisfies SyncWireMessage[];
      },
      fetchOverlayPage: async (channelId, fromSeq, throughSeq) => {
        const limit = Math.max(1, throughSeq - fromSeq + 1);
        const data = await client!.get<unknown>(
          `/messages/channel/${encodeURIComponent(channelId)}?after=${fromSeq - 1}&limit=${limit}`,
        );
        const raw = rawPageForCache(data, (item) => {
          if (
            item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            && typeof (item as { seq?: unknown }).seq === "number"
          ) {
            return { seq: (item as { seq: number }).seq, id: (item as { id: string }).id, raw: item as Record<string, unknown> };
          }
          return null;
        });
        if (raw.messages.length === 0) return null;
        const summaries = parseThreadSummaries(data);
        return {
          fromSeq,
          throughSeq,
          messages: raw.messages.map((row) => ({ seq: row.seq, id: row.id, raw: row.raw })),
          ...(Object.keys(summaries).length > 0
            ? { threadSummaries: summaries as unknown as Record<string, Record<string, unknown> & { threadChannelId?: string }> }
            : {}),
        };
      },
    });
  }
  return instance;
}
