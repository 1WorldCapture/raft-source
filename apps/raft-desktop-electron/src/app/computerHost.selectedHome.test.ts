// The host's selected home (a restored deployment root) and the process env must agree: the Computer library resolves
// the home from RAFT_HOME/SLOCK_HOME at call time in several places.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";


test("restoring a selected deployment home pins RAFT_HOME/SLOCK_HOME of the process to it", async (t) => {
  const testHome = await mkdtemp(path.join(tmpdir(), "raft-host-selected-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));
  const storage = path.join(testHome, "computer-deployments");
  const deployment = path.join(storage, "computer-x");
  await mkdir(deployment, { recursive: true });
  await writeFile(path.join(storage, "selected-root.json"), JSON.stringify({ home: deployment, origin: "http://example.invalid" }));
  const savedRaft = process.env.RAFT_HOME;
  const savedSlock = process.env.SLOCK_HOME;
  t.after(() => { if (savedRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = savedRaft; if (savedSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = savedSlock; });
  process.env.RAFT_HOME = "/somewhere/else/.slock";
  process.env.SLOCK_HOME = "/somewhere/else/.slock";
  const api = { getStatus: async () => ({ servers: [], service: { running: false } }) };
  t.mock.module("electron", { namedExports: {
    app: {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {},
      getPath: () => testHome,
    },
  } });
  t.mock.module("./sessionOriginGuard.js", { namedExports: {
    checkSessionOrigin: async () => ({ status: "none", configuredOrigin: "https://example.invalid" }),
    describeSessionOriginMismatch: () => "",
    SESSION_ORIGIN_MISMATCH_CODE: "SESSION_ORIGIN_MISMATCH",
  } });
  t.mock.module("@botiverse/raft-computer/lib", { namedExports: {
    connectService: async () => { throw new Error("unused"); },
    convergeAppHostLifecycle: async () => ({ owner: "app", enabled: true, status: "converged", label: null, definitionPath: null, definition: null }),
    createComputerApi: () => api,
    readProcessStartTime: async () => null,
    rebindParentEvidence: async () => {},
    DEFAULT_UPGRADE_BASE_URL: "https://example.invalid/computer",
    // phase 3-1: the host archives foreign-origin attachments before attach.
    listServerAttachments: async () => [],
    serversDir: (home: string) => `${home}/computer/servers`,
    canonicalizeServerUrl: (url: string) => { try { return new URL(url).origin; } catch { return url; } },
    fetchCdnLatestVersion: async () => null,
    resolveRaftHome: () => testHome,
    userSessionPath: (home: string) => `${home}/user-session.json`,
  } });

  const { ComputerHost } = await import("./computerHost.ts");
  const host = new ComputerHost({ home: "/somewhere/else/.slock", configuredOrigin: "http://example.invalid", storageDirectory: storage, readProcesses: async () => ({ rootPids: [], rows: [] }) });
  await host.restoreSelection();
  assert.equal(host.slockHome, deployment);
  assert.deepEqual([process.env.RAFT_HOME, process.env.SLOCK_HOME], [deployment, deployment]);
});
