// Task #12: the patched k-carrier upgrade lock (pnpm patchedDependencies)
// must not be wedged by an EXITED-but-unreaped holder. These tests run the
// REAL acquire/release path of the actually-installed dependency. The zombie
// fixture is manufactured for real (a Python parent forks a child that exits
// and holds the corpse until told to waitpid — same shape and teardown
// discipline as PR #141's merged liveness tests: fixture reaps in finally,
// parent must finish waitpid with exit code 0, both pids verified gone via
// ESRCH even when an earlier assertion failed). Conservative branches are
// additionally exercised through the DEFAULT platform predicate — a real
// running holder (pid reuse shape) and a signal-0 EPERM holder — not only
// through the injection seam.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  acquireUpgradeLock,
  UpgradeLockError,
  type UpgradeLockDeps,
} from "@botiverse/k-carrier";

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";
const isPosix = isLinux || isDarwin;

const PYTHON_PARENT = [
  "import os, sys",
  "pid = os.fork()",
  "if pid == 0:",
  "    os._exit(0)",
  "print(pid, flush=True)",
  "sys.stdin.readline()",
  "os.waitpid(pid, 0)",
].join("\n");

let python3: string | null | undefined;
function pythonParentCommand(): string | null {
  if (python3 !== undefined) return python3;
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "print(1)"], { timeout: 5_000 });
    if (probe.status === 0) {
      python3 = candidate;
      return python3;
    }
  }
  python3 = null;
  return null;
}
const pythonAvailable = pythonParentCommand() !== null;

interface ZombieFixture {
  parent: ChildProcessWithoutNullStreams;
  zombiePid: number;
}

async function manufactureZombie(): Promise<ZombieFixture> {
  const parent = spawn(python3!, ["-c", PYTHON_PARENT], {
    stdio: ["pipe", "pipe", "inherit"],
  }) as ChildProcessWithoutNullStreams;
  let out = "";
  parent.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const deadline = Date.now() + 3_000;
  while (!out.trim() && parent.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const zombiePid = Number.parseInt(out.trim().split("\n")[0]!, 10);
  if (!Number.isInteger(zombiePid) || zombiePid > 0 === false) {
    const closed = new Promise<void>((resolve) => {
      if (parent.exitCode !== null || parent.signalCode !== null) resolve();
      else parent.once("close", () => resolve());
    });
    parent.stdin.end("\n");
    await closed;
    throw new Error(`python parent reported pid "${out.trim()}"`);
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { parent, zombiePid };
}

/** Same discipline as PR #141's merged fixture teardown (ESRCH proof). */
function assertPidGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ESRCH",
    `pid ${pid} must no longer exist, including as a zombie`);
}

async function reapFixture(fixture: ZombieFixture): Promise<void> {
  const parent = fixture.parent;
  const closed = new Promise<void>((resolve, reject) => {
    if (parent.exitCode !== null || parent.signalCode !== null) { resolve(); return; }
    parent.once("close", () => resolve());
    parent.once("error", reject);
  });
  parent.stdin.end("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture waitpid did not finish")), 3_000);
      }),
    ]);
    assert.equal(parent.exitCode, 0, "parent must finish waitpid successfully");
    assertPidGone(parent.pid!);
    assertPidGone(fixture.zombiePid);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tempStateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "k-lock-alive-"));
}

async function writeLockRecord(stateDir: string, pid: number): Promise<void> {
  await writeFile(
    path.join(stateDir, "upgrade.lock"),
    JSON.stringify({ pid, acquiredAtMs: Date.now() }),
  );
}

test.skipIf(!isPosix || !pythonAvailable)(
  "zombie holder: the real default predicate takes the lock over; fixture self-reaps",
  { timeout: 20_000 },
  async () => {
    const fixture = await manufactureZombie();
    const stateDir = await tempStateDir();
    try {
      // Precondition: the holder really is an unreaped corpse that still
      // answers signal 0 — the exact shape that used to wedge the lock.
      assert.doesNotThrow(() => process.kill(fixture.zombiePid, 0));
      await writeLockRecord(stateDir, fixture.zombiePid);
      const lock = await acquireUpgradeLock(stateDir, Date.now());
      await lock.release();
    } finally {
      await reapFixture(fixture);
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!isPosix || !pythonAvailable)(
  "running holder: the real default predicate refuses takeover",
  { timeout: 15_000 },
  async () => {
    const parent = spawn(python3!, ["-c", "import sys; sys.stdin.readline()"], {
      stdio: ["pipe", "inherit", "inherit"],
    }) as ChildProcessWithoutNullStreams;
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, parent.pid!);
      await assert.rejects(
        acquireUpgradeLock(stateDir, Date.now()),
        (err: unknown) => err instanceof UpgradeLockError,
      );
    } finally {
      const closed = new Promise<void>((resolve) => {
        if (parent.exitCode !== null || parent.signalCode !== null) resolve();
        else parent.once("close", () => resolve());
      });
      parent.stdin.end("\n");
      await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("holder fixture did not exit")), 3_000)),
      ]);
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!isPosix)(
  "pid-reuse shape: a live successor on the holder pid is never taken over (DEFAULT predicate, real pid)",
  { timeout: 10_000 },
  async () => {
    // A REAL running process (this test process) recorded as the "holder":
    // whatever the kernel did to arrive at this pid, a live process answers
    // the default predicate and takeover must be refused — the conservative
    // contract for a reused pid, proven without the injection seam.
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, process.pid);
      await assert.rejects(
        acquireUpgradeLock(stateDir, Date.now()),
        (err: unknown) => err instanceof UpgradeLockError,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!isPosix)(
  "EPERM holder: default predicate stays conservatively alive (real pid 1)",
  { timeout: 10_000 },
  async () => {
    // pid 1 (launchd/systemd) belongs to root: signal 0 from an unprivileged
    // user answers EPERM — "exists but not ours" — which must read alive and
    // refuse takeover, on the DEFAULT predicate with no injection. Running
    // as root (no EPERM) leaves nothing to assert here: inline skip.
    let eperm = false;
    try { process.kill(1, 0); } catch (err) {
      eperm = (err as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!eperm) return; // running as root or a platform without EPERM here
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, 1);
      await assert.rejects(
        acquireUpgradeLock(stateDir, Date.now()),
        (err: unknown) => err instanceof UpgradeLockError,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!isLinux)(
  "Linux state-query failure on the lock path: default predicate keeps the alive verdict",
  { timeout: 10_000 },
  async () => {
    // The /proc read inside the patched predicate is forced to fail for a
    // RUNNING holder: the real acquire path must keep the signal-0 verdict
    // (alive → refuse takeover). Module mock (not spyOn) — builtin exports
    // are non-configurable on some Node versions.
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => {
      const real = await orig<typeof import("node:fs")>();
      const failing = () => {
        throw Object.assign(new Error("i/o error"), { code: "EIO" });
      };
      return { ...real, readFileSync: failing };
    });
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, process.pid);
      const mod = await import("@botiverse/k-carrier");
      await assert.rejects(
        mod.acquireUpgradeLock(stateDir, Date.now()),
        (err: unknown) => err instanceof mod.UpgradeLockError,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  },
);

test.skipIf(!isPosix)(
  "seam parity: conservative-alive refuses, confirmed-dead takes over, releases, re-acquires",
  { timeout: 10_000 },
  async () => {
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, 424_242);
      const unconfirmed: UpgradeLockDeps = { isProcessAlive: () => true };
      await assert.rejects(
        acquireUpgradeLock(stateDir, Date.now(), unconfirmed),
        (err: unknown) => err instanceof UpgradeLockError,
      );
      const dead: UpgradeLockDeps = { isProcessAlive: () => false };
      const lock = await acquireUpgradeLock(stateDir, Date.now(), dead);
      await lock.release();
      const second = await acquireUpgradeLock(stateDir, Date.now(), dead);
      await second.release();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);
