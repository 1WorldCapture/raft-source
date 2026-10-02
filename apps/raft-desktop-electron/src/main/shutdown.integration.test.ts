// Real processes live only in freshly-created test roots. The foreign service
// and test driver deliberately share a PGID with the owned process tree.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerProcessScope, readComputerProcesses } from "./computerProcesses.ts";
import { runShutdownTree } from "./shutdown.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("fixture did not start")), 5000);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY")) { clearTimeout(timeout); resolve(output); }
    });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("fixture exited early")); });
  });
}

test("real shutdown: clears detached orphan while foreign root and same-group GUI remain alive", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "raft-real-shutdown-"));
  const own = path.join(directory, "own root");
  const other = path.join(directory, "other root");
  const run = path.join(own, "computer", "run");
  await mkdir(run, { recursive: true });
  const children: ChildProcess[] = [];
  const extraPids: number[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    for (const pid of extraPids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await rm(directory, { recursive: true, force: true });
  });
  const foreignSignals = path.join(directory, "foreign-signals.txt");
  const foreign = spawn(process.execPath, ["-e", `const fs = require('fs'); process.on('SIGTERM', () => fs.appendFileSync(process.argv[2], 'TERM')); setInterval(() => {}, 1000); console.log('READY');`, "__service", foreignSignals], {
    env: { ...process.env, RAFT_HOME: other, SLOCK_HOME: other }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(foreign);
  await ready(foreign);
  const service = spawn(process.execPath, ["-e", `const {spawn} = require('child_process'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {},1000); console.log('READY');"], {env: {...process.env, SLOCK_AGENT_ID:'fixture-only'}, stdio:['ignore','pipe','ignore'], detached:true}); child.stdout.once('data', () => console.log('READY '+child.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {},1000);`, "__service"], {
    env: { ...process.env, RAFT_HOME: own, SLOCK_HOME: own }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(service);
  const output = await ready(service);
  const childPid = Number(output.match(/READY (\d+)/)![1]);
  extraPids.push(childPid);
  await writeFile(path.join(run, "service.pid"), String(service.pid));
  const initial = await readComputerProcesses(own);
  const ownRow = initial.rows.find((row) => row.pid === service.pid)!;
  const foreignRow = initial.rows.find((row) => row.pid === foreign.pid)!;
  assert.equal(ownRow.home, own);
  assert.equal(ownRow.pgid, foreignRow.pgid, "the foreign service intentionally shares the owner's process group");
  const signaled: number[] = [];
  const complete = await runShutdownTree({
    scope: new ComputerProcessScope(own), snapshot: () => readComputerProcesses(own),
    requestStop: async () => {
      service.kill("SIGTERM");
      await once(service, "exit");
      await rm(path.join(run, "service.pid"));
    },
    signal: (pid, signal) => { signaled.push(pid); process.kill(pid, signal); },
    now: () => Date.now(), sleep: delay, logFile: path.join(run, "shutdown.log"), systemShutdown: false,
    tuning: { gracefulTimeoutMs: 100, termTimeoutMs: 100 },
  });
  assert.equal(complete, true);
  assert.ok(signaled.includes(childPid), "orphan agent is escalated after service removes its pidfile");
  assert.ok(signaled.every((pid) => pid > 0 && pid !== foreign.pid && pid !== process.pid));
  process.kill(foreign.pid!, 0);
  await assert.rejects(readFile(foreignSignals), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(readComputerProcesses(own).then((snapshot) => {
    if (!snapshot.rows.some((row) => row.pid === childPid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  }), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});
