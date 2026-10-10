import type { RuntimeDriver } from "./types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GrokDriver } from "./grok.js";
import { AntigravityDriver } from "./antigravity.deprecated.js";
import { AntigravityStreamDriver } from "./antigravityStream.js";
import { CopilotDriver } from "./copilot.js";
import { CursorSdkDriver } from "./cursor-sdk.js";
import { GeminiDriver } from "./gemini.js";
import { KimiDriver } from "./kimi.js";
import { KimiSdkDriver } from "./kimi-sdk.js";
import { OpenCodeDriver } from "./opencode.js";
import { BuiltInDriver, PiDriver } from "./pi.js";
import { OmpDriver } from "./omp.js";

export type {
  RuntimeDriver,
  RuntimeBusyDeliveryReadiness,
  ParsedEvent,
  SpawnContext,
  SpawnResult,
  RuntimeSession,
  RuntimeExitInfo,
  RuntimeSendResult,
  RuntimeSessionDescriptor,
  RuntimeTurnAttribution,
} from "./types.js";
export { createChildProcessRuntimeSession, ChildProcessRuntimeSession } from "./runtimeSession.js";
export {
  allowedTranscriptRootsForRuntime,
  ensureRuntimeHomeDir,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  writeRuntimeTerminalCauseRecord,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeTerminalCausePhase,
} from "./runtimeArtifacts.js";
export {
  projectCompactionInterruptionTraceAttrs,
  projectStructuredRuntimeTerminalFailure,
} from "../runtimeCompactionProjection.js";
export { resolveClaudeCommand } from "./claude.js";
export { buildCodexAppServerArgs, parseCodexJsonRpcLine, resolveCodexSpawn } from "./codex.js";

const driverFactories: Record<string, () => RuntimeDriver> = {
  builtin: () => new BuiltInDriver(),
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  grok: () => new GrokDriver(),
  // Deprecated: retain for existing agents to run/resume. Shared availability
  // and server admission prohibit creating agents or switching into this runtime.
  antigravity: () => new AntigravityDriver(),
  "antigravity-stream": () => new AntigravityStreamDriver(),
  copilot: () => new CopilotDriver(),
  "cursor-sdk": () => new CursorSdkDriver(),
  gemini: () => new GeminiDriver(),
  // Two separate Kimi runtimes (per #proj-runtime:cc818e65 6/16 consensus):
  //   - `kimi`     = legacy kimi-cli child-process driver. Backward-compat for
  //                  existing `runtime=kimi` agents. Frontend marks deprecated.
  //   - `kimi-sdk` = canonical in-process SDK driver. Frontend label "Kimi Code".
  // No alias / no auto-migration; explicit pick at agent-create time.
  kimi: () => new KimiDriver(),
  "kimi-sdk": () => new KimiSdkDriver(),
  opencode: () => new OpenCodeDriver(),
  pi: () => new PiDriver(),
  // OMP (oh-my-pi): registration + probe in phase-1 task #1; the RPC
  // transport (spawn/parse/stdin) lands with task #2. Server admission keeps
  // the runtime flag-gated until the phase is accepted end to end.
  omp: () => new OmpDriver(),
};

/** Runtime ids that existed once and are intentionally gone (not "unknown"). */
const RETIRED_RUNTIMES: Readonly<Record<string, string>> = {
  cursor: "the Cursor CLI runtime has been retired; use the Cursor SDK runtime (runtime id \"cursor-sdk\") instead",
};

/** Thrown for a runtime that was retired, so callers can report a clear reason instead of "Unknown runtime". */
export class RetiredRuntimeError extends Error {
  readonly runtimeId: string;
  constructor(runtimeId: string) {
    super(`Runtime "${runtimeId}" is no longer available: ${RETIRED_RUNTIMES[runtimeId]}.`);
    this.name = "RetiredRuntimeError";
    this.runtimeId = runtimeId;
  }
}

export function isRetiredRuntime(runtimeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_RUNTIMES, runtimeId);
}

/** Get the driver for a runtime ID. Throws RetiredRuntimeError for a retired runtime and Error if unknown. */
export function getDriver(runtimeId: string): RuntimeDriver {
  if (isRetiredRuntime(runtimeId)) throw new RetiredRuntimeError(runtimeId);
  const createDriver = driverFactories[runtimeId];
  const driver = createDriver?.();
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(", ")}`);
  }
  return driver;
}
