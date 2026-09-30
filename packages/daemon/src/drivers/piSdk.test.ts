import assert from "node:assert/strict";
import { test } from "vitest";
import { PI_SDK_VERSION, loadPiSdk, loadedPiSdk, requireLoadedPiSdk } from "./piSdk.js";

test("PI_SDK_VERSION matches the installed pi SDK (bump it with the dependency)", async () => {
  const { codingAgent } = await loadPiSdk();
  assert.equal(PI_SDK_VERSION, codingAgent.VERSION);
});

test("loadPiSdk loads the SDK once and exposes it to code that runs inside a pi session", async () => {
  const first = await loadPiSdk();
  const second = await loadPiSdk();
  assert.equal(second, first, "one shared load, not one per launch");
  assert.equal(loadedPiSdk(), first);
  assert.equal(requireLoadedPiSdk(), first);
  assert.equal(typeof first.codingAgent.createAgentSessionServices, "function");
  assert.equal(typeof first.ai.isContextOverflow, "function");
});
