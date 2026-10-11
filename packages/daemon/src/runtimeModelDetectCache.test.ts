import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";
import { DaemonCore } from "./core.js";

async function makeCore(): Promise<DaemonCore> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-model-detect-test-"));
  return new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
  });
}

function detectJoin(core: DaemonCore) {
  return (core as unknown as {
    detectRuntimeModelJoined: (
      runtime: string,
      refresh: boolean | undefined,
      startDetection: () => Promise<RuntimeModelSourceOutcome>,
    ) => Promise<RuntimeModelSourceOutcome>;
  }).detectRuntimeModelJoined.bind(core);
}

function liveOutcome(id: string): RuntimeModelSourceOutcome {
  return {
    kind: "live",
    value: { models: [{ id, label: id }], default: id },
  };
}

function deferredStart(counter: { calls: number }, outcome: () => RuntimeModelSourceOutcome) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    start: () => {
      counter.calls += 1;
      return gate.then(outcome);
    },
  };
}

test("concurrent model detections for one runtime join a single detection", async () => {
  const core = await makeCore();
  const detect = detectJoin(core);
  const counter = { calls: 0 };
  const { release, start } = deferredStart(counter, () => liveOutcome("m1"));

  const first = detect("claude", undefined, start);
  const second = detect("claude", undefined, start);
  release();
  assert.deepEqual(await Promise.all([first, second]), [liveOutcome("m1"), liveOutcome("m1")]);
  assert.equal(counter.calls, 1, "both requests must join one detection");
});

test("a completed detection is served from the 5-minute cache without re-running", async () => {
  const core = await makeCore();
  const detect = detectJoin(core);
  const counter = { calls: 0 };
  const run = () => {
    counter.calls += 1;
    return Promise.resolve(liveOutcome(`m${counter.calls}`));
  };

  assert.deepEqual(await detect("claude", undefined, run), liveOutcome("m1"));
  assert.deepEqual(await detect("claude", undefined, run), liveOutcome("m1"));
  assert.equal(counter.calls, 1, "the second request must be served from the cache");
});

test("refresh bypasses both the in-flight join and the completed cache", async () => {
  const core = await makeCore();
  const detect = detectJoin(core);
  const counter = { calls: 0 };
  const run = () => {
    counter.calls += 1;
    return Promise.resolve(liveOutcome(`m${counter.calls}`));
  };

  await detect("claude", undefined, run);
  assert.deepEqual(await detect("claude", true, run), liveOutcome("m2"));
  assert.equal(counter.calls, 2, "refresh must re-run the detection");
});

test("an error outcome is not cached, so the next request retries", async () => {
  const core = await makeCore();
  const detect = detectJoin(core);
  const counter = { calls: 0 };
  const run = (): Promise<RuntimeModelSourceOutcome> => {
    counter.calls += 1;
    return Promise.resolve(counter.calls === 1
      ? { kind: "error", retryable: true }
      : liveOutcome("m-ok"));
  };

  assert.deepEqual(await detect("claude", undefined, run), { kind: "error", retryable: true });
  assert.deepEqual(await detect("claude", undefined, run), liveOutcome("m-ok"));
  assert.equal(counter.calls, 2, "a transient error must not poison the cache");
});

test("a failed detection releases the in-flight slot so the next request retries", async () => {
  const core = await makeCore();
  const detect = detectJoin(core);
  const counter = { calls: 0 };
  const run = () => {
    counter.calls += 1;
    return counter.calls === 1
      ? Promise.reject(new Error("spawn failed"))
      : Promise.resolve(liveOutcome("m-after"));
  };

  await assert.rejects(detect("claude", undefined, run), /spawn failed/);
  assert.deepEqual(await detect("claude", undefined, run), liveOutcome("m-after"));
  assert.equal(counter.calls, 2, "the in-flight slot must be released after a rejection");
});
