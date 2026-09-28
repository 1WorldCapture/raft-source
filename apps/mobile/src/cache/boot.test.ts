import assert from "node:assert/strict";
import test from "node:test";
import {
  drainAfterPages,
  hydrateCachedMessages,
  latestCoverageThrough,
  messageFetchPlan,
  rawPageForCache,
  seedConversations,
} from "./boot.ts";

test("seedConversations passes through valid cached channels and drops junk", () => {
  const seeded = seedConversations([
    { id: "c1", type: "channel", raw: { id: "c1", name: "one", type: "channel" } },
    { id: "c2", type: "dm", raw: null },
    { id: "c3", type: "dm", raw: { notAChannel: true } },
  ]);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]?.id, "c1");
});

test("latestCoverageThrough picks the highest covered seq", () => {
  assert.equal(
    latestCoverageThrough([
      { fromSeq: 1, throughSeq: 5 },
      { fromSeq: 30, throughSeq: 40 },
      { fromSeq: 10, throughSeq: 20 },
    ]),
    40,
  );
  assert.equal(latestCoverageThrough([]), null);
});

test("messageFetchPlan continues from coverage tail or falls back to latest", () => {
  assert.deepEqual(messageFetchPlan([{ fromSeq: 7, throughSeq: 12 }]), { after: 12 });
  assert.deepEqual(messageFetchPlan([]), { latest: true });
});

test("hydrateCachedMessages merges overlay over body and drops invalid rows", () => {
  const hydrated = hydrateCachedMessages([
    {
      seq: 1,
      id: "m-1",
      raw: { id: "m-1", seq: 1, channelId: "c1", senderId: "u1", senderType: "user", createdAt: "2026-09-01T00:00:00Z", reactions: [] },
      overlay: { id: "m-1", seq: 1, channelId: "c1", senderId: "u1", senderType: "user", createdAt: "2026-09-01T00:00:00Z", reactions: [{ emoji: "x" }] },
    },
    { seq: 2, id: "m-2", raw: { broken: true }, overlay: null },
  ]);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0]?.id, "m-1");
  // parseMessage normalizes reactions to {emoji, count, reactedByMe, ...}.
  assert.equal(hydrated[0]?.reactions?.[0]?.emoji, "x");
  assert.equal(hydrated[0]?.reactions?.[0]?.count, 1);
});

test("rawPageForCache extracts rows and coerces the coverage window", () => {
  const toRow = (item: unknown) => {
    const record = item as { id?: string; seq?: number };
    return typeof record?.id === "string" && typeof record?.seq === "number"
      ? { seq: record.seq, id: record.id, raw: record as Record<string, unknown> }
      : null;
  };
  const wrapped = rawPageForCache(
    {
      messages: [{ id: "a", seq: 3 }, { id: "b", seq: 4 }, { invalid: true }],
      messageWindow: { coveredFromSeq: "3", coveredThroughSeq: 4, hasGap: false },
    },
    toRow,
  );
  // Non-numeric window fields degrade to absent (row-span rule in the repo).
  assert.equal(wrapped.window, undefined);
  assert.deepEqual(wrapped.messages.map((m) => m.seq), [3, 4]);

  const windowed = rawPageForCache(
    { messages: [{ id: "a", seq: 3 }], messageWindow: { coveredFromSeq: 1, coveredThroughSeq: 9, hasGap: false } },
    toRow,
  );
  assert.deepEqual(windowed.window, { coveredFromSeq: 1, coveredThroughSeq: 9, hasGap: false });
});

test("drainAfterPages pages until a short page and caps runaway loops", async () => {
  let calls = 0;
  const fake = async (after: number) => {
    calls += 1;
    // Three full pages of 50, then a short page of 3.
    if (calls <= 3) return Array.from({ length: 50 }, (_, i) => ({ seq: after + i + 1 }));
    return [{ seq: after + 1 }, { seq: after + 2 }, { seq: after + 3 }];
  };
  const drained = await drainAfterPages(100, fake, (p) => p.length >= 50);
  assert.equal(drained.pages.length, 4);
  assert.equal(drained.lastSeq, 100 + 150 + 3);
  assert.equal(calls, 4);

  // Runaway: always-full fetcher stops at the cap without hanging.
  let endless = 0;
  const result = await drainAfterPages(0, async (after) => {
    endless += 1;
    return Array.from({ length: 50 }, (_, i) => ({ seq: after + i + 1 }));
  }, (p) => p.length >= 50, 5);
  assert.equal(result.pages.length, 5);
  assert.equal(endless, 5);

  // Empty first page: nothing pulled.
  const empty = await drainAfterPages(7, async () => [], (p) => p.length >= 50);
  assert.deepEqual(empty.pages, []);
  assert.equal(empty.lastSeq, 7);
});
