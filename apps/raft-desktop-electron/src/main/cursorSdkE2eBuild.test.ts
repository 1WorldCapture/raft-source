import assert from "node:assert/strict";
import test from "node:test";
import { isCursorSdkE2eBuild } from "./cursorSdkE2eBuild.js";

test("only the explicit Cursor SDK E2E artifact opts out of production updates", () => {
  assert.equal(isCursorSdkE2eBuild("0.1.8-cursor-sdk.1"), true);
  assert.equal(isCursorSdkE2eBuild("0.1.8"), false);
  assert.equal(isCursorSdkE2eBuild("0.1.9-beta.1"), false);
  assert.equal(isCursorSdkE2eBuild("cursor-sdk"), false);
});
