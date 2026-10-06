// Gate pin (2026-10-02 incident): a self-hosted build must NEVER take over,
// stop, start, or recycle a state root whose persisted session belongs to a
// different deployment. converge() must return {ok:false} BEFORE any
// lifecycle action runs; the operator actions must refuse the same way.
// Own file (not appended to convergeState.test.ts) because node:test module
// mocks bind at first import — a second mock of the same specifier in the
// same process would silently reuse the first test's bindings.
import assert from "node:assert/strict";
import test from "node:test";

test("converge() blocks BEFORE any lifecycle action when the session belongs to another deployment", async (t) => {
  const calls: string[] = [];
  t.mock.module("electron", { namedExports: {
    app: {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {},
      getPath: () => "/tmp/raft-host-test",
    },
  } });
  t.mock.module("@botiverse/raft-computer/lib", { namedExports: {
    connectService: async () => { throw new Error("unused"); },
    // Landing in these would mean the gate failed to block the takeover.
    convergeAppHostLifecycle: async () => { calls.push("convergeAppHostLifecycle"); return { owner: "app", enabled: false, status: "converged", label: null, definitionPath: null, definition: null }; },
    createComputerApi: () => ({ getStatus: async () => { calls.push("api.getStatus"); return { servers: [], service: { running: false } }; } }),
    readProcessStartTime: async () => null,
    rebindParentEvidence: async () => {},
    DEFAULT_UPGRADE_BASE_URL: "https://example.invalid/computer",
    // phase 3-1: the host archives foreign-origin attachments before attach.
    listServerAttachments: async () => [],
    serversDir: (home: string) => `${home}/computer/servers`,
    canonicalizeServerUrl: (url: string) => { try { return new URL(url).origin; } catch { return url; } },
    fetchCdnLatestVersion: async () => null,
    resolveRaftHome: () => "/tmp/raft-host-test",
    userSessionPath: (home: string) => `${home}/user-session.json`,
  } });
  t.mock.module("./sessionOriginGuard.js", { namedExports: {
    checkSessionOrigin: async () => ({
      status: "mismatch",
      sessionOrigin: "http://grokbot.example.net:3001",
      configuredOrigin: "https://raft.example.com",
    }),
    describeSessionOriginMismatch: (check: { sessionOrigin: string; configuredOrigin: string }) =>
      `session belongs to ${check.sessionOrigin}, build points at ${check.configuredOrigin}`,
    SESSION_ORIGIN_MISMATCH_CODE: "SESSION_ORIGIN_MISMATCH",
  } });

  const { ComputerHost } = await import("./computerHost.ts");
  const host = new ComputerHost();
  const result = await host.converge();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /grokbot\.example\.net:3001/);
  const status = await host.getStatus();
  assert.equal(status.converge?.ok, false);
  assert.equal(status.converge?.code, "SESSION_ORIGIN_MISMATCH");
  // Status reads are fine (the card must render the notice); nothing
  // lifecycle-shaped ran during the blocked converge.
  assert.deepEqual(calls, ["api.getStatus"]);

  // The gate applies to the operator actions too — a foreign session must
  // never be stopped/started/recycled by this build.
  await assert.rejects(() => host.start(), (error: {code?: string}) => error.code === "SESSION_ORIGIN_MISMATCH");
  await assert.rejects(() => host.stop(), (error: {code?: string}) => error.code === "SESSION_ORIGIN_MISMATCH");
  await assert.rejects(() => host.recycleService(), (error: {code?: string}) => error.code === "SESSION_ORIGIN_MISMATCH");
  assert.equal(calls.includes("convergeAppHostLifecycle"), false, "no lifecycle writes ever ran");
});
