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
    final: { result: "rolled_back", from: "/a", to: "/b", error: "boom", serviceState: "running" },
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
