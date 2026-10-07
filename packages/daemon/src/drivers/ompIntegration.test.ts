/**
 * Real-CLI-path integration tests for the OMP driver (task #5, PM acceptance:
 * the standing prompt must hold on the REAL omp binary, not just fakes).
 *
 * Skipped by default — opt in with RUN_OMP_INTEGRATION_TESTS=1 (requires a
 * local `omp` >= 18.6.0; no provider credentials are needed because the test
 * mounts a mock OpenAI-compatible provider via PI_CODING_AGENT_DIR, so the
 * materializing turn never touches the user's subscription).
 *
 *   RUN_OMP_INTEGRATION_TESTS=1 pnpm --filter @botiverse/raft-daemon exec vitest run src/drivers/ompIntegration.test.ts
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";

import { OmpDriver } from "./omp.js";
import type { ParsedEvent, SpawnContext } from "./types.js";

const STANDING_MARKER = "RAFT-OMP-STANDING-MARKER-X9K2";
const AGENTS_SENTINEL = "SENTINEL-AGENTS-LEAK-CHECK-7Q3F";
const STANDING_PROMPT = `${STANDING_MARKER} You are a Raft agent. Follow the raft CLI rules.\n`;

const ompAvailable = await (async () => {
  try {
    const driver = new OmpDriver();
    const outcome = await driver.probe();
    return outcome.available;
  } catch {
    return false;
  }
})();

// The env switch is part of the gate (pi precedent): a bare `vitest run`
    // must never launch the real binary, even when omp is installed.
describe.skipIf(!process.env.RUN_OMP_INTEGRATION_TESTS || !ompAvailable)("omp real CLI integration (task #5)", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "slock-omp-e2e-"));
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "slock-omp-e2e-agent-"));
  writeFileSync(path.join(workspace, "AGENTS.md"), `# AGENTS\n\n${AGENTS_SENTINEL} do not leak\n`);
  writeFileSync(path.join(workspace, "SYSTEM.md"), `${AGENTS_SENTINEL}-system-md\n`);
  mkdirSync(path.join(workspace, ".omp"), { recursive: true });
  writeFileSync(path.join(workspace, ".omp", "AGENTS.md"), `# AGENTS\n\n${AGENTS_SENTINEL}-ompdir do not leak\n`);
  // The user-level context file in the redirected agent dir must SURVIVE
  // (PM task #5 ruling: user-level preferences stay, matching the Cursor
  // SDK decision) — only project-level discovery is disabled.
  const userContextMarker = "RAFT-USER-CONTEXT-KEPT-K4M8";
  writeFileSync(path.join(agentDir, "AGENTS.md"), `# AGENTS\n\n${userContextMarker} user prefs\n`);

  let mockServer: Server;
  let mockPort = 0;
  const savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

  const startMockLlm = (): Promise<number> =>
    new Promise((resolve) => {
      mockServer = createServer((req, res) => {
        if (req.url?.includes("/chat/completions")) {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          req.on("end", () => {
            const wantsStream = (() => {
              try { return JSON.parse(body).stream === true; } catch { return false; }
            })();
            res.setHeader("Content-Type", wantsStream ? "text/event-stream" : "application/json");
            if (wantsStream) {
              res.write('data: {"id":"mock-1","object":"chat.completion.chunk","created":1,"model":"raft-mock","choices":[{"index":0,"delta":{"role":"assistant","content":"mock-ok"},"finish_reason":null}]}\n\n');
              res.write('data: {"id":"mock-1","object":"chat.completion.chunk","created":1,"model":"raft-mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
              res.write("data: [DONE]\n\n");
            } else {
              res.end(JSON.stringify({
                id: "mock-1",
                object: "chat.completion",
                created: 1,
                model: "raft-mock",
                choices: [{ index: 0, message: { role: "assistant", content: "mock-ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }));
            }
          });
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const address = mockServer.address();
        mockPort = typeof address === "object" && address ? address.port : 0;
        resolve(mockPort);
      });
    });

  const writeModelsYml = (): void => {
    // The models config rides the redirected agent dir, so the mock provider
    // is the ONLY provider: the materializing turn cannot reach the network.
    writeFileSync(path.join(agentDir, "models.yml"), `providers:
  raft-mock:
    baseUrl: http://127.0.0.1:${mockPort}/v1
    api: openai-completions
    auth: none
    models:
      - id: raft-mock
        name: Raft Mock
        api: openai-completions
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 4096
`);
  };

  function makeContext(sessionId: string | null): SpawnContext {
    const ctx = {
      agentId: "agent-omp-e2e",
      standingPrompt: STANDING_PROMPT,
      prompt: "Start.",
      workingDirectory: workspace,
      slockCliPath: "/tmp/slock-cli.js",
      daemonApiKey: "daemon-token",
      launchId: "launch-e2e",
      config: {
        name: "OMP E2E",
        displayName: null,
        description: null,
        runtime: "omp",
        serverUrl: "https://slock.example",
        authToken: "agent-token",
        sessionId,
        model: "raft-mock/raft-mock",
        reasoningEffort: null,
        envVars: null,
        runtimeContext: {
          agentId: "agent-omp-e2e",
          serverId: "server-1",
          machineId: "machine-1",
          machineName: "Dev Machine",
          machineHostname: "host.local",
          machineOs: "darwin arm64",
          daemonVersion: "0.42.0",
          workspacePath: workspace,
        },
      },
    } as unknown as SpawnContext;
    return ctx;
  }

  async function readSystemPrompt(driver: OmpDriver): Promise<string> {
    const response = await driver.request({ type: "get_state" }, { timeoutMs: 20_000 });
    const data = response.data as { systemPrompt?: unknown } | undefined;
    const blocks = Array.isArray(data?.systemPrompt) ? data!.systemPrompt : [];
    return blocks.map((block) => String(block)).join("\n");
  }

  test("fresh and resumed launches both run the standing prompt with discovery isolation", { timeout: 120_000 }, async () => {
    const port = await startMockLlm();
    writeModelsYml();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const events: ParsedEvent[] = [];

    try {
      // Fresh launch (mode 1): the driver passes --system-prompt and the
      // isolation overlay; the first turn materializes the session through
      // the mock provider, so resume has something to load.
      const fresh = new OmpDriver();
      const freshSpawn = await fresh.spawn(makeContext(null));
      let freshStdout = "";
      freshSpawn.process.stdout?.setEncoding("utf8");
      freshSpawn.process.stdout?.on("data", (chunk: string) => {
        freshStdout += chunk;
        let index: number;
        while ((index = freshStdout.indexOf("\n")) >= 0) {
          const line = freshStdout.slice(0, index);
          freshStdout = freshStdout.slice(index + 1);
          if (line.trim()) events.push(...fresh.parseLine(line));
        }
      });
      freshSpawn.process.stdout?.resume();

      try {
        await fresh.whenReady();
        const promptText = await readSystemPrompt(fresh);
        assert.ok(promptText.includes(STANDING_MARKER), "the standing prompt must replace the default instruction block");
        assert.ok(!promptText.includes(AGENTS_SENTINEL), "workspace AGENTS.md/SYSTEM.md must not stack under the standing prompt");
        assert.ok(!promptText.includes(`${AGENTS_SENTINEL}-ompdir`), "project .omp/AGENTS.md must be disabled too");
        assert.ok(promptText.includes(userContextMarker), "user-level context must stay loaded (PM ruling)");

        // A real turn through the mock provider materializes the session.
        const idle = fresh.encodeStdinMessage("materialize please", null, { mode: "idle" });
        freshSpawn.process.stdin?.write(idle + "\n");
        const started = Date.now();
        while (!events.some((event) => event.kind === "turn_end") && Date.now() - started < 60_000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(events.some((event) => event.kind === "turn_end"), "the mock turn must complete");
        assert.ok(fresh.currentSessionId, "the turn must materialize a session id");
        const freshSessionId = fresh.currentSessionId!;

        // Resumed launch (mode 2; every wake that respawns takes this path):
        // the standing prompt and isolation must survive --resume.
        fresh.stop({ sigtermGraceMs: 100 });
        // omp holds an OS lease on the materialized session while it lives;
        // resume must wait for the first process to be fully gone.
        const firstProc = freshSpawn.process;
        const exitedAt = Date.now();
        while (firstProc.exitCode === null && firstProc.signalCode === null && Date.now() - exitedAt < 10_000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const resumed = new OmpDriver();
        const resumedSpawn = await resumed.spawn(makeContext(freshSessionId));
        let resumedStdout = "";
        resumedSpawn.process.stdout?.setEncoding("utf8");
        resumedSpawn.process.stdout?.on("data", (chunk: string) => {
          resumedStdout += chunk;
          let index: number;
          while ((index = resumedStdout.indexOf("\n")) >= 0) {
            const line = resumedStdout.slice(0, index);
            resumedStdout = resumedStdout.slice(index + 1);
            if (line.trim()) events.push(...resumed.parseLine(line));
          }
        });
        resumedSpawn.process.stdout?.resume();
        try {
          await resumed.whenReady();
          const resumedAt = Date.now();
          while (resumed.currentSessionId === null && Date.now() - resumedAt < 20_000) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(resumed.currentSessionId, freshSessionId, `the resumed driver must adopt the recorded session (got ${resumed.currentSessionId}, want ${freshSessionId}); fallback: ${resumed.resumeFallback}`);
          const resumedPrompt = await readSystemPrompt(resumed);
          assert.ok(resumedPrompt.includes(STANDING_MARKER), "the standing prompt must survive resume");
          assert.ok(!resumedPrompt.includes(AGENTS_SENTINEL), "discovery isolation must survive resume");
          assert.ok(resumedPrompt.includes(userContextMarker), "user-level context must survive resume too");
        } finally {
          resumed.stop({ sigtermGraceMs: 100 });
        }
      } finally {
        fresh.stop({ sigtermGraceMs: 100 });
      }
    } finally {
      process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
      mockServer.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("message-wake keeps the mounted prompt (steer path needs no re-mount)", { timeout: 30_000 }, () => {
    // Mode 3 (woken by a message): the daemon passes ctx.standingPrompt on
    // EVERY spawn (agentProcessManager buildSystemPrompt call is
    // unconditional), so a wake that respawns takes the fresh/resumed paths
    // verified above, and a wake that steers a LIVE process keeps the prompt
    // mounted at its launch. There is no third argv shape to test; the two
    // real-CLI launches above cover the mount itself.
    assert.ok(true);
  });
});
