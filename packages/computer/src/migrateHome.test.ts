import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  aliasPathFor,
  defaultListSourceCarriers,
  encodeProjectDirName,
  homeEnvPlistPath,
  mentionsPathBounded,
  migrateHome,
  migrateResultPath,
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
async function fixture(
  opts: { livePid?: boolean; stopped?: boolean; alias?: boolean; homeEnv?: boolean; oldCarrier?: boolean } = {},
) {
  // realpath up front: preflight resolves through symlinks (macOS /tmp → /private/tmp),
  // and the tests compare against the resolved paths.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "migrate-home-")));
  const user = path.join(root, "user");
  const from = path.join(user, "embedded");
  const to = path.join(user, ".slock");
  await mkdir(path.join(from, "agents", "a1"), { recursive: true });
  await mkdir(path.join(from, "agents", "a2"), { recursive: true });
  await mkdir(path.join(from, "computer", "servers", "s1"), { recursive: true });
  await mkdir(path.join(from, "computer", "run"), { recursive: true });
  if (opts.livePid) {
    // The vitest worker itself is a live pid — isProcessAlive() sees it.
    await writeFile(path.join(from, "computer", "run", "service.pid"), `${process.pid}\n`, "utf8");
  }
  if (opts.stopped) {
    await writeDesiredState(from, "stopped");
  }
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
  const sessionClashTarget = path.join(projectsDir, `${newPrefix}-agents-a2`);
  await mkdir(sessionA, { recursive: true });
  await mkdir(sessionClash, { recursive: true });
  await mkdir(sessionUnrelated, { recursive: true });
  await mkdir(sessionClashTarget, { recursive: true });
  await writeFile(path.join(sessionA, "session.jsonl"), "[]", "utf8");
  return { root, user, from, to, alias, carrierPlist, projectsDir, sessionA, sessionClash, sessionUnrelated, sessionClashTarget };
}

function fakeDeps(user: string, overrides: { statuses?: MigrateHomeStatus[] } = {}) {
  const events: MigrateEvent[] = [];
  const stopCalls: string[] = [];
  const startCalls: string[] = [];
  const convergeCalls: Array<[string, "enabled" | "disabled"]> = [];
  const launchctlCalls: string[][] = [];
  let poll = 0;
  const deps: MigrateHomeDeps = {
    homeDir: user,
    uid: 501,
    env: {},
    sleep: async () => {},
    selfCheckTimeoutMs: 200,
    selfCheckPollMs: 1,
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
  return { deps, events, stopCalls, startCalls, convergeCalls, launchctlCalls };
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
    assert.deepEqual(statuses, Array.from({ length: 9 }, () => "planned"));
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
    // Durable backups of every deleted plist + recorded in the result file.
    const backupDir = path.join(f.to, "computer", "migrate-backup");
    assert.match(await readFile(path.join(backupDir, "build.raft.computer.test-carrier.plist"), "utf8"), /--slock-home/);
    assert.match(await readFile(path.join(backupDir, "build.raft.desktop.home-env.plist"), "utf8"), /home-env fixture/);
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
        "stop:start",
        "stop:ok",
        "move:start",
        "move:ok",
        "alias:start",
        "alias:ok",
        "sessions:start",
        "sessions:ok",
        "home-env:start",
        "home-env:ok",
        "backup:start",
        "backup:ok",
        "start:start",
        "start:ok",
        "self-check:start",
        "self-check:ok",
      ],
    );
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

test("preflight: from === to is blocked", async () => {
  const f = await fixture();
  const h = fakeDeps(f.user);
  try {
    const run = await migrateHome({ from: f.to, to: f.to, ...dry }, h.deps, (e) => h.events.push(e));
    assert.equal(run.outcome, "blocked");
    assert.match(JSON.stringify(h.events.filter((e) => e.step === "preflight").at(-1)?.detail?.blockers), /distinct/);
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
