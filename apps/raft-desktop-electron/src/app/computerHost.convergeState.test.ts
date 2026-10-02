// Fix pin: a converge/recycle failure notice must CLEAR once any action
// leaves the local service running. The start-only retry offered after
// RECYCLE_START_FAILED goes through host.start(); without the explicit
// {ok:true} on success the notice would linger until the app restarts.
// ComputerHost touches electron (`app`) and the raft-computer lib directly, so
// both are module-mocked; the api stub's start() is scripted per phase.
import assert from "node:assert/strict";
import test from "node:test";

test("start() success clears a failed converge notice; enable() does too", async (t) => {
  const starts: string[] = [];
  let failNextStart = true;
  const api = {
    getStatus: async () => ({ servers: [{ serverId: "s1" }], service: { running: false } }),
    stop: async () => {
      starts.push("stop");
    },
    start: async (input: { serverId: string | null }) => {
      starts.push(`start:${input?.serverId ?? "all"}`);
      if (failNextStart) {
        failNextStart = false;
        throw Object.assign(new Error("spawn boom"), { code: "SUPERVISOR_SPAWN_FAILED" });
      }
    },
    attach: async () => ({ serverId: "s1", apiKey: "k" }),
    resetService: async () => {},
    tryUpgradeViaService: async () => ({ routed: false }),
  };
  t.mock.module("electron", { namedExports: {
    app: {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {},
      getPath: () => "/tmp/raft-host-test",
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
    fetchCdnLatestVersion: async () => null,
    resolveRaftHome: () => "/tmp/raft-host-test",
    userSessionPath: (home: string) => `${home}/user-session.json`,
  } });

  const { ComputerHost } = await import("./computerHost.ts");
  const host = new ComputerHost();

  // Simulate the failure state the card surfaces: a recycle whose start threw.
  // stop succeeds, the service reports not-running, then start fails.
  await assert.rejects(() => host.recycleService(), (error: { code?: string }) => error.code === "RECYCLE_START_FAILED");
  let status = await host.getStatus();
  assert.deepEqual(status.converge, {
    ok: false,
    code: "RECYCLE_START_FAILED",
    message: "Stopped the old service, but starting the new one failed: spawn boom (Retry starts the service — no second stop.)",
  });

  // The start-only retry path: a plain start() that now succeeds must clear
  // the notice — this is the regression this test pins.
  await host.start();
  status = await host.getStatus();
  assert.deepEqual(status.converge, { ok: true });

  // enable() also boots the service; a failure state must clear through it.
  failNextStart = false;
  (host as unknown as { convergeState: unknown }).convergeState = { ok: false, code: "SERVICE_VERSION_SKEW", message: "stale" };
  await host.enable({ serverSlug: "raftbuild", serverUrl: "http://example.invalid", accessToken: "a", refreshToken: "r" });
  status = await host.getStatus();
  assert.deepEqual(status.converge, { ok: true });

  // Ordering sanity: recycle stopped once, then starts went all → failed → (via retry) all.
  assert.deepEqual(starts, ["stop", "start:all", "start:all", "start:s1"]);
});
