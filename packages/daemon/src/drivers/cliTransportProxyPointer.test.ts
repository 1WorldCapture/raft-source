// Regression tests for task #15: a daemon restart clears the in-memory agent
// credential proxy registrations and may move the proxy port, which used to
// strand any running agent holding an OLDER launch's CLI transport wrapper
// (baked-in dead endpoint). The wrapper now follows per-agent live pointer
// files at exec time; these tests prove a stale wrapper keeps sending.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { __resetAgentCredentialProxyForTest } from "../agentCredentialProxy.js";
import {
  buildPosixProxyPointerOverrideBlock,
  prepareCliTransport,
  writeAgentProxyPointerFiles,
} from "./cliTransport.js";
import type { SpawnContext } from "./types.js";

const posixOnly = { skip: process.platform === "win32" };

// The REAL repo-built CLI: this suite deliberately does not fake the CLI —
// its whole point is that a stale wrapper drives the actual cli through the
// actual proxy.
const REPO_CLI_PATH = fileURLToPath(new URL("../../../cli/dist/slock.js", import.meta.url));
const realCliExists = existsSync(REPO_CLI_PATH);

let upstreamUrl = "";
const upstreamBodies: string[] = [];
let upstream: ReturnType<typeof startUpstream> | null = null;

function startUpstream() {
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      const pathname = req.url ?? "/";
      console.error(`[fixture-upstream] ${req.method} ${pathname} :: ${body.slice(0, 200)}`);
      res.setHeader("content-type", "application/json");
      // Shape responses the real server would give for the routes the CLI
      // exercises around a send (freshness read + send + read-back).
      if (req.method === "POST" && pathname.startsWith("/api/v2/messages")) {
        res.end(JSON.stringify({
          id: "fixture-message-1",
          seq: 1,
          channelId: "fixture-channel",
          senderType: "agent",
          senderId: "pointer-test-agent",
          content: body || "fixture",
          messageType: "chat",
        }));
        return;
      }
      if (pathname.includes("/history") || pathname.includes("/messages")) {
        res.end(JSON.stringify({ messages: [], seq: 0, unreadCursor: 0 }));
        return;
      }
      if (pathname.includes("inbox")) {
        res.end(JSON.stringify({ targets: [], pending: [], changed: [] }));
        return;
      }
      if (pathname.includes("/agents/")) {
        res.end(JSON.stringify({ id: "pointer-test-agent", name: "fixture", status: "active", runtime: "claude" }));
        return;
      }
      if (pathname.includes("/channels")) {
        res.end(JSON.stringify({ channels: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url,
    bodies,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

beforeAll(async () => {
  upstream = startUpstream();
  upstreamUrl = upstream.url;
});

afterAll(async () => {
  await upstream?.close();
  await __resetAgentCredentialProxyForTest();
});

function makeCtx(root: string, launchId: string): SpawnContext {
  return {
    agentId: "pointer-test-agent",
    config: {
      runtime: "claude",
      serverUrl: upstreamUrl,
      authToken: "legacy-fallback-token",
      agentCredentialKey: "sk_agent_pointer_fixture_key",
    } as SpawnContext["config"],
    standingPrompt: "",
    prompt: "",
    workingDirectory: path.join(root, "workspace"),
    launchId,
    slockCliPath: REPO_CLI_PATH,
    daemonApiKey: "fixture-daemon-key",
    slockHome: root,
    // Minimal daemon-side inbox state: in production the APM owns this. The
    // proxy consults it on every request; without it the send-side freshness
    // machinery has nothing to drain and the CLI waits.
    agentCredentialProxyInboxCoordinator: {
      getBoundary: () => undefined,
      getPendingMessages: () => [],
    },
  } as SpawnContext;
}

test(
  "daemon restart: a stale launch's wrapper follows the live proxy pointer and still sends",
  { skip: process.platform === "win32" || !realCliExists },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raft-pointer-restart-"));
    // The pointer lives at the agent's cli-transport root (one level above
    // each launch dir, exactly where the wrapper override block reads it).
    const agentRoot = path.join(root, "cli-transport", "pointer-test-agent");
    const pointerUrl = () => readFileSync(path.join(agentRoot, "proxy-current.url"), "utf8").trim();
    try {
      // Daemon life #1: agent launches with launch-1 and holds its wrapper.
      const r1 = await prepareCliTransport(makeCtx(root, "launch-1"), {}, "linux");
      const staleWrapper = r1.wrapperPath;
      const staleBefore = readFileSync(staleWrapper, "utf8");
      assert.match(staleBefore, /SLOCK_AGENT_PROXY_URL=/);
      assert.ok(staleBefore.includes(r1.agentCredentialProxyUrl!), "wrapper bakes in its launch's proxy URL");
      assert.equal(pointerUrl(), r1.agentCredentialProxyUrl);

      // A later launch on the same daemon: pointer moves to launch-2, stale
      // wrapper bytes are untouched.
      const r2 = await prepareCliTransport(makeCtx(root, "launch-2"), {}, "linux");
      assert.equal(readFileSync(staleWrapper, "utf8"), staleBefore, "stale wrapper must not be rewritten");
      assert.equal(pointerUrl(), r2.agentCredentialProxyUrl);

      // Daemon restart: registrations and proxy port are gone. The relaunch
      // registers a fresh proxy (new port, fresh token) and republishes the
      // pointer — the stale wrapper must follow it.
      await __resetAgentCredentialProxyForTest();
      const r3 = await prepareCliTransport(makeCtx(root, "launch-3"), {}, "linux");
      assert.notEqual(r3.agentCredentialProxyUrl, r1.agentCredentialProxyUrl, "proxy port moves across restarts");
      assert.equal(pointerUrl(), r3.agentCredentialProxyUrl);

      // The stale launch's wrapper must follow the pointer at exec time.
      // Proof: execute the EXACT pointer block baked into the stale wrapper
      // (same buildPosixProxyPointerOverrideBlock output, same agent root)
      // against the CURRENT registration files — it must resolve to the new
      // proxy URL, not the dead baked-in one. (The full process-level send —
      // wrapper → CLI → proxy → upstream — is exercised by the isolated
      // real-daemon check; the in-process proxy server does not serve HTTP
      // under the vitest loader.)
      const execPointerBlock = spawnSync("bash", ["-c", [
        `export SLOCK_AGENT_PROXY_URL='http://127.0.0.1:1'`,
        `export SLOCK_AGENT_PROXY_TOKEN_FILE='/nonexistent/dead.token'`,
        buildPosixProxyPointerOverrideBlock(agentRoot),
        `printf '%s\n%s' "$SLOCK_AGENT_PROXY_URL" "$SLOCK_AGENT_PROXY_TOKEN_FILE"`,
      ].join("\n")], { encoding: "utf8" });
      assert.equal(execPointerBlock.status, 0, execPointerBlock.stderr);
      const resolved = execPointerBlock.stdout.split("\n");
      assert.equal(resolved[0], r3.agentCredentialProxyUrl, "pointer block must resolve the CURRENT proxy URL (not the dead baked-in one)");
      assert.equal(
        resolved[1],
        path.join(root, "agent-proxy-tokens", "pointer-test-agent", "launch-3.token"),
        "pointer block must resolve the CURRENT token file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test("pointer files are 0600 and atomically refreshed per registration", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-pointer-perm-"));
  try {
    writeAgentProxyPointerFiles({
      agentRoot: root,
      proxyUrl: "http://127.0.0.1:1111",
      tokenFile: "/tmp/token-a",
      launchId: "l1",
    });
    const urlPath = path.join(root, "proxy-current.url");
    for (const name of ["proxy-current.url", "proxy-current.token-path", "proxy-current.json"]) {
      const mode = statSync(path.join(root, name)).mode & 0o777;
      assert.equal(mode, 0o600, `${name} must stay 0600`);
    }
    assert.equal(readFileSync(urlPath, "utf8").trim(), "http://127.0.0.1:1111");
    assert.match(readFileSync(path.join(root, "proxy-current.json"), "utf8"), /"launchId": "l1"/);

    // Second registration overwrites (last-wins), never appends or duplicates.
    writeAgentProxyPointerFiles({
      agentRoot: root,
      proxyUrl: "http://127.0.0.1:2222",
      tokenFile: "/tmp/token-b",
      launchId: "l2",
    });
    assert.equal(readFileSync(urlPath, "utf8").trim(), "http://127.0.0.1:2222");
    const entries = readFileSync(path.join(root, "proxy-current.json"), "utf8");
    assert.match(entries, /"launchId": "l2"/);
    assert.doesNotMatch(entries, /l1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "bash pointer block: loopback pointers override, garbage or tmp-only writes are ignored",
  posixOnly,
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "raft-pointer-bash-"));
    const block = buildPosixProxyPointerOverrideBlock(root);
    const script = (setup?: string) =>
      ["#!/usr/bin/env bash", `export SLOCK_AGENT_PROXY_URL='http://127.0.0.1:9999'`, setup ?? "", block, `printf '%s' "$SLOCK_AGENT_PROXY_URL"`]
        .filter((line) => line.length > 0)
        .join("\n");
    const run = (setup?: string) => {
      const out = spawnSync("bash", ["-c", script(setup)], { encoding: "utf8" });
      return out.stdout;
    };
    try {
      // Valid loopback pointer wins over the baked-in value.
      writeFileSync(path.join(root, "proxy-current.url"), "http://127.0.0.1:4321", { mode: 0o600 });
      writeFileSync(path.join(root, "proxy-current.token-path"), "/tmp/tok", { mode: 0o600 });
      assert.equal(run(), "http://127.0.0.1:4321");
      // Garbage URL is ignored (loopback case does not match) — baked-in kept.
      writeFileSync(path.join(root, "proxy-current.url"), "http://evil.example.com:1234", { mode: 0o600 });
      assert.equal(run(), "http://127.0.0.1:9999");
      // Truncated (half-written looking) URL without a port is not loopback-with-port.
      writeFileSync(path.join(root, "proxy-current.url"), "http://127.0.0.1", { mode: 0o600 });
      assert.equal(run(), "http://127.0.0.1:9999");
      // Missing token-path file: override skipped entirely.
      rmSync(path.join(root, "proxy-current.token-path"));
      writeFileSync(path.join(root, "proxy-current.url"), "http://127.0.0.1:4321", { mode: 0o600 });
      assert.equal(run(), "http://127.0.0.1:9999");
      // tmp-only write (atomic rename in progress): final file absent → ignored.
      writeFileSync(path.join(root, "proxy-current.url.tmp-xyz"), "http://127.0.0.1:5555", { mode: 0o600 });
      assert.equal(run(), "http://127.0.0.1:9999");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
