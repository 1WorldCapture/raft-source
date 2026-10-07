// Pins the anti-orphan watchdog (task #7): the detached tree exits only when
// the recorded GUI pid is dead AND its start time no longer matches (pid
// reuse must not look alive), a legacy binding without a start time disarms
// the watchdog, and the adopt-rebind rewrite keeps a freshly adopted tree
// alive by naming the CURRENT GUI.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { parseParentBinding, rebindParentEvidence, startParentWatchdog } from "./parentWatchdog.js";

test("parseParentBinding: requires pid + non-empty start time", () => {
  assert.deepEqual(parseParentBinding({ parentPid: 42, parentStartedAt: "Sun Sep 27 17:00:00 2026" }), {
    parentPid: 42,
    parentStartedAt: "Sun Sep 27 17:00:00 2026",
  });
  assert.equal(parseParentBinding({ parentPid: 42 }), null, "no start time → legacy, disarmed");
  assert.equal(parseParentBinding({ parentPid: -1, parentStartedAt: "x" }), null);
  assert.equal(parseParentBinding({ parentPid: "42", parentStartedAt: "x" }), null);
  assert.equal(parseParentBinding(null), null);
});

test("rebindParentEvidence rewrites parent fields atomically, preserving the rest", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "raft-watchdog-"));
  try {
    const file = path.join(home, "computer", "service-version.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: "1.0.28", pid: 111, parentPid: 999, parentStartedAt: "old" }), "utf8");
    await rebindParentEvidence(home, { parentPid: 4242, parentStartedAt: "new lstart" });
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.parentPid, 4242);
    assert.equal(after.parentStartedAt, "new lstart");
    assert.equal(after.version, "1.0.28", "other evidence fields preserved");
    assert.equal(after.pid, 111);
    // No evidence file at all → no-op, no throw.
    const empty = path.join(home, "other");
    await assert.doesNotReject(() => rebindParentEvidence(empty, { parentPid: 1, parentStartedAt: "x" }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("watchdog: two consecutive dead ticks fire once; live tick resets; null binding never fires", async () => {
  const fired: number[] = [];
  type Timer = { fn: () => void };
  const timers: Timer[] = [];
  const fakeSet = (fn: () => void) => {
    timers.push({ fn });
    return timers.length - 1;
  };
  const fakeClear = () => {};
  let alive = false;
  let binding: { parentPid: number; parentStartedAt: string } | null = { parentPid: 1, parentStartedAt: "s" };
  const handle = startParentWatchdog({
    readBinding: async () => binding,
    isAlive: async () => alive,
    onParentLost: () => fired.push(Date.now()),
    intervalMs: 3_000,
    misses: 2,
    setIntervalFn: fakeSet as unknown as typeof setInterval,
    clearIntervalFn: fakeClear as unknown as typeof clearInterval,
  });
  try {
    // Legacy binding (null) resets misses and never fires.
    binding = null;
    await timers[0].fn();
    assert.equal(fired.length, 0);
    // Dead tick 1: no fire yet.
    binding = { parentPid: 1, parentStartedAt: "s" };
    alive = false;
    await timers[0].fn();
    assert.equal(fired.length, 0, "one miss is not enough");
    // Live tick resets the streak.
    alive = true;
    await timers[0].fn();
    // Two dead ticks in a row → fires exactly once.
    alive = false;
    await timers[0].fn();
    await timers[0].fn();
    assert.equal(fired.length, 1, "fires once after two consecutive misses");
    await timers[0].fn();
    assert.equal(fired.length, 1, "does not re-fire after firing");
  } finally {
    handle.stop();
  }
});
