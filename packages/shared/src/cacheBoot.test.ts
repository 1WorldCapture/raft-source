// Shared boot fast-path helper tests (desktop-data-cache task #6 / P0).
// Pure functions: coverage → fetch plan, row hydration with an injected
// parser, after-page draining, raw page extraction.
import assert from "node:assert/strict";
import test from "node:test";
import {
  drainAfterPages,
  hydrateCachedMessages,
  latestCoverageThrough,
  messageFetchPlan,
  rawPageForCache,
  seedConversations,
} from "./cacheBoot.js";
import type { CachedMessage } from "./cacheRepoContract.js";

test("latestCoverageThrough returns the highest throughSeq across ranges", () => {
  assert.equal(latestCoverageThrough([]), null);
  assert.equal(latestCoverageThrough([{ fromSeq: 5, throughSeq: 9 }, { fromSeq: 1, throughSeq: 3 }]), 9);
});

test("messageFetchPlan continues from the tail with coverage, latest without", () => {
  assert.deepEqual(messageFetchPlan([{ fromSeq: 1, throughSeq: 7 }]), { after: 7 });
  assert.deepEqual(messageFetchPlan([]), { latest: true });
});

test("seedConversations passes through object rows with a string id and drops junk", () => {
  const good = { id: "c1", name: "a" };
  assert.deepEqual(seedConversations([{ id: "c1", type: "channel", raw: good }, { id: "c2", type: "x", raw: null }, { id: "c3", type: "x", raw: 42 }]), [good]);
});

test("hydrateCachedMessages merges overlay over raw, coerces legacy string seqs, drops parse failures", () => {
  const rows: CachedMessage[] = [
    { seq: 1, id: "m1", raw: { seq: "1", id: "m1", content: "legacy" }, overlay: { reactions: ["x"] } },
    { seq: 2, id: "m2", raw: { seq: 2, id: "m2" }, overlay: null },
    { seq: 3, id: "m3", raw: { seq: "not-a-number", id: "m3" }, overlay: null },
  ];
  const out = hydrateCachedMessages(rows, (value) => {
    const record = value as { seq?: unknown; reactions?: unknown };
    return typeof record.seq === "number" ? { seq: record.seq, reactions: record.reactions ?? null } : null;
  });
  assert.deepEqual(out, [
    { seq: 1, reactions: ["x"] }, // string seq coerced BEFORE parse + overlay merged
    { seq: 2, reactions: null },
    // "not-a-number" seq stays a string → parser drops the row
  ]);
});

test("drainAfterPages keeps paging on full pages and stops on a short page", async () => {
  const pages = [
    Array.from({ length: 50 }, (_, i) => ({ seq: i + 1 })),
    Array.from({ length: 50 }, (_, i) => ({ seq: i + 51 })),
    Array.from({ length: 3 }, (_, i) => ({ seq: i + 101 })),
  ];
  let call = 0;
  const out = await drainAfterPages(0, async () => pages[Math.min(call++, pages.length - 1)]!, (p) => p.length >= 50);
  assert.equal(out.pages.length, 3);
  assert.equal(out.lastSeq, 103);
  assert.equal(out.hitCap, false);
});

test("drainAfterPages reports hitCap when the cap is reached on a full page", async () => {
  const full = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1 }));
  const out = await drainAfterPages(
    0,
    async () => full,
    () => true,
    3,
  );
  assert.equal(out.pages.length, 3);
  assert.equal(out.hitCap, true, "ended on a full page at the cap — more may exist beyond");
  assert.equal(out.lastSeq, 50);
});

test("drainAfterPages stops on an empty page with nothing pulled", async () => {
  const out = await drainAfterPages(10, async () => [], () => true);
  assert.deepEqual(out, { pages: [], lastSeq: 10, hitCap: false });
});

test("rawPageForCache extracts rows and the server window, degrading when absent", () => {
  const withWindow = rawPageForCache(
    {
      messages: [{ id: "m1", seq: 1 }],
      messageWindow: { coveredFromSeq: 1, coveredThroughSeq: 50, hasGap: false },
    },
    (item) => {
      const record = item as { id?: unknown; seq?: unknown };
      return typeof record.id === "string" && typeof record.seq === "number"
        ? { seq: record.seq, id: record.id, raw: record as Record<string, unknown> }
        : null;
    },
  );
  assert.deepEqual(withWindow.messages.map((m) => m.seq), [1]);
  assert.deepEqual(withWindow.window, { coveredFromSeq: 1, coveredThroughSeq: 50, hasGap: false });

  const bare = rawPageForCache([{ id: "m1", seq: 1 }], (item) => {
    const record = item as { id?: unknown; seq?: unknown };
    return typeof record.id === "string" && typeof record.seq === "number"
      ? { seq: record.seq, id: record.id, raw: record as Record<string, unknown> }
      : null;
  });
  assert.equal(bare.window, undefined, "no window on the response → row span is the repo's business");
});
