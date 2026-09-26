import type { ApiClient } from "./client";
import { maxSeq, parseMessagePage, type RaftMessage } from "../model/messages";

const PAGE = 200;

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
    const messages = parseMessagePage(data);
    if (messages.length === 0) break;
    collected.push(...messages);
    const next = maxSeq(messages);
    if (next <= cursor || messages.length < PAGE) break;
    cursor = next;
  }
  return collected;
}
