// Regression: the K download/verify FACTORY consumes the runtime release
// source (PR #132 review P1). After persisting a private source, the default
// construction inside createComputerUpgrader — the one path every upgrade,
// rollback, recovery and reconcile entry point funnels through — must resolve
// releases ONLY from that source: no official Hands query, no official CDN
// download, across restarts (fresh factory from the persisted file) and for
// explicit pinned versions. A corrupt persisted file fails the factory
// loudly instead of silently degrading to the official default.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import type { HandsUpdater } from "@botiverse/hands-node/updater";
import { createUpgrader } from "@botiverse/k-carrier";
import type { Release, ReleaseSource, Upgrader } from "@botiverse/k-carrier";
import { createComputerUpgrader } from "./kUpgrader.js";
import { initializeReleaseSource, releaseSourcePath } from "./lib/releaseSource.js";
import { withHermeticHome } from "./test/hermeticAssertions.js";
import { HANDS_API_ORIGIN } from "./releaseAuthority.js";

const CTX = { currentVersion: "0.0.0", platformKey: "linux-x64" };

/** Record every outbound fetch URL and forward to the real network stack. */
function recordFetch(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return original(input, init);
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

interface CapturedSource {
  source: ReleaseSource;
}

/** Capture the source K would download through, without building a real upgrader. */
function captureUpgraderConfig(): { captured: CapturedSource; fn: typeof createUpgrader } {
  const captured: CapturedSource = { source: undefined as unknown as ReleaseSource };
  const fn = ((config: { source: ReleaseSource }) => {
    captured.source = config.source;
    return undefined as unknown as Upgrader;
  }) as typeof createUpgrader;
  return { captured, fn };
}

async function withLoopbackServer(
  handler: (url: string) => { status: number; body: string } | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const answer = handler(req.url ?? "/");
    if (!answer) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}/computer`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const LATEST_MANIFEST = JSON.stringify({ version: "1.0.1" });
const VERSION_MANIFEST = JSON.stringify({
  targets: {
    "linux-x64": { file: "raft-computer-linux-x64", sha256: "ab".repeat(32), size: 1234 },
  },
});

test("restart keeps the factory on the persisted manifest source: real HTTP, zero official queries", async () => {
  await withHermeticHome(async (home) => {
    await withLoopbackServer((url) => {
      if (url === "/computer/manifest.json") return { status: 200, body: LATEST_MANIFEST };
      if (url === "/computer/1.0.1/manifest.json") return { status: 200, body: VERSION_MANIFEST };
      return undefined;
    }, async (base) => {
      // A previous install persisted the private source; this process starts
      // fresh with a clean env — only the file remains.
      await initializeReleaseSource(home, {
        schemaVersion: 1,
        backend: "manifest",
        releaseBase: base,
      }, "test");

      const { captured, fn } = captureUpgraderConfig();
      const recorder = recordFetch();
      try {
        createComputerUpgrader(home, { createUpgraderFn: fn });

        const latest = await captured.source.checkForUpdate({ ...CTX });
        assert.ok(latest, "a newer private pointer must resolve to a release");
        assert.equal(latest.version, "1.0.1");
        assert.ok(latest.url.startsWith(base), `download url must stay on ${base}: ${latest.url}`);

        const explicit = await captured.source.fetchRelease("1.0.1", { ...CTX });
        assert.equal(explicit.version, "1.0.1");
        assert.ok(explicit.url.startsWith(base), `pinned download url must stay on ${base}: ${explicit.url}`);

        // The teeth: every single outbound request hit the persisted private
        // base — no Hands query, no official CDN download, not even a probe.
        assert.ok(recorder.urls.length >= 3, "expected the real HTTP exchange to happen");
        for (const url of recorder.urls) {
          assert.ok(
            url.startsWith(base),
            `official-source leak: fetch to ${url} while the persisted source is ${base}`,
          );
        }
      } finally {
        recorder.restore();
      }
    });
  });
});

test("persisted hands source hands K the private Hands origin", async () => {
  await withHermeticHome(async (home) => {
    const origins: string[] = [];
    const { captured, fn } = captureUpgraderConfig();
    await initializeReleaseSource(home, {
      schemaVersion: 1,
      backend: "hands",
      releaseBase: "https://files.private.example/computer",
      handsOrigin: "https://hands.private.example",
    }, "test");

    createComputerUpgrader(home, {
      createUpgraderFn: fn,
      releaseSourceDeps: {
        createHandsUpdaterFn: (options) => {
          origins.push(options.apiOrigin);
          return {
            checkUpdate: async () => ({ kind: "up_to_date" }),
          } as unknown as HandsUpdater;
        },
        getHandsDeviceIdFn: async () => "123e4567-e89b-4d3a-a456-426614174000",
        channelProvider: () => "latest",
      },
    });

    assert.deepEqual(origins, ["https://hands.private.example"], "Hands updater must be built on the persisted private origin");
    assert.notEqual(origins[0], HANDS_API_ORIGIN, "must not silently use the official Hands origin");

    const result = await captured.source.checkForUpdate({ ...CTX });
    assert.equal(result, null, "up_to_date stub maps to null");
  });
});

test("a corrupt persisted release source fails the factory before any fetch", async () => {
  await withHermeticHome(async (home) => {
    await mkdir(path.dirname(releaseSourcePath(home)), { recursive: true });
    await writeFile(releaseSourcePath(home), "{ not json", "utf8");
    const recorder = recordFetch();
    const { fn } = captureUpgraderConfig();
    try {
      assert.throws(
        () => createComputerUpgrader(home, { createUpgraderFn: fn }),
        (error: unknown) => (error as { code?: string }).code === "RELEASE_SOURCE_CORRUPT",
        "corrupt state must fail loudly, never fall back to the official default",
      );
      assert.equal(recorder.urls.length, 0, "no network may happen for a corrupt source");
    } finally {
      recorder.restore();
    }
  });
});

test("a validated env group overrides the persisted file for the factory source", async () => {
  await withHermeticHome(async (home) => {
    await withLoopbackServer((url) => {
      if (url === "/computer/manifest.json") return { status: 200, body: JSON.stringify({ version: "2.0.0" }) };
      if (url === "/computer/2.0.0/manifest.json") return { status: 200, body: VERSION_MANIFEST };
      return undefined;
    }, async (envBase) => {
      // The persisted file points somewhere else; the env group must win.
      await initializeReleaseSource(home, {
        schemaVersion: 1,
        backend: "manifest",
        releaseBase: "https://persisted.example/computer",
      }, "test");

      const previous = { ...process.env } as Record<string, string | undefined>;
      process.env.RAFT_COMPUTER_RELEASE_BASE = envBase;
      process.env.RAFT_COMPUTER_RELEASE_BACKEND = "manifest";
      const recorder = recordFetch();
      const { captured, fn } = captureUpgraderConfig();
      try {
        createComputerUpgrader(home, { createUpgraderFn: fn });
        const latest: Release | null = await captured.source.checkForUpdate({ ...CTX });
        assert.equal(latest?.version, "2.0.0");
        assert.ok(latest!.url.startsWith(envBase));
        for (const url of recorder.urls) {
          assert.ok(url.startsWith(envBase), `env group must win over the persisted file: ${url}`);
        }
      } finally {
        recorder.restore();
        for (const key of Object.keys(previous)) {
          if (previous[key] === undefined) delete process.env[key];
          else (process.env as Record<string, string | undefined>)[key] = previous[key];
        }
      }
    });
  });
});
