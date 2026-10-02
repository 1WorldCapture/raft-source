import assert from "node:assert/strict";
import { test } from "vitest";
import { getLatestComputerVersion, resolveComputerUpgradeAvailable, __resetLatestComputerVersionForTest } from "./computerVersionService.js";
import {
  RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  RAFT_COMPUTER_PINNED_VERSION_ENV,
  RAFT_COMPUTER_RELEASE_BACKEND_ENV,
  RAFT_COMPUTER_RELEASE_BASE_ENV,
  RAFT_PUBLIC_ORIGIN_ENV,
} from "../config/computerDeploymentConfig.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const DEPLOYMENT_ENV_KEYS = [
  RAFT_PUBLIC_ORIGIN_ENV,
  RAFT_COMPUTER_RELEASE_BASE_ENV,
  RAFT_COMPUTER_RELEASE_BACKEND_ENV,
  RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  RAFT_COMPUTER_PINNED_VERSION_ENV,
] as const;

/** Install exactly the given deployment config around a callback. */
async function withDeploymentEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of DEPLOYMENT_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const key of DEPLOYMENT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const MANIFEST_ENV = {
  [RAFT_PUBLIC_ORIGIN_ENV]: "https://raft.example.com",
  [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://raft.example.com/computer",
  [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "manifest",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("manifest backend resolves latest from the configured release root, never the official CDN", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return jsonResponse(200, { version: "1.0.30" });
  }) as typeof fetch;

  try {
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), null); // cold: unknown, refresh started
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });
    assert.deepEqual(fetchCalls, ["https://raft.example.com/computer/manifest.json"]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("hands backend resolves latest through the configured Hands authority and channel", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return jsonResponse(200, { build: { version: "1.0.31" }, notes: "mentions 9.9.9 to bait naive parsing" });
  }) as typeof fetch;

  try {
    await withDeploymentEnv({
      ...MANIFEST_ENV,
      [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "hands",
      [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
    }, async () => {
      assert.equal(await getLatestComputerVersion(), null);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.31"); // build.version, not notes
    });
    assert.deepEqual(fetchCalls, [
      "https://hands.internal/public/v2/apps/raft-computer-cli/latest?channel=main",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a deployment pin IS the target version — no network lookup at all", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return jsonResponse(200, { version: "9.9.9" });
  }) as typeof fetch;

  try {
    await withDeploymentEnv({
      ...MANIFEST_ENV,
      [RAFT_COMPUTER_PINNED_VERSION_ENV]: "1.0.25",
    }, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.25");
      assert.equal(await getLatestComputerVersion(), "1.0.25");
    });
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("missing or invalid deployment config answers unknown and never consults any source", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return jsonResponse(200, { version: "9.9.9" });
  }) as typeof fetch;

  try {
    await withDeploymentEnv({}, async () => {
      assert.equal(await getLatestComputerVersion(), null);
    });
    await withDeploymentEnv({ [RAFT_PUBLIC_ORIGIN_ENV]: "https://user:pass@raft.example.com" }, async () => {
      assert.equal(await getLatestComputerVersion(), null);
    });
    assert.equal(fetchCount, 0, "no official-CDN fallback exists for a misconfigured deployment");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a config identity change drops the previous source's cached version", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    const base = url.includes("other.example.com") ? "1.0.40" : "1.0.30";
    return jsonResponse(200, { version: base });
  }) as typeof fetch;

  try {
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });
    await withDeploymentEnv({
      ...MANIFEST_ENV,
      [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://other.example.com/computer",
    }, async () => {
      // Identity changed → the old cached value must not leak through.
      assert.equal(await getLatestComputerVersion(), null);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.40");
    });
    assert.equal(fetchCalls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("network failures keep the last value under the SAME identity only", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, { version: "1.0.30" })) as typeof fetch;

  try {
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });

    // Same identity, failing network: the cached value survives (best-effort
    // refresh, never an "already latest" claim from a failure).
    __resetLatestComputerVersionForTest();
    globalThis.fetch = (async () => jsonResponse(200, { version: "1.0.31" })) as typeof fetch;
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
    });

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    // Force expiry of the refresh window without breaking the cached value.
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.31");
    });
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("resolveComputerUpgradeAvailable: server asserts available/up-to-date/unknown states", () => {
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", "0.0.62"), true);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "0.0.62"), false);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.63", "0.0.62"), false);

  assert.equal(resolveComputerUpgradeAvailable(false, "0.0.61", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, null, "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.61", null), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62-rc1", "0.0.62"), null);
  assert.equal(resolveComputerUpgradeAvailable(true, "0.0.62", "latest"), null);
});
