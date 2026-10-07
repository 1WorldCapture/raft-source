import assert from "node:assert/strict";
import test from "node:test";
import { bodyFont, color } from "./tokens.ts";
import { resolvePixel } from "./pixelAvatar.ts";

test("brand colors match the web theme", () => {
  assert.equal(color.yellow, "#FFD440");
  assert.equal(color.pink, "#FE7DA8");
  assert.equal(color.cyan, "#27CCF3");
  assert.equal(color.ink, "#141111");
});

test("body font follows the user preference and defaults to md", () => {
  assert.deepEqual(bodyFont("sm"), { fontSize: 12, lineHeight: 16 });
  assert.deepEqual(bodyFont("lg"), { fontSize: 16, lineHeight: 24 });
  assert.deepEqual(bodyFont(null), { fontSize: 14, lineHeight: 20 });
});

test("pixel avatars resolve a named sprite and a seeded one", () => {
  const named = resolvePixel("pixel:robot");
  assert.equal(named?.grid.length, 8);
  assert.equal(named?.grid[0]?.length, 8);
  const seeded = resolvePixel("pixel:random:localdev");
  assert.equal(seeded?.grid.length, 8);
  assert.equal(resolvePixel("https://example.com/a.png"), null);
});
