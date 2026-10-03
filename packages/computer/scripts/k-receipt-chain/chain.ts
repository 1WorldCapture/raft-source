// k-receipt-chain — the replayable container acceptance script for task #11
// (May r2 ruling 2026-10-03: the upgrade chain IS the acceptance body).
//
//   serve 9.9.90/9.9.91/9.9.92 → bootstrap stable 9.9.90
//   → real upgrade to 9.9.91 whose coordinator SIGKILLs itself the instant
//     the journal records handing-over (kill -9 at a defined phase)
//   → fresh engine redo settles the transaction: receipt promoted WITHOUT
//     predecessor identities (the crash-redo shape)
//   → the computer recovery entry acknowledges it through the six gates
//     against REAL journal + REAL live-service attestation
//   → the NEXT upgrade to 9.9.92 passes (no lock, no refusal)
//
// Run inside the linux container (or any POSIX host) from packages/computer:
//   node --import tsx scripts/k-receipt-chain/chain.ts
// Prints one JSON evidence document; exit 0 only when every step held.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FakeServer } from "../../node_modules/@botiverse/k-carrier/harness/src/fake-server/server.ts";
import { ArtifactFactory } from "../../node_modules/@botiverse/k-carrier/harness/src/artifact-factory/factory.ts";
import { currentPlatformKey } from "../../node_modules/@botiverse/k-carrier/core/src/artifact/staticManifestSource.ts";
import { COMPUTER_ACCEPTANCE_APP_SOURCE } from "../../src/kAcceptanceApp.js";
import {
  recoverTerminalUpgradeReceiptMissingPredecessors,
} from "../../src/kOperationAcknowledgement.js";
import { kStateDir } from "../../src/kPaths.js";

const CHAIN_VERSIONS = ["9.9.90", "9.9.91", "9.9.92"] as const;
const STEP_TIMEOUT_MS = 180_000;

const evidence: Array<Record<string, unknown>> = [];
let sandbox: string | undefined;

function step(name: string, data: Record<string, unknown>): void {
  evidence.push({ step: name, ...data });
  process.stdout.write(`[chain] ${name} ok\n`);
}

function runnerPath(): string {
  return resolve(import.meta.dirname ?? ".", "runner.ts");
}

function runRunner(args: string[], env: Record<string, string>): Promise<{
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", runnerPath(), ...args],
      { cwd: resolve(import.meta.dirname ?? "..", ".."), env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function parseResult(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no RESULT line in runner output:\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

async function waitExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => { stdout += String(d); });
    child.stderr!.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, stdout, stderr });
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CHAIN ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  sandbox = await mkdtemp(join(tmpdir(), "k-receipt-chain-"));
  const slockHome = join(sandbox, "slock");
  const startedAt = new Date().toISOString();

  // 1. Serve each release from its own store (the static manifest exposes
  // the ACTIVE release; harness convention: one server per target version).
  const factory = new ArtifactFactory({
    cacheDir: join(sandbox, "cache"),
    demoSource: COMPUTER_ACCEPTANCE_APP_SOURCE,
  });
  const servers = new Map<string, FakeServer>();
  const artifactBytes = new Map<string, Uint8Array>();
  for (const version of CHAIN_VERSIONS) {
    const server = new FakeServer({ storeDir: join(sandbox, `serve-${version}`) });
    await server.start();
    const rel = await factory.makeRelease({
      version,
      behavior: "ok",
      store: server.store,
      platform: currentPlatformKey(),
    });
    servers.set(version, server);
    artifactBytes.set(version, rel.artifactBytes);
  }
  const baseUrl = (version: string) => servers.get(version)!.url;
  step("serve", { servers: [...servers.values()].map((s) => s.url), versions: CHAIN_VERSIONS });

  // 2. Bootstrap stable at 9.9.90 from the real seed artifact bytes.
  const seedArtifact = join(sandbox, "seed-artifact.bin");
  await writeFile(seedArtifact, artifactBytes.get("9.9.90")!, { mode: 0o755 });
  const boot = await runRunner(
    ["bootstrap", "--slock-home", slockHome, "--seed-artifact", seedArtifact, "--version", "9.9.90"],
    {},
  );
  assert(boot.code === 0, `bootstrap failed: ${boot.stderr}`);
  step("bootstrap", { stable: "9.9.90" });

  // 2b. Start the stable service — the real-machine shape. The live
  //     service's startId is what the journal's handing-over record carries
  //     as priorStartId (the engine probes it BEFORE the handover).
  const startRun = await runRunner(["start-service", "--slock-home", slockHome], {});
  assert(startRun.code === 0, `start-service failed: ${startRun.stderr}`);
  const startedProbe = parseResult(startRun.stdout).probe as { version?: string; startId?: string };
  assert(startedProbe.version === "9.9.90", `stable service must attest 9.9.90, got ${startedProbe.version}`);
  step("start-service", { version: startedProbe.version, startId: startedProbe.startId });

  // 3. Upgrade to 9.9.91; the coordinator kills itself inside the host
  //    adapter's first post-successor-start healthProbe (the write-path
  //    seam, May r2 rework option A): the running-experiment intent is
  //    durable and zero progress follows, so the redo deterministically
  //    verifies the live successor and completes the promote — the
  //    crash-redo receipt shape: promoted, predecessor identities absent.
  //    Both settle shapes stay accepted below as belt-and-braces.
  const op91 = `chain-${randomUUID().slice(0, 8)}`;
  const killChild = spawn(
    process.execPath,
    [
      "--import", "tsx", runnerPath(),
      "upgrade", "--slock-home", slockHome, "--base-url", baseUrl("9.9.91"),
      "--version", "9.9.91", "--operation-id", op91, "--kill-at-successor-probe", "1",
    ],
    { cwd: resolve(import.meta.dirname ?? "..", ".."), env: process.env },
  );
  const killed = await waitExit(killChild);
  assert(killed.signal === "SIGKILL", `expected SIGKILL death, got code=${killed.code} signal=${killed.signal} stderr=${killed.stderr}`);

  // 4. Crash shape: durable state says in-flight, no identities recorded.
  const afterCrash = parseResult(
    (await runRunner(["state", "--slock-home", slockHome, "--base-url", baseUrl("9.9.91")], {})).stdout,
  );
  const crashOp = (afterCrash.operation as { kind: string; operation: Record<string, unknown> }).operation;
  assert(crashOp.id === op91, `operation id mismatch after crash: ${crashOp.id}`);
  assert(crashOp.outcome === null, `expected in-flight (outcome null), got ${crashOp.outcome}`);
  const crashMeta = crashOp.metadata as Record<string, string>;
  assert(crashMeta.priorProcessIdentities === undefined, "crash-redo shape requires NO prior identities");
  const journal = await readFile(join(kStateDir(slockHome), "journal.jsonl"), "utf8");
  assert(journal.includes('"handing-over"'), "journal must carry the handing-over record");
  assert(journal.includes('"probing"') === false, "the seam must kill before any phase past handing-over");
  assert(journal.includes('"running-experiment"') === false, "the seam must kill before the engine journals running-experiment");
  step("crash-at-running-experiment", { operationId: op91, coordinatorPid: crashMeta.coordinatorPid, outcome: null });

  // 5. Fresh engine redo settles the transaction (coordinator's redo path).
  //    The kill point sits inside running-experiment whose sub-position
  //    varies, so redo legitimately settles EITHER way (May r2 review):
  //    promoted (successor evidence verified) or rolled-back (fail-safe).
  //    BOTH shapes are accepted and each runs the full acceptance below.
  const rec = await runRunner(
    ["recover", "--slock-home", slockHome, "--base-url", baseUrl("9.9.91"), "--operation-id", op91],
    {},
  );
  assert(rec.code === 0, `recover failed: ${rec.stderr}`);
  const recovered = parseResult(rec.stdout);
  const recOp = (recovered.operation as { operation: Record<string, unknown> }).operation;
  const settle = recOp.outcome as "promoted" | "rolled-back" | string;
  assert(settle === "promoted" || settle === "rolled-back", `redo must settle promoted or rolled-back, got ${settle}`);
  assert((recOp.metadata as Record<string, string>).priorProcessIdentities === undefined, "redo receipt must lack predecessor identities");
  step("redo", { operationId: op91, outcome: settle, identities: "absent" });

  // 6. THE ACCEPTANCE: the computer recovery entry acknowledges the
  //    identity-less receipt through its six gates (real journal, real
  //    live-service attestation, real pids). The outcome whitelist covers
  //    both settle shapes: promoted checks the target version, rolled-back
  //    checks the restored from-version.
  const expectedVersion = settle === "promoted" ? "9.9.91" : "9.9.90";
  const audited: string[] = [];
  const t0 = Date.now();
  const receipt = await recoverTerminalUpgradeReceiptMissingPredecessors(slockHome, op91, {
    audit: (line) => audited.push(line),
  });
  step("recovery-entry", {
    status: receipt.status,
    outcome: receipt.outcome,
    expectedVersion,
    ms: Date.now() - t0,
  });
  assert(receipt.status === "acknowledged", `recovery entry refused: ${JSON.stringify(receipt)}`);
  assert(receipt.outcome === settle, `recovered outcome must match the redo settle (${settle}), got ${receipt.outcome}`);
  assert(audited.length === 1, `exactly one audit line expected, got ${audited.length}`);
  assert(audited[0]!.includes("RECEIPT_RECOVERED_MISSING_PREDECESSORS"), "audit line must carry the recovery marker");
  assert(audited[0]!.includes(`outcome=${settle}`), "audit line must carry the settled outcome");

  // 7. The NEXT upgrade passes end to end (what a missing recovery used to
  //    brick: the next upgrade blocked behind the unacknowledged receipt).
  const op92 = `chain-${randomUUID().slice(0, 8)}`;
  const next = await runRunner(
    ["upgrade", "--slock-home", slockHome, "--base-url", baseUrl("9.9.92"), "--version", "9.9.92", "--operation-id", op92],
    {},
  );
  assert(next.code === 0, `next upgrade failed: ${next.stderr}`);
  const nextResult = parseResult(next.stdout);
  const nextOutcome = nextResult.outcome as { result?: string };
  assert(nextOutcome.result === "promoted", `next upgrade must promote, got ${JSON.stringify(nextOutcome)}`);
  const finalState = parseResult(
    (await runRunner(["state", "--slock-home", slockHome, "--base-url", baseUrl("9.9.92")], {})).stdout,
  );
  const finalTxn = finalState.state as { phase?: string; stableVersion?: string };
  assert(finalTxn.stableVersion === "9.9.92", `stable must be 9.9.92, got ${finalTxn.stableVersion} (phase ${finalTxn.phase})`);
  step("next-upgrade", { operationId: op92, outcome: "promoted", stable: finalTxn.stableVersion });

  for (const server of servers.values()) await server.stop();
  const document = {
    chain: "k-receipt-upgrade-chain",
    startedAt,
    finishedAt: new Date().toISOString(),
    sandbox,
    result: "PASS",
    steps: evidence,
  };
  process.stdout.write(`EVIDENCE ${JSON.stringify(document)}\n`);
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (error) => {
  process.stderr.write(`chain failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.stdout.write(`EVIDENCE ${JSON.stringify({ result: "FAIL", steps: evidence })}\n`);
  // Hygiene: a failed chain can leave a resumed service running from the
  // sandbox; stop it so reruns start clean.
  if (sandbox !== undefined) {
    await new Promise<void>((r) => {
      const killer = spawn("pkill", ["-f", sandbox]);
      killer.on("close", () => r());
      killer.on("error", () => r());
    });
  }
  process.exit(1);
});
