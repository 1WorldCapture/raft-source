// Task #5/#6 (private deployment, phase 2): deployment-info resolution
// semantics — one retry on failure, "unknown" after both attempts fail,
// page-lifetime caching once resolved, and the private downloads payload.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __resetDeploymentModeForTests,
  ensureDeploymentMode,
} from "../src/utils/deploymentMode";

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
    const info = await ensureDeploymentMode();
    assert.equal(info.deploymentMode, "private");
    assert.equal(info.downloads, undefined);
    assert.equal(calls, 2);
    assert.equal((await ensureDeploymentMode()).deploymentMode, "private");
    assert.equal(calls, 2, "resolved mode is cached — no further fetches");
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("private responses carry the server-rendered download URLs", async () => {
  __resetDeploymentModeForTests();
  const payload = {
    deploymentMode: "private",
    downloads: {
      computerBase: "https://raft.internal.example:18443/downloads/computer",
      cli: "https://raft.internal.example:18443/downloads/cli/raft-0.0.24.tgz",
      daemon: "https://raft.internal.example:18443/downloads/daemon/raft-daemon-1.0.25.tgz",
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  try {
    assert.deepEqual(await ensureDeploymentMode(), payload);
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
    const resolved = await ensureDeploymentMode();
    assert.equal(resolved, "unknown");
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("private without a usable downloads object still resolves the mode", async () => {
  __resetDeploymentModeForTests();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ deploymentMode: "private" }), { status: 200 })) as typeof fetch;
  try {
    const info = await ensureDeploymentMode();
    assert.equal(info.deploymentMode, "private");
    assert.equal(info.downloads, undefined);
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});
