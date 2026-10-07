import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { CursorSdkRuntimeSession } from "./cursor-sdk.js";
import type { ParsedEvent, SpawnContext } from "./types.js";
import { detectCursorSdkModels, resolveCursorCredentialLease } from "../runtimeAuth/cursor/nativeCredentialBroker.js";

const live = process.env.RAFT_CURSOR_SDK_LIVE_SMOKE === "1" ? test : test.skip;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, max = 60_000) {
  const end = Date.now() + max;
  while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(25); }
}

/** Explicit opt-in only; uses the existing SDK login, never logs in or mints keys. */
live("staged real Cursor host: saved auth, same-agent runs, busy steer, resume and shutdown", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-cursor-live-"));
  const work = path.join(root, "workspace"); await mkdir(work);
  const events: ParsedEvent[] = [];
  const sessions: CursorSdkRuntimeSession[] = [];
  let currentId: string | null = null;
  const nonce = `nonce-${randomUUID().slice(0, 8)}`;
  try {
    const lease = await resolveCursorCredentialLease({ slockHome: root });
    assert.ok(lease.principalId, "production auth host verifies the existing login");
    const catalog = await detectCursorSdkModels({ slockHome: root });
    assert.equal(catalog.kind, "live", "existing SDK login must work through the production auth host");
    if (catalog.kind !== "live") return;
    const model = catalog.value.models.find((m) => m.id === "composer-2.5")?.id ?? catalog.value.default ?? catalog.value.models[0].id;
    const base = {
      agentId: "cursor-sdk-live-fixture", standingPrompt: "", prompt: "", workingDirectory: work,
      slockHome: root, slockCliPath: "/unused-in-this-host-smoke", daemonApiKey: "fixture-no-network",
      config: { name: "Cursor smoke", displayName: null, description: null, runtime: "cursor-sdk", serverUrl: "http://127.0.0.1:1", authToken: "fixture", sessionId: null, model, reasoningEffort: null, envVars: null, runtimeContext: null },
    } as SpawnContext;
    function create(sessionId: string | null) {
      const runtime = new CursorSdkRuntimeSession({ ...base, config: { ...base.config, sessionId } }, (id) => { currentId = id; }, {
        // Isolate Raft server/CLI side effects. Runtime assets, credential
        // broker, private IPC, vendor SDK and conversation store are real.
        prepareTransport: async () => ({ slockHome: root, spawnEnv: { ...process.env } }) as Awaited<ReturnType<typeof import("./cliTransport.js").prepareCliTransport>>,
        prepareManagedMcp: async () => null,
      });
      runtime.on("runtime_event", (event) => { events.push(event); });
      sessions.push(runtime); return runtime;
    }
    const runtime = create(null);
    const first = await runtime.start({ text: `Do not use tools. Remember this exact test marker: ${nonce}. Reply only with that marker.` });
    assert.equal(first.ok, true);
    await until(() => events.some((e) => e.kind === "turn_end"), "first run");
    assert.ok(events.filter((e) => e.kind === "text").map((e) => e.text).join("").includes(nonce));
    assert.ok(currentId);
    const firstId = currentId;
    const pid = runtime.pid;
    events.length = 0;
    assert.equal(runtime.send({ mode: "idle", sessionId: firstId, text: "Do not use tools. Reply only with the marker I asked you to remember.", attemptId: "live-followup" }).ok, true);
    await until(() => events.some((e) => e.kind === "turn_end"), "second run");
    assert.equal(runtime.pid, pid);
    assert.equal(currentId, firstId);
    assert.ok(events.filter((e) => e.kind === "text").map((e) => e.text).join("").includes(nonce));
    events.length = 0;
    assert.equal(runtime.send({ mode: "idle", sessionId: firstId, text: "For a safe concurrency test, use the shell tool once to run exactly: sleep 8. Do not read or change any files. After the command returns, reply ORIGINAL.", attemptId: "live-sleep" }).ok, true);
    await until(() => events.some((e) => e.kind === "tool_call") || events.some((e) => e.kind === "turn_end"), "tool start");
    assert.ok(!events.some((e) => e.kind === "turn_end"), "must observe an active native Run");
    assert.equal(runtime.send({ mode: "busy", sessionId: firstId, text: "Change the final response: after the current command finishes, reply exactly STEERED_OK, not ORIGINAL.", attemptId: "live-steer" }).ok, true);
    await until(() => events.some((e) => e.kind === "turn_end"), "steered run");
    const outcome = events.find((e) => e.kind === "delivery_outcome" && e.attemptId === "live-steer");
    assert.equal(outcome?.kind === "delivery_outcome" ? outcome.outcome : null, "delivered");
    assert.ok(events.filter((e) => e.kind === "text").map((e) => e.text).join("").includes("STEERED_OK"));
    await runtime.stop({ forceAfterMs: 5000, reason: "live-smoke-close" });
    assert.equal(runtime.closed, true);
    if (pid) assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/);
    events.length = 0;
    const resumed = create(firstId);
    await resumed.start({ sessionId: firstId, text: "Do not use tools. Reply only with the earlier nonce marker I asked you to remember, not the later steering response." });
    await until(() => events.some((e) => e.kind === "turn_end"), "resumed run");
    assert.equal(currentId, firstId);
    assert.notEqual(resumed.pid, pid);
    assert.ok(events.filter((e) => e.kind === "text").map((e) => e.text).join("").includes(nonce));
    await resumed.stop({ forceAfterMs: 5000, reason: "live-smoke-resume-close" });
    console.log(JSON.stringify({ test: "cursor-sdk-live-driver", model, sameHostAcrossRuns: true, sameAgentAcrossResume: true, liveSteer: "delivered", hostExited: true, markerHash: createHash("sha256").update(nonce).digest("hex").slice(0, 12) }));
  } finally {
    for (const runtime of sessions) await runtime.stop({ forceAfterMs: 2000, reason: "live-smoke-finally" }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
