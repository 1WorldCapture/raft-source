import assert from "node:assert/strict";
import test from "node:test";
import {
  canExtendTailWithLive,
  contiguousRuns,
  mergeRanges,
  overlayIsNewer,
  overlayPageNeedsRefresh,
  pageRange,
  taskRevisionGate,
} from "./merge.ts";

test("mergeRanges fuses touching ranges", () => {
  const merged = mergeRanges([{ fromSeq: 10, throughSeq: 20 }], { fromSeq: 21, throughSeq: 30 });
  assert.deepEqual(merged, [{ fromSeq: 10, throughSeq: 30 }]);
});

test("mergeRanges fuses overlapping ranges", () => {
  const merged = mergeRanges([{ fromSeq: 10, throughSeq: 20 }], { fromSeq: 15, throughSeq: 25 });
  assert.deepEqual(merged, [{ fromSeq: 10, throughSeq: 25 }]);
});

test("mergeRanges keeps disjoint ranges apart (the gap survives)", () => {
  const merged = mergeRanges([{ fromSeq: 10, throughSeq: 20 }], { fromSeq: 25, throughSeq: 30 });
  assert.deepEqual(merged, [
    { fromSeq: 10, throughSeq: 20 },
    { fromSeq: 25, throughSeq: 30 },
  ]);
});

test("mergeRanges inserts out-of-order and fuses from both sides", () => {
  const merged = [
    { fromSeq: 30, throughSeq: 40 },
    { fromSeq: 10, throughSeq: 12 },
  ].reduce(
    (acc, range) => mergeRanges(acc, range),
    [] as Array<{ fromSeq: number; throughSeq: number }>,
  );
  const withMiddle = mergeRanges(merged, { fromSeq: 13, throughSeq: 29 });
  assert.deepEqual(withMiddle, [{ fromSeq: 10, throughSeq: 40 }]);
});

test("mergeRanges is idempotent", () => {
  const once = mergeRanges([{ fromSeq: 1, throughSeq: 5 }], { fromSeq: 6, throughSeq: 9 });
  const twice = mergeRanges(once, { fromSeq: 6, throughSeq: 9 });
  assert.deepEqual(twice, once);
});

test("mergeRanges ignores an inverted range", () => {
  const merged = mergeRanges([{ fromSeq: 1, throughSeq: 2 }], { fromSeq: 5, throughSeq: 4 });
  assert.deepEqual(merged, [{ fromSeq: 1, throughSeq: 2 }]);
});

test("pageRange uses the server window only when it has no gaps", () => {
  assert.deepEqual(
    pageRange([{ seq: 30 }, { seq: 40 }], {
      coveredFromSeq: 10,
      coveredThroughSeq: 45,
      hasGap: false,
    }),
    { fromSeq: 10, throughSeq: 45 },
  );
  assert.deepEqual(
    pageRange([{ seq: 30 }, { seq: 40 }], {
      coveredFromSeq: 10,
      coveredThroughSeq: 45,
      hasGap: true,
    }),
    { fromSeq: 30, throughSeq: 40 },
  );
});

test("pageRange falls back to the row span without a window", () => {
  assert.deepEqual(pageRange([{ seq: 7 }, { seq: 5 }, { seq: 6 }]), { fromSeq: 5, throughSeq: 7 });
  assert.equal(pageRange([]), null);
});

test("live messages may only extend a connected tail", () => {
  const tail = [{ fromSeq: 10, throughSeq: 20 }];
  assert.equal(canExtendTailWithLive(tail, 21, true), true);
  assert.equal(canExtendTailWithLive(tail, 21, false), false);
  assert.equal(canExtendTailWithLive(tail, 25, true), false);
  assert.equal(canExtendTailWithLive(tail, 15, true), false);
  assert.equal(canExtendTailWithLive([], 1, true), false);
});

test("contiguousRuns rebuilds true coverage", () => {
  assert.deepEqual(contiguousRuns([1, 2, 3, 7, 8]), [
    { fromSeq: 1, throughSeq: 3 },
    { fromSeq: 7, throughSeq: 8 },
  ]);
  assert.deepEqual(contiguousRuns([]), []);
  assert.deepEqual(contiguousRuns([42]), [{ fromSeq: 42, throughSeq: 42 }]);
});

test("overlayIsNewer is last-write-wins with a stale guard", () => {
  assert.equal(overlayIsNewer(null, "2026-01-01T00:00:00Z"), true);
  assert.equal(overlayIsNewer("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), true);
  assert.equal(overlayIsNewer("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), false);
  assert.equal(overlayIsNewer("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), false);
});

test("taskRevisionGate only moves forward", () => {
  assert.equal(taskRevisionGate(null, 1), true);
  assert.equal(taskRevisionGate(3, 4), true);
  assert.equal(taskRevisionGate(4, 4), false);
  assert.equal(taskRevisionGate(5, 4), false);
});

test("overlay pages refresh once per boot", () => {
  assert.equal(overlayPageNeedsRefresh(null, "boot-a"), true);
  assert.equal(overlayPageNeedsRefresh({ refreshedAt: "t", bootId: "boot-a" }, "boot-a"), false);
  assert.equal(overlayPageNeedsRefresh({ refreshedAt: "t", bootId: "boot-a" }, "boot-b"), true);
});
