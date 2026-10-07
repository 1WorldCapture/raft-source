// Record a real OMP RPC session as a test fixture (phase-1 task #3).
//
// Run manually on a machine with omp installed and logged in — never in CI:
//
//   pnpm --filter @botiverse/raft-daemon exec tsx scripts/omp-rpc-record.ts
//
// Hygiene (PM task #3 review): the child runs with --no-session (nothing is
// written to ~/.omp/agent/sessions), a disposable temp cwd containing only a
// synthetic a.txt, and a canned prompt. The recorder negotiates protocol v2,
// sends one prompt, and captures every stdout frame until the turn settles
// (prompt_result + session_settled) or a cap elapses. The output is sanitized
// (home paths, hostname, emails, bearer/token-shaped strings, provider account
// ids) and written to src/testdata/omp-rpc-session.jsonl.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

const CAPTURE_CAP_MS = 180_000;
const FIXTURE_PATH = new URL("../src/testdata/omp-rpc-session.jsonl", import.meta.url).pathname;

function sanitize(line: string, replacements: Array<[RegExp, string]>): string {
  let out = line;
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(path.join(tmpdir(), "omp-rpc-record-"));
  writeFileSync(path.join(workspace, "a.txt"), "The quick brown fox jumps over the lazy dog.\nLine two of the synthetic fixture file.\n");
  const command = process.env.OMP_BIN ?? "omp";
  const child = spawn(command, ["--mode", "rpc", "--no-session"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const home = process.env.HOME ?? "";
  const host = hostname();
  const replacements: Array<[RegExp, string]> = [
    [new RegExp(home.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"), "<HOME>"],
    [new RegExp(host.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi"), "<HOSTNAME>"],
    [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<EMAIL>"],
    [/\b(sk|rk|pk|api[_-]?key|bearer)[-_][A-Za-z0-9_-]{8,}\b/gi, "<TOKEN>"],
    [/"acct_[A-Za-z0-9_-]+"/g, '"<ACCOUNT>"'],
    [/"org_[A-Za-z0-9_-]+"/g, '"<ORG>"'],
    [new RegExp(workspace.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"), "<WORKSPACE>"],
  ];

  const frames: string[] = [];
  const seenTypes = new Map<string, number>();
  let settled = false;
  let sawPromptResult = false;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      frames.push(line);
      try {
        const frame = JSON.parse(line) as { type?: string };
        const type = frame.type ?? "unknown";
        seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1);
        if (frame.type === "prompt_result") sawPromptResult = true;
        if (frame.type === "session_settled" && sawPromptResult) settled = true;
      } catch {
        seenTypes.set("unparseable", (seenTypes.get("unparseable") ?? 0) + 1);
      }
    }
  });
  const stderrTail: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail.push(chunk);
    if (stderrTail.length > 40) stderrTail.shift();
  });

  // Handshake: ready frame → negotiate v2 (the recorder speaks the same
  // protocol as the daemon driver).
  const stdin = child.stdin;
  const waitForFrame = (type: string, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        if (frames.some((line) => line.includes(`"type":"${type}"`))) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${type}`));
        setTimeout(poll, 50);
      };
      poll();
    });

  await waitForFrame("ready", 60_000);
  stdin.write(JSON.stringify({ id: "rec-negotiate", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");

  const prompt = "Read the file a.txt in the current directory with your read tool, then reply with a one-sentence summary of it. Do not do anything else.";
  stdin.write(JSON.stringify({ id: "rec-prompt-1", type: "prompt", message: prompt }) + "\n");

  const startedAt = Date.now();
  while (!settled && Date.now() - startedAt < CAPTURE_CAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { child.kill("SIGKILL"); } catch { /* already gone */ }

  const sanitized = frames.map((line) => sanitize(line, replacements));
  mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, sanitized.join("\n") + "\n");

  console.log(`frames captured: ${frames.length}`);
  console.log("frame types:", [...seenTypes.entries()].map(([t, n]) => `${t}=${n}`).sort().join(" "));
  console.log(`settled: ${settled}`);
  console.log(`fixture: ${FIXTURE_PATH}`);
  if (!settled) {
    console.error("WARNING: capture ended without a settled turn; fixture may be truncated");
    console.error("stderr tail:", stderrTail.join("").slice(-2000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
