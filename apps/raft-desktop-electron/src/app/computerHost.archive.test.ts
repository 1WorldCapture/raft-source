// Phase 3-1: the host's deployment-origin behaviors.
//  - enable() archives foreign-origin attachments (out of `servers/`) before
//    attaching, keeping the one-home-one-origin invariant the upgrade source
//    resolution fails closed on — and never touches same-origin ones.
//  - upgrade checks read the official CDN for official origins and the
//    deployment's own /downloads/computer tree for private ones (no official
//    egress from a private desktop).
//
// One top-level test with mock-registry-friendly subtests: node's module
// mocks bind at first import (see computerHost.convergeState.test.ts), so
// the lib mock exposes mutable scenario knobs instead of re-mocking per
// subtest.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OFFICIAL_ORIGIN = "https://api.raft.build";
const PRIVATE_ORIGIN = "https://raft.internal.example:8443";
const OFFICIAL_CDN = "https://cdn.raft.build/computer";

interface AttachmentFixture {
  serverId: string;
  serverUrl: string;
}

async function writeAttachment(home: string, fixture: AttachmentFixture): Promise<void> {
  const dir = path.join(home, "computer", "servers", fixture.serverId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "server.json"),
    JSON.stringify({
      kind: "computer-attachment",
      serverId: fixture.serverId,
      serverUrl: fixture.serverUrl,
      apiKey: "test-key",
      serverMachineId: "m-1",
    }),
  );
}

test("host deployment-origin behaviors (archive + upgrade base)", async (t) => {
  const testHome = await mkdtemp(path.join(tmpdir(), "raft-host-archive-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));

  // ── scenario knobs (mutated by each subtest before building a host) ──
  let currentHome = testHome;
  const upgradeBases: string[] = [];
  const attachCalls: unknown[] = [];

  t.mock.module("electron", { namedExports: {
    app: { getPath: () => testHome, getLoginItemSettings: () => ({ openAtLogin: false }) },
  } });
  t.mock.module("./sessionOriginGuard.js", { namedExports: {
    checkSessionOrigin: async () => ({ status: "none", configuredOrigin: PRIVATE_ORIGIN }),
    describeSessionOriginMismatch: () => "",
    SESSION_ORIGIN_MISMATCH_CODE: "SESSION_ORIGIN_MISMATCH",
  } });
  // listServerAttachments reads the REAL fixture layout under currentHome —
  // that one call needs fidelity; everything else stays stubbed.
  t.mock.module("@botiverse/raft-computer/lib", { namedExports: {
    connectService: async () => { throw new Error("unused"); },
    convergeAppHostLifecycle: async () => ({ owner: "app", enabled: false, status: "converged", label: null, definitionPath: null, definition: null }),
    createComputerApi: () => ({
      getStatus: async () => ({ service: { running: false }, servers: [] }),
      attach: async (input: unknown) => { attachCalls.push(input); return { serverId: "new-server" }; },
      start: async () => {},
      stop: async () => {},
      tryUpgradeViaService: async () => ({ routed: true }),
    }),
    readProcessStartTime: async () => null,
    rebindParentEvidence: async () => {},
    DEFAULT_UPGRADE_BASE_URL: OFFICIAL_CDN,
    fetchCdnLatestVersion: async (baseUrl: string) => { upgradeBases.push(baseUrl); return "9.9.9"; },
    resolveRaftHome: () => testHome,
    userSessionPath: (home: string) => `${home}/user-session.json`,
    listServerAttachments: async (home: string) => {
      const serversRoot = path.join(home, "computer", "servers");
      if (!existsSync(serversRoot)) return [];
      const out: Array<{ serverId: string; serverUrl: string }> = [];
      for (const name of await readdir(serversRoot)) {
        const raw = JSON.parse(await readFile(path.join(serversRoot, name, "server.json"), "utf8"));
        out.push({ serverId: raw.serverId, serverUrl: raw.serverUrl });
      }
      return out;
    },
    serversDir: (home: string) => path.join(home, "computer", "servers"),
    canonicalizeServerUrl: (url: string) => { try { return new URL(url).origin; } catch { return url; } },
  } });

  const { ComputerHost } = await import("./computerHost.ts");

  async function makeHost(configuredOrigin: string, home = currentHome) {
    return new ComputerHost({
      home,
      configuredOrigin,
      readProcesses: async () => ({ rootPids: [], rows: [] }),
      storageDirectory: path.join(testHome, "deployments"),
    });
  }

  await t.test("enable() archives only foreign-origin attachments", async () => {
    await writeAttachment(currentHome, { serverId: "official-one", serverUrl: OFFICIAL_ORIGIN });
    await writeAttachment(currentHome, { serverId: "private-kept", serverUrl: `${PRIVATE_ORIGIN}/` });
    const host = await makeHost(PRIVATE_ORIGIN);

    await host.enable({
      serverSlug: "acme",
      serverUrl: PRIVATE_ORIGIN,
      accessToken: "at",
      refreshToken: "rt",
    });

    // The attach went to the configured origin.
    assert.equal((attachCalls.at(-1) as { serverUrl?: string }).serverUrl, PRIVATE_ORIGIN);

    const serversRoot = path.join(currentHome, "computer", "servers");
    assert.deepEqual((await readdir(serversRoot)).sort(), ["private-kept"]);

    // The official attachment was archived, not deleted — bytes intact.
    const computerRoot = path.join(currentHome, "computer");
    const retired = (await readdir(computerRoot)).filter((name) => name.startsWith("servers-retired-"));
    assert.equal(retired.length, 1);
    const archived = JSON.parse(await readFile(path.join(computerRoot, retired[0]!, "official-one", "server.json"), "utf8"));
    assert.equal(archived.serverUrl, OFFICIAL_ORIGIN);
  });

  await t.test("enable() with only same-origin attachments archives nothing", async () => {
    const host = await makeHost(PRIVATE_ORIGIN);
    await host.enable({
      serverSlug: "acme",
      serverUrl: PRIVATE_ORIGIN,
      accessToken: "at",
      refreshToken: "rt",
    });
    const computerRoot = path.join(currentHome, "computer");
    assert.deepEqual((await readdir(computerRoot)).filter((n) => n.startsWith("servers-retired-")).length, 1); // only the earlier batch
    assert.deepEqual((await readdir(path.join(computerRoot, "servers"))).sort(), ["private-kept"]);
  });

  await t.test("upgrade checks read the official CDN for official origins", async () => {
    upgradeBases.length = 0;
    const host = await makeHost(OFFICIAL_ORIGIN);
    assert.deepEqual(await host.getUpgradeInfo(), { latestVersion: "9.9.9" });
    assert.deepEqual(upgradeBases, [OFFICIAL_CDN]);
  });

  await t.test("upgrade checks read the deployment's own downloads tree for private origins", async () => {
    upgradeBases.length = 0;
    const host = await makeHost(PRIVATE_ORIGIN);
    assert.deepEqual(await host.getUpgradeInfo(), { latestVersion: "9.9.9" });
    assert.deepEqual(upgradeBases, [`${PRIVATE_ORIGIN}/downloads/computer`]);
  });
});
