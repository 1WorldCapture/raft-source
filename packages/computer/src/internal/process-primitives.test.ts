// Task #10: isProcessAlive must distinguish an EXITED-but-unreaped process
// (a zombie) from a running one. Signal 0 alone answers both identically,
// which turned every wait-for-exit loop into a guaranteed timeout under a
// non-reaping init (stop wait, upgrade handover wait, predecessor-receipt
// checks). The zombie below is MANUFACTURED, not scavenged: a shell starts a
// background sleep and then execs another sleep, so the first sleep's parent
// is a process that never waits — it becomes a deterministic zombie we own
// and reap when the parent dies.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  isExitedProcessState,
  isProcessAlive,
  parseLinuxStatState,
  readDarwinProcessState,
  readLinuxProcessState,
} from "./process-primitives.js";

const isPosix = process.platform === "linux" || process.platform === "darwin";
const isLinux = process.platform === "linux";

test("parseLinuxStatState: state survives comm containing spaces and nested parens", () => {
  // comm may legally contain spaces, parens, even "(launchd) worker".
  assert.equal(parseLinuxStatState("123 (node) S 1 2 3"), "S");
  assert.equal(parseLinuxStatState("42 (Chrome Helper (Renderer)) R 1"), "R");
  assert.equal(parseLinuxStatState("7 ((weird) name (x)) Z 1"), "Z");
  assert.equal(parseLinuxStatState("9 (a b c) X"), "X");
  assert.equal(parseLinuxStatState("9 (a b c) x"), "x");
  // Not a stat line: no closing comm paren.
  assert.equal(parseLinuxStatState("garbage without parens"), null);
  assert.equal(parseLinuxStatState(""), null);
});

test("isExitedProcessState: only kernel exit states read as exited", () => {
  assert.equal(isExitedProcessState("Z"), true); // zombie, awaiting reap
  assert.equal(isExitedProcessState("X"), true); // dead, being torn down
  assert.equal(isExitedProcessState("x"), true);
  assert.equal(isExitedProcessState("R"), false); // running
  assert.equal(isExitedProcessState("S"), false); // sleeping
  assert.equal(isExitedProcessState("D"), false); // uninterruptible sleep
  assert.equal(isExitedProcessState("T"), false); // stopped (suspended/traced)
  assert.equal(isExitedProcessState("U"), false); // darwin uninterruptible wait
  assert.equal(isExitedProcessState(""), false);
  assert.equal(isExitedProcessState(null), false); // unanswered is NOT exited
});

test("isProcessAlive: rejects non-pid values before any kernel call", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test("isProcessAlive: a reaped real child reads as dead (no pid_max stand-in)", { timeout: 10_000 }, async () => {
  // A REAL child that exited and was reaped by libuv — the production shape
  // "waited-on process is gone". Deterministic on both branches: if the
  // kernel already reused the pid for a live successor, the conservative
  // contract REQUIRES alive, and the state reader must show a running (non-Z)
  // state for that successor; if nothing owns the pid, dead.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const verdict = isProcessAlive(pid);
  if (verdict === false) return; // gone: the expected common case
  const state = isLinux ? readLinuxProcessState(pid) : readDarwinProcessState(pid);
  assert.ok(
    state !== null && !isExitedProcessState(state),
    `pid ${pid} was reused by a live successor (state ${state}) — conservative alive is correct, but state evidence is missing`,
  );
});

test("isProcessAlive: unreadable state refinement stays conservatively alive", () => {
  // EPERM on signal 0: the process exists but belongs to someone else.
  const kill = vi.spyOn(process, "kill").mockImplementation((() => {
    const err = new Error("operation not permitted") as NodeJS.ErrnoException;
    err.code = "EPERM";
    throw err;
  }) as unknown as typeof process.kill);
  try {
    assert.equal(isProcessAlive(424_242), true);
  } finally {
    kill.mockRestore();
  }
});

test("isProcessAlive on Linux: /proc read failure keeps the alive verdict", async () => {
  if (!isLinux) return;
  // A RUNNING self, with the /proc read forced to fail: the predicate must
  // fall back to the signal-0 answer (alive), never guess "exited". The fs
  // module is replaced via module mock (not spyOn: on some Node versions the
  // builtin's exports are non-configurable and cannot be spied on).
  vi.resetModules();
  vi.doMock("node:fs", async (orig) => {
    const real = await orig<typeof import("node:fs")>();
    const failing = () => {
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    };
    return { ...real, readFileSync: failing };
  });
  try {
    const mod = await import("./process-primitives.js");
    assert.equal(mod.isProcessAlive(process.pid), true);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

const spawned: Array<{ child: ChildProcess; reap: "stdin-wait" | "kill-parent" }> = [];
afterEach(async () => {
  // Tear down every manufactured tree WITHOUT leaving zombies behind.
  // Linux fixtures reap through the stdin→`wait` protocol (the shell itself
  // waits its zombie child, then exits). The Darwin fixture's parent is an
  // exec'd binary, so teardown kills it and VERIFY the zombie is reaped by
  // the host (launchd); a teardown that silently left zombies would fail the
  // no-residue assertion inside the test.
  for (const { child, reap } of spawned.splice(0)) {
    if (child.exitCode === null && reap === "stdin-wait" && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write("\n");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          child.once("close", () => { clearTimeout(timer); resolve(); });
        });
      } catch {
        /* stdin gone: fall through to kill */
      }
    }
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
});

test("isProcessAlive: a manufactured unreaped zombie reads as dead (deterministic, no residue)", { timeout: 20_000 }, async () => {
  if (!isPosix) return; // zombie semantics under test are POSIX
  // Linux (/bin/sh = dash): the shell starts a background sleep (printing its
  // pid) and BLOCKS on `read` — dash holds the exited child as a real zombie
  // for as long as we stay silent. stdin gets one line at teardown → `wait`
  // → the shell ACTUALLY reaps its child and exits: the fixture cleans up
  // after itself instead of donating zombies to PID 1.
  //
  // Darwin (/bin/sh = bash): bash reaps finished background jobs before every
  // next command, so no living bash can hold a zombie across a command
  // boundary. There the fixture execs a binary (sleep) as the parent — a
  // process that structurally never waits — and teardown kills it, handing
  // the zombie to launchd (which always reaps) and asserting the residue is
  // gone. The two shapes assert the same predicate on both platforms.
  const script = isLinux
    ? "sleep 0.4 & echo $!; IFS= read -r _; wait"
    : "sleep 0.4 & echo $!; exec sleep 30";
  const shell = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "inherit"] });
  spawned.push({ child: shell, reap: isLinux ? "stdin-wait" : "kill-parent" });
  let out = "";
  shell.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  while (!out.trim() && shell.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const zombiePid = Number.parseInt(out.trim().split("\n")[0]!, 10);
  assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, `shell reported pid "${out.trim()}"`);
  // Wait past the child's exit, while its never-waiting parent still lives.
  await new Promise((resolve) => setTimeout(resolve, 900));

  // The zombie really exists and really exited (positive evidence both ways).
  if (isLinux) {
    assert.equal(readLinuxProcessState(zombiePid), "Z");
  }
  let signal0Succeeds = false;
  try { process.kill(zombiePid, 0); signal0Succeeds = true; } catch { /* reaped already */ }
  assert.equal(
    signal0Succeeds,
    true,
    "precondition failed: zombie vanished before assertion (parent died early?)",
  );
  // The refined predicate reads the corpse as dead.
  assert.equal(isProcessAlive(zombiePid), false);
  // And the live parent still reads alive through the same refined path.
  assert.equal(isProcessAlive(shell.pid!), true);

  // NO-RESIDUE teardown, with evidence. Linux: command the shell to `wait` —
  // it reaps the zombie itself, then exits (libuv reaps the shell). Darwin:
  // kill the exec'd parent, then require launchd to have reaped the orphan.
  if (isLinux) {
    shell.stdin!.write("\n");
    await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    assert.equal(isProcessAlive(shell.pid!), false, "parent shell must exit after reaping");
    assert.equal(isProcessAlive(zombiePid), false, "zombie must be gone after the parent's wait");
  } else {
    shell.kill("SIGKILL");
    await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    let reaped = false;
    for (let i = 0; i < 40 && !reaped; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { process.kill(zombiePid, 0); } catch { reaped = true; }
    }
    assert.equal(reaped, true, "launchd must reap the orphaned zombie after parent death");
  }
});

test("Darwin: ps failure stays conservatively alive (deterministic)", async () => {
  if (process.platform !== "darwin") return; // darwin refinement only
  // Force `ps` to fail inside the refinement: the predicate must fall back to
  // the signal-0 verdict (alive) for a RUNNING process, never guess "exited".
  vi.resetModules();
  vi.doMock("node:child_process", async (orig) => {
    const real = await orig<typeof import("node:child_process")>();
    return {
      ...real,
      spawnSync: () => Object.assign(new Error("ps unavailable"), { error: new Error("spawn failed") }),
    };
  });
  try {
    const mod = await import("./process-primitives.js");
    assert.equal(mod.isProcessAlive(process.pid), true);
    assert.equal(mod.readDarwinProcessState(process.pid), null);
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});

test("readLinuxProcessState: parses the self stat line on Linux", () => {
  if (!isLinux) return; // /proc/<pid>/stat is a Linux contract
  const state = readLinuxProcessState(process.pid);
  assert.ok(state !== null, "self /proc/<pid>/stat must be readable on Linux");
  assert.match(state!, /^[A-Za-z]$/);
  assert.equal(isExitedProcessState(state), false);
});

test("spawnSync sanity: the manufacturing recipe works on this host", () => {
  if (!isPosix) return;
  const probe = spawnSync("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 0.1"]);
  assert.equal(probe.status, 0);
});
