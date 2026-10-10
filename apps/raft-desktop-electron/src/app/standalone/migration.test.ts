import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MigrationController, parseMigrationLine, runMigrateHome, type MigrateRun, type MigrationState } from "./migration.ts";

const ev = (step: string, status: string, detail?: Record<string, unknown>) => ({ step, status, ...(detail ? { detail } : {}) });

test("line parser: events, the apply result, the dry-run summary; anything else is ignored", () => {
  assert.deepEqual(parseMigrationLine('{"step":"stop","status":"ok"}'), { kind: "event", event: { step: "stop", status: "ok" } });
  assert.deepEqual(parseMigrationLine('{"step":"move","status":"planned","detail":{"to":"/h"}}'), { kind: "event", event: { step: "move", status: "planned", detail: { to: "/h" } } });
  assert.deepEqual(parseMigrationLine('{"schemaVersion":1,"result":"rolled_back","from":"/a","to":"/b","error":"boom","serviceState":"running","steps":[]}'), {
    kind: "result",
    final: { result: "rolled_back", from: "/a", to: "/b", error: "boom", serviceState: "running", reason: null },
  });
  assert.deepEqual(parseMigrationLine('{"dryRun":true,"outcome":"blocked","blocked":true}'), { kind: "dry-run", outcome: "blocked" });
  assert.deepEqual(parseMigrationLine('{"dryRun":true,"outcome":"planned","blocked":false}'), { kind: "dry-run", outcome: "planned" });
  assert.equal(parseMigrationLine("oops").kind, "other");
  assert.equal(parseMigrationLine("[1]").kind, "other");
});

async function withScript<T>(body: string, fn: (script: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "migrate-fake-"));
  try {
    const script = path.join(dir, "raft-computer");
    await writeFile(script, `#!/bin/sh\n${body}\n`);
    await chmod(script, 0o755);
    return await fn(script);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runner: real child process; passes --from/--apply/--json, streams events, reads the result line", async () => {
  const body = `echo "$@" > "$0.args"
echo '{"step":"preflight","status":"ok","detail":{"to":"/home/u/.slock"}}'
echo '{"step":"stop","status":"start"}'
echo '{"step":"stop","status":"ok"}'
printf '{"schemaVersion":1,"result":"success","from":"/a","to":"/home/u/.slock","error":null,"serviceState":"running","steps":[]}\\n'`;
  await withScript(body, async (script) => {
    const seen: string[] = [];
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: true, onEvent: (e) => seen.push(`${e.step}:${e.status}`) });
    assert.equal(run.outcome, "success");
    assert.deepEqual(seen, ["preflight:ok", "stop:start", "stop:ok"]);
    assert.equal(run.final?.to, "/home/u/.slock");
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(`${script}.args`, "utf8")).trim(), "migrate-home --from /a --apply --json");
  });
});

test("runner: a dry run reports planned/blocked; a non-zero exit with a result line still reports the result", async () => {
  await withScript(`echo '{"step":"move","status":"planned"}'\necho '{"dryRun":true,"outcome":"planned","blocked":false}'`, async (script) => {
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: false });
    assert.equal(run.outcome, "planned");
  });
  await withScript(`echo '{"result":"rolled_back","from":"/a","to":"/b","error":"self-check failed","serviceState":"running"}'\nexit 1`, async (script) => {
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: true });
    assert.deepEqual([run.outcome, run.exitCode, run.final?.error], ["rolled_back", 1, "self-check failed"]);
  });
});

test("runner: no result line (old binary, crash, missing file, timeout) is an error with the reason, never a success", async () => {
  await withScript(`echo "error: unknown command 'migrate-home'" >&2\nexit 1`, async (script) => {
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: true });
    assert.equal(run.outcome, "error");
    assert.match(run.detail ?? "", /unknown command/);
  });
  const missing = await runMigrateHome({ binaryPath: "/nonexistent/raft-computer", from: "/a", apply: true });
  assert.equal(missing.outcome, "error");
  await withScript(`sleep 5`, async (script) => {
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: true, timeoutMs: 100 });
    assert.deepEqual([run.outcome, run.timedOut], ["error", true]);
    await new Promise((r) => setTimeout(r, 50));
  });
});

function controller(opts: { runs: Array<Partial<MigrateRun> & { outcome: MigrateRun["outcome"] }>; available?: boolean; afterSuccess?: (to: string) => Promise<{ warnings: string[] }>; ensureBinary?: () => Promise<string> }) {
  const published: MigrationState[] = [];
  const calls: Array<{ apply: boolean; from: string }> = [];
  const queue = [...opts.runs];
  const c = new MigrationController({
    available: opts.available ?? true,
    getFromHome: async () => "/app/home",
    ensureBinary: opts.ensureBinary ?? (async () => "/bin/raft-computer"),
    run: async (input) => {
      calls.push({ apply: input.apply, from: input.from });
      const next = queue.shift()!;
      const run: MigrateRun = { events: [], final: null, detail: null, exitCode: 0, ...next };
      for (const e of run.events) input.onEvent?.(e);
      return run;
    },
    afterSuccess: opts.afterSuccess ?? (async () => ({ warnings: [] })),
    publish: (s) => published.push(s),
  });
  return { c, published, calls };
}

const PLANNED = { outcome: "planned" as const, events: [ev("preflight", "ok", { to: "/home/u/.slock", warnings: ["w1"] }), ev("stop", "planned"), ev("move", "planned")] };

test("unavailable (no bundled Computer / not embedded): nothing runs", async () => {
  const { c, calls } = controller({ runs: [], available: false });
  assert.equal(c.getState().phase, "unavailable");
  await c.plan();
  await c.apply();
  assert.deepEqual(calls, []);
});

test("plan: dry run only; ready carries the target, steps and warnings; apply is refused before a plan", async () => {
  const { c, calls } = controller({ runs: [PLANNED] });
  assert.equal((await c.apply()).phase, "idle");
  assert.deepEqual(calls, []);
  const s = await c.plan();
  assert.deepEqual(calls, [{ apply: false, from: "/app/home" }]);
  assert.deepEqual([s.phase, s.from, s.to, s.warnings], ["ready", "/app/home", "/home/u/.slock", ["w1"]]);
  assert.deepEqual(s.steps.map((x) => `${x.step}:${x.status}`), ["preflight:ok", "stop:planned", "move:planned"]);
});

test("plan: blockers are listed and apply stays refused", async () => {
  const { c, calls } = controller({ runs: [{ outcome: "blocked", events: [ev("preflight", "blocked", { to: "/t", blockers: ["target is not empty"] })] }] });
  const s = await c.plan();
  assert.deepEqual([s.phase, s.blockers], ["blocked", ["target is not empty"]]);
  await c.apply();
  assert.equal(calls.length, 1);
});

test("apply success: switches the app over (afterSuccess), reports relaunching and the result file", async () => {
  const switched: string[] = [];
  const { c, calls } = controller({
    runs: [PLANNED, { outcome: "success", events: [ev("stop", "ok"), ev("move", "ok")], final: { result: "success", from: "/app/home", to: "/home/u/.slock", error: null, serviceState: "running" } }],
    afterSuccess: async (to) => { switched.push(to); return { warnings: ["cursor-sdk copy skipped"] }; },
  });
  await c.plan();
  const s = await c.apply();
  assert.deepEqual(calls.map((x) => x.apply), [false, true]);
  assert.deepEqual(switched, ["/home/u/.slock"]);
  assert.deepEqual([s.phase, s.relaunching, s.resultFile, s.warnings], ["success", true, "/home/u/.slock/computer/migrate-result.json", ["cursor-sdk copy skipped"]]);
});

test("apply success but the mode switch fails: an error that says the Computer already moved; no relaunch", async () => {
  const { c } = controller({
    runs: [PLANNED, { outcome: "success", final: { result: "success", from: "/a", to: "/home/u/.slock", error: null, serviceState: "running" } }],
    afterSuccess: async () => { throw new Error("EACCES"); },
  });
  await c.plan();
  const s = await c.apply();
  assert.deepEqual([s.phase, s.relaunching], ["error", false]);
  assert.match(s.error ?? "", /moved to \/home\/u\/\.slock.*EACCES/);
});

test("rolled back / failed / error leave embedded mode alone (afterSuccess never runs) and carry the reason", async () => {
  for (const [outcome, phase] of [["rolled_back", "rolled_back"], ["failed", "failed"], ["error", "error"]] as const) {
    let switched = false;
    const { c } = controller({
      runs: [PLANNED, { outcome, detail: "no result", final: outcome === "error" ? null : { result: outcome, from: "/app/home", to: "/t", error: "self-check failed", serviceState: "running" } }],
      afterSuccess: async () => { switched = true; return { warnings: [] }; },
    });
    await c.plan();
    const s = await c.apply();
    assert.equal(s.phase, phase);
    assert.equal(s.error, outcome === "error" ? "no result" : "self-check failed");
    assert.equal(switched, false);
    assert.equal(s.resultFile, "/app/home/computer/migrate-result.json");
    assert.equal(c.reset().phase, "idle");
  }
});

test("binary preparation failure (e.g. bundled copy failed) is an error before any migrate-home call", async () => {
  const { c, calls } = controller({ runs: [], ensureBinary: async () => { throw new Error("disk full"); } });
  const s = await c.plan();
  assert.deepEqual([s.phase, s.error, calls], ["error", "disk full", []]);
});

test("apply that outlives the wait is NOT killed: the result file is watched (both homes) and its result is honoured", async () => {
  const reads: string[] = [];
  const outcomes: string[] = [];
  const c = new MigrationController({
    available: true,
    getFromHome: async () => "/app/home",
    ensureBinary: async () => "/bin/rc",
    run: async (input) => input.apply
      ? { outcome: "error", events: [], final: null, detail: "still running", exitCode: null, timedOut: true }
      : { outcome: "planned", events: [ev("preflight", "ok", { to: "/t" })], final: null, detail: null, exitCode: 0 },
    readResult: async (home) => { reads.push(home); return reads.length < 4 ? null : { result: "rolled_back", startedAt: "2999-01-01T00:00:00Z", from: "/app/home", to: "/t", error: "late failure" }; },
    sleep: async () => undefined,
    afterSuccess: async () => { outcomes.push("switched"); return { warnings: [] }; },
    publish: () => undefined,
  });
  await c.plan();
  const s = await c.apply();
  assert.deepEqual([s.phase, s.error, s.slow], ["rolled_back", "late failure", true]);
  assert.ok(reads.includes("/t") && reads.includes("/app/home"));
  assert.deepEqual(outcomes, []);
});

test("a stale result file from an earlier run is ignored while waiting", async () => {
  let n = 0;
  const c = new MigrationController({
    available: true, getFromHome: async () => "/h", ensureBinary: async () => "/b",
    run: async (input) => input.apply ? { outcome: "error", events: [], final: null, detail: null, exitCode: null, timedOut: true } : { outcome: "planned", events: [ev("preflight", "ok", { to: "/t" })], final: null, detail: null, exitCode: 0 },
    readResult: async () => (++n < 3 ? { result: "success", startedAt: "2000-01-01T00:00:00Z", from: "/h", to: "/t", error: null } : { result: "failed", startedAt: "2999-01-01T00:00:00Z", from: "/h", to: "/t", error: "x" }),
    sleep: async () => undefined, afterSuccess: async () => ({ warnings: [] }), publish: () => undefined,
  });
  await c.plan();
  assert.equal((await c.apply()).phase, "failed");
});

test("a second plan/apply while one is running is ignored; progress is published step by step", async () => {
  const { c, published } = controller({ runs: [PLANNED] });
  const first = c.plan();
  const second = await c.plan();
  assert.equal(second.phase, "checking");
  await first;
  assert.ok(published.some((s) => s.phase === "checking"));
  assert.ok(published.some((s) => s.steps.some((x) => x.step === "stop")));
});

test("plan detects in-place from the preflight (mode, or from == to)", async () => {
  for (const detail of [{ mode: "in-place", to: "/h/.slock" }, { from: "/h/.slock", to: "/h/.slock" }]) {
    const { c } = controller({ runs: [{ outcome: "planned", events: [ev("preflight", "ok", detail)] }] });
    assert.equal((await c.plan()).inPlace, true);
  }
  const { c } = controller({ runs: [PLANNED] });
  assert.equal((await c.plan()).inPlace, false);
});

test("an unexpected exception anywhere becomes an error state, never a stuck dialog", async () => {
  const c = new MigrationController({
    available: true, getFromHome: async () => "/h", ensureBinary: async () => "/b",
    run: async () => { throw new Error("kaboom"); },
    afterSuccess: async () => ({ warnings: [] }), publish: () => undefined,
  });
  const s = await c.plan();
  assert.deepEqual([s.phase, s.error], ["error", "kaboom"]);
  assert.equal(c.reset().phase, "idle", "and the dialog can be dismissed / retried");
});

test("runner: the command's stdout is a file, not a pipe (a killed app cannot make it die with EPIPE) and it is detached", async () => {
  const body = `if [ -p /proc/self/fd/1 ]; then K=pipe; else K=file; fi
echo "{\\"step\\":\\"stop\\",\\"status\\":\\"ok\\",\\"detail\\":{\\"stdout\\":\\"$K\\"}}"
echo '{"dryRun":true,"outcome":"planned","blocked":false}'`;
  await withScript(body, async (script) => {
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: false });
    assert.equal(run.outcome, "planned");
    assert.equal(run.events[0].detail?.stdout, "file");
  });
});

test("runner: events stream while the command is still running (tail), and a late final line is read after exit", async () => {
  const body = `echo '{"step":"stop","status":"start"}'
sleep 1
echo '{"step":"stop","status":"ok"}'
printf '{"result":"success","from":"/a","to":"/b","error":null}'`;
  await withScript(body, async (script) => {
    const seen: string[] = [];
    const t0 = Date.now();
    let firstAt = 0;
    const run = await runMigrateHome({ binaryPath: script, from: "/a", apply: true, onEvent: (e) => { if (!firstAt) firstAt = Date.now() - t0; seen.push(e.status); } });
    assert.deepEqual(seen, ["start", "ok"]);
    assert.ok(firstAt < 900, `first event arrived while the command was still running (${firstAt}ms)`);
    assert.equal(run.outcome, "success", "an unterminated final line is still read");
  });
});

function withHandOver(handOver: () => Promise<void>, over: { onRun?: (input: { onSpawn?: (pid: number) => void }) => Promise<MigrateRun>; supportsCancel?: boolean } = {}) {
  const order: string[] = [];
  const signals: Array<[number, string]> = [];
  const c = new MigrationController({
    available: true, getFromHome: async () => "/h", ensureBinary: async () => "/b",
    handOver: async () => { order.push("handover"); await handOver(); },
    restoreBuiltIn: async () => { order.push("restore"); return { ok: true }; },
    signal: (pid, sig) => { signals.push([pid, sig]); },
    supportsCancel: async () => over.supportsCancel ?? true,
    run: async (input) => {
      if (!input.apply) return { outcome: "planned", events: [ev("preflight", "ok", { to: "/t" })], final: null, detail: null, exitCode: 0 };
      order.push("run");
      return over.onRun ? over.onRun(input) : { outcome: "success", events: [], final: { result: "success", from: "/h", to: "/t", error: null, serviceState: "running" }, detail: null, exitCode: 0 };
    },
    afterSuccess: async () => ({ warnings: [] }), publish: () => undefined,
  });
  return { c, order, signals };
}

test("hand-over runs BEFORE the command and is a visible step", async () => {
  const { c, order } = withHandOver(async () => undefined);
  await c.plan();
  const s = await c.apply();
  assert.deepEqual(order, ["handover", "run"]);
  assert.equal(s.steps.find((x) => x.step === "handover")?.status, "ok");
});

test("hand-over that leaves processes behind aborts: no command is run, error says nothing changed, built-in is restored", async () => {
  const { c, order } = withHandOver(async () => { throw new Error("pid 4 still running"); });
  await c.plan();
  const s = await c.apply();
  assert.deepEqual(order, ["handover", "restore"], "the migrate command was never started");
  assert.equal(s.phase, "error");
  assert.match(s.error ?? "", /nothing was changed.*pid 4 still running/i);
  assert.equal(s.steps.find((x) => x.step === "handover")?.status, "fail");
});

test("cancel: only once the command runs; sends SIGTERM to its pid; the rollback result says 'cancelled'", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { c, signals } = withHandOver(async () => undefined, {
    onRun: async (input) => {
      input.onSpawn?.(777);
      await gate;
      return { outcome: "rolled_back", events: [], final: { result: "rolled_back", from: "/h", to: "/t", error: null, serviceState: "running", reason: "cancelled" }, detail: null, exitCode: 1 };
    },
  });
  await c.plan();
  const applying = c.apply();
  assert.deepEqual(c.cancel().cancelRequested, false, "not cancellable before the command is running");
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getState().cancellable, true);
  assert.equal(c.cancel().cancelRequested, true);
  c.cancel(); // second press is ignored
  release();
  const s = await applying;
  assert.deepEqual(signals, [[777, "SIGTERM"]]);
  assert.deepEqual([s.phase, s.reason, s.cancellable], ["rolled_back", "cancelled", false]);
});

test("an older raft-computer (no clean cancel) never offers Cancel: SIGTERM would kill the move half way", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { c, signals } = withHandOver(async () => undefined, {
    supportsCancel: false,
    onRun: async (input) => { input.onSpawn?.(9); await gate; return { outcome: "success", events: [], final: { result: "success", from: "/h", to: "/t", error: null, serviceState: "running" }, detail: null, exitCode: 0 }; },
  });
  await c.plan();
  const applying = c.apply();
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getState().cancellable, false);
  assert.equal(c.cancel().cancelRequested, false);
  assert.deepEqual(signals, []);
  release();
  await applying;
});

test("in-place is remembered once apply starts (the dialog keeps saying Switching)", async () => {
  const { c } = withHandOver(async () => undefined, {
    onRun: async () => ({ outcome: "success", events: [], final: { result: "success", from: "/h", to: "/h", error: null, serviceState: "running" }, detail: null, exitCode: 0 }),
  });
  // plan() reports in-place through the preflight detail
  (c as unknown as { deps: { run: unknown } }).deps.run = async (input: { apply: boolean }) => input.apply
    ? { outcome: "success", events: [], final: { result: "success", from: "/h", to: "/h", error: null, serviceState: "running" }, detail: null, exitCode: 0 }
    : { outcome: "planned", events: [{ step: "preflight", status: "ok", detail: { mode: "in-place", from: "/h", to: "/h" } }], final: null, detail: null, exitCode: 0 };
  assert.equal((await c.plan()).inPlace, true);
  assert.equal((await c.apply()).inPlace, true);
});

test("runner: --deadline is passed (absolute epoch-ms) only on apply, never on a dry run", async () => {
  await withScript(`echo "$@" > "$0.args"\necho '{"dryRun":true,"outcome":"planned","blocked":false}'`, async (script) => {
    const { readFile } = await import("node:fs/promises");
    await runMigrateHome({ binaryPath: script, from: "/a", apply: false, deadlineMs: 1234 });
    assert.equal((await readFile(`${script}.args`, "utf8")).trim(), "migrate-home --from /a --json");
    await runMigrateHome({ binaryPath: script, from: "/a", apply: true, deadlineMs: 1234.4 });
    assert.equal((await readFile(`${script}.args`, "utf8")).trim(), "migrate-home --from /a --apply --deadline 1234 --json");
  });
});

test("controller: a Computer that supports cancel gets a 10-minute deadline; an older one gets none", async () => {
  for (const supported of [true, false]) {
    const seen: Array<number | undefined> = [];
    const c = new MigrationController({
      available: true, getFromHome: async () => "/h", ensureBinary: async () => "/b", supportsCancel: async () => supported,
      run: async (input) => { if (input.apply) seen.push(input.deadlineMs); return input.apply
        ? { outcome: "success", events: [], final: { result: "success", from: "/h", to: "/t", error: null, serviceState: "running" }, detail: null, exitCode: 0 }
        : { outcome: "planned", events: [ev("preflight", "ok", { to: "/t" })], final: null, detail: null, exitCode: 0 }; },
      afterSuccess: async () => ({ warnings: [] }), publish: () => undefined,
    });
    const t0 = Date.now();
    await c.plan();
    await c.apply();
    if (supported) assert.ok(seen[0]! >= t0 + 10 * 60_000 && seen[0]! <= Date.now() + 10 * 60_000);
    else assert.equal(seen[0], undefined);
  }
});

test("a move that did not complete puts the built-in Computer back (cancelled, deadline, failed, no result); a success never does", async () => {
  const cases: Array<[string, MigrateRun["outcome"], string | null]> = [["cancelled", "rolled_back", "cancelled"], ["deadline", "rolled_back", "deadline"], ["failed", "failed", null], ["rolled back", "rolled_back", null], ["no result", "error", null]];
  for (const [label, outcome, reason] of cases) {
    const { c, order } = withHandOver(async () => undefined, {
      onRun: async () => ({ outcome, events: [], final: outcome === "error" ? null : { result: outcome as "failed", from: "/h", to: "/t", error: "boom", serviceState: "down", reason }, detail: "no result", exitCode: 1 }),
    });
    await c.plan();
    const s = await c.apply();
    assert.deepEqual(order, ["handover", "run", "restore"], label);
    assert.deepEqual([s.restored, s.restoreError], ["ok", null], label);
  }
  const ok = withHandOver(async () => undefined);
  await ok.c.plan();
  assert.equal((await ok.c.apply()).restored, null);
  assert.deepEqual(ok.order, ["handover", "run"], "success: not restored");
});

test("hand-over aborted: the built-in Computer is restored and the command never ran", async () => {
  const { c, order } = withHandOver(async () => { throw new Error("pid 4 still running"); });
  await c.plan();
  const s = await c.apply();
  assert.deepEqual(order, ["handover", "restore"]);
  assert.deepEqual([s.phase, s.restored], ["error", "ok"]);
});

test("a restore that fails (or throws) is reported, never silent", async () => {
  for (const restore of [async () => ({ ok: false, error: "port busy" }), async () => { throw new Error("explode"); }]) {
    const c = new MigrationController({
      available: true, getFromHome: async () => "/h", ensureBinary: async () => "/b", handOver: async () => undefined, restoreBuiltIn: restore,
      run: async (input) => input.apply
        ? { outcome: "failed", events: [], final: { result: "failed", from: "/h", to: "/t", error: "x", serviceState: "down" }, detail: null, exitCode: 1 }
        : { outcome: "planned", events: [ev("preflight", "ok", { to: "/t" })], final: null, detail: null, exitCode: 0 },
      afterSuccess: async () => ({ warnings: [] }), publish: () => undefined,
    });
    await c.plan();
    const s = await c.apply();
    assert.equal(s.restored, "failed");
    assert.match(s.restoreError ?? "", /port busy|explode/);
  }
});
