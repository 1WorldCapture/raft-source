import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  agentPurgeTargets, agentTrashRetentionMs, isCursorHostLockHeld, isPurgeableAgentId, moveAgentDirectoriesToTrash, sweepAgentTrash,
} from "./agentPurge.js";

const AGENT = "8d44e2f2-4752-4ddf-b4b4-1226da8cf3aa";
const OTHER = "11111111-2222-4333-8444-555555555555";
let home: string;

beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "raft-purge-test-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const targets = () => agentPurgeTargets(home, path.join(home, "agents"));
async function seed(id: string) {
  for (const dir of ["agents", "cli-transport", "cursor-sdk-host"]) {
    await mkdir(path.join(home, dir, id), { recursive: true });
    await writeFile(path.join(home, dir, id, "data.txt"), `${dir}-${id}`);
  }
}
const exists = (p: string) => stat(p).then(() => true, () => false);

test("only strict UUIDs can become paths", () => {
  expect(isPurgeableAgentId(AGENT)).toBe(true);
  for (const bad of ["", "../etc", "..", AGENT + "/..", "8d44e2f2-4752-4ddf-b4b4", AGENT.toUpperCase() + "x", `${AGENT}\0`, 42, null, undefined]) {
    expect(isPurgeableAgentId(bad as unknown)).toBe(false);
  }
});

test("directories move into trash, the originals disappear, and other agents are untouched", async () => {
  await seed(AGENT); await seed(OTHER);
  const now = new Date("2026-10-07T14:56:49.123Z");
  expect(await moveAgentDirectoriesToTrash({ agentId: AGENT, slockHome: home, targets: targets(), now })).toBe("purged");
  for (const dir of ["agents", "cli-transport", "cursor-sdk-host"]) {
    expect(await exists(path.join(home, dir, AGENT))).toBe(false);
    const moved = path.join(home, "trash", dir, `${AGENT}-2026-10-07T14-56-49.123Z`);
    expect(await readFile(path.join(moved, "data.txt"), "utf8")).toBe(`${dir}-${AGENT}`);
    expect(await exists(path.join(home, dir, OTHER, "data.txt"))).toBe(true);
  }
});

test("a repeated purge is idempotent and a partially present agent still moves what exists", async () => {
  await mkdir(path.join(home, "agents", AGENT), { recursive: true });
  expect(await moveAgentDirectoriesToTrash({ agentId: AGENT, slockHome: home, targets: targets() })).toBe("purged");
  expect(await moveAgentDirectoriesToTrash({ agentId: AGENT, slockHome: home, targets: targets() })).toBe("nothing_to_purge");
});

test("an invalid id is refused before any filesystem access", async () => {
  await seed(AGENT);
  await expect(moveAgentDirectoriesToTrash({ agentId: "../agents/" + AGENT, slockHome: home, targets: targets() })).rejects.toThrow(/UUID/);
  expect(await exists(path.join(home, "agents", AGENT))).toBe(true);
});

test("a symlinked agent directory is refused and nothing is moved, not even the other targets", async () => {
  await seed(AGENT);
  const outside = await mkdtemp(path.join(os.tmpdir(), "raft-purge-outside-"));
  try {
    await rm(path.join(home, "cli-transport", AGENT), { recursive: true });
    await symlink(outside, path.join(home, "cli-transport", AGENT));
    await expect(moveAgentDirectoriesToTrash({ agentId: AGENT, slockHome: home, targets: targets() })).rejects.toThrow(/not a plain directory/);
    expect(await exists(path.join(home, "agents", AGENT, "data.txt"))).toBe(true);
    expect(await exists(path.join(home, "trash"))).toBe(false);
    expect(await exists(outside)).toBe(true);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("retention defaults to 14 days and the env var overrides it", () => {
  expect(agentTrashRetentionMs({})).toBe(14 * 24 * 3600 * 1000);
  expect(agentTrashRetentionMs({ RAFT_AGENT_TRASH_RETENTION_DAYS: "2" })).toBe(2 * 24 * 3600 * 1000);
  expect(agentTrashRetentionMs({ RAFT_AGENT_TRASH_RETENTION_DAYS: "abc" })).toBe(14 * 24 * 3600 * 1000);
});

test("the sweeper removes only entries older than the retention, ignores foreign names, and reports what remains", async () => {
  const old = new Date("2026-09-01T00:00:00.000Z");
  const fresh = new Date("2026-10-06T00:00:00.000Z");
  const now = new Date("2026-10-07T00:00:00.000Z");
  await seed(AGENT); await seed(OTHER);
  await moveAgentDirectoriesToTrash({ agentId: AGENT, slockHome: home, targets: targets(), now: old });
  await moveAgentDirectoriesToTrash({ agentId: OTHER, slockHome: home, targets: targets(), now: fresh });
  // things the sweeper must never touch
  await mkdir(path.join(home, "trash", "agents", "not-ours"), { recursive: true });
  await mkdir(path.join(home, "trash", "agents", `${AGENT}-old-looking-but-not-a-timestamp`), { recursive: true });
  await writeFile(path.join(home, "trash", "agents", "stray.txt"), "x");

  const result = await sweepAgentTrash({ slockHome: home, now, retentionMs: 14 * 24 * 3600 * 1000 });
  expect(result.removed).toBe(3);      // the 3 old per-kind entries
  expect(result.remaining).toBe(3);    // the 3 fresh per-kind entries
  expect(result.remainingBytes).toBeGreaterThan(0);
  const agentsTrash = await readdir(path.join(home, "trash", "agents"));
  expect(agentsTrash.sort()).toEqual([
    `${AGENT}-old-looking-but-not-a-timestamp`, `${OTHER}-2026-10-06T00-00-00.000Z`, "not-ours", "stray.txt",
  ].sort());
  // a second run with nothing due removes nothing
  expect((await sweepAgentTrash({ slockHome: home, now, retentionMs: 14 * 24 * 3600 * 1000 })).removed).toBe(0);
});

test("sweeping with no trash directory is a no-op", async () => {
  expect(await sweepAgentTrash({ slockHome: home })).toEqual({ removed: 0, remaining: 0, remainingBytes: 0 });
});


async function writeLock(dir: string, body: string, ageMs = 0) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "host.lock");
  await writeFile(file, body);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
}

test("Cursor host lock: live owner pid = held; dead pid or no lock = free", async () => {
  const dir = path.join(home, "cursor-sdk-host", AGENT);
  expect(await isCursorHostLockHeld(dir)).toBe(false); // no directory, no lock
  await writeLock(dir, JSON.stringify({ pid: process.pid, token: "t" }));
  expect(await isCursorHostLockHeld(dir)).toBe(true);
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  await writeLock(dir, JSON.stringify({ pid: dead.pid, token: "t" }));
  expect(await isCursorHostLockHeld(dir)).toBe(false);
});

test("Cursor host lock: an unreadable lock counts as held only inside the short grace window", async () => {
  const dir = path.join(home, "cursor-sdk-host", AGENT);
  await writeLock(dir, "{not json");
  expect(await isCursorHostLockHeld(dir)).toBe(true);
  await writeLock(dir, "{not json", 5 * 60_000);
  expect(await isCursorHostLockHeld(dir)).toBe(false);
  await writeLock(dir, JSON.stringify({ token: "no-pid" }), 5 * 60_000);
  expect(await isCursorHostLockHeld(dir)).toBe(false);
});
