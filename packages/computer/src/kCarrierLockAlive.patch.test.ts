// Task #12: the patched k-carrier upgrade lock (pnpm patchedDependencies)
// must not be wedged by an EXITED-but-unreaped holder. These tests run the
// REAL acquire/release path of the actually-installed dependency — the
// zombie holder is manufactured for real (a Python parent forks a child
// that exits and holds the corpse until we tell it to waitpid), and the
// conservative branches force holder states through the lock's injection
// seam instead of depending on kernel luck.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  acquireUpgradeLock,
  UpgradeLockError,
  type UpgradeLockDeps,
} from "@botiverse/k-carrier";

const isPosix = process.platform === "linux" || process.platform === "darwin";

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

async function tempStateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "k-lock-alive-"));
}

async function writeLockRecord(stateDir: string, pid: number): Promise<string> {
  const lockPath = path.join(stateDir, "upgrade.lock");
  await writeFile(lockPath, JSON.stringify({ pid, acquiredAtMs: Date.now() }));
  return lockPath;
}

test("zombie holder: the real lock is taken over, fixture reaps itself in finally", { timeout: 20_000 }, async () => {
  if (!isPosix) return;
  const python = pythonParentCommand();
  if (python === null) return; // fixture tool unavailable: explicit skip
  const parent = spawn(python, ["-c", PYTHON_PARENT], {
    stdio: ["pipe", "pipe", "inherit"],
  }) as ChildProcessWithoutNullStreams;
  let out = "";
  parent.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  while (!out.trim() && parent.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const zombiePid = Number.parseInt(out.trim().split("\n")[0]!, 10);
  assert.ok(Number.isInteger(zombiePid) && zombiePid > 0);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stateDir = await tempStateDir();
  try {
    // Precondition: the holder really is an unreaped corpse that still
    // answers signal 0 — the exact shape that used to wedge the lock.
    assert.doesNotThrow(() => process.kill(zombiePid, 0));
    await writeLockRecord(stateDir, zombiePid);
    // The REAL acquire path (default predicate) must take the lock over.
    const lock = await acquireUpgradeLock(stateDir, Date.now());
    await lock.release();
  } finally {
    if (parent.exitCode === null && !parent.stdin.destroyed) {
      try { parent.stdin.write("\n"); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      parent.once("close", () => { clearTimeout(timer); resolve(); });
    });
    if (parent.exitCode === null) {
      try { parent.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await rm(stateDir, { recursive: true, force: true });
  }
  // No residue: the parent reaped its zombie and exited.
  assert.equal(parent.exitCode, 0);
  assert.throws(() => process.kill(zombiePid, 0), /ESRCH/);
});

test("running holder: the real lock refuses takeover (no injection — real pid)", { timeout: 15_000 }, async () => {
  if (!isPosix) return;
  const python = pythonParentCommand();
  if (python === null) return; // fixture tool unavailable: explicit skip
  const parent = spawn(python, ["-c", "import sys; sys.stdin.readline()"], {
    stdio: ["pipe", "inherit", "inherit"],
  }) as ChildProcessWithoutNullStreams;
  try {
    const stateDir = await tempStateDir();
    try {
      await writeLockRecord(stateDir, parent.pid!);
      await assert.rejects(
        acquireUpgradeLock(stateDir, Date.now()),
        (err: unknown) => err instanceof UpgradeLockError,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  } finally {
    if (parent.exitCode === null) {
      try { parent.stdin.write("\n"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        parent.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (parent.exitCode === null) {
        try { parent.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
});

test("state-query failure and pid reuse: conservative ALIVE holder is never taken over (seam, real path)", { timeout: 10_000 }, async () => {
  if (!isPosix) return;
  const stateDir = await tempStateDir();
  try {
    await writeLockRecord(stateDir, 424_242);
    // A state query that cannot answer ("is this pid alive?" → conservatively
    // yes) must NOT let the lock be taken over from a possibly-running holder.
    const unconfirmed: UpgradeLockDeps = { isProcessAlive: () => true };
    await assert.rejects(
      acquireUpgradeLock(stateDir, Date.now(), unconfirmed),
      (err: unknown) => err instanceof UpgradeLockError,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("confirmed-dead holder via seam: takeover then release then re-acquire (real path)", { timeout: 10_000 }, async () => {
  const stateDir = await tempStateDir();
  try {
    await writeLockRecord(stateDir, 424_243);
    const dead: UpgradeLockDeps = { isProcessAlive: () => false };
    const lock = await acquireUpgradeLock(stateDir, Date.now(), dead);
    await lock.release();
    // After release the lock is free again for the next transaction.
    const second = await acquireUpgradeLock(stateDir, Date.now(), dead);
    await second.release();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
