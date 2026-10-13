#!/usr/bin/env tsx
// Production feature-flag changes. This is the only supported writer: it
// calls featureFlagRolloutWriterService, which locks the current config
// version, applies the guardrail, and stores the audit receipt. Do not
// insert into feature_flags, feature_flag_rules, feature_flag_config_versions,
// or feature_flag_rollout_audit_events by hand.
//
// Inside the server image (DATABASE_URL is already set; do not print it):
//   node packages/server/dist/flag-rollout.js show --flag <flag>
//   node packages/server/dist/flag-rollout.js server_allowlist_add \
//     --flag <flag> --server <uuid> \
//     --actor-type human --actor-name <name> --reason "..." [--dry-run]
// Widening (allowlist add, or kill_switch_set --desired false) also needs
// --receipt-file pointing at a trusted guardrail receipt on the server.
// A source checkout can run the same file with tsx scripts/flag-rollout.ts.
import { readFile } from "node:fs/promises";

import { closeDatabase, initDatabase } from "../src/db/index.js";
import {
  FlagRolloutUsageError,
  indexReceiptDocument,
  parseFlagRolloutArgs,
  runFlagRollout,
  type FlagRolloutRequest,
} from "../src/services/featureFlagRolloutAdmin.js";

const CONTROL_PLANE_ENV = "RAFT_FEATURE_FLAG_CONTROL_PLANE_ID";

function controlPlaneId(env: NodeJS.ProcessEnv): string {
  const value = env[CONTROL_PLANE_ENV]?.trim() || "production";
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) {
    throw new FlagRolloutUsageError(`${CONTROL_PLANE_ENV} is not a valid control plane id`);
  }
  return value;
}

async function receiptLoader(request: FlagRolloutRequest): Promise<{
  request: FlagRolloutRequest;
  loadTrustedReceipt?: (receiptId: string) => Promise<unknown | null>;
}> {
  if (!request.receiptFile) return { request };
  const raw = await readFile(request.receiptFile, "utf8");
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    throw new FlagRolloutUsageError("receipt file is not valid JSON");
  }
  const store = indexReceiptDocument(document);
  let receiptId = request.receiptId;
  if (!receiptId) {
    if (store.size !== 1) {
      throw new FlagRolloutUsageError("--receipt-id is required when the receipt file has more than one receipt");
    }
    receiptId = [...store.keys()][0];
  }
  return {
    request: { ...request, receiptId },
    loadTrustedReceipt: async (id) => store.get(id) ?? null,
  };
}

async function main(): Promise<void> {
  const parsed = parseFlagRolloutArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new FlagRolloutUsageError("DATABASE_URL is required");
  const { request, loadTrustedReceipt } = await receiptLoader(parsed);
  await initDatabase(databaseUrl, undefined, { log() {} });
  try {
    const report = await runFlagRollout(request, {
      controlPlaneId: controlPlaneId(process.env),
      loadTrustedReceipt,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "flag rollout failed";
  process.stderr.write(`flag-rollout: ${message}\n`);
  process.exitCode = error instanceof FlagRolloutUsageError ? 2 : 1;
});
