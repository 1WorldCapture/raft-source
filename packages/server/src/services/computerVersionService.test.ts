import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getLatestComputerVersion,
  resolveComputerUpgradeAvailable,
  __resetLatestComputerVersionForTest,
  __setLatestComputerFetchDeadlineForTest,
  __setLatestComputerRefreshIntervalForTest,
} from "./computerVersionService.js";
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

test("a late response from a previous source never overwrites the new source's cache", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  // Identity A's fetch hangs until released; identity B resolves immediately.
  const hungA = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return url.includes("other.example.com")
      ? jsonResponse(200, { version: "2.0.0" })
      : hungA.promise;
  }) as typeof fetch;

  const B_ENV = {
    ...MANIFEST_ENV,
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://other.example.com/computer",
  };

  try {
    // Start a refresh under identity A (its fetch never settles yet).
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
    });
    // Switch identity: B resolves and caches 2.0.0.
    await withDeploymentEnv(B_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "2.0.0");
    });
    const callsAfterBCached = fetchCalls.length;

    // A's response finally arrives — with a stale version. It must NOT
    // overwrite B's cached value, and the next B read must neither degrade
    // to unknown nor fire another fetch.
    hungA.resolve(jsonResponse(200, { version: "1.0.0" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await withDeploymentEnv(B_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "2.0.0");
    });
    assert.equal(fetchCalls.length, callsAfterBCached, "late stale response must not cause re-fetch churn");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("an older request finishing before the newer one must not break coalescing", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const hungA = deferred<Response>();
  const hungB = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return url.includes("other.example.com") ? hungB.promise : hungA.promise;
  }) as typeof fetch;

  const B_ENV = {
    ...MANIFEST_ENV,
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://other.example.com/computer",
  };

  try {
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
    });
    // B starts while A is still in flight.
    await withDeploymentEnv(B_ENV, async () => {
      await getLatestComputerVersion();
    });
    assert.equal(fetchCalls.length, 2);

    // A finishes FIRST. Its finally must not clear B's in-flight marker: a
    // second B read while B is still in flight must coalesce onto B's own
    // promise instead of starting a duplicate fetch.
    hungA.resolve(jsonResponse(200, { version: "1.0.0" }));
    await new Promise((resolve) => setImmediate(resolve));

    await withDeploymentEnv(B_ENV, async () => {
      await getLatestComputerVersion();
    });
    assert.equal(fetchCalls.length, 2, "B's in-flight refresh must survive A finishing");

    hungB.resolve(jsonResponse(200, { version: "2.0.0" }));
    await new Promise((resolve) => setImmediate(resolve));
    await withDeploymentEnv(B_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "2.0.0");
    });
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a hanging upstream times out, releases the refresh slot, and keeps the same-identity cache", async () => {
  __resetLatestComputerVersionForTest();
  __setLatestComputerFetchDeadlineForTest(30);
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  // Seed a cached value first.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return jsonResponse(200, { version: "1.0.30" });
  }) as typeof fetch;
  await withDeploymentEnv(MANIFEST_ENV, async () => {
    await getLatestComputerVersion();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await getLatestComputerVersion(), "1.0.30");
  });

  // Expire immediately and hang every fetch: the deadline must fire, the
  // cached same-identity value must survive, and the refresh slot must free
  // up so the next call retries rather than coalescing onto the hung request.
  __setLatestComputerRefreshIntervalForTest(0);
  let hang = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    if (!hang) return jsonResponse(200, { version: "1.0.31" });
    // A stuck upstream that only settles when aborted, like a real fetch
    // whose AbortSignal fires — not a promise that ignores the deadline.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as typeof fetch;

  try {
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.30"); // cached value still served
      await new Promise((resolve) => setTimeout(resolve, 80)); // let the deadline fire
      assert.equal(await getLatestComputerVersion(), "1.0.30"); // still cached, slot released
    });
    assert.ok(fetchCalls.length >= 2, "a retry must have been possible after the deadline");

    // Recovery: wait out any in-flight hung refresh, then let the upstream
    // answer again — the next refresh must succeed.
    await new Promise((resolve) => setTimeout(resolve, 80));
    hang = false;
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.31");
    });
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("switching back to a cached identity retires another identity's in-flight request", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  // A resolves immediately (caches 1.0.30); B hangs until released.
  const hungB = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return url.includes("other.example.com")
      ? hungB.promise
      : jsonResponse(200, { version: "1.0.30" });
  }) as typeof fetch;

  const B_ENV = {
    ...MANIFEST_ENV,
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://other.example.com/computer",
  };

  try {
    // A caches 1.0.30.
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      await getLatestComputerVersion();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });
    // B's refresh starts and hangs.
    await withDeploymentEnv(B_ENV, async () => {
      await getLatestComputerVersion();
    });
    assert.equal(fetchCalls.length, 2);

    // Switch BACK to A: this read only hits A's cache, but it must still
    // retire B's in-flight request — otherwise B's late response would
    // overwrite the cache A's reader just relied on.
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });
    const callsAfterACacheHit = fetchCalls.length;
    assert.equal(callsAfterACacheHit, 2, "a cache hit must not start a fetch");

    hungB.resolve(jsonResponse(200, { version: "2.0.0" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.30");
    });
    assert.equal(fetchCalls.length, callsAfterACacheHit, "late B response must not evict A's cache or re-fetch");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a genuinely expired cache keeps its value when the failing refresh throws", async () => {
  __resetLatestComputerVersionForTest();
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return jsonResponse(200, { version: "1.0.31" });
  }) as typeof fetch;
  await withDeploymentEnv(MANIFEST_ENV, async () => {
    await getLatestComputerVersion();
    await new Promise((resolve) => setImmediate(resolve));
  });

  try {
    // Expire the cache window immediately and make fetch itself throw: the
    // failing refresh MUST actually run (count its stub calls), and once it
    // completes the same-identity cached value must survive the failure.
    __setLatestComputerRefreshIntervalForTest(0);
    let failingFetchCalls = 0;
    globalThis.fetch = (async () => {
      failingFetchCalls += 1;
      throw new Error("network down");
    }) as typeof fetch;
    await withDeploymentEnv(MANIFEST_ENV, async () => {
      assert.equal(await getLatestComputerVersion(), "1.0.31");
      // Let the failing refresh actually run to completion before judging
      // the cached value's survival.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await getLatestComputerVersion(), "1.0.31");
    });
    assert.ok(failingFetchCalls >= 1, "the failing refresh path must have been exercised");
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
