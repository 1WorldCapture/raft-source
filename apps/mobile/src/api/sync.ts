import type { ApiClient } from "./client";
import { isRecord, maxSeq, parseMessagePage, type RaftMessage } from "../model/messages";

const PAGE = 200;

/**
 * Normalize a /messages/sync response for parseMessagePage: older servers
 * return a BARE array (unlike /messages/channel's {messages,...}) and
 * serialize seq as a JSON string (pg bigserial via the raw row path).
 * parseMessage drops string seqs, which silently degraded the catch-up loop
 * (maxSeq came back 0 → immediate break) and upserted messages without seqs.
 * Same compatibility the cache gap-sync carries (cacheSyncRuntime); both stay
 * until every server ships the numeric-seq fix (server task #7/#19).
 */
function normalizeSyncRows(data: unknown): unknown[] {
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.messages)
      ? data.messages
      : [];
  return rows.map((row) => (
    isRecord(row) && typeof row.seq === "string" && /^\d+$/.test(row.seq) ? { ...row, seq: Number(row.seq) } : row
  ));
}

/** Catch up after a reconnect or a return to the foreground. */
export async function syncSince(client: ApiClient, sinceSeq: number, channelId?: string): Promise<RaftMessage[]> {
  if (sinceSeq <= 0) return [];
  const collected: RaftMessage[] = [];
  let cursor = sinceSeq;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      since_seq: String(cursor),
      limit: String(PAGE),
    });
    if (channelId) params.set("channel_id", channelId);
    const data = await client.get<unknown>(`/messages/sync?${params.toString()}`);
    const messages = parseMessagePage(normalizeSyncRows(data));
    if (messages.length === 0) break;
    collected.push(...messages);
    const next = maxSeq(messages);
    if (next <= cursor || messages.length < PAGE) break;
    cursor = next;
  }
  return collected;
}
