// Server-rail cache helpers (#desktop-data-cache task #1). The ordered server
// list is persisted under the kv key "serverList" (one snapshot per member
// server's scope — see serverRailStore.persistServersToCache). These pure
// helpers turn a cached value back into rail-renderable state.
import { isRecord, parseServers, type RaftServer } from "../model/messages";

/** Validate a cached `serverList` kv value into servers; junk degrades to []. */
export function serversFromCacheValue(value: unknown): RaftServer[] {
  if (!isRecord(value) || !Array.isArray(value.servers)) return [];
  return parseServers(value.servers);
}
