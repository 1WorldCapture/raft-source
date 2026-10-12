import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { clearSearchAnchor, writeSearchAnchor } from "./searchAnchor.ts";

test("the search field's geometry becomes the three overlay anchor variables, and clears again", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const root = dom.window.document.documentElement;
  writeSearchAnchor(root, { top: 4.4, left: 300, width: 520 });
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-top"), "4px");
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-center-x"), "560px");
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-width"), "520px");
  clearSearchAnchor(root);
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-top"), "");
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-center-x"), "");
  assert.equal(root.style.getPropertyValue("--desktop-search-anchor-width"), "");
});
