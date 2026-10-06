// Task #5 (private deployment, phase 2): deployment-mode resolution
// semantics — one retry on failure, "unknown" after both attempts fail,
// page-lifetime caching once resolved.
import assert from "node:assert/strict";
import { test } from "node:test";

import { __resetDeploymentModeForTests, ensureDeploymentMode } from "../src/utils/deploymentMode";

const realFetch = globalThis.fetch;

test("retries exactly once, then resolves unknown when both attempts fail", async () => {
  __resetDeploymentModeForTests();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("offline");
  }) as typeof fetch;
  try {
    assert.equal(await ensureDeploymentMode(), "unknown");
    assert.equal(calls, 2, "exactly one retry");
    // "unknown" is terminal and cached — no third attempt.
    assert.equal(await ensureDeploymentMode(), "unknown");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("a transient failure recovers on the retry and is cached for the page lifetime", async () => {
  __resetDeploymentModeForTests();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("blip");
    return new Response(JSON.stringify({ deploymentMode: "private" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.equal(await ensureDeploymentMode(), "private");
    assert.equal(calls, 2);
    assert.equal(await ensureDeploymentMode(), "private");
    assert.equal(calls, 2, "resolved mode is cached — no further fetches");
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("a malformed or non-OK response resolves unknown rather than guessing", async () => {
  __resetDeploymentModeForTests();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ deploymentMode: "weird" }), { status: 200 })) as typeof fetch;
  try {
    assert.equal(await ensureDeploymentMode(), "unknown");
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});
