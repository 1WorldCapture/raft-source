import assert from "node:assert/strict";
import test from "node:test";
import {
  clampOffset,
  clampZoom,
  isDismissSwipe,
  nextDoubleTapZoom,
} from "./imageViewerMath.ts";

test("clampZoom keeps scale within 1-4", () => {
  assert.equal(clampZoom(0.5), 1);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(2.5), 2.5);
  assert.equal(clampZoom(9), 4);
});

test("double tap toggles between 1x and the zoom-in level", () => {
  assert.equal(nextDoubleTapZoom(1), 2.5);
  assert.equal(nextDoubleTapZoom(1.01), 2.5);
  assert.equal(nextDoubleTapZoom(1.2), 1);
  assert.equal(nextDoubleTapZoom(2.5), 1);
  assert.equal(nextDoubleTapZoom(4), 1);
});

test("clampOffset centres at 1x and bounds the over-scroll rectangle", () => {
  assert.equal(clampOffset(50, 1, 300), 0);
  assert.equal(clampOffset(-50, 1, 300), 0);
  // scale 2 on a 300dp viewport allows 150dp of travel either way
  assert.equal(clampOffset(50, 2, 300), 50);
  assert.equal(clampOffset(999, 2, 300), 150);
  assert.equal(clampOffset(-999, 2, 300), -150);
  // scale 4 allows 450dp
  assert.equal(clampOffset(999, 4, 300), 450);
});

test("dismiss swipe requires vertical dominance past the threshold", () => {
  assert.equal(isDismissSwipe(10, 200), true);
  assert.equal(isDismissSwipe(0, 141), true);
  assert.equal(isDismissSwipe(0, 100), false);
  assert.equal(isDismissSwipe(300, 200), false);
  assert.equal(isDismissSwipe(0, -200), false);
});
