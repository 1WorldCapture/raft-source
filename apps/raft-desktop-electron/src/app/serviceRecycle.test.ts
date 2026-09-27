// Pure orchestrator tests for the local-service recycle (stop → confirm
// cleared → start): the ordering and every failure branch, with injected
// effects only — no electron, no live service. The failure CODES matter as
// much as the control flow: the renderer branches on them (a failed start
// leaves the machine stopped, so its retry must be start-only).
import assert from "node:assert/strict";
import test from "node:test";

import { reduceConvergeFailure } from "./convergeState.ts";
import {
  DEFAULT_CLEAR_POLL_MS,
  RECYCLE_START_FAILED,
  RECYCLE_STOP_FAILED,
  runServiceRecycle,
  type RecycleDeps,
} from "./serviceRecycle.ts";

interface ScriptedRecycle {
  calls: string[];
  settled: unknown[];
  deps: RecycleDeps;
}

function scripted(overrides: Partial<Record<"stop" | "start", Error>> & { clearedAfter?: number }): ScriptedRecycle {
  const calls: string[] = [];
  const settled: unknown[] = [];
  let polls = 0;
  const deps: RecycleDeps = {
    stop: async () => {
      calls.push("stop");
      if (overrides.stop) throw overrides.stop;
    },
    start: async () => {
      calls.push("start");
      if (overrides.start) throw overrides.start;
    },
    isCleared: async () => {
      calls.push("isCleared");
      polls += 1;
      return polls >= (overrides.clearedAfter ?? 1);
    },
    delay: async () => {
      calls.push("delay");
    },
    settle: (state) => {
      settled.push(state);
    },
  };
  return { calls, settled, deps };
}

test("happy path: stop, confirm cleared, start, settle ok", async () => {
  const s = scripted({});
  await runServiceRecycle(s.deps);
  assert.deepEqual(s.calls, ["stop", "isCleared", "start"]);
  assert.deepEqual(s.settled, [{ ok: true }]);
});

test("polls with the default cadence until the service is confirmed gone", async () => {
  const s = scripted({ clearedAfter: 3 });
  await runServiceRecycle(s.deps);
  assert.deepEqual(s.calls, ["stop", "isCleared", "delay", "isCleared", "delay", "isCleared", "start"]);
});

test("stop failure surfaces RECYCLE_STOP_FAILED and never starts", async () => {
  const s = scripted({ stop: Object.assign(new Error("lock held"), { code: "SERVICE_BUSY" }) });
  await assert.rejects(runServiceRecycle(s.deps), (error: { code?: string }) => error.code === RECYCLE_STOP_FAILED);
  assert.deepEqual(s.calls, ["stop"]);
  const state = s.settled[0] as { ok: boolean; code: string; message: string };
  assert.equal(state.ok, false);
  assert.equal(state.code, RECYCLE_STOP_FAILED);
  assert.match(state.message, /left as-is/);
});

test("clear-timeout surfaces RECYCLE_STOP_FAILED, force-kills nothing, never starts", async () => {
  const s = scripted({ clearedAfter: Number.POSITIVE_INFINITY });
  let timedOut = false;
  s.deps.onTimeout = () => {
    timedOut = true;
  };
  await assert.rejects(
    runServiceRecycle(s.deps, { clearPollMs: 1, clearTimeoutMs: 5 }),
    (error: { code?: string }) => error.code === RECYCLE_STOP_FAILED,
  );
  assert.equal(timedOut, true);
  assert.ok(!s.calls.includes("start"), "must not start a successor while the old service lingers");
  const state = s.settled[0] as { code: string; message: string };
  assert.equal(state.code, RECYCLE_STOP_FAILED);
  assert.match(state.message, /did not fully exit/);
});

test("start failure surfaces RECYCLE_START_FAILED (machine stopped — retry must be start-only)", async () => {
  const s = scripted({ start: Object.assign(new Error("spawn failed"), { code: "SUPERVISOR_SPAWN_FAILED" }) });
  await assert.rejects(runServiceRecycle(s.deps), (error: { code?: string }) => error.code === RECYCLE_START_FAILED);
  assert.deepEqual(s.calls, ["stop", "isCleared", "start"]);
  const state = s.settled[0] as { ok: boolean; code: string; message: string };
  assert.equal(state.ok, false);
  assert.equal(state.code, RECYCLE_START_FAILED);
  assert.match(state.message, /no second stop/);
});

test("reduceConvergeFailure keeps ComputerServiceError codes and collapses the rest", () => {
  const kept = reduceConvergeFailure("prefix: ", Object.assign(new Error("boom"), { code: "SERVICE_VERSION_SKEW" }));
  assert.deepEqual(kept, { code: "SERVICE_VERSION_SKEW", message: "prefix: boom" });
  const collapsed = reduceConvergeFailure("prefix: ", new Error("plain"));
  assert.equal(collapsed.code, "CONVERGE_FAILED");
  const stringy = reduceConvergeFailure("prefix: ", "not an error");
  assert.equal(stringy.code, "CONVERGE_FAILED");
  assert.equal(stringy.message, "prefix: not an error");
});

test("defaults exist and are sane", () => {
  assert.ok(DEFAULT_CLEAR_POLL_MS > 0 && DEFAULT_CLEAR_POLL_MS <= 1000);
});
