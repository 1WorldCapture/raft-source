import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { CursorSdkRuntimeSession } from "./cursor-sdk.js";
import { buildCliTransportSystemPrompt } from "./cliTransport.js";
import type { ParsedEvent, SpawnContext } from "./types.js";
import type { AgentConfig } from "@botiverse/raft-shared";

// Explicit opt-in like cursorSdkLive.integration.test.ts: real staged assets,
// real @cursor/sdk, real existing SDK login, and — unlike the live smoke — a
// REAL CLI transport path (prepareCliTransport runs for real, registering the
// real agent credential proxy) fronting a minimal fixture upstream. This is
// the regression net for the standing-prompt defect: a message-woken agent
// must actually execute the raft CLI (fixture upstream sees the request)
// instead of only producing text.
const live = process.env.RAFT_CURSOR_SDK_LIVE_SMOKE === "1" ? test : test.skip;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, max = 120_000) {
  const end = Date.now() + max;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(50);
  }
}

const REPO_CLI_PATH = fileURLToPath(new URL("../../../cli/dist/slock.js", import.meta.url));

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

async function startFixtureUpstream(): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      // Minimal sane responses for the routes the CLI exercises. The proxy
      // forwards /internal/agent-api/* here after stripping that prefix.
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && (req.url ?? "").startsWith("/api/v2/messages")) {
        res.end(JSON.stringify({ id: "fixture-message-1", seq: 1 }));
        return;
      }
      if ((req.url ?? "").startsWith("/api/agents/")) {
        res.end(JSON.stringify({ id: "fixture-agent", name: "fixture", status: "active" }));
        return;
      }
      if ((req.url ?? "").includes("inbox")) {
        res.end(JSON.stringify({ targets: [], pending: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function makeConfig(serverUrl: string): AgentConfig {
  return {
    name: "Cursor CLI-path fixture",
    displayName: null,
    description: null,
    runtime: "cursor-sdk",
    serverUrl,
    authToken: "fixture-legacy-token",
    // Non-empty on purpose: the production proxy transport path (real agent
    // credential proxy + wrapper with SLOCK_AGENT_PROXY_URL) is what the
    // defect escaped through when tests sealed the transport behind a seam.
    agentCredentialKey: "sk_agent_live_fixture_key",
    sessionId: null,
    model: "default",
    reasoningEffort: null,
    envVars: null,
    runtimeContext: null,
  };
}

live(
  "message-woken cursor-sdk agent executes the real raft CLI through the real transport",
  { timeout: 240_000 },
  async () => {
    const upstream = await startFixtureUpstream();
    const root = await mkdtemp(path.join(os.tmpdir(), "raft-cursor-cli-path-"));
    const work = path.join(root, "workspace");
    await mkdir(work);
    const marker = `cli-path-marker-${Date.now()}`;
    const events: ParsedEvent[] = [];
    let runtime: CursorSdkRuntimeSession | null = null;
    try {
      const config = makeConfig(upstream.url);
      const ctx: SpawnContext = {
        agentId: "cursor-sdk-cli-path-fixture",
        // The REAL production standing prompt: it teaches the agent the raft
        // CLI surface. The driver mounts it as a project rule on launch.
        standingPrompt: buildCliTransportSystemPrompt(config, { extraCriticalRules: [] }),
        prompt: "",
        workingDirectory: work,
        slockCliPath: REPO_CLI_PATH,
        // The machine's real isolated Raft home: the credential broker reads
        // the existing (read-only) SDK binding from there, exactly like the
        // desktop test instance does.
        slockHome: "/Users/lyon/raft-e2e/cursor-sdk/home",
        daemonApiKey: "fixture-daemon-key",
        config,
      } as SpawnContext;

      runtime = new CursorSdkRuntimeSession(ctx, () => {}, {
        prepareManagedMcp: async () => null,
        // prepareTransport intentionally NOT sealed: the real CLI transport
        // (wrapper + real agent credential proxy) is the point of this test.
      });
      runtime.on("runtime_event", (event) => events.push(event));

      // Mount check belongs to the unit suite; here it is the precondition
      // that makes the CLI guidance visible to the agent at all.
      const start = await runtime.start({
        text: [
          "[Raft inbox notice:",
          `#general pending: 1 message · latest sender @anna-e2e · you were mentioned`,
          "]",
          "Use the raft CLI to send a chat message to #general whose body is exactly:",
          marker,
          "Then finish your turn.",
        ].join("\n"),
      });
      assert.equal(start.ok, true);
      assert.equal(
        existsSync(path.join(work, ".cursor", "rules", "raft-agent.mdc")),
        true,
        "standing prompt rule must be mounted before the host starts",
      );

      // The defect: without the mounted rule the agent produced text only and
      // NEVER executed the CLI. With the rule, the fixture upstream must see
      // real CLI traffic (proxy → upstream) carrying the marker.
      await until(
        () => upstream.requests.some((r) => r.body.includes(marker) || r.path.includes("messages")),
        "agent-driven CLI request reaching the fixture upstream",
      );
      const sendLike = upstream.requests.find(
        (r) => r.method === "POST" && r.body.includes(marker),
      );
      assert.ok(
        sendLike,
        `fixture upstream must observe a POST carrying the marker; saw: ${JSON.stringify(
          upstream.requests.map((r) => ({ m: r.method, p: r.path })),
        )}`,
      );

      await runtime.stop({ forceAfterMs: 5000, reason: "cli-path-live-close" });
      assert.equal(runtime.closed, true);
    } finally {
      if (runtime) await runtime.stop({ forceAfterMs: 2000, reason: "cli-path-finally" }).catch(() => {});
      await upstream.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
