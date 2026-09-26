import assert from "node:assert/strict";
import test from "node:test";
import { runFontFamily } from "./runFont.ts";

test("latin runs keep Space Grotesk instead of inheriting nothing", () => {
  assert.equal(runFontFamily(false, "SpaceGrotesk-400", "sans-serif"), "SpaceGrotesk-400");
  assert.equal(runFontFamily(true, "SpaceGrotesk-700", "sans-serif"), "sans-serif");
});
