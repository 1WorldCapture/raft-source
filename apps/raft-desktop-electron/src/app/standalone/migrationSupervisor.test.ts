import assert from "node:assert/strict";
import test from "node:test";
import { MigrationSupervisor, type SupervisorDeps } from "./migrationSupervisor.ts";
import type { InProgressMarker } from "./migrationRecovery.ts";

const marker = (over: Partial<InProgressMarker> = {}): InProgressMarker => ({ pid: 4242, from: "/h/old", to: "/h/.slock", startedAt: "2026-10-10T00:00:00Z", deadlineAt: "2026-10-10T00:10:00Z", step: "stop", home: "/h/old", ...over });

function make(over: Partial<SupervisorDeps> = {}) {
  const calls: string[] = [];
  let aliveLeft = 2;
  const published: string[] = [];
  const deps: SupervisorDeps = {
    marker: marker(),
    readMarker: async () => marker({ step: "start" }),
    readResult: async () => ({ result: "success", from: "/h/old", to: "/h/.slock", finishedAt: "x", startedAt: "2026-10-10T00:00:05Z", error: null, reason: null }),
    isAlive: () => aliveLeft-- > 0,
    signal: (pid, sig) => { calls.push(`signal:${pid}:${sig}`); },
    finish: async (to) => { calls.push(`finish:${to}`); return { warnings: [] }; },
    relaunch: () => { calls.push("relaunch"); },
    publish: (s) => published.push(`${s.phase}${s.cancelRequested ? "+cancel" : ""}`),
    sleep: async () => undefined,
    ...over,
  };
  return { sup: new MigrationSupervisor(deps), calls, published };
}

test("starts as 'applying' with the marker's step and deadline, supervising and cancellable", () => {
  const { sup } = make();
  const s = sup.getState();
  assert.deepEqual([s.phase, s.supervising, s.cancellable, s.deadlineAt, s.steps[0]?.step], ["applying", true, true, "2026-10-10T00:10:00Z", "stop"]);
});

test("watches until the command is gone; a success finishes the switch and restarts the app", async () => {
  const { sup, calls } = make();
  await sup.run();
  assert.equal(sup.getState().phase, "success");
  assert.deepEqual(calls.slice(0, 1), ["finish:/h/.slock"]);
  assert.equal(sup.getState().relaunching, true);
});

test("cancel sends SIGTERM to the marker's pid once; the rolled-back result is reported with its reason", async () => {
  const { sup, calls } = make({ readResult: async () => ({ result: "rolled_back", from: "/h/old", to: "/h/.slock", finishedAt: "x", startedAt: "2026-10-10T00:00:05Z", error: null, reason: "cancelled" }) });
  assert.equal(sup.cancel().cancelRequested, true);
  sup.cancel();
  await sup.run();
  assert.deepEqual(calls.filter((c) => c.startsWith("signal")), ["signal:4242:SIGTERM"]);
  const s = sup.getState();
  assert.deepEqual([s.phase, s.reason], ["rolled_back", "cancelled"]);
  sup.reset();
  assert.ok(calls.includes("relaunch"), "closing the result restarts the app so the normal launch decision runs");
});

test("a stale result from an earlier run is not mistaken for this one; no result at all is an error that restarts on close", async () => {
  const { sup, calls } = make({ readResult: async () => ({ result: "success", from: "/h/old", to: "/h/.slock", finishedAt: "x", startedAt: "2000-01-01T00:00:00Z", error: null, reason: null }) });
  await sup.run();
  assert.equal(sup.getState().phase, "error");
  assert.ok(!calls.some((c) => c.startsWith("finish")));
  sup.reset();
  assert.ok(calls.includes("relaunch"));
});

test("a failed finish after a success is an error that says the Computer already moved", async () => {
  const { sup } = make({ finish: async () => { throw new Error("EACCES"); } });
  await sup.run();
  assert.equal(sup.getState().phase, "error");
  assert.match(sup.getState().error ?? "", /moved to .*EACCES/);
});

test("progress follows the marker (step) while the command runs", async () => {
  const { sup, published } = make();
  await sup.run();
  assert.ok(published.length >= 2);
  assert.equal(sup.getState().steps[0]?.step, "start");
});

test("a marker without a deadline (older Computer) is watched but cannot be cancelled", () => {
  const { sup, calls } = make({ marker: marker({ deadlineAt: null }) });
  assert.equal(sup.getState().cancellable, false);
  assert.equal(sup.cancel().cancelRequested, false);
  assert.deepEqual(calls, []);
});
