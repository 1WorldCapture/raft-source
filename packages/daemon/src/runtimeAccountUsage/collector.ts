import type { Runtime } from "@botiverse/oar";
import { createLazyModule } from "../lazyModule.js";

import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import {
  projectOarAccountUsageFailure,
  projectOarAccountUsageSnapshot,
  type OarAccountUsageSnapshot,
} from "./oarAdapter.js";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Exhaustive mapping: every account-usage provider is read through OAR. OAR is
 * ~170MB of resident memory once loaded and only the server's usage refresh
 * needs it, so it is imported on the first read instead of at daemon boot. A
 * failed import is not cached: the next read retries.
 */
const oarModule = createLazyModule<typeof import("@botiverse/oar")>(() => import("@botiverse/oar"));
const loadOar = () => oarModule.get();

/** Exported for tests: resolves a provider's OAR runtime, loading OAR on first use. */
export async function oarRuntimeForProvider(provider: RuntimeAccountUsageProvider): Promise<Runtime> {
  const oar = await loadOar();
  return ({
    codex: oar.codexRuntime,
    claude: oar.claudeRuntime,
    kimi: oar.kimiRuntime,
    grok: oar.grokRuntime,
  } as const satisfies Record<RuntimeAccountUsageProvider, Runtime>)[provider];
}

/** Injectable for tests; production passes the real OAR runtime. */
export type OarUsageReadDeps = {
  readonly runtime?: Runtime;
  readonly timeoutMs?: number;
};

/**
 * Reads one provider's account usage through OAR and projects it onto the Raft
 * wire shape.
 *
 * The two failure vocabularies are kept apart on purpose:
 *  - `unsupported` means Raft structurally cannot obtain a reading — the
 *    runtime exposes no probe or reader, or is not installed on this machine.
 *  - `error` means we tried and the attempt failed (threw, timed out, or
 *    returned something unusable).
 * Collapsing these would make "we never could" and "it broke just now" look
 * identical to every consumer downstream.
 */
export async function readOarAccountUsage(input: {
  provider: RuntimeAccountUsageProvider;
  localAccountSlot: string;
  collectorVersion: string;
  observedAtMs: number;
  deps?: OarUsageReadDeps;
}): Promise<RuntimeAccountUsageSnapshot> {
  const failure = () => projectOarAccountUsageFailure({
    provider: input.provider,
    localAccountSlot: input.localAccountSlot,
    collectorVersion: input.collectorVersion,
    observedAtMs: input.observedAtMs,
  });
  let runtime = input.deps?.runtime;
  if (!runtime) {
    try {
      runtime = await oarRuntimeForProvider(input.provider);
    } catch {
      // OAR could not be loaded: an attempt that failed, not an absent reader.
      return failure();
    }
  }
  const project = (snapshot: OarAccountUsageSnapshot): RuntimeAccountUsageSnapshot =>
    projectOarAccountUsageSnapshot({
      provider: input.provider,
      snapshot,
      localAccountSlot: input.localAccountSlot,
      collectorVersion: input.collectorVersion,
      observedAtMs: input.observedAtMs,
    });

  const probe = runtime.installation;
  const readUsage = runtime.accountUsage;
  if (!probe || !readUsage) {
    // Structural absence, not a failed attempt.
    return project({ kind: "unsupported" });
  }

  try {
    const installation = await probe();
    if (installation.kind !== "available") {
      // `not_found` and `unsupported` are both "no reading is obtainable here".
      return project({ kind: "unsupported" });
    }
    const snapshot = await readUsage(installation, {
      timeoutMs: input.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return project(snapshot);
  } catch {
    // A thrown read is an explicit error account with no windows. It must never
    // be rendered as zero usage.
    return failure();
  }
}

export type RuntimeAccountUsageCollector = (
  provider: RuntimeAccountUsageProvider,
) => Promise<RuntimeAccountUsageSnapshot>;

/** Read every provider through OAR and project its published usage contract. */
export function createRuntimeAccountUsageCollector(input: {
  localAccountSlot: string;
  collectorVersion: string;
  now?: () => number;
  /** Test seam for the OAR read; production uses the real runtimes. */
  oar?: OarUsageReadDeps;
}): RuntimeAccountUsageCollector {
  const now = input.now ?? Date.now;
  return (provider) => readOarAccountUsage({
    provider,
    localAccountSlot: input.localAccountSlot,
    collectorVersion: input.collectorVersion,
    observedAtMs: now(),
    ...(input.oar ? { deps: input.oar } : {}),
  });
}
