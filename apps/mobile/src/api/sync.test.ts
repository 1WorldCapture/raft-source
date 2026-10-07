import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "./client";
import { syncSince } from "./sync.ts";

// client-data-cache task #8 — the reconnect catch-up must survive the legacy
// /messages/sync shape (bare array + STRING seqs + pg timestamps) exactly
// like the cache gap-sync does, until every server ships the numeric fix.

type Scripted = { pattern: RegExp; pages: unknown[][] };

function makeClient(script: Scripted[]): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  let pageIdx = 0;
  const client = {
    get: (path: string) => {
      calls.push(path);
      for (const s of script) {
        if (!s.pattern.test(path)) continue;
        const page = s.pages[Math.min(pageIdx, s.pages.length - 1)] ?? [];
        pageIdx += 1;
        return Promise.resolve(page);
      }
      return Promise.resolve([]);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const msg = (seq: number | string) => ({
  id: `m-${seq}`, seq, channelId: "c1", senderId: "u", senderType: "user",
  createdAt: "2026-09-28 11:34:17.509+00", content: `body ${seq}`,
});

test("syncSince collects string-seq rows from the bare-array legacy shape", async () => {
  const { client } = makeClient([{ pattern: /\/messages\/sync/, pages: [[msg("5"), msg("6")]] }]);
  const out = await syncSince(client, 4);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.seq), [5, 6], "string seqs are coerced and collected");
  assert.equal(out[0]!.createdAt, "2026-09-28T11:34:17.509Z", "pg timestamp normalizes to ISO");
});

test("syncSince pages on full pages with numeric seqs", async () => {
  const page = (from: number) => Array.from({ length: 200 }, (_, i) => msg(from + i)); // from=1: seqs 1..200
  const { client, calls } = makeClient([{ pattern: /\/messages\/sync/, pages: [page(1), page(201), [msg(401)]] }]);
  const out = await syncSince(client, 1, "c1");
  assert.equal(out.length, 401);
  assert.equal(calls.length, 3);
  assert.match(calls[1]!, /since_seq=200/);
  assert.match(calls[2]!, /since_seq=400/);
});

test("syncSince accepts the {messages:[...]} wrapper shape too", async () => {
  const client = {
    get: () => Promise.resolve({ messages: [msg(9)] }),
  } as unknown as ApiClient;
  const out = await syncSince(client, 8);
  assert.deepEqual(out.map((m) => m.seq), [9]);
});
