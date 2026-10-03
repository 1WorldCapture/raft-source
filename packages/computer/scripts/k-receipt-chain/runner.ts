// k-receipt-chain runner — the CHILD side of the task #11 container
// acceptance chain (#bugfix:0f23b6da, May r2 ruling 2026-10-03: "docker 起 →
// 定义相位 SIGKILL 协调者 → redo → 恢复入口 → 验证 → 下一版升级通过").
//
// Every mode drives the REAL production wiring — createUpgrader with the
// real Computer host adapter (real fs, real processes, real pids) and a real
// HTTP release source over the served releases. Receipts are stamped exactly
// like runKUpgradeCoordinator stamps local cli receipts (trigger/scope/
// coordinatorPid), so the operation records have production shape.
//
// Modes (one per invocation; one trailing "RESULT {...}" line on stdout):
//   bootstrap --slock-home H --seed-artifact P --version V
//       Seed K's stable slot once from the trusted seed bytes.
//   start-service --slock-home H
//       Start the stable service through the real adapter (detached spawn)
//       and print its probe evidence — the live service the handover hands
//       over FROM (its startId becomes the journal's priorStartId).
//   upgrade --slock-home H --base-url U --version V --operation-id ID
//       [--kill-at-intent intent]
//       One real upgradeTo() transaction. With the kill flag the process
//       SIGKILLs ITSELF as soon as the journal records the given intent —
//       kill -9 at a defined phase, no cross-process race: only durable
//       state survives, which is exactly the crash-redo shape.
//   recover --slock-home H --base-url U --operation-id ID
//       Fresh engine over the same durable state: settle the in-flight
//       transaction (the coordinator's redo path).
//   state --slock-home H --base-url U
//       Print { operation, state } for assertions.

import {
  createUpgrader,
  bootstrapStable,
  fileProvenanceJournal,
  type CreateUpgraderOptions,
  type HostAdapter,
  type NotificationEvent,
  type ReleaseSource,
  type Upgrader,
} from "@botiverse/k-carrier";
import { createKHostAdapter } from "../../src/kHostAdapter.js";
import { kStateDir } from "../../src/kPaths.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// staticManifestSource is not on the package exports map; import it by file
// path through pnpm's symlink like the harness scenarios do.
const K_CORE_URL = new URL(
  "../../node_modules/@botiverse/k-carrier/core/src/",
  import.meta.url,
);

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      args[a.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    } else if (args.mode === undefined) {
      args.mode = a;
    }
  }
  return args;
}

async function buildUpgrader(slockHome: string, baseUrl: string): Promise<Upgrader> {
  const stateDir = kStateDir(slockHome);
  // The PRODUCTION host adapter with ONE harness-standard deviation: the
  // managed-set reads are static-matched to the acceptance app (the sandbox
  // has no daemon-configured managed servers). Every other path — slot
  // resolution, IPC, stop/spawn, pidfile, surfaces — is production.
  const host: HostAdapter = createKHostAdapter(slockHome, {
    listManagedServerIdsFn: async () => ["srv-a"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }),
  });
  const source: ReleaseSource = await import(
    new URL("artifact/staticManifestSource.ts", K_CORE_URL).href
  ).then((m) => m.staticManifestSource({ baseUrl }));
  const opts: CreateUpgraderOptions = {
    stateDir,
    host,
    source,
    policy: "auto",
    notificationSink: async (_event: NotificationEvent) => {},
    provenance: fileProvenanceJournal(stateDir),
    provenanceIdentity: { who: "local", carrier: "cli" },
    // No lifecycleSurfaces: the production service-executable surface reads
    // the resident/SEA executable shape, which a plain-node staged artifact
    // does not have. The surfaces are optional — omitted, that predicate is
    // skipped — and the harness's own service-tier checks do the same for
    // fixture-owned readbacks.
  };
  return createUpgrader(opts);
}

async function waitIntent(stateDir: string, intent: string): Promise<void> {
  const journalPath = join(stateDir, "journal.jsonl");
  for (;;) {
    const text = await readFile(journalPath, "utf8").catch(() => "");
    if (text.includes(`"${intent}"`)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? "";
  const slockHome = resolve(args["slock-home"] ?? "");
  const baseUrl = args["base-url"] ?? "";
  const stateDir = kStateDir(slockHome);

  if (mode === "bootstrap") {
    await bootstrapStable({
      stateDir,
      version: args.version!,
      artifactPath: resolve(args["seed-artifact"]!),
    });
    emit({ mode, stable: args.version });
    return;
  }

  if (mode === "start-service") {
    const adapter = createKHostAdapter(slockHome, {
      listManagedServerIdsFn: async () => ["srv-a"],
      readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }),
    });
    await adapter.start("stable");
    const probe = await adapter.healthProbe();
    emit({ mode, probe });
    return;
  }

  const u = await buildUpgrader(slockHome, baseUrl);

  if (mode === "upgrade") {
    if (args["kill-at-intent"]) {
      void waitIntent(stateDir, args["kill-at-intent"]).then(() => {
        process.kill(process.pid, "SIGKILL");
      });
    }
    const outcome = await u.upgradeTo(args.version!, {
      consented: true,
      provenance: { who: "local", carrier: "cli" },
      operation: {
        id: args["operation-id"]!,
        startedAtMs: Date.now(),
        metadata: {
          trigger: "cli",
          upgradeScopeVersion: "1",
          upgradeScope: "local",
          coordinatorPid: String(process.pid),
        },
      },
    });
    emit({ mode, version: args.version, outcome });
    return;
  }

  if (mode === "recover") {
    const before = await u.operation();
    if (before.kind !== "observed" || before.operation.id !== args["operation-id"]) {
      emit({ mode, result: "recovery-not-needed", operation: before });
      return;
    }
    if (before.operation.outcome !== null) {
      emit({ mode, result: "already-settled", operation: before });
      return;
    }
    await u.recover();
    const after = await u.operation();
    const state = await u.state();
    emit({ mode, result: "recovered-terminal", operation: after, state });
    return;
  }

  if (mode === "state") {
    const operation = await u.operation();
    const state = await u.state();
    emit({ mode, operation, state });
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

function emit(payload: unknown): void {
  process.stdout.write(`RESULT ${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  process.stderr.write(`runner failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
