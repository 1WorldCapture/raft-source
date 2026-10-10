import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  aliasPathFor,
  createMigrationEventSink,
  defaultListSourceCarriers,
  type HomeProcess,
  encodeProjectDirName,
  homeEnvPlistPath,
  mentionsPathBounded,
  migrateHome,
  migrateInProgressPath,
  parseMigrateDeadline,
  MIGRATE_IN_PROGRESS_DEADLINE_MS,
  migrateResultPath,
  migrateRunLogPath,
  serviceSocketPathTooLong,
  type MigrateEvent,
  type MigrateHomeDeps,
  type MigrateHomeStatus,
} from "./migrateHome.js";
import { writeDesiredState } from "./desiredState.js";

/** Fixture home layout mirroring the real extract scenario:
 *   <root>/user/                        — fake $HOME
 *   <root>/user/embedded/               — the old (desktop-managed) home
 *     agents/a1, agents/a2, computer/servers/s1, computer/run/service.pid
 *   <root>/user/.slock-raft → embedded  — the D1 alias
 *   <root>/user/Library/LaunchAgents/build.raft.desktop.home-env.plist
 */
const ATTACHED_SERVER_ID = "00000000-0000-4000-8000-000000000001";

async function fixture(
  opts: {
    livePid?: boolean;
    stopped?: boolean;
    alias?: boolean;
    homeEnv?: boolean;
    oldCarrier?: boolean;
    /** Write a real (parseable) runner.state.json so `start` has work. */
    attachment?: boolean;
  } = {},
) {
  // realpath up front: preflight resolves through symlinks (macOS /tmp → /private/tmp),
  // and the tests compare against the resolved paths. The root sits under a
  // SHORT /tmp prefix, not os.tmpdir(): on macOS the per-user tempdir prefix
  // alone (~49 bytes) pushes the target socket path past the AF_UNIX limit
  // the preflight now blocks on, and every apply test would trip it.
  const rootPrefix = process.platform === "win32" ? path.join(tmpdir(), "migrate-home-") : "/tmp/migrate-home-";
  const root = await realpath(await mkdtemp(rootPrefix));
  const user = path.join(root, "user");
  const from = path.join(user, "embedded");
  const to = path.join(user, ".slock");
  await mkdir(path.join(from, "agents", "a1"), { recursive: true });
  await mkdir(path.join(from, "agents", "a2"), { recursive: true });
  await mkdir(path.join(from, "computer", "servers", ATTACHED_SERVER_ID), { recursive: true });
  await mkdir(path.join(from, "computer", "run"), { recursive: true });
  if (opts.attachment !== false) {
    // Real attachment shape (serverState.parseAttachment contract) — an
    // empty servers/<id> dir does NOT count, which is exactly how the drill
    // caught the NO_ATTACHMENT gap.
    await writeFile(
      path.join(from, "computer", "servers", ATTACHED_SERVER_ID, "runner.state.json"),
      JSON.stringify({
        kind: "computer-attachment",
        serverId: ATTACHED_SERVER_ID,
        serverMachineId: "drill-fixture-machine",
        apiKey: "test-fixture-only",
        serverUrl: "http://127.0.0.1:1",
      }),
      "utf8",
    );
  }
  if (opts.livePid) {
    // The vitest worker itself is a live pid — isProcessAlive() sees it.
    await writeFile(path.join(from, "computer", "run", "service.pid"), `${process.pid}\n`, "utf8");
  }
  if (opts.stopped) {
    await writeDesiredState(from, "stopped");
  }
  // Stale host-lifecycle owner record (present after any real start; the
  // migration must clear it on move and restore it byte-identically on
  // rollback — at the SOURCE path, never re-creating the target).
  await writeFile(
    path.join(from, "computer", "host-lifecycle-owner.json"),
    '{"formatVersion":1,"owner":"cli","enabled":true,"label":"build.raft.computer.login.fixture"}\n',
    "utf8",
  );
  const alias = aliasPathFor(user);
  if (opts.alias !== false) {
    await symlink(from, alias, "dir");
  }
  if (opts.homeEnv !== false) {
    const plist = homeEnvPlistPath(user);
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, "<plist>home-env fixture</plist>\n", "utf8");
  }
  let carrierPlist: string | null = null;
  if (opts.oldCarrier !== false) {
    carrierPlist = path.join(user, "Library", "LaunchAgents", "build.raft.computer.test-carrier.plist");
    await mkdir(path.dirname(carrierPlist), { recursive: true });
    // Path sits inside a <string> element with the closing tag right after it
    // — the boundary the scan requires.
    await writeFile(carrierPlist, `<plist><string>--slock-home</string><string>${from}</string></plist>\n`, "utf8");
  }
  // ~/.claude/projects: one dir for an agent cwd under the old home, one
  // whose NEW name already exists (must be skipped, never clobbered), and
  // one unrelated dir that must not move.
  const projectsDir = path.join(user, ".claude", "projects");
  const oldPrefix = encodeProjectDirName(from);
  const newPrefix = encodeProjectDirName(to);
  const sessionA = path.join(projectsDir, `${oldPrefix}-agents-a1`);
  const sessionClash = path.join(projectsDir, `${oldPrefix}-agents-a2`);
  const sessionUnrelated = path.join(projectsDir, "-Users-someone-else");
  // Sibling decoy: encodes <from>-neighbor — shares the loose prefix but is
  // NOT an agent cwd; it must stay put (PM review on #271).
  const sessionSibling = path.join(projectsDir, `${oldPrefix}-neighbor`);
  const sessionClashTarget = path.join(projectsDir, `${newPrefix}-agents-a2`);
  await mkdir(sessionA, { recursive: true });
  await mkdir(sessionClash, { recursive: true });
  await mkdir(sessionUnrelated, { recursive: true });
  await mkdir(sessionSibling, { recursive: true });
  await mkdir(sessionClashTarget, { recursive: true });
  await writeFile(path.join(sessionA, "session.jsonl"), "[]", "utf8");
  return {
    root, user, from, to, alias, carrierPlist, projectsDir,
    sessionA, sessionClash, sessionUnrelated, sessionSibling, sessionClashTarget,
  };
}

function fakeDeps(user: string, overrides: { statuses?: MigrateHomeStatus[] } = {}) {
  const events: MigrateEvent[] = [];
  const stopCalls: string[] = [];
  const startCalls: string[] = [];
  const convergeCalls: Array<[string, "enabled" | "disabled"]> = [];
  const launchctlCalls: string[][] = [];
  // Process-sweep fakes: seeded via liveProcesses; kills remove unless
  // killWorks is set false (the unkillable-survivor case).
  const liveProcesses = new Map<number, HomeProcess>();
  const killLog: Array<[number, "SIGTERM" | "SIGKILL"]> = [];
  const harnessKillWorks = { value: true };
  // Machine-API fake for record/restore-agents. rosterPhases is consumed per
  // GET: record reads phase 1, restore reads the next ones — a test can make
  // the record see "active" and the restore see the agent down. When only
  // one phase is seeded every GET returns it.
  const machineCalls: string[] = [];
  const rosterPhases: Array<Array<{ id: string; name: string; status: string; runtime: string }>> = [
    [{ id: "agent-fixture-1", name: "fixture-one", status: "active", runtime: "claude" }],
  ];
  let rosterPoll = 0;
  const startStatus = { code: 200 };
  let poll = 0;
  const deps: MigrateHomeDeps = {
    homeDir: user,
    // The fake harness runs "for real" against the fixture user — override
    // per test when asserting the $HOME-isolation guard.
    realHomeDir: () => user,
    uid: 501,
    env: {},
    scanHomeProcesses: async () => [...liveProcesses.values()], // spellings ignored by the fake
    killHomeProcess: (pid, signal) => {
      killLog.push([pid, signal]);
      if (harnessKillWorks.value) liveProcesses.delete(pid);
    },
    sleep: async () => {},
    selfCheckTimeoutMs: 200,
    selfCheckPollMs: 1,
    agentRestoreDeps: {
      fetchImpl: async (_serverUrl, _apiKey, apiPath, init) => {
        machineCalls.push(`${init?.method ?? "GET"} ${apiPath}`);
        if (apiPath === "/internal/machine/agents") {
          const roster = rosterPhases[Math.min(rosterPoll, rosterPhases.length - 1)];
          rosterPoll += 1;
          return { status: 200, json: async () => roster };
        }
        if (apiPath.startsWith("/internal/machine/agents/") && init?.method === "POST") {
          return { status: startStatus.code, json: async () => ({ ok: true }) };
        }
        return { status: 404, json: async () => ({ error: "not found" }) };
      },
    },
    stopServiceAt: async (home) => {
      stopCalls.push(home);
    },
    startServiceAt: async (home) => {
      startCalls.push(home);
    },
    convergeCarrierAt: async (home, desired) => {
      convergeCalls.push([home, desired]);
    },
    statusAt: async () => {
      const queue = overrides.statuses;
      if (queue === undefined) return { serviceRunning: true, serverCount: 1, serversOnline: true };
      const status = queue[Math.min(poll, queue.length - 1)] ?? queue[queue.length - 1]!;
      poll += 1;
      return status;
    },
    runLaunchctl: async (args) => {
      launchctlCalls.push(args);
      return { code: 0, stderr: "" };
    },
  };
  return {
    deps,
    events,
    stopCalls,
    startCalls,
    convergeCalls,
    launchctlCalls,
    machineCalls,
    rosterPhases,
    startStatus,
    liveProcesses,
    killLog,
    setKillWorks: (works: boolean) => {
      harnessKillWorks.value = works;
    },
  };
}

const apply = { apply: true };
const dry = { apply: false };

test("dry-run plans the full migration and mutates nothing", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "planned");
    assert.equal(run.result, null);
    // Nothing moved, nothing stopped, nothing written.
    const pid = await readFile(path.join(f.from, "computer", "run", "service.pid"), "utf8");
    assert.match(pid.trim(), /^\d+$/);
    assert.deepEqual(h.stopCalls, []);
    assert.deepEqual(h.startCalls, []);
    assert.deepEqual(h.launchctlCalls, []);
    assert.match(await readFile(homeEnvPlistPath(f.user), "utf8"), /home-env fixture/);
    await assert.rejects(() => readFile(migrateResultPath(f.to)));
    const preflight = h.events.filter((e) => e.step === "preflight").at(-1);
    assert.equal(preflight?.status, "ok");
    const statuses = h.events.filter((e) => e.step !== "preflight").map((e) => e.status);
    assert.deepEqual(statuses, Array.from({ length: 12 }, () => "planned"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("dry-run is blocked when the target exists and is not empty", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  try {
    await mkdir(f.to, { recursive: true });
    await writeFile(path.join(f.to, "leftover.txt"), "x", "utf8");
    const run = await migrateHome({ from: f.from, ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    assert.equal(run.blocked, true);
    const preflight = h.events.filter((e) => e.step === "preflight").at(-1);
    assert.equal(preflight?.status, "blocked");
    assert.match(JSON.stringify(preflight?.detail?.blockers), /not empty/);
    // Both the source home and the target leftovers are untouched.
    await readFile(path.join(f.to, "leftover.txt"), "utf8");
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: full success — move, alias repoint, home-env removal, start, self-check, result file", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    // Old path gone; the new home carries the whole tree.
    await assert.rejects(() => readFile(path.join(f.from, "agents", "a1")));
    assert.match((await readFile(path.join(f.to, "computer", "run", "service.pid"), "utf8")).trim(), /^\d+$/);
    // Alias repointed at the new home.
    assert.equal(await readlink(f.alias), f.to);
    // Old carrier login item removed; home-env plist removed; bootouts in
    // step order — the source carrier goes out BEFORE the service stops.
    await assert.rejects(() => readFile(f.carrierPlist!));
    await assert.rejects(() => readFile(homeEnvPlistPath(f.user)));
    assert.deepEqual(h.launchctlCalls.map((c) => c.join(" ")), [
      "bootout gui/501/build.raft.computer.test-carrier",
      "bootout gui/501/build.raft.desktop.home-env",
    ]);
    const carrierBootoutAt = h.launchctlCalls.findIndex((c) => c[1] === "gui/501/build.raft.computer.test-carrier");
    assert.ok(carrierBootoutAt >= 0);
    // Service lifecycle: stopped at source, started at target.
    assert.deepEqual(h.stopCalls, [f.from]);
    assert.deepEqual(h.startCalls, [f.to]);
    // Session continuity: the old-home project dir moved to the new-encoded
    // name; the clashing one stayed put (never clobbered); unrelated untouched.
    assert.equal((await stat(path.join(f.projectsDir, `${encodeProjectDirName(f.to)}-agents-a1`, "session.jsonl"))).isFile(), true);
    await assert.rejects(() => stat(f.sessionA));
    assert.equal((await stat(f.sessionClash)).isDirectory(), true);
    assert.equal((await stat(f.sessionClashTarget)).isDirectory(), true);
    assert.equal((await stat(f.sessionUnrelated)).isDirectory(), true);
    assert.equal((await stat(f.sessionSibling)).isDirectory(), true, "sibling project dir stays put");
    const sessions = h.events.filter((e) => e.step === "sessions").at(-1);
    assert.deepEqual(sessions?.detail?.skippedSibling, [f.sessionSibling.split(path.sep).at(-1)]);
    // Durable backups of every deleted plist + recorded in the result file.
    const backupDir = path.join(f.to, "computer", "migrate-backup");
    assert.match(await readFile(path.join(backupDir, "build.raft.computer.test-carrier.plist"), "utf8"), /--slock-home/);
    assert.match(await readFile(path.join(backupDir, "build.raft.desktop.home-env.plist"), "utf8"), /home-env fixture/);
    // The stale lifecycle marker was cleared by the move.
    await assert.rejects(() => readFile(path.join(f.to, "computer", "host-lifecycle-owner.json")));
    const moveStep = h.events.filter((e) => e.step === "move").at(-1);
    assert.equal(moveStep?.detail?.staleLifecycleMarkerCleared, true);
    // Result file at the NEW home.
    const result = JSON.parse(await readFile(migrateResultPath(f.to), "utf8")) as {
      result: string;
      serviceState: string;
      backups: Array<{ label: string; originalPath: string; backupPath: string }>;
    };
    assert.equal(result.result, "success");
    assert.equal(result.serviceState, "running");
    assert.deepEqual(
      result.backups.map((b) => b.label).sort(),
      ["build.raft.computer.test-carrier", "build.raft.desktop.home-env"],
    );
    assert.ok(result.backups.every((b) => b.backupPath.startsWith(backupDir)));
    assert.deepEqual(
      h.events.map((e) => `${e.step}:${e.status}`),
      [
        "preflight:start",
        "preflight:ok",
        "source-carrier:start",
        "source-carrier:ok",
        "record-agents:start",
        "record-agents:ok",
        "stop:start",
        "stop:ok",
        "move:start",
        "move:ok",
        "alias:start",
        "alias:ok",
        "sessions:start",
        "sessions:ok",
        "cursor-sessions:start",
        "cursor-sessions:ok",
        "home-env:start",
        "home-env:ok",
        "backup:start",
        "backup:ok",
        "start:start",
        "start:ok",
        "restore-agents:start",
        "restore-agents:ok",
        "self-check:start",
        "self-check:ok",
      ],
    );
    // Record/restore round trip: the fixture roster's active agent was
    // recorded before the stop, found already running after the (fake)
    // start, and the record file was consumed by finish().
    const restore = h.events.filter((e) => e.step === "restore-agents").at(-1);
    assert.equal(restore?.detail?.recorded, 1);
    assert.deepEqual(restore?.detail?.alreadyRunning, ["agent-fixture-1"]);
    await assert.rejects(() => readFile(path.join(f.to, "computer", "migrate-restore-agents.json")));
    await assert.rejects(() => readFile(path.join(f.from, "computer", "migrate-restore-agents.json")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: a stopped-by-user service stays stopped — carrier converged, no start, no self-check", async () => {
  const f = await fixture({ stopped: true, alias: false, homeEnv: false });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    assert.deepEqual(h.startCalls, []);
    assert.deepEqual(h.stopCalls, []); // service not running → stop skipped
    assert.deepEqual(h.convergeCalls, [[f.to, "enabled"]]);
    const result = JSON.parse(await readFile(migrateResultPath(f.to), "utf8")) as { result: string; serviceState: string };
    assert.equal(result.result, "success");
    assert.equal(result.serviceState, "stopped-by-user");
    assert.equal(h.events.find((e) => e.step === "self-check")?.status, "skipped");
    assert.equal(h.events.filter((e) => e.step === "start").at(-1)?.status, "ok");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: self-check failure rolls everything back and restarts the source service", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user, { statuses: [{ serviceRunning: true, serverCount: 1, serversOnline: false }] });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    // Home back at the source path; nothing left at the target.
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    await assert.rejects(() => readFile(migrateResultPath(f.to)));
    // Alias restored to the source home; session dirs back at old names.
    assert.equal(await readlink(f.alias), f.from);
    assert.equal((await stat(f.sessionA)).isDirectory(), true);
    await assert.rejects(() => stat(path.join(f.projectsDir, `${encodeProjectDirName(f.to)}-agents-a1`)));
    // Both plists restored byte-for-byte and bootstrapped back in.
    assert.match(await readFile(f.carrierPlist!, "utf8"), /--slock-home/);
    assert.match(await readFile(homeEnvPlistPath(f.user), "utf8"), /home-env fixture/);
    const launchctl = h.launchctlCalls.map((c) => c.join(" "));
    assert.ok(launchctl.includes("bootout gui/501/build.raft.desktop.home-env"));
    assert.ok(launchctl.includes(`bootstrap gui/501 ${homeEnvPlistPath(f.user)}`));
    assert.ok(launchctl.includes(`bootstrap gui/501 ${f.carrierPlist}`));
    // Target service stopped before the move back; source service restarted.
    assert.ok(h.stopCalls.includes(f.to));
    assert.equal(h.startCalls[h.startCalls.length - 1], f.from);
    // The stale lifecycle marker is back at the SOURCE home byte-identically,
    // and the target path was NOT re-created (PM review on #278).
    assert.equal(
      await readFile(path.join(f.from, "computer", "host-lifecycle-owner.json"), "utf8"),
      '{"formatVersion":1,"owner":"cli","enabled":true,"label":"build.raft.computer.login.fixture"}\n',
    );
    await assert.rejects(() => stat(f.to));
    // Result file at the SOURCE home after rollback.
    const result = JSON.parse(await readFile(migrateResultPath(f.from), "utf8")) as {
      result: string;
      serviceState: string;
      rollback: { attempted: boolean; ok: boolean };
      error: string;
    };
    assert.equal(result.result, "rolled_back");
    assert.equal(result.serviceState, "running");
    assert.deepEqual(result.rollback, { attempted: true, ok: true });
    assert.match(result.error, /self-check timed out/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: rollback does not start a service that was down before the migration", async () => {
  const f = await fixture({ livePid: false }); // desiredState defaults to running
  const h = fakeDeps(f.user, { statuses: [{ serviceRunning: false, serverCount: 1, serversOnline: false }] });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    // The start step ran (intent running) and the rollback stopped the
    // target, but the source is NOT restarted — it was down before we began.
    assert.deepEqual(h.startCalls, [f.to]);
    assert.deepEqual(h.stopCalls, [f.to]);
    const result = JSON.parse(await readFile(migrateResultPath(f.from), "utf8")) as { serviceState: string };
    assert.equal(result.serviceState, "down");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: blockers abort before any mutation — no stop, no move, no result file", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    await mkdir(f.to, { recursive: true });
    await writeFile(path.join(f.to, "leftover.txt"), "x", "utf8");
    const run = await migrateHome({ from: f.from, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    assert.equal(run.result, null);
    // Nothing was touched at all.
    assert.deepEqual(h.stopCalls, []);
    assert.deepEqual(h.startCalls, []);
    assert.deepEqual(h.launchctlCalls, []);
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    await readFile(path.join(f.to, "leftover.txt"), "utf8");
    await readFile(f.carrierPlist!, "utf8");
    await assert.rejects(() => readFile(migrateResultPath(f.from)));
    await assert.rejects(() => readFile(migrateResultPath(f.to)));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("preflight: cross-filesystem targets are blocked (mv-only, never copy)", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  h.deps.deviceOf = async (p: string) => (p === f.from ? 1 : 2);
  try {
    const run = await migrateHome({ from: f.from, ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    assert.match(JSON.stringify(h.events.filter((e) => e.step === "preflight").at(-1)?.detail?.blockers), /different filesystem/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("preflight: nested (non-equal) targets stay blocked", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: path.join(f.from, "sub"), ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    assert.match(JSON.stringify(h.events.filter((e) => e.step === "preflight").at(-1)?.detail?.blockers), /distinct/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("in-place: from === to plans a takeover (no move steps, mode surfaced)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.from, ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "planned");
    assert.equal(run.mode, "in-place");
    const preflight = h.events.filter((e) => e.step === "preflight").at(-1);
    assert.equal(preflight?.detail?.mode, "in-place");
    const steps = h.events.filter((e) => e.step !== "preflight").map((e) => e.step);
    assert.ok(!steps.includes("move"), "no move step");
    assert.ok(!steps.includes("alias"), "no alias step");
    assert.ok(!steps.includes("sessions"), "no sessions step");
    assert.deepEqual(steps, ["source-carrier", "record-agents", "stop", "home-env", "backup", "start", "restore-agents", "self-check"]);
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    assert.deepEqual(h.stopCalls, []);
    assert.deepEqual(h.startCalls, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("in-place: apply takes over at the same path — never renames, removes the app owner record", async () => {
  const f = await fixture({ livePid: true });
  const markerFile = path.join(f.from, "computer", "host-lifecycle-owner.json");
  await writeFile(markerFile, '{"formatVersion":1,"owner":"app","enabled":true}\n', "utf8");
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.from, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    assert.equal(run.mode, "in-place");
    // The home NEVER moved: same path, same tree.
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    assert.equal((await stat(path.join(f.from, "computer", "servers", ATTACHED_SERVER_ID))).isDirectory(), true);
    await assert.rejects(() => stat(f.to), "in-place must not create the ~/.slock target");
    // Lifecycle: app owner record removed, service started at the SAME home.
    await assert.rejects(() => readFile(markerFile));
    assert.deepEqual(h.stopCalls, [f.from]);
    assert.deepEqual(h.startCalls, [f.from]);
    const start = h.events.filter((e) => e.step === "start").at(-1);
    assert.equal(start?.detail?.lifecycleTakeover, true);
    assert.equal(start?.detail?.mode, "in-place");
    const result = JSON.parse(await readFile(migrateResultPath(f.from), "utf8")) as {
      result: string; mode: string; serviceState: string;
    };
    assert.equal(result.result, "success");
    assert.equal(result.mode, "in-place");
    assert.equal(result.serviceState, "running");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("in-place: failure rolls back the carrier and the owner record byte-for-byte", async () => {
  const f = await fixture({ livePid: true });
  const markerFile = path.join(f.from, "computer", "host-lifecycle-owner.json");
  const markerBefore = '{"formatVersion":1,"owner":"app","enabled":true}\n';
  await writeFile(markerFile, markerBefore, "utf8");
  const h = fakeDeps(f.user, { statuses: [{ serviceRunning: true, serverCount: 1, serversOnline: false }] });
  try {
    const run = await migrateHome({ from: f.from, to: f.from, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    assert.equal(
      await readFile(f.carrierPlist!, "utf8"),
      await readFile(path.join(f.from, "computer", "migrate-backup", "build.raft.computer.test-carrier.plist"), "utf8"),
    );
    assert.equal(await readFile(markerFile, "utf8"), markerBefore);
    const launchctl = h.launchctlCalls.map((c) => c.join(" "));
    assert.ok(launchctl.includes(`bootstrap gui/501 ${f.carrierPlist}`));
    assert.equal(h.startCalls[h.startCalls.length - 1], f.from);
    const result = JSON.parse(await readFile(migrateResultPath(f.from), "utf8")) as { result: string; mode: string };
    assert.equal(result.result, "rolled_back");
    assert.equal(result.mode, "in-place");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("scan: path boundary matching — a similar-prefix path does not match (PM review)", async () => {
  assert.equal(mentionsPathBounded(`<string>/Users/x/foo</string>`, "/Users/x/foo"), true, "XML close tag is a boundary");
  assert.equal(mentionsPathBounded(`<string>/Users/x/foo/sub</string>`, "/Users/x/foo"), true, "subpath is a boundary");
  assert.equal(mentionsPathBounded(`<string>/Users/x/foo\"`, "/Users/x/foo"), true, "quote is a boundary");
  assert.equal(mentionsPathBounded("<string>/Users/x/foobar</string>", "/Users/x/foo"), false, "longer path is NOT a match");
  assert.equal(mentionsPathBounded("<string>/Users/x/foo-bar</string>", "/Users/x/foo"), false, "hyphen continuation is NOT a match");
  assert.equal(mentionsPathBounded("<string>/Users/x/foo", "/Users/x/foo"), false, "end of content is NOT a match (strict rule)");

  const f = await fixture({ oldCarrier: false, homeEnv: false });
  try {
    // A decoy plist that mentions a LONGER path sharing the source prefix.
    const decoy = path.join(f.user, "Library", "LaunchAgents", "build.raft.computer.decoy.plist");
    await mkdir(path.dirname(decoy), { recursive: true });
    await writeFile(decoy, `<plist><string>${f.from}-neighbor</string></plist>\n`, "utf8");
    const carriers = await defaultListSourceCarriers(f.user, [f.from]);
    assert.deepEqual(carriers.map((c) => c.label), [], "similar-prefix plist is not selected");
    // ...while an exact boundary mention IS selected.
    await writeFile(decoy, `<plist><string>${f.from}</string></plist>\n`, "utf8");
    const found = await defaultListSourceCarriers(f.user, [f.from]);
    assert.deepEqual(found.map((c) => c.label), ["build.raft.computer.decoy"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("dry-run lists the discovered source carriers and the backup plan", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    await migrateHome({ from: f.from, ...dry }, h.deps, (e) => h.events.push(e));
    const carrier = h.events.filter((e) => e.step === "source-carrier").at(-1);
    assert.equal(carrier?.status, "planned");
    assert.deepEqual((carrier?.detail?.carriers as Array<{ label: string }>).map((c) => c.label), [
      "build.raft.computer.test-carrier",
    ]);
    const backup = h.events.filter((e) => e.step === "backup").at(-1);
    assert.equal(backup?.status, "planned");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("apply: zero-attachment home migrates with converge-only start (fresh-install shape)", async () => {
  const f = await fixture({ livePid: true, attachment: false });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    // Home moved; nothing was started (start refuses zero attachments);
    // the login item was converged and self-check skipped.
    await assert.rejects(() => stat(f.from));
    assert.deepEqual(h.startCalls, []);
    assert.deepEqual(h.stopCalls, [f.from]);
    assert.deepEqual(h.convergeCalls, [[f.to, "enabled"]]);
    assert.equal(h.events.filter((e) => e.step === "self-check").at(-1)?.status, "skipped");
    const result = JSON.parse(await readFile(migrateResultPath(f.to), "utf8")) as {
      result: string;
      serviceState: string;
    };
    assert.equal(result.result, "success");
    assert.equal(result.serviceState, "down");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("home-env: launchctl is never touched when $HOME is overridden (fixed label isolation)", async () => {
  // PM incident 2026-10-10: the home-env label has no home hash, so a drill
  // that overrides HOME must not bootout/bootstrap the REAL gui domain.
  const f = await fixture({ livePid: true, attachment: false });
  const h = fakeDeps(f.user);
  h.deps.realHomeDir = () => "/Users/definitely-not-the-drill-home";
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    // File-level handling still happened locally…
    await assert.rejects(() => readFile(homeEnvPlistPath(f.user)));
    assert.match(
      await readFile(path.join(f.to, "computer", "migrate-backup", "build.raft.desktop.home-env.plist"), "utf8"),
      /home-env fixture/,
    );
    // …but the ONLY launchctl calls are the (home-hashed, safe) carrier ones.
    assert.deepEqual(
      h.launchctlCalls.map((c) => c.join(" ")),
      ["bootout gui/501/build.raft.computer.test-carrier"],
    );
    const homeEnv = h.events.filter((e) => e.step === "home-env").at(-1);
    assert.equal(homeEnv?.detail?.launchctl, "skipped-isolated-home");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("home-env: launchctl runs when the plist sits in the REAL user's LaunchAgents", async () => {
  const f = await fixture({ livePid: true, attachment: false });
  const h = fakeDeps(f.user);
  h.deps.realHomeDir = () => f.user; // simulate: HOME is the real home
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    assert.ok(h.launchctlCalls.some((c) => c.join(" ") === "bootout gui/501/build.raft.desktop.home-env"));
    const homeEnv = h.events.filter((e) => e.step === "home-env").at(-1);
    assert.equal(homeEnv?.detail?.launchctl, "domain");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stop step sweeps an orphaned runner tree of the source home (PM blocking fix)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  h.liveProcesses.set(4242, { pid: 4242, kind: "runner", serverId: ATTACHED_SERVER_ID });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    const stop = h.events.filter((e) => e.step === "stop").at(-1);
    assert.equal(stop?.status, "ok");
    assert.equal(stop?.detail?.treeClean, true);
    assert.deepEqual(h.killLog, [[4242, "SIGTERM"]]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stop step fails into rollback when a home process cannot be stopped", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  h.liveProcesses.set(666, { pid: 666, kind: "runner", serverId: ATTACHED_SERVER_ID });
  h.setKillWorks(false);
  h.deps.sweepTimeoutMs = 300;
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    const stop = h.events.filter((e) => e.step === "stop").at(-1);
    assert.equal(stop?.status, "fail");
    assert.match(String(stop?.detail?.error), /did not stop/);
    // Nothing moved.
    assert.equal((await stat(path.join(f.from, "agents", "a1"))).isDirectory(), true);
    await assert.rejects(() => stat(f.to));
    assert.ok(h.killLog.some(([pid, signal]) => pid === 666 && signal === "SIGKILL"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("self-check fails on a duplicate runner tree per server", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success"); // sanity: clean tree passes
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
  const f2 = await fixture({ livePid: true });
  const h2 = fakeDeps(f2.user);
  // Two runners for the same server visible at the target during self-check.
  h2.deps.scanHomeProcesses = async (homeSpellings: string[]) =>
    homeSpellings.some((spelling) => spelling === f2.to)
      ? [
          { pid: 900, kind: "runner", serverId: ATTACHED_SERVER_ID },
          { pid: 901, kind: "runner", serverId: ATTACHED_SERVER_ID },
        ]
      : [];
  h2.deps.selfCheckTimeoutMs = 200;
  h2.deps.selfCheckPollMs = 5;
  try {
    const run = await migrateHome({ from: f2.from, to: f2.to, ...apply }, h2.deps, (e) => h2.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    const selfCheck = h2.events.filter((e) => e.step === "self-check").at(-1);
    assert.equal(selfCheck?.status, "fail");
    assert.match(String(selfCheck?.detail?.error), /duplicate runner trees/);
    // Rolled back to the source.
    assert.equal((await stat(path.join(f2.from, "agents", "a1"))).isDirectory(), true);
  } finally {
    await rm(f2.root, { recursive: true, force: true });
  }
});

test("scan attribution: symlink spelling and argv boundary (#281 review)", async () => {
  const { argvMentionsHome, mentionsWithBoundary, defaultScanHomeProcesses } = await import("./migrateHome.js");
  // argv boundary: ~/.slock must NOT select --slock-home ~/.slock-raft.
  assert.equal(argvMentionsHome("--slock-home /Users/x/.slock-raft", "/Users/x/.slock"), false);
  assert.equal(argvMentionsHome("--slock-home /Users/x/.slock", "/Users/x/.slock"), true);
  assert.equal(argvMentionsHome("--slock-home=/Users/x/.slock other", "/Users/x/.slock"), true);
  assert.equal(argvMentionsHome("--slock-home /Users/x/.slock-raft", "/Users/x/.slock-raft"), true);
  // env boundary: same rule for environment mentions.
  assert.equal(mentionsWithBoundary("RAFT_HOME=/Users/x/.slock-raft FOO=1", "/Users/x/.slock"), false);
  assert.equal(mentionsWithBoundary("RAFT_HOME=/Users/x/.slock FOO=1", "/Users/x/.slock"), true);
  assert.equal(mentionsWithBoundary("SLOCK_HOME=/Users/x/.slock", "/Users/x/.slock"), true);
  // The scanner accepts the multi-spelling shape.
  assert.deepEqual(await defaultScanHomeProcesses(["/definitely/absent-home-1", "/definitely/absent-home-2"]), []);
});

test("stop step sweeps by EVERY spelling: realpath + original argument + alias (#281 review)", async () => {
  const f = await fixture({ livePid: true }); // fixture creates the ~/.slock-raft alias
  const h = fakeDeps(f.user);
  const spellingsSeen: string[][] = [];
  h.deps.scanHomeProcesses = async (homeSpellings) => {
    spellingsSeen.push(homeSpellings);
    return [...h.liveProcesses.values()];
  };
  h.liveProcesses.set(4242, { pid: 4242, kind: "runner", serverId: ATTACHED_SERVER_ID });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    const stopScan = spellingsSeen.find((spellings) => spellings.includes(f.from));
    assert.ok(stopScan, "a scan received the realpath spelling");
    assert.ok(stopScan!.includes(f.alias), "the alias spelling is swept too");
    // The real owner shape: fromArg may differ from the realpath; here the
    // fixture's --from WAS the realpath, so fromArg equals it — still assert
    // the plumbing carried both entries distinctly.
    assert.ok(stopScan!.length >= 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// --- in-progress marker + forced-quit stdout hardening (drill 284-run3, PM fix) ---

test("apply writes the in-progress marker at start and removes it on success", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  let markerDuringRun: unknown = null;
  h.deps.stopServiceAt = async (home) => {
    h.stopCalls.push(home);
    // By the time the service stops, the apply is underway — the marker must
    // exist at the SOURCE home and carry the run's identity.
    markerDuringRun = JSON.parse(await readFile(migrateInProgressPath(f.from), "utf8"));
  };
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    assert.ok(markerDuringRun, "marker existed while the apply was running");
    const marker = markerDuringRun as Record<string, unknown>;
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.from, f.from);
    assert.equal(marker.to, f.to);
    assert.equal(marker.mode, "move");
    assert.equal(typeof marker.pid, "number");
    assert.equal(typeof marker.startedAt, "string");
    // step tracks the run's progress; refreshes are chained async, so a
    // mid-run read may lag by an event or two — assert it is a plausible
    // recent step of this run, not an exact one.
    assert.ok(
      ["preflight", "source-carrier", "record-agents", "stop"].includes(marker.step as string),
      `unexpected mid-run marker step ${JSON.stringify(marker.step)}`,
    );
    // deadlineAt = startedAt + the app's bounded-wait budget.
    const expectedDeadline = Date.parse(marker.startedAt as string) + MIGRATE_IN_PROGRESS_DEADLINE_MS;
    assert.equal(Date.parse(marker.deadlineAt as string), expectedDeadline);
    // Removed from BOTH candidate homes once the result file is on disk.
    await assert.rejects(() => readFile(migrateInProgressPath(f.to)));
    await assert.rejects(() => readFile(migrateInProgressPath(f.from)));
    // The result file (the marker's successor) does exist.
    const result = JSON.parse(await readFile(migrateResultPath(f.to), "utf8"));
    assert.equal(result.result, "success");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rolled-back apply removes the in-progress marker from the restored home", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user, { statuses: [{ serviceRunning: false, serverCount: 1, serversOnline: false }] });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    // The rollback restored the source home — the marker must be gone from
    // it (and never left behind at the target).
    await assert.rejects(() => readFile(migrateInProgressPath(f.from)));
    await assert.rejects(() => readFile(migrateInProgressPath(f.to)));
    const result = JSON.parse(await readFile(migrateResultPath(f.from), "utf8"));
    assert.equal(result.result, "rolled_back");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("dry-run and blocked applies never write the in-progress marker", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  try {
    await migrateHome({ from: f.from, to: f.to, ...dry }, h.deps, (e) => h.events.push(e));
    await assert.rejects(() => readFile(migrateInProgressPath(f.from)));

    const blocked = await fixture();
    await mkdir(blocked.to, { recursive: true });
    await writeFile(path.join(blocked.to, "leftover.txt"), "x", "utf8");
    const bh = fakeDeps(blocked.user);
    const run = await migrateHome({ from: blocked.from, to: blocked.to, ...apply }, bh.deps, (e) => bh.events.push(e));
    assert.equal(run.outcome, "blocked");
    await assert.rejects(() => readFile(migrateInProgressPath(blocked.from)));
    await rm(blocked.root, { recursive: true, force: true });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stdout EPIPE mid-run: events switch to the migrate-run.ndjson file and the result file still lands", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  const stdoutLines: string[] = [];
  const fileEntries: Array<{ file: string; line: string }> = [];
  let stdoutWrites = 0;
  // Break stdout after the preflight events — the drill shape (the app died
  // mid-apply, so the very next emit hits the dead pipe).
  const sink = createMigrationEventSink(f.from, f.to, {
    writeStdout: (line) => {
      stdoutWrites += 1;
      if (stdoutWrites > 2) {
        const error = new Error("write EPIPE") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        throw error;
      }
      stdoutLines.push(line);
    },
    onStdoutError: () => {},
    ignoreSignals: () => {},
    appendFileSync: (file, line) => {
      fileEntries.push({ file, line });
    },
  });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (event) =>
      sink.emitLine(`${JSON.stringify(event)}\n`),
    );
    assert.equal(run.outcome, "success");
    assert.equal(sink.stdoutBroken(), true);
    // No emit ever escaped as a throw — the run reached finish().
    const result = JSON.parse(await readFile(migrateResultPath(f.to), "utf8"));
    assert.equal(result.result, "success");
    // The final summary line went through the same hardened sink.
    sink.emitLine(`${JSON.stringify(result)}\n`);
    // Post-move, the fallback resolves to the TARGET home; every event after
    // the break is in the file and none was lost.
    assert.ok(fileEntries.length >= 10, `expected the remaining events in the file, got ${fileEntries.length}`);
    assert.ok(stdoutLines.length === 2);
    const fileText = fileEntries.map((entry) => entry.line).join("");
    assert.match(fileText, /"step":"start"/);
    assert.match(fileText, /"step":"self-check"/);
    const lastEntry = fileEntries.at(-1)!;
    const lastLine = JSON.parse(lastEntry.line.trim());
    assert.equal(lastLine.result, "success");
    // The fallback path rides the home: pre-move lines ride the SOURCE home
    // (the rename then carries that file to the target — by inode it IS the
    // same file), post-move lines resolve the target spelling directly.
    const allowed = new Set([migrateRunLogPath(f.from), migrateRunLogPath(f.to)]);
    for (const entry of fileEntries) assert.ok(allowed.has(entry.file), `unexpected fallback path ${entry.file}`);
    assert.equal(lastEntry.file, migrateRunLogPath(f.to));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("sink: async stdout 'error' event flips to the file; non-EPIPE errors still throw", () => {
  const fileLines: string[] = [];
  let errorHandler: ((error: Error) => void) | undefined;
  const sink = createMigrationEventSink("/from-home", "/to-home", {
    writeStdout: (line) => {
      if (line.includes("die")) {
        const error = new Error("write EPIPE") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        throw error;
      }
    },
    onStdoutError: (handler) => {
      errorHandler = handler;
    },
    ignoreSignals: () => {},
    appendFileSync: (_file, line) => {
      fileLines.push(line);
    },
    homeComputerExists: () => false,
  });
  // Async EPIPE arrives on the stream's 'error' event before any throw.
  const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
  epipe.code = "EPIPE";
  errorHandler!(epipe);
  assert.equal(sink.stdoutBroken(), true);
  sink.emitLine("after-async-epipe\n");
  assert.deepEqual(fileLines, ["after-async-epipe\n"]);
  // Non-EPIPE stream errors keep their crash semantics.
  assert.throws(() => errorHandler!(new Error("EBADF: bad file descriptor")), /EBADF/);
});

test("sink: the fallback home never resurrects a rolled-back (empty) target dir", () => {
  // Post-rollback shape: <to> exists but has NO computer/ dir (the rollback
  // restored an empty target); the real home is back at <from>.
  const fileLines: string[] = [];
  const sink = createMigrationEventSink("/from-home", "/to-home", {
    writeStdout: () => {
      const error = new Error("write EPIPE") as NodeJS.ErrnoException;
      error.code = "EPIPE";
      throw error;
    },
    onStdoutError: () => {},
    ignoreSignals: () => {},
    appendFileSync: (file, line) => {
      fileLines.push(`${file}::${line}`);
    },
    homeComputerExists: (home) => home === "/from-home",
  });
  sink.emitLine("rollback-tail\n");
  assert.match(fileLines[0]!, /^\/from-home\/computer\/migrate-run\.ndjson::/);
});

// --- hard deadline + SIGTERM cancellation (PM fix #288) ---

test("abort signal (SIGTERM shape): forward steps cancel into rollback, which the signal never interrupts", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  const cancel = new AbortController();
  h.deps.abortSignal = cancel.signal;
  // Abort DURING the stop step's service stop — the next step boundary
  // (move) must fail with the cancellation reason and roll everything back.
  h.deps.stopServiceAt = async (home) => {
    h.stopCalls.push(home);
    cancel.abort();
  };
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    assert.match(run.result?.error ?? "", /cancelled by SIGTERM/);
    assert.equal(run.result?.rollback?.ok, true);
    // Rollback immunity in practice: the undo journal ran to completion
    // (home back, alias back) even though the signal stayed aborted.
    assert.equal((await stat(f.from)).isDirectory(), true);
    const failed = h.events.find((e) => e.status === "fail");
    // The abortable wait interrupts the STOP step itself (1.0.34), not the
    // next step boundary.
    assert.equal(failed?.step, "stop");
    const rollbackEvent = h.events.filter((e) => e.step === "rollback").at(-1);
    assert.equal(rollbackEvent?.status, "ok");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("deadline: exceeding it mid-run fails the current step into rollback; the rollback is not deadline-bound", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  // Deterministic clock: t0 at run start, then jump far past the deadline
  // so the check at the move step boundary trips.
  let clock = 1_700_000_000_000;
  h.deps.now = () => new Date(clock);
  h.deps.stopServiceAt = async (home) => {
    h.stopCalls.push(home);
    clock += 10 * 60_000; // the deadline (startedAt + 1min) is now far past
  };
  try {
    const run = await migrateHome(
      { from: f.from, to: f.to, ...apply, deadlineAt: 1_700_000_000_000 + 60_000 },
      h.deps,
      (e) => h.events.push(e),
    );
    assert.equal(run.outcome, "rolled_back");
    assert.match(run.result?.error ?? "", /deadline exceeded/);
    assert.equal(run.result?.rollback?.ok, true);
    assert.equal((await stat(f.from)).isDirectory(), true);
    const failed = h.events.find((e) => e.status === "fail");
    assert.equal(failed?.step, "stop");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("parseMigrateDeadline: epoch milliseconds, ISO 8601, and the invalid shape", () => {
  assert.equal(parseMigrateDeadline("1770000000000"), 1_770_000_000_000);
  assert.equal(parseMigrateDeadline("2026-10-10T00:00:00.000Z"), Date.parse("2026-10-10T00:00:00.000Z"));
  assert.throws(() => parseMigrateDeadline("in-a-while"), /MIGRATE_DEADLINE_INVALID/);
  assert.throws(() => parseMigrateDeadline("-5"), /MIGRATE_DEADLINE_INVALID/);
});

test("dry-run ignores the deadline and the abort signal (nothing to roll back)", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  const cancel = new AbortController();
  cancel.abort();
  h.deps.abortSignal = cancel.signal;
  try {
    const run = await migrateHome(
      { from: f.from, to: f.to, ...dry, deadlineAt: 1 },
      h.deps,
      (e) => h.events.push(e),
    );
    assert.equal(run.outcome, "planned");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("no explicit --deadline: the default (startedAt + 10 min) is enforced and matches the marker (PM review on #290)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  // Deterministic clock: t0 at run start, then jump past t0 + 10 min during
  // the stop step — the next step boundary must abort on the DEFAULT.
  let clock = 1_700_000_000_000;
  h.deps.now = () => new Date(clock);
  let markerDeadlineSeen: number | null = null;
  h.deps.stopServiceAt = async (home) => {
    h.stopCalls.push(home);
    const marker = JSON.parse(await readFile(migrateInProgressPath(f.from), "utf8"));
    markerDeadlineSeen = Date.parse(marker.deadlineAt);
    clock += MIGRATE_IN_PROGRESS_DEADLINE_MS + 1;
  };
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    assert.match(run.result?.error ?? "", /deadline exceeded/);
    assert.equal(run.result?.rollback?.ok, true);
    // The enforced deadline IS the marker's deadlineAt (t0 + 10 min).
    assert.equal(markerDeadlineSeen, 1_700_000_000_000 + MIGRATE_IN_PROGRESS_DEADLINE_MS);
    const failed = h.events.find((e) => e.status === "fail");
    assert.equal(failed?.step, "move");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// --- start-step interruption + reason field (PM #292, 1.0.34) ---

test("cancel while the start step is stuck: fails into rollback within ~1s, reason=cancelled", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  const cancel = new AbortController();
  h.deps.abortSignal = cancel.signal;
  h.deps.abandonedWaitTimeoutMs = 1000;
  // The start step's daemon wait never settles on its own (the xai shape:
  // unreachable server → START_DAEMON_TIMEOUT would only fire late). Only
  // the FIRST call hangs — the rollback's undo and the source restart must
  // still be able to settle through the same seam.
  let startCalls = 0;
  h.deps.startServiceAt = async (home: string) => {
    startCalls += 1;
    h.startCalls.push(home);
    if (startCalls === 1) await new Promise<void>(() => {});
  };
  const began = Date.now();
  setTimeout(() => cancel.abort(), 1200);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    const elapsed = Date.now() - began;
    assert.equal(run.outcome, "rolled_back");
    assert.equal(run.result?.reason, "cancelled");
    assert.match(run.result?.error ?? "", /start aborted: cancelled by SIGTERM/);
    assert.equal(run.result?.rollback?.ok, true);
    assert.equal((await stat(f.from)).isDirectory(), true);
    assert.ok(elapsed < 6000, `cancel must interrupt the start wait promptly, took ${elapsed}ms`);
    const failed = h.events.find((e) => e.status === "fail");
    assert.equal(failed?.step, "start");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("deadline while the start step is stuck: reason=deadline", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  h.deps.abandonedWaitTimeoutMs = 1000;
  let startCalls2 = 0;
  h.deps.startServiceAt = async (home: string) => {
    startCalls2 += 1;
    h.startCalls.push(home);
    if (startCalls2 === 1) await new Promise<void>(() => {});
  };
  const began = Date.now();
  try {
    const run = await migrateHome(
      { from: f.from, to: f.to, ...apply, deadlineAt: Date.now() + 800 },
      h.deps,
      (e) => h.events.push(e),
    );
    const elapsed = Date.now() - began;
    assert.equal(run.outcome, "rolled_back");
    assert.equal(run.result?.reason, "deadline");
    assert.match(run.result?.error ?? "", /start aborted: deadline exceeded/);
    assert.equal(run.result?.rollback?.ok, true);
    assert.ok(elapsed < 6000, `deadline must interrupt the start wait promptly, took ${elapsed}ms`);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("plain step failures keep reason=null (no abort flags set)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user, { statuses: [{ serviceRunning: false, serverCount: 1, serversOnline: false }] });
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "rolled_back");
    assert.equal(run.result?.reason, null);
    assert.match(run.result?.error ?? "", /self-check timed out/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// --- abandoned start spawning after the rollback began (PM review on #292) ---

async function runLateSpawnScenario(opts: { alsoCreateTargetFiles: boolean }) {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  const cancel = new AbortController();
  h.deps.abortSignal = cancel.signal;
  h.deps.abandonedWaitTimeoutMs = 3000;
  // Real (bounded) sleeps so the rollback's abandoned-wait actually waits.
  h.deps.sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 50)));
  let startCalls = 0;
  h.deps.startServiceAt = async (home: string) => {
    startCalls += 1;
    h.startCalls.push(home);
    if (startCalls === 1) {
      // The abandoned runStart: settles only AFTER the cancel, and its
      // convergence work "spawns" a detached runner at that late moment
      // (plus, in variant b, recreates files under the moved-back target).
      await new Promise<void>((resolveLate) => {
        setTimeout(async () => {
          h.liveProcesses.set(99123, { pid: 99123, kind: "runner", serverId: ATTACHED_SERVER_ID });
          if (opts.alsoCreateTargetFiles) {
            await mkdir(path.join(f.to, "computer", "run"), { recursive: true });
          }
          resolveLate();
        }, 1800);
      });
    }
  };
  setTimeout(() => cancel.abort(), 1000);
  try {
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    return { run, harness: h, f };
  } catch (err) {
    await rm(f.root, { recursive: true, force: true });
    throw err;
  }
}

test("late spawn after cancel: no process residue, target path restored, rollback ok (PM #292 review)", async () => {
  const { run, harness: h, f } = await runLateSpawnScenario({ alsoCreateTargetFiles: false });
  try {
    assert.equal(run.outcome, "rolled_back");
    assert.equal(run.result?.reason, "cancelled");
    assert.equal(run.result?.rollback?.ok, true, `unexpected undo errors: ${run.result?.rollback?.detail}`);
    // The late-spawned runner was reaped by the post-rollback sweep.
    assert.equal([...h.liveProcesses.values()].length, 0, "no process of the abandoned start may survive");
    // The home is back at the source; the target is in its promised shape.
    assert.equal((await stat(f.from)).isDirectory(), true);
    await assert.rejects(() => stat(f.to));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("late spawn that also recreates target files is REPORTED, never silently passed (PM #292 review)", async () => {
  const { run, harness: h, f } = await runLateSpawnScenario({ alsoCreateTargetFiles: true });
  try {
    // The rollback did its best (process reaped) but the target path was
    // left non-empty — that is an undo error surfaced in the result file.
    assert.equal(run.outcome, "failed");
    assert.equal(run.result?.reason, "cancelled");
    assert.equal(run.result?.rollback?.ok, false);
    assert.match(run.result?.rollback?.detail ?? "", /target path left non-empty after rollback/);
    assert.equal([...h.liveProcesses.values()].length, 0);
    assert.equal((await stat(f.from)).isDirectory(), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// --- target socket path length guard (PM fix, drill 290-anna finding) ---

test("preflight: a target whose service.sock path exceeds the AF_UNIX limit is blocked before any mutation", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  // A deep target home: path.join(long prefixes) until the socket path is
  // over 103 bytes.
  const deep = path.join(f.root, "a-very-long-directory-name-padding", "nested-further", "and-further-still", "target-home");
  try {
    const run = await migrateHome({ from: f.from, to: deep, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    const preflight = h.events.filter((e) => e.step === "preflight").at(-1);
    assert.match(JSON.stringify(preflight?.detail?.blockers), /AF_UNIX limit/);
    // Blocked applies mutate nothing and write neither marker nor result.
    await assert.rejects(() => readFile(migrateInProgressPath(f.from)));
    await assert.rejects(() => readFile(migrateResultPath(f.from)));
    assert.equal((await stat(f.from)).isDirectory(), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("serviceSocketPathTooLong: boundary and platform behavior", () => {
  // Windows named pipes never trip the guard.
  assert.equal(serviceSocketPathTooLong("/" + "x".repeat(300), "win32"), false);
  // Exactly at the limit passes; one byte over fails.
  const suffixBytes = Buffer.byteLength("/computer/run/service.sock", "utf8");
  const homeAtLimit = "/" + "h".repeat(103 - 1 - suffixBytes);
  assert.equal(Buffer.byteLength(path.join(homeAtLimit, "computer", "run", "service.sock"), "utf8"), 103);
  assert.equal(serviceSocketPathTooLong(homeAtLimit), false);
  assert.equal(serviceSocketPathTooLong(homeAtLimit + "x"), true);
});

test("lib surface: the shared sweep ladder and spellings helper are importable for the Desktop host", async () => {
  const lib = await import("./lib/homeProcessSweep.js");
  type LibHomeProcess = import("./lib/homeProcessSweep.js").HomeProcess;
  assert.equal(typeof lib.sweepHomeProcesses, "function");
  assert.equal(typeof lib.defaultScanHomeProcesses, "function");
  assert.equal(typeof lib.defaultKillHomeProcess, "function");
  assert.equal(typeof lib.argvMentionsHome, "function");
  assert.equal(typeof lib.mentionsWithBoundary, "function");
  assert.deepEqual(lib.homeProcessSpellings("/a", "/a", "/a"), ["/a"]);
  assert.deepEqual(lib.homeProcessSpellings("/real", "/arg", null), ["/real", "/arg"]);
  // The ladder itself through fakes: one TERM-resistant process gets KILLed.
  const procs = new Map<number, LibHomeProcess>([[42, { pid: 42, kind: "runner", serverId: "s1" }]]);
  let termSeen = false;
  const remaining = await lib.sweepHomeProcesses(["/h"], {
    scanHomeProcesses: async () => [...procs.values()],
    killHomeProcess: (pid, signal) => {
      if (signal === "SIGTERM") termSeen = true;
      if (signal === "SIGKILL") procs.delete(pid);
    },
    sleep: async () => {},
    sweepTimeoutMs: 100,
  });
  assert.equal(termSeen, true);
  assert.deepEqual(remaining, []);
});

test("early bootstrap armor: argv-gated handlers install on import for migrate-home only", async () => {
  const savedArgv = process.argv;
  const countBefore = { pipe: process.listenerCount("SIGPIPE"), hup: process.listenerCount("SIGHUP") };
  try {
    process.argv = ["node", "raft-computer", "migrate-home", "--apply"];
    // The query busts the ESM cache so the module re-evaluates under the
    // new argv; TypeScript cannot resolve query-suffixed specifiers.
    // @ts-expect-error intentional cache-busting query import
    await import("./earlySignals.js?v=armed");
    assert.ok(process.listenerCount("SIGPIPE") >= countBefore.pipe + 1);
    assert.ok(process.listenerCount("SIGHUP") >= countBefore.hup + 1);
    assert.ok(process.stdout.listenerCount("error") >= 1);

    const counts = { pipe: process.listenerCount("SIGPIPE"), hup: process.listenerCount("SIGHUP"), out: process.stdout.listenerCount("error") };
    process.argv = ["node", "raft-computer", "status"];
    // @ts-expect-error intentional cache-busting query import
    await import("./earlySignals.js?v=unarmed");
    assert.equal(process.listenerCount("SIGPIPE"), counts.pipe, "other commands add nothing");
    assert.equal(process.listenerCount("SIGHUP"), counts.hup);
    assert.equal(process.stdout.listenerCount("error"), counts.out);
  } finally {
    process.argv = savedArgv;
  }
});

test("sessions: every spelling of the old home is renamed — alias-encoded dirs move too (owner migration 2026-10-10)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    // The live-incident shape: the agent cwd went through the ~/.slock-raft
    // ALIAS, so the actually-used project dir is alias-encoded while the
    // realpath-encoded dir also exists (older sessions).
    const aliasAgentsDir = path.join(
      f.projectsDir,
      `${encodeProjectDirName(f.alias)}-agents-a1`,
    );
    await mkdir(aliasAgentsDir, { recursive: true });
    await writeFile(path.join(aliasAgentsDir, "history.jsonl"), "[]", "utf8");
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    // Both spellings landed at the SAME new-prefix dir — the alias-encoded
    // history merged into the dir the realpath rename produced.
    const mergedDir = path.join(f.projectsDir, `${encodeProjectDirName(f.to)}-agents-a1`);
    assert.equal((await stat(path.join(mergedDir, "history.jsonl"))).isFile(), true);
    const sessions = h.events.filter((e) => e.step === "sessions").at(-1);
    assert.equal(sessions?.detail?.renamed, 1, "realpath-encoded dir renamed");
    assert.equal(sessions?.detail?.merged, 1, "alias-encoded dir merged into it");
    assert.deepEqual(sessions?.detail?.mergeConflicts, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("sessions: a name collision keeps the target's file and reports it", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    // Both sides hold a file with the SAME name — the target's byte content
    // must win and the collision must be reported (PM: 不覆盖已有文件).
    const aliasAgentsDir = path.join(f.projectsDir, `${encodeProjectDirName(f.alias)}-agents-a1`);
    await mkdir(aliasAgentsDir, { recursive: true });
    await writeFile(path.join(aliasAgentsDir, "session.jsonl"), "alias-side", "utf8");
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    const mergedFile = path.join(f.projectsDir, `${encodeProjectDirName(f.to)}-agents-a1`, "session.jsonl");
    assert.equal(await readFile(mergedFile, "utf8"), "[]", "the pre-existing target file wins");
    const sessions = h.events.filter((e) => e.step === "sessions").at(-1);
    assert.deepEqual(sessions?.detail?.mergeConflicts, ["session.jsonl"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("cursor-sessions: agents.ndjson cwd is rewritten to the new home spelling", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    const agentId = "3fa7c2d2-fixture";
    const storeDir = path.join(f.from, "cursor-sdk-host", agentId, "store");
    await mkdir(storeDir, { recursive: true });
    const oldCwd = `${f.alias}/agents/${agentId}`;
    const lines = [
      JSON.stringify({ agentId: "agent-a", cwd: oldCwd, status: "running" }),
      JSON.stringify({ agentId: "agent-b", cwd: `${f.from}/agents/${agentId}`, status: "idle" }),
      JSON.stringify({ agentId: "agent-c", cwd: "/Users/someone/elsewhere", status: "idle" }),
      "",
    ].join("\n");
    await writeFile(path.join(storeDir, "agents.ndjson"), lines, "utf8");
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    const after = (await readFile(path.join(f.to, "cursor-sdk-host", agentId, "store", "agents.ndjson"), "utf8"))
      .split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { cwd: string });
    assert.equal(after[0].cwd, `${f.to}/agents/${agentId}`, "alias spelling rewritten");
    assert.equal(after[1].cwd, `${f.to}/agents/${agentId}`, "realpath spelling rewritten");
    assert.equal(after[2].cwd, "/Users/someone/elsewhere", "foreign cwd untouched");
    // Original byte-captured into migrate-backup for the rollback.
    const backup = await readFile(path.join(f.to, "computer", "migrate-backup", `cursor-sdk-${agentId}-agents.ndjson`), "utf8");
    assert.equal(backup, lines);
    const cursor = h.events.filter((e) => e.step === "cursor-sessions").at(-1);
    assert.equal(cursor?.detail?.rewritten, 2);
    assert.equal(cursor?.detail?.files, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("restore-agents: an agent that fails to come back leaves a SUCCESS with agentsNotRestored (no rollback)", async () => {
  const f = await fixture({ livePid: true });
  const h = fakeDeps(f.user);
  try {
    // Phase 1 (record): active. Phase 2+ (restore/poll): the server has it
    // inactive and rejects the restart (PM decision 2026-10-10: the move is
    // done and the computer is healthy — a stuck agent is a manual-Start
    // warning, never a reason to churn every agent back to the old home).
    h.rosterPhases.push([{ id: "agent-fixture-1", name: "fixture-one", status: "inactive", runtime: "claude" }]);
    h.startStatus.code = 500;
    const run = await migrateHome({ from: f.from, to: f.to, ...apply }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "success");
    assert.deepEqual(
      run.result?.agentsNotRestored?.map((entry) => ({ agentId: entry.agentId, reason: entry.reason })),
      [{ agentId: "agent-fixture-1", reason: "start-failed" }],
    );
    const selfCheck = h.events.filter((e) => e.step === "self-check").at(-1);
    assert.equal(selfCheck?.status, "ok", "computer health passed; the missing agent is a warning");
    assert.ok(!h.events.some((e) => e.step === "rollback"), "a missing agent never triggers a rollback");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
