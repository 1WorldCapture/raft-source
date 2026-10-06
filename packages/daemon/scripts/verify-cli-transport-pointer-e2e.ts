// Process-level verification for task #15: a CLI transport wrapper baked into
// a dead agent-credential-proxy endpoint must keep working across a daemon
// restart.
//
// Why a standalone script and not a vitest test: under the vitest loader the
// in-process agent-credential-proxy HTTP server does not serve requests (the
// CLI child's connections time out), so the full chain
//   wrapper -> real CLI process -> local proxy -> upstream
// can only be proven from a plain node process. Run with:
//   cd packages/daemon && pnpm exec tsx scripts/verify-cli-transport-pointer-e2e.ts
//
// Phases:
//   A. launch-1 wrapper sends while its own proxy registration is live.
//   B. Daemon "restarts" (registrations wiped, proxy re-binds on a NEW port
//      for launch-2): the SAME stale launch-1 wrapper must still send by
//      following the per-agent pointer files. This is the regression.
//   C. Daemon fully down (no re-registration): the stale wrapper must FAIL
//      with the daemon-availability hint, never a credential error.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __resetAgentCredentialProxyForTest } from "../src/agentCredentialProxy.js";
import { prepareCliTransport } from "../src/drivers/cliTransport.js";
import type { SpawnContext } from "../src/drivers/types.js";

const REPO_CLI_PATH = fileURLToPath(new URL("../../cli/dist/slock.js", import.meta.url));
if (!REPO_CLI_PATH || !process.env.PATH) throw new Error("unreachable");

async function startUpstream() {
  const bodies: { method: string; url: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push({ method: req.method ?? "?", url: req.url ?? "/", body });
      console.log(`  [upstream] ${req.method} ${req.url} :: ${body.slice(0, 160)}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && /^\/internal\/agent-api\/(v2\/)?send/.test(req.url ?? "")) {
        res.end(JSON.stringify({
          ok: true,
          state: "sent",
          messageId: `e2e-message-${bodies.length}`,
          messageSeq: bodies.length,
        }));
        return;
      }
      if ((req.url ?? "").includes("inbox")) {
        res.end(JSON.stringify({ targets: [], pending: [], changed: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  // address() is only valid once the listener is bound; port 0 here would
  // make the proxy connect to "127.0.0.1:0" (EADDRNOTAVAIL).
  await new Promise<void>((done) => server.once("listening", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function makeCtx(root: string, upstreamUrl: string, launchId: string): SpawnContext {
  return {
    agentId: "pointer-e2e-agent",
    config: {
      runtime: "claude",
      serverUrl: upstreamUrl,
      authToken: "legacy-fallback-token",
      agentCredentialKey: "sk_agent_pointer_e2e_key",
    } as SpawnContext["config"],
    standingPrompt: "",
    prompt: "",
    workingDirectory: path.join(root, "workspace"),
    launchId,
    slockCliPath: REPO_CLI_PATH,
    daemonApiKey: "e2e-daemon-key",
    slockHome: root,
    // Production inbox ownership lives in the APM; the proxy consults this on
    // every request and the CLI's freshness machinery drains through it.
    agentCredentialProxyInboxCoordinator: {
      getBoundary: () => undefined,
      getPendingMessages: () => [],
      consumeVisibleMessages: () => {},
    },
  } as unknown as SpawnContext;
}

function sendViaWrapper(
  wrapperPath: string,
  env: NodeJS.ProcessEnv,
  content: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(wrapperPath, ["message", "send", "--target", "#e2e-pointer"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin.write(content);
    child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

async function main() {
  // Isolated homes (rule: never inherit the host's launchd-injected dirs).
  const isolationRoot = mkdtempSync(path.join(os.tmpdir(), "raft-pointer-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    RAFT_HOME: path.join(isolationRoot, "raft-home"),
    SLOCK_HOME: path.join(isolationRoot, "slock-home"),
  };
  const root = isolationRoot;
  const agentRoot = path.join(root, "cli-transport", "pointer-e2e-agent");
  const upstream = await startUpstream();

  try {
    // ---- Phase A: launch-1 wrapper sends against its own live registration.
    const r1 = await prepareCliTransport(makeCtx(root, upstream.url, "launch-1"), {}, "linux");
    const staleWrapper = r1.wrapperPath;
    const pointerUrl = () => readFileSync(path.join(agentRoot, "proxy-current.url"), "utf8").trim();
    assert.equal(pointerUrl(), r1.agentCredentialProxyUrl, "pointer follows launch-1");
    console.log(`Phase A: launch-1 proxy=${r1.agentCredentialProxyUrl}`);

    const a = await sendViaWrapper(staleWrapper, env, "phase-a: live registration\n");
    assert.equal(a.status, 0, `phase A send failed: ${a.stderr}`);
    console.log("Phase A: PASS — wrapper send reached upstream while its registration was live");

    // ---- Phase B: daemon restart. Wipe registrations (proxy port dies),
    // relaunch as launch-2 on a NEW port, then re-send through the SAME
    // stale launch-1 wrapper.
    await __resetAgentCredentialProxyForTest();
    const r2 = await prepareCliTransport(makeCtx(root, upstream.url, "launch-2"), {}, "linux");
    assert.notEqual(r2.agentCredentialProxyUrl, r1.agentCredentialProxyUrl, "restart moves the proxy port");
    assert.equal(pointerUrl(), r2.agentCredentialProxyUrl, "pointer now follows launch-2");
    const staleWrapperBytesUnchanged =
      readFileSync(staleWrapper, "utf8").includes(r1.agentCredentialProxyUrl!);
    assert.ok(staleWrapperBytesUnchanged, "stale wrapper still carries its dead baked-in URL");
    console.log(`Phase B: restart moved proxy to ${r2.agentCredentialProxyUrl}; stale wrapper re-sends`);

    const b = await sendViaWrapper(staleWrapper, env, "phase-b: stale wrapper after daemon restart\n");
    assert.equal(b.status, 0, `phase B send failed (THE regression): ${b.stderr}\n${b.stdout}`);
    console.log("Phase B: PASS — stale launch-1 wrapper followed the pointer and still sent");

    const sentBodies = upstream.bodies.filter(
      (e) => e.method === "POST" && /^\/internal\/agent-api\/(v2\/)?send/.test(e.url),
    );
    assert.equal(sentBodies.length, 2, "both sends must have reached the upstream fixture");
    assert.match(sentBodies[1].body, /phase-b: stale wrapper after daemon restart/);

    // ---- Phase C: daemon fully down (no re-registration). The send must
    // fail with the daemon-availability hint, never a credential error.
    await __resetAgentCredentialProxyForTest();
    const c = await sendViaWrapper(staleWrapper, env, "phase-c: daemon down\n");
    assert.notEqual(c.status, 0, "send must fail while the daemon is down");
    assert.match(
      c.stderr + c.stdout,
      /not a credential problem/,
      "failure must point at daemon availability, not credentials",
    );
    console.log("Phase C: PASS — daemon down fails loudly with the availability hint");

    console.log("\nALL PHASES PASS: stale wrappers keep sending across daemon restarts.");
  } finally {
    await upstream.close();
    await __resetAgentCredentialProxyForTest();
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("E2E FAILED:", error);
  process.exit(1);
});
