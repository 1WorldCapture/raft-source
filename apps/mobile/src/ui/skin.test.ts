import assert from "node:assert/strict";
import test from "node:test";

import { bindSkinStorage, getSkinId, setSkin, skinRoles } from "./skin.ts";

test("the default skin is rose and signal falls back to the old yellow", () => {
  assert.equal(getSkinId(), "rose");
  assert.equal(skinRoles().chrome, "#EFA9C6");
  assert.equal(skinRoles("signal").chrome, "#FFD440");
  assert.equal(skinRoles("nope").id, "rose");
});

test("signal soft and pale keep the old yellow recipes", () => {
  const signal = skinRoles("signal");
  assert.equal(signal.signalSoft, "rgba(255, 212, 65, 0.4)");
  assert.ok(channelDelta(signal.signalPale, "#FFF4CF") <= 1, signal.signalPale);
});

test("setSkin notifies readers and ignores an unknown id by using rose", () => {
  setSkin("sky");
  assert.equal(getSkinId(), "sky");
  assert.equal(skinRoles(getSkinId()).chrome, "#A9D6F2");
  setSkin("nope");
  assert.equal(getSkinId(), "rose");
  setSkin("rose");
});

test("a saved skin applies before paint, and a bad save is ignored", () => {
  const writes: string[] = [];
  bindSkinStorage({
    read: () => "  sky\n",
    write: (id) => writes.push(id),
  });
  assert.equal(getSkinId(), "sky");
  setSkin("cloud");
  setSkin("cloud");
  assert.deepEqual(writes, ["cloud"]);

  bindSkinStorage({
    read: () => "Rose",
    write: () => {
      throw new Error("disk");
    },
  });
  assert.equal(getSkinId(), "cloud");
  setSkin("signal");
  assert.equal(getSkinId(), "signal");

  bindSkinStorage({
    read: () => {
      throw new Error("disk");
    },
    write: () => {},
  });
  assert.equal(getSkinId(), "signal");
  bindSkinStorage({ read: () => null, write: () => {} });
  setSkin("rose");
  assert.equal(getSkinId(), "rose");
});

function channelDelta(actual: string, expected: string): number {
  const left = Number.parseInt(actual.slice(1), 16);
  const right = Number.parseInt(expected.slice(1), 16);
  return Math.max(
    Math.abs(((left >> 16) & 255) - ((right >> 16) & 255)),
    Math.abs(((left >> 8) & 255) - ((right >> 8) & 255)),
    Math.abs((left & 255) - (right & 255)),
  );
}
