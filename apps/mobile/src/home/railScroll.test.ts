import assert from "node:assert/strict";
import test from "node:test";
import { railOverflow, railScrollTargetY } from "./railScroll.ts";

test("railOverflow is quiet when everything fits", () => {
  assert.deepEqual(railOverflow({ offset: 0, viewport: 600, contentHeight: 400 }), { above: false, below: false });
  assert.deepEqual(railOverflow({ offset: 0, viewport: 0, contentHeight: 900 }), { above: false, below: false });
});

test("railOverflow flags the directions that still have content", () => {
  assert.deepEqual(railOverflow({ offset: 0, viewport: 600, contentHeight: 900 }), { above: false, below: true });
  assert.deepEqual(railOverflow({ offset: 150, viewport: 600, contentHeight: 900 }), { above: true, below: true });
  assert.deepEqual(railOverflow({ offset: 300, viewport: 600, contentHeight: 900 }), { above: true, below: false });
});

test("railScrollTargetY leaves a visible slot alone", () => {
  assert.equal(railScrollTargetY({ slot: { y: 100, height: 44 }, offset: 0, viewport: 600, contentHeight: 900 }), null);
});

test("railScrollTargetY scrolls the minimum distance with a margin", () => {
  // Below the fold: bottom (800 + 44 + 12 = 856) aligns with the viewport bottom.
  assert.equal(railScrollTargetY({ slot: { y: 800, height: 44 }, offset: 0, viewport: 600, contentHeight: 1200 }), 256);
  // Above: top minus margin.
  assert.equal(railScrollTargetY({ slot: { y: 100, height: 44 }, offset: 400, viewport: 600, contentHeight: 1200 }), 88);
});

test("railScrollTargetY clamps to the scrollable range", () => {
  assert.equal(railScrollTargetY({ slot: { y: 4, height: 44 }, offset: 50, viewport: 600, contentHeight: 900 }), 0);
  assert.equal(railScrollTargetY({ slot: { y: 880, height: 44 }, offset: 0, viewport: 600, contentHeight: 900 }), 300);
});
