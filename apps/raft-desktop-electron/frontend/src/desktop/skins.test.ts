import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { applySkin, clearSkin, currentSkinId, initSkin, syncSkinToTheme } from "./skins.ts";

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://raft.local/" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
}

test("applySkin writes the shared chrome and the same oklch signal desktop used before", () => {
  installDom();
  applySkin("signal");
  const root = document.documentElement;
  assert.equal(root.dataset.raftSkin, "signal");
  assert.equal(root.style.getPropertyValue("--color-soft-signal"), "#FFD440");
  assert.equal(root.style.getPropertyValue("--soft-signal-rgb"), "255 212 64");
  assert.equal(root.style.getPropertyValue("--color-brutal-yellow-400"), "oklch(from #FFD440 88.3% 0.162 h)");
  assert.equal(root.style.getPropertyValue("--color-brutal-yellow"), "var(--color-brutal-yellow-400)");
  assert.equal(root.style.getPropertyValue("--brutal-yellow-rgb"), "255 212 64");
});

test("a machine with no saved skin opens on rose", () => {
  installDom();
  assert.equal(currentSkinId(), "rose");
  initSkin();
  assert.equal(document.documentElement.dataset.raftSkin, "rose");
  assert.equal(document.documentElement.style.getPropertyValue("--color-soft-signal"), "#EFA9C6");
  assert.equal(
    document.documentElement.style.getPropertyValue("--color-brutal-yellow-400"),
    "oklch(from #EFA9C6 88.3% 0.162 h)",
  );
});

test("a saved skin still wins over the rose default", () => {
  installDom();
  localStorage.setItem("raft-desktop-skin", "amber");
  initSkin();
  assert.equal(document.documentElement.dataset.raftSkin, "amber");
  assert.equal(document.documentElement.style.getPropertyValue("--color-soft-signal"), "#FBE08C");
});

test("skins colour Brutal only: Elegant clears every skin token and ignores applySkin", () => {
  installDom();
  localStorage.setItem("raft-desktop-skin", "amber");
  initSkin();
  const root = document.documentElement;
  assert.equal(root.dataset.raftSkin, "amber");

  root.dataset.theme = "elegant";
  syncSkinToTheme();
  assert.equal(root.dataset.raftSkin, undefined);
  for (const property of ["--color-soft-signal", "--soft-signal-rgb", "--color-brutal-yellow", "--color-brutal-yellow-400", "--brutal-yellow-rgb"]) {
    assert.equal(root.style.getPropertyValue(property), "", `${property} must not survive on Elegant`);
  }
  applySkin("sky");
  assert.equal(root.dataset.raftSkin, undefined, "a skin pick cannot recolour Elegant");
  assert.equal(localStorage.getItem("raft-desktop-skin"), "amber", "the saved skin is untouched");

  root.dataset.theme = "brutal";
  syncSkinToTheme();
  assert.equal(root.dataset.raftSkin, "amber", "back on Brutal the saved skin returns");
  clearSkin();
  assert.equal(root.dataset.raftSkin, undefined);
});
