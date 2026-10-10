// A restored deployment home too deep for the service socket (103 bytes) is reached through the ~/.slock-raft alias that
// points at it; with no such alias the host refuses control operations with a clear error instead of failing to bind.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";



test("a deployment home that is too deep for the service socket: alias used when it points at it; otherwise a clear error", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "rh-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fakeHome = path.join(base, "u");
  await mkdir(fakeHome, { recursive: true });
  const savedHome = process.env.HOME;
  const savedRaft = process.env.RAFT_HOME;
  const savedSlock = process.env.SLOCK_HOME;
  t.after(() => { process.env.HOME = savedHome; if (savedRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = savedRaft; if (savedSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = savedSlock; });
  process.env.HOME = fakeHome; // os.homedir() follows HOME on POSIX
  const storage = path.join(base, "Application Support-with-a-deliberately-long-folder-name", "computer-deployments");
  const deployment = path.join(storage, "computer-deep");
  await mkdir(deployment, { recursive: true });
  assert.ok(Buffer.byteLength(path.join(deployment, "computer", "run", "service.sock")) > 103);
  await writeFile(path.join(storage, "selected-root.json"), JSON.stringify({ home: deployment, origin: "http://example.invalid" }));
  const api = { getStatus: async () => ({ servers: [], service: { running: false } }) };
  t.mock.module("electron", { namedExports: {
    app: {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {},
      getPath: () => base,
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
    resolveRaftHome: () => path.join(fakeHome, ".slock"),
    userSessionPath: (home: string) => `${home}/user-session.json`,
  } });

  const { ComputerHost } = await import("./computerHost.ts");
  const make = () => new ComputerHost({ home: path.join(fakeHome, ".slock"), configuredOrigin: "http://example.invalid", storageDirectory: storage, readProcesses: async () => ({ rootPids: [], rows: [] }) });

  // no alias: refused with a clear error
  const without = make();
  await without.restoreSelection();
  await assert.rejects(() => without.start(), /too deep for its socket/);

  // alias pointing at the deployment home: used
  const alias = path.join(fakeHome, ".slock-raft");
  await symlink(deployment, alias);
  const withAlias = make();
  await withAlias.restoreSelection();
  assert.equal(withAlias.slockHome, alias);
  assert.deepEqual([process.env.RAFT_HOME, process.env.SLOCK_HOME], [alias, alias]);
});
