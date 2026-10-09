import assert from "node:assert/strict";
import test from "node:test";
import { createSkinSync } from "./skinSync.js";

const KNOWN = new Set(["signal", "amber", "rose", "sky"]);

function harness(opts: { local?: string | null; pending?: boolean; pushFails?: boolean } = {}) {
  const state = { local: opts.local ?? null, current: opts.local ?? "amber", pending: opts.pending ?? false, pushFails: opts.pushFails ?? false };
  const pushed: string[] = [];
  const adopted: string[] = [];
  const sync = createSkinSync({
    storage: { getPending: () => state.pending, setPending: (v) => { state.pending = v; } },
    isKnown: (id) => KNOWN.has(id),
    localExplicit: () => state.local,
    current: () => state.current,
    adopt: (id) => { adopted.push(id); state.local = id; state.current = id; },
    push: async (id) => {
      if (state.pushFails) throw new Error("offline");
      pushed.push(id);
    },
  });
  return { sync, state, pushed, adopted };
}

test("server has a value: it is applied and remembered locally, nothing is written back", async () => {
  const h = harness({ local: "amber" });
  await h.sync.onLogin("sky");
  assert.deepEqual(h.adopted, ["sky"]);
  assert.equal(h.state.current, "sky");
  assert.deepEqual(h.pushed, []);
});

test("server has the same value as the local one: no-op", async () => {
  const h = harness({ local: "rose" });
  await h.sync.onLogin("rose");
  assert.deepEqual(h.adopted, []);
  assert.deepEqual(h.pushed, []);
});

test("server has no value but the user picked one here: it is written to the account once", async () => {
  const h = harness({ local: "signal" });
  await h.sync.onLogin(null);
  assert.deepEqual(h.pushed, ["signal"]);
  assert.equal(h.state.pending, false);
  assert.deepEqual(h.adopted, []);
});

test("server has no value and the user never picked one: nothing is written (default stays a default)", async () => {
  const h = harness({ local: null });
  await h.sync.onLogin(undefined);
  assert.deepEqual(h.pushed, []);
  assert.deepEqual(h.adopted, []);
});

test("unknown server value is ignored like no value", async () => {
  const h = harness({ local: "amber" });
  await h.sync.onLogin("neon");
  assert.deepEqual(h.adopted, []);
  assert.deepEqual(h.pushed, ["amber"]);
});

test("offline pick: stays pending, the local pick wins over the account on login, and is retried when online", async () => {
  const h = harness({ local: "amber", pushFails: true });
  await h.sync.onUserPick("sky");
  h.state.local = "sky"; h.state.current = "sky"; // what setSkin() does before notifying
  assert.equal(h.state.pending, true, "kept for a retry");
  assert.deepEqual(h.pushed, []);

  await h.sync.onLogin("rose"); // account still has an older value, but our pick is newer
  assert.deepEqual(h.adopted, [], "the unsent pick is not overwritten");
  assert.equal(h.state.pending, true);

  h.state.pushFails = false;
  await h.sync.onOnline();
  assert.deepEqual(h.pushed, ["sky"]);
  assert.equal(h.state.pending, false);
});

test("a pick while online is written and clears the pending flag", async () => {
  const h = harness({ local: "amber" });
  h.state.local = "sky"; h.state.current = "sky";
  await h.sync.onUserPick("sky");
  assert.deepEqual(h.pushed, ["sky"]);
  assert.equal(h.state.pending, false);
});

test("a newer pick made while an older write was in flight keeps the pending flag", async () => {
  const h = harness({ local: "amber" });
  h.state.local = "sky"; h.state.current = "sky";
  const first = h.sync.onUserPick("sky");
  h.state.local = "rose"; h.state.current = "rose"; // user picks again before the first write settles
  const second = h.sync.onUserPick("rose");
  await Promise.all([first, second]);
  assert.deepEqual(h.pushed, ["sky", "rose"], "writes are serialized in order");
  assert.equal(h.state.pending, false);
});

test("later account change (other device) is applied unless an own pick is pending", () => {
  const h = harness({ local: "amber" });
  h.sync.onServerValue("sky");
  assert.deepEqual(h.adopted, ["sky"]);
  const pendingHarness = harness({ local: "amber", pending: true });
  pendingHarness.sync.onServerValue("sky");
  assert.deepEqual(pendingHarness.adopted, []);
  h.sync.onServerValue("sky");
  h.sync.onServerValue(null);
  h.sync.onServerValue("neon");
  assert.deepEqual(h.adopted, ["sky"]);
});
