// Task #5/#6 (private deployment, phase 2): deployment-info resolution
// semantics — one retry on failure, "unknown" after both attempts fail,
// page-lifetime caching once resolved, and the private downloads payload.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __resetDeploymentModeForTests,
  ensureDeploymentMode,
  parseDesktopDownloads,
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

// D3 regression guard (task #13 acceptance): parseDeploymentInfo used to
// declare DeploymentDownloads["desktop"] in the type but never parse the
// field, so the settings download section could never render on a private
// deployment even with a correct server payload.
test("private responses keep the desktop installer block when its dmg links are usable", async () => {
  __resetDeploymentModeForTests();
  // Under --dom the module-level API-origin fallback is jsdom's
  // http://localhost:3000, and same-origin with it is the acceptance rule —
  // so the stubbed payload must live on that origin. parseDesktopDownloads'
  // https-stack case is covered directly in the same-origin unit test below.
  const payload = {
    deploymentMode: "private",
    downloads: {
      computerBase: "http://localhost:3000/downloads/computer",
      desktop: {
        version: "0.1.10",
        dmg: {
          arm64: "http://localhost:3000/downloads/desktop/0.1.10/Raft-Desktop-0.1.10-arm64.dmg",
          x64: "http://localhost:3000/downloads/desktop/0.1.10/Raft-Desktop-0.1.10-x64.dmg",
        },
      },
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  try {
    const info = await ensureDeploymentMode();
    assert.deepEqual(info.downloads?.desktop, payload.downloads.desktop);
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("a non-http(s) desktop link drops only the desktop block, keeping the other downloads", async () => {
  __resetDeploymentModeForTests();
  const payload = {
    deploymentMode: "private",
    downloads: {
      computerBase: "https://raft.internal.example:18443/downloads/computer",
      desktop: {
        version: "0.1.10",
        dmg: {
          arm64: "javascript:alert(1)",
          x64: "https://raft.internal.example:18443/downloads/desktop/0.1.10/Raft-Desktop-0.1.10-x64.dmg",
        },
      },
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  try {
    const info = await ensureDeploymentMode();
    assert.equal(info.downloads?.computerBase, payload.downloads.computerBase);
    assert.equal(info.downloads?.desktop, undefined, "a non-http(s) link must drop the desktop block");
  } finally {
    globalThis.fetch = realFetch;
    __resetDeploymentModeForTests();
  }
});

test("parseDesktopDownloads enforces same-origin against a known api origin", () => {
  const downloads = {
    desktop: {
      version: "0.1.10",
      dmg: {
        arm64: "https://raft.internal.example:18443/downloads/desktop/0.1.10/arm64.dmg",
        x64: "https://cdn.example.net/downloads/desktop/0.1.10/x64.dmg",
      },
    },
  } as Record<string, unknown>;
  // Cross-origin x64 link against a known origin → the whole block drops.
  assert.equal(parseDesktopDownloads(downloads, "https://raft.internal.example:18443"), null);
  // Same-origin on both links → kept.
  const same = structuredClone(downloads);
  (same.desktop as { dmg: { x64: string } }).dmg.x64 =
    "https://raft.internal.example:18443/downloads/desktop/0.1.10/x64.dmg";
  assert.deepEqual(
    parseDesktopDownloads(same, "https://raft.internal.example:18443/"),
    (same as { desktop: { version: string; dmg: { arm64: string; x64: string } } }).desktop,
  );
  // Not a URL at all → dropped even with no origin to compare against.
  const junk = { desktop: { version: "1", dmg: { arm64: "not-a-url", x64: "https://ok.example/x.dmg" } } };
  assert.equal(parseDesktopDownloads(junk, ""), null);
  // Scheme follows the deployment: a plain-http intranet origin accepts
  // plain-http same-origin links (phase 3-1 http topology).
  const httpStack = { desktop: { version: "1", dmg: { arm64: "http://raft.internal:8080/d/arm64.dmg", x64: "http://raft.internal:8080/d/x64.dmg" } } };
  assert.ok(parseDesktopDownloads(httpStack, "http://raft.internal:8080/"));
  // Missing desktop field → null (the pre-D3 shape: nothing to render).
  assert.equal(parseDesktopDownloads({ computerBase: "https://x.example" }, ""), null);
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
