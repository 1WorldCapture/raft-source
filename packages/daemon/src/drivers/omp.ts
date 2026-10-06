import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ManagedMcpRuntimeTool } from "@botiverse/raft-shared";

import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import {
  callManagedMcpTool,
  fetchManagedMcpToolSnapshot,
  managedMcpHttpErrorDetail,
  type ManagedMcpEndpoint,
} from "./managedMcpTools.js";
import { logger } from "../logger.js";
import {
  closeOmpTurnOnProcessExit,
  createOmpEventMappingState,
  mapOmpRpcFrameToParsedEvents,
  type OmpEventMappingState,
} from "./ompEventNormalizer.js";
import {
  MAX_OMP_RPC_FRAME_BYTES,
  MAX_OMP_RPC_REASSEMBLED_BYTES,
  OmpRpcFrameDecoder,
  OmpRpcFrameError,
  encodeOmpRpcFrame,
} from "./ompRpcFrame.js";
import { firstExistingPath, readCommandVersion, resolveCommandOnPath, type ProbeDeps } from "./probe.js";
import type { AgentConfig, AxSurfaceText } from "@botiverse/raft-shared";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types.js";

// OMP (oh-my-pi) ships a Bun-only SDK, so the daemon drives it as a
// `omp --mode rpc` child process over stdio NDJSON. Task #2 owns the transport
// (framing, ready/negotiation, request correlation, lifecycle); event mapping
// lands with task #3, session control with #4, Raft integration (system
// prompt, CLI env, managed MCP host tools) with #5.
export const MIN_SUPPORTED_OMP_VERSION = "18.6.0";

const OMP_BINARY = "omp";

/** Launch-file names written into the per-agent CLI transport dir (0600). */
const OMP_SYSTEM_PROMPT_FILE = "omp-system-prompt.md";
const OMP_CONFIG_OVERLAY_FILE = "omp-config-overlay.yml";

/**
 * Discovery providers disabled for managed agents (task #5). `--system-prompt`
 * only replaces the instruction block — omp's generated `<project-context>`
 * footer would still render every discovered context file, so a workspace
 * AGENTS.md / CLAUDE.md would silently stack under the Raft standing prompt.
 * `disabledProviders` is a whole-provider switch (context files, rules, MCP
 * servers, …), and it is the only CLI-level knob; suppressing user-level
 * context as well is accepted so the managed prompt stays authoritative.
 * Authentication / the user's subscription live outside the provider system
 * and are unaffected (task #5 spec: use ~/.omp, never modify it).
 */
const OMP_DISABLED_DISCOVERY_PROVIDERS = [
  "native",
  "claude",
  "codex",
  "gemini",
  "opencode",
  "github",
  "agents",
  "agents-md",
  "claude-md",
];

/** Bound for the ready frame and each RPC request, mirroring the bundled clients. */
const OMP_RPC_READY_TIMEOUT_MS = 30_000;
const OMP_RPC_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Long-running commands that answer only when the work finishes; they get no
 * request timeout — liveness is judged by the process staying up and the event
 * stream, never by the wall clock (PM task #2 review).
 */
const OMP_RPC_NO_TIMEOUT_COMMANDS = new Set(["bash", "compact", "live_start", "btw", "handoff", "export_html"]);

/** Grace between the SIGTERM and SIGKILL passes when stopping the process tree. */
const OMP_STOP_SIGTERM_GRACE_MS = 3000;

/** Head start given to a best-effort abort command before the tree kill. */
const OMP_STOP_ABORT_HEAD_START_MS = 100;

/**



 */


function killPosixProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    // The child spawns detached, so -pid addresses its whole process group.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

function killWindowsProcessTree(pid: number): void {
  const killer = childSpawn("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.unref();
}

function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    // taskkill /T walks the tree directly; it has no signal distinction.
    killWindowsProcessTree(pid);
    return;
  }
  killPosixProcessTree(pid, signal);
}

/**
 * Fallback lookup paths for non-interactive daemon environments whose PATH
 * misses the user install locations. Order matters: PATH wins (it may carry a
 * deliberately pinned install), then omp.sh's default install dir
 * ($HOME/.local/bin, PI_INSTALL_DIR-relocatable), then the bun installer's
 * $HOME/.bun/bin, then the Homebrew prefixes.
 */
export function ompCandidatePaths(deps: ProbeDeps = {}): string[] {
  const homeDir = deps.homeDir ?? deps.env?.HOME ?? process.env.HOME ?? "";
  return [
    path.join(homeDir, ".local", "bin", OMP_BINARY),
    path.join(homeDir, ".bun", "bin", OMP_BINARY),
    path.join("/opt", "homebrew", "bin", OMP_BINARY),
    path.join("/usr", "local", "bin", OMP_BINARY),
  ];
}

/**
 * Resolve the omp executable to an absolute path. Callers launch with this
 * resolved path (never a bare "omp") so the child does not depend on the
 * daemon's PATH.
 */
export function resolveOmpCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath(OMP_BINARY, deps) ?? firstExistingPath(ompCandidatePaths(deps), deps);
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedOmpVersion(version: string | null | undefined): boolean {
  if (!version) return true;
  const actual = parseSemver(version);
  const minimum = parseSemver(MIN_SUPPORTED_OMP_VERSION);
  if (!actual || !minimum) return true;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

export function unsupportedOmpVersionMessage(version: string | null | undefined): string | null {
  if (!version || isSupportedOmpVersion(version)) return null;
  return `OMP ${version} is unsupported; requires OMP >= ${MIN_SUPPORTED_OMP_VERSION}. Upgrade omp (curl -fsSL https://omp.sh/install | sh, or brew install can1357/tap/omp) before starting this runtime.`;
}

export interface OmpProbeDeps extends ProbeDeps {}

// ── RPC wire types (oh-my-pi docs/rpc.md) ──

export interface OmpRpcReadyFrame {
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

export interface OmpRpcResponseFrame {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** Outbound (docs/rpc.md "Host Tool Sub-Protocol"): registers host-owned tools. */
interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Inbound: the agent wants the host to execute one registered tool. */
interface OmpHostToolCallFrame {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Inbound: a pending host tool call must be aborted. */
interface OmpHostToolCancelFrame {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

/**
 * Managed-agent discovery isolation overlay (task #5). Loaded with
 * `--config` so the launch never touches the user's global omp config.
 */
function buildOmpConfigOverlay(): string {
  return [
    "# Written by the Raft daemon (task #5): managed agents get the Raft",
    "# standing prompt as their sole instruction source — omp's context-file",
    "# discovery (workspace AGENTS.md/CLAUDE.md, user-level equivalents) must",
    "# not stack underneath it.",
    "disabledProviders:",
    ...OMP_DISABLED_DISCOVERY_PROVIDERS.map((provider) => `  - ${provider}`),
    "",
  ].join("\n");
}

export class OmpRpcProcessExitedError extends Error {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;

  constructor(code: number | null, signal: string | null, stderrTail: string) {
    const exit = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    const stderr = stderrTail.trim();
    super(`OMP RPC process exited (${exit})${stderr ? `: ${stderr}` : ""}`);
    this.name = "OmpRpcProcessExitedError";
    this.code = code;
    this.signal = signal;
    this.stderrTail = stderrTail;
  }
}

export class OmpRpcRequestTimeoutError extends Error {
  readonly command: string;
  readonly id: string;

  constructor(command: string, id: string, timeoutMs: number) {
    super(`OMP RPC request timed out after ${timeoutMs}ms: ${command} (id ${id})`);
    this.name = "OmpRpcRequestTimeoutError";
    this.command = command;
    this.id = id;
  }
}

export class OmpRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpRpcProtocolError";
  }
}

interface PendingOmpRpcRequest {
  command: string;
  resolve: (response: OmpRpcResponseFrame) => void;
  reject: (error: Error) => void;
  /** Null for commands that run without a wall-clock bound. */
  timer: NodeJS.Timeout | null;
}

export interface OmpRpcLaunchOverrides {
  /** Test seam: launch this command instead of the resolved omp binary. */
  command?: string;
  /** Test seam: replace the omp argument list entirely (no session args). */
  args?: string[];
  /** Test seam: append to the built argument list (keeps session args). */
  extraArgs?: string[];
  /** Test seam: bound the ready-frame wait instead of the 30s default. */
  readyTimeoutMs?: number;
}

const STDERR_TAIL_LIMIT = 4000;

/** Phase-1 log-only frame categories: never mapped, never dropped silently. */
const OMP_LOG_ONLY_FRAME_TYPES = new Set([
  "advisor_cost_changed",
  "advisor_yielded",
  "subagent_lifecycle",
  "subagent_progress",
  "subagent_event",
  "btw_delta",
  "btw_record",
  "live_phase",
  "live_levels",
  "live_transcript",
  "live_end",
  "command_output",
  "available_commands_update",
  "extension_error",
  "extension_ui_request",
  "session_info_update",
  "config_update",
  "queue_update",
  "model_changed",
  "thinking_level_changed",
  "config_warnings_changed",
  "goal_updated",
  "agent_start",
  "turn_start",
  "turn_end",
]);

export class OmpDriver implements RuntimeDriver {
  readonly id = "omp";
  // Phase-1 target contract: `omp --mode rpc` is a long-lived stdio process
  // that accepts prompt/steer/abort, like the codex app-server shape. Tasks
  // #2/#3 own the transport and event mapping and confirm these constants.
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly stdoutChannel = "structured_protocol";
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly supportsNativeStandingPrompt = true;

  private process: ChildProcess | null = null;
  private decoder = new OmpRpcFrameDecoder();
  private requestCounter = 0;
  private pending = new Map<string, PendingOmpRpcRequest>();
  private readyTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";
  private readyDeferred: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
  private eventState: OmpEventMappingState = createOmpEventMappingState();
  /** Events produced before the session machinery attaches; drained on the next parseLine. */
  private queuedEvents: ParsedEvent[] = [];

  // Transport state, exposed for observability and the phase-1 turn work (#3+).
  private ready = false;
  private protocolVersion = 0;
  private negotiatedProtocolVersion: number | null = null;
  /** Set once negotiation has settled (v2 confirmed, or the peer is v1-only). */
  private protocolSettled = false;
  private maxFrameBytes: number = MAX_OMP_RPC_FRAME_BYTES;
  private maxReassembledFrameBytes: number = MAX_OMP_RPC_REASSEMBLED_BYTES;
  private frameErrorCount = 0;
  private lastFrameError: string | null = null;
  private lastProtocolError: string | null = null;

  // Session state (phase-1 task #4).
  private sessionId: string | null = null;
  private sessionDir: string | null = null;
  private resumeAttempted = false;
  private resumeFallbackNotice: string | null = null;
  private launchRetryUsed = false;
  /** Ids issued by encodeStdinMessage; refusals surface as error events. */
  private deliveryIds = new Map<string, string>();

  // Raft integration (task #5): launch files, managed MCP host tools.
  private systemPromptPath: string | null = null;
  private configOverlayPath: string | null = null;
  private hostToolEndpoint: ManagedMcpEndpoint | null = null;
  private hostTools: ManagedMcpRuntimeTool[] = [];
  /** In-flight host_tool_call executions keyed by the omp frame id. */
  private hostToolCalls = new Map<string, { controller: AbortController }>();

  /** True once the ready frame has been seen (and negotiation dispatched if offered). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Runtime-native session identity observed via get_state after startup. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** True when the handshake fully settled: sends are safe. */
  get isProtocolSettled(): boolean {
    return this.protocolSettled;
  }

  /** Non-null when a --resume attempt fell back to a fresh session. */
  get resumeFallback(): string | null {
    return this.resumeFallbackNotice;
  }

  private createReadyDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The deferred may be discarded without a consumer (never-ready tests,
    // stop() races); mark it handled so abandonment is never an unhandled
    // rejection. Real consumers via whenReady() still receive the rejection.
    promise.catch(() => {});
    return { promise, resolve, reject };
  }

  /**
   * Resolves once the transport is usable: the ready frame has been seen AND
   * protocol negotiation has settled (confirmed v2, or a v1-only peer, or a
   * failed negotiation — which rejects). Task #4's turn sends should await
   * this instead of racing the handshake.
   */
  whenReady(): Promise<void> {
    return this.readyDeferred?.promise ?? Promise.reject(new OmpRpcProtocolError("OMP RPC process is not running"));
  }

  /** Protocol version after negotiation: 1, 2, or 0 before the ready frame. */
  get activeProtocolVersion(): number {
    return this.negotiatedProtocolVersion ?? this.protocolVersion;
  }

  get frameErrors(): { count: number; last: string | null } {
    return { count: this.frameErrorCount, last: this.lastFrameError };
  }

  get protocolError(): string | null {
    return this.lastProtocolError;
  }

  probe(deps: OmpProbeDeps = {}): RuntimeProbeResult {
    const command = resolveOmpCommand(deps);
    if (!command) return { available: false };
    const version = readCommandVersion(command, [], deps);
    const unsupportedMessage = unsupportedOmpVersionMessage(version);
    if (unsupportedMessage) {
      return {
        available: false,
        version: `${version ?? "unknown"} (requires >= ${MIN_SUPPORTED_OMP_VERSION})`,
        diagnostic: unsupportedMessage,
      };
    }
    return { available: true, version: version ?? undefined };
  }

  async spawn(ctx: SpawnContext, launchOverrides: OmpRpcLaunchOverrides = {}): Promise<SpawnResult> {
    const { spawnEnv, slockDir } = await prepareCliTransport(ctx, { NO_COLOR: "1" });

    // Managed-agent launch files live in the per-agent CLI transport dir —
    // 0600, outside the workspace, rewritten every spawn (task #5). The
    // prompt travels as a file because omp treats a multi-line
    // --system-prompt VALUE as a literal, while a single-line path is read
    // as a file (docs/system-prompt-customization.md).
    this.systemPromptPath = this.writeLaunchFile(slockDir, OMP_SYSTEM_PROMPT_FILE, ctx.standingPrompt);
    this.configOverlayPath = this.writeLaunchFile(slockDir, OMP_CONFIG_OVERLAY_FILE, buildOmpConfigOverlay());

    // Managed MCP tools (task #5): membership is the server's decision, made
    // against the agent credential. Fetching is best-effort — a failure means
    // the agent runs without managed tools this launch, never a dead session.
    this.hostTools = [];
    this.hostToolEndpoint = ctx.config.agentCredentialKey
      ? { serverUrl: ctx.config.serverUrl, agentCredentialKey: ctx.config.agentCredentialKey }
      : null;
    if (this.hostToolEndpoint) {
      try {
        this.hostTools = await fetchManagedMcpToolSnapshot(this.hostToolEndpoint);
      } catch (error) {
        logger.warn(`[omp] managed MCP tools unavailable: ${managedMcpHttpErrorDetail(error)}`);
        this.hostToolEndpoint = null;
      }
    }

    this.process = null;
    this.decoder = new OmpRpcFrameDecoder();
    this.requestCounter = 0;
    this.pending.clear();
    this.clearReadyTimer();
    this.stderrTail = "";
    this.ready = false;
    this.protocolVersion = 0;
    this.negotiatedProtocolVersion = null;
    this.protocolSettled = false;
    this.maxFrameBytes = MAX_OMP_RPC_FRAME_BYTES;
    this.maxReassembledFrameBytes = MAX_OMP_RPC_REASSEMBLED_BYTES;
    this.frameErrorCount = 0;
    this.lastFrameError = null;
    this.lastProtocolError = null;
    this.eventState = createOmpEventMappingState();
    this.readyDeferred = this.createReadyDeferred();
    this.deliveryIds.clear();
    this.hostToolCalls.clear();
    this.sessionId = null;
    this.resumeFallbackNotice = null;
    this.launchRetryUsed = false;
    this.deliveryIds.clear();

    // Per-workspace session isolation (PM task #4): never mix with the
    // user's own omp sessions in ~/.omp.
    this.sessionDir = launchOverrides.args ? null : path.join(ctx.workingDirectory, ".omp-sessions");

    const resumeSessionId = typeof ctx.config.sessionId === "string" && ctx.config.sessionId.trim()
      ? ctx.config.sessionId
      : null;

    const firstAttempt = await this.launchChild(ctx, spawnEnv, launchOverrides, resumeSessionId);

    // Resume fallback (PM task #4 r2): the condition is "exited before the
    // ready frame" — wait for ready or exit, whichever comes first, capped by
    // the ready timeout. Measured on a real omp 18.6.1 (owner's Mac, temp
    // session dir): a nonexistent session id exits pre-ready at ~1.6s
    // (extension discovery + session load take longer than any fixed window),
    // while a session whose saved model is unavailable still reaches ready at
    // ~0.8s and surfaces model problems per-turn. The scanner buffers raw
    // lines without parsing; on ready it hands the buffered lines to
    // parseLine so the driver settles (negotiation sent) before the session
    // machinery attaches. An omp that cannot resume may just as well be a
    // broken binary or a logged-out machine, so the fallback diagnostic
    // carries the first exit's stderr summary; a fallback launch failing
    // pre-ready is the REAL startup error and is not retried again.
    if (resumeSessionId !== null && !launchOverrides.args) {
      const firstOutcome = await this.awaitResumeHandshake(firstAttempt.process, launchOverrides.readyTimeoutMs ?? OMP_RPC_READY_TIMEOUT_MS);
      if (firstOutcome.outcome === "timeout") {
        const timeoutError = new OmpRpcProtocolError(
          `OMP RPC process did not send a ready frame within ${launchOverrides.readyTimeoutMs ?? OMP_RPC_READY_TIMEOUT_MS}ms. stderr: ${this.stderrTail.trim()}`,
        );
        this.recordProtocolError(timeoutError.message);
        this.killProcess();
        throw timeoutError;
      }
      if (firstOutcome.outcome === "exit") {
        this.launchRetryUsed = true;
        const firstExitSummary = this.stderrTail.trim().slice(-600) || firstOutcome.summary;
        this.resumeFallbackNotice = `OMP could not resume session ${resumeSessionId}; started a fresh session. First exit: ${firstExitSummary}`;
        logger.info(`[omp] ${this.resumeFallbackNotice}`);
        // Reset per-generation state for the fresh launch. The first
        // attempt's readyDeferred was rejected by its exit handler; silence
        // the abandoned promise before replacing it.
        this.readyDeferred?.promise.catch(() => {});
        this.decoder = new OmpRpcFrameDecoder();
        this.pending.clear();
        this.clearReadyTimer();
        this.stderrTail = "";
        this.ready = false;
        this.protocolSettled = false;
        this.readyDeferred = this.createReadyDeferred();
        this.hostToolCalls.clear();
        return this.launchChild(ctx, spawnEnv, launchOverrides, null);
      }
      // Ready: settle the driver from the buffered lines (ready → negotiate →
      // …). Event-producing frames among them (a tool call sharing the ready
      // chunk, an early session_init) are queued and drained into the
      // machinery's first parseLine call, in wire order.
      for (const line of firstOutcome.bufferedLines) {
        this.queuedEvents.push(...this.parseLine(line));
      }
    }

    return firstAttempt;
  }

  /**
   * Watch a resume attempt until the ready frame or an exit, whichever comes
   * first, capped by the ready timeout. Raw line scanning only — parsed
   * processing happens in spawn's handoff (bufferedLines) so parseLine is
   * never called twice per line.
   *
   * Data safety (PM task #4 r3): at handoff the stream is PAUSED (removing a
   * data listener does not stop a flowing stream) and any bytes after the
   * ready line are pushed back with unshift, so the session machinery's
   * reader — attaching right after spawn returns — replays every byte, even
   * a partial line sharing the ready chunk.
   */
  private awaitResumeHandshake(
    proc: ChildProcess,
    readyTimeoutMs: number,
  ): Promise<{ outcome: "ready"; bufferedLines: string[] } | { outcome: "exit"; summary: string } | { outcome: "timeout" }> {
    return new Promise((resolve) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (result: { outcome: "ready"; bufferedLines: string[] } | { outcome: "exit"; summary: string } | { outcome: "timeout" }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout?.off("data", onStdout);
        proc.off("exit", onExit);
        resolve(result);
      };
      const completeLines: string[] = [];
      const onStdout = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        let index: number;
        while ((index = buffer.indexOf(0x0a)) >= 0) {
          const lineBytes = buffer.subarray(0, index);
          buffer = buffer.subarray(index + 1);
          const line = lineBytes.toString("utf8");
          if (!line.trim()) continue;
          let frameType: unknown = null;
          try {
            const value: unknown = JSON.parse(line);
            if (typeof value === "object" && value !== null) frameType = (value as { type?: unknown }).type;
          } catch {
            // Unparseable lines stay buffered like any other line.
          }
          completeLines.push(line);
          if (frameType === "ready") {
            // Stop the stream before nobody owns it, and return every byte
            // after the ready line to the front of the queue. The explicit
            // pause is half of the handover contract: the session machinery
            // resumes the stream after attaching its reader (runtimeSession
            // attachProcess) — a plain data listener does not clear an
            // explicit pause (verified on Node 26).
            proc.stdout?.pause();
            if (buffer.byteLength > 0) proc.stdout?.unshift(buffer);
            buffer = Buffer.alloc(0);
            finish({ outcome: "ready", bufferedLines: completeLines });
            return;
          }
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish({ outcome: "exit", summary: `exit ${code ?? signal ?? "unknown"}` });
      };
      const timer = setTimeout(() => finish({ outcome: "timeout" }), readyTimeoutMs);
      timer.unref?.();
      proc.stdout?.on("data", onStdout);
      proc.on("exit", onExit);
    });
  }

  private async launchChild(
    ctx: SpawnContext,
    spawnEnv: NodeJS.ProcessEnv,
    launchOverrides: OmpRpcLaunchOverrides,
    resumeSessionId: string | null,
  ): Promise<SpawnResult> {
    const resuming = resumeSessionId !== null && !launchOverrides.args;
    this.resumeAttempted = resuming;
    const command = launchOverrides.command ?? resolveOmpCommand() ?? OMP_BINARY;
    let args: string[];
    if (launchOverrides.args) {
      args = launchOverrides.args;
    } else {
      // extraArgs leads the list so a script seam (command: node, extraArgs:
      // [script, mode]) sees its own argv first; omp itself treats flags
      // order-independently. --system-prompt and --config ride along on both
      // fresh and resumed launches: resumed sessions re-apply the current
      // standing prompt (task #5 — new / resumed / woken launches must all
      // run with it).
      args = [
        ...(launchOverrides.extraArgs ?? []),
        "--mode", "rpc",
        "--session-dir", this.sessionDir!,
        ...(this.systemPromptPath ? ["--system-prompt", this.systemPromptPath] : []),
        ...(this.configOverlayPath ? ["--config", this.configOverlayPath] : []),
      ];
      if (resumeSessionId) args = [...args, "--resume", resumeSessionId];
    }

    const proc = childSpawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      // Own process group, so stop() can take down omp plus every bash
      // tool / subagent / kernel descendant it spawned (PM task #2 review).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.process = proc;

    // Every handler closes over its own proc and checks it against the
    // driver's current process: a late exit/error from a PREVIOUS generation
    // (stop() then spawn() again — the resume flow of task #4) must never
    // clear the new session's state or reject its pending requests.
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.process !== proc) return;
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
    });

    proc.stdin?.on("error", (error) => {
      // A dead child turns stdin writes into async EPIPE errors; they must
      // become typed request rejections, never an uncaught daemon crash.
      if (this.process !== proc) return;
      this.failAllPending(new OmpRpcProcessExitedError(null, null, `stdin error: ${error.message}\n${this.stderrTail}`));
    });

    proc.on("error", (error) => {
      // Spawn failures (ENOENT etc.); the exit handler covers real exits.
      if (this.process !== proc) return;
      this.failAllPending(new OmpRpcProcessExitedError(null, null, `${error.message}\n${this.stderrTail}`));
    });

    proc.on("exit", (code, signal) => {
      // Sweep lingering group members (a crashed omp can leave bash tools /
      // subagents alive) even when the event is from a stale generation.
      if (proc.pid) killProcessTree(proc.pid, "SIGKILL");
      if (this.process !== proc) return;
      this.clearReadyTimer();

      // Map the closing turn exactly once before the failure path (PM task
      // #3: an interrupted turn ends with an error and a turn_end, never
      // hangs). The turn layer consumes the closure from #5 on; here it is
      // logged so the exactly-once behavior is observable in the field.
      const turnClosure = closeOmpTurnOnProcessExit(this.eventState, `process exited (${code ?? signal ?? "unknown"})`);
      if (turnClosure.length > 0) {
        logger.info(`[omp] turn closed by process exit: ${turnClosure.map((event) => event.kind).join("+")}`);
      }

      this.process = null;
      this.readyDeferred?.reject(new OmpRpcProcessExitedError(code, signal, this.stderrTail));
      this.readyDeferred = null;
      this.abortHostToolCalls();
      this.failAllPending(new OmpRpcProcessExitedError(code, signal, this.stderrTail));
    });

    // The ready frame must arrive on its own; nothing the daemon sends can
    // prompt it. A launch that never becomes ready is killed here instead of
    // leaving a silent child behind for the session watchdog. Resume first
    // attempts are watched by spawn's outcome watcher instead (its timeout
    // decides the fallback), so the two timers never race on one process.
    if (!resumeSessionId) {
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        const timeoutError = new OmpRpcProtocolError(
          `OMP RPC process did not send a ready frame within ${launchOverrides.readyTimeoutMs ?? OMP_RPC_READY_TIMEOUT_MS}ms. stderr: ${this.stderrTail.trim()}`,
        );
        this.recordProtocolError(timeoutError.message);
        this.readyDeferred?.reject(timeoutError);
        this.readyDeferred = null;
        this.killProcess();
        this.failAllPending(timeoutError);
      }, launchOverrides.readyTimeoutMs ?? OMP_RPC_READY_TIMEOUT_MS);
      this.readyTimer.unref?.();
    }

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    if (!this.process) return [];

    // Events produced before the machinery attached (the resume handshake's
    // handoff) lead the first parseLine result, in wire order.
    let queued = this.queuedEvents;
    if (queued.length > 0) this.queuedEvents = [];

    let frame: object;
    try {
      const decoded = this.decoder.pushLine(line);
      // An in-progress rpc_chunk sequence has nothing to dispatch yet.
      if (!decoded) {
        if (queued.length > 0) return queued;
        return [];
      }
      frame = decoded;
    } catch (error) {
      const message = error instanceof OmpRpcFrameError ? error.message : String(error);
      this.frameErrorCount += 1;
      this.lastFrameError = message;
      if (queued.length > 0) return queued;
      return [];
    }

    const type = (frame as { type?: unknown }).type;
    if (type === "ready") {
      this.handleReady(frame as unknown as OmpRpcReadyFrame);
      return queued;
    }
    if (type === "response") {
      const events = this.handleResponse(frame as unknown as OmpRpcResponseFrame);
      return [...queued, ...events];
    }
    if (type === "host_tool_call") {
      // Host tool executions are daemon business, not agent-visible events:
      // execute against the managed MCP endpoint and answer over stdin.
      this.handleHostToolCall(frame as unknown as OmpHostToolCallFrame);
      return queued;
    }
    if (type === "host_tool_cancel") {
      this.handleHostToolCancel(frame as unknown as OmpHostToolCancelFrame);
      return queued;
    }
    if (typeof type === "string" && OMP_LOG_ONLY_FRAME_TYPES.has(type)) {
      logger.info(`[omp] ${type} frame observed (phase-1 log-only, not mapped)`);
      return queued;
    }
    const mapped = mapOmpRpcFrameToParsedEvents(frame, this.eventState);
    return queued.length > 0 ? [...queued, ...mapped] : mapped;
  }

  /**
   * Send one RPC command and resolve with its response, matched by id. Command
   * failures (`success: false`) still resolve — callers inspect the response;
   * timeouts and process exits reject with typed errors.
   *
   * Timeout policy (PM task #2 review): the default bound does not fit every
   * command — `bash`, `compact`, and friends legitimately answer long after 30s,
   * so they run without a timer. A timeout means "the host stopped waiting",
   * not "the work failed": no automatic abort is sent, because that would kill
   * slow-but-legitimate work; abort remains an explicit turn-layer decision
   * (phase-1 tasks #3/#4).
   */
  request(
    command: Record<string, unknown> & { type: string },
    opts: { timeoutMs?: number } = {},
  ): Promise<OmpRpcResponseFrame> {
    const proc = this.process;
    if (!proc || !this.ready) {
      return Promise.reject(new OmpRpcProtocolError("OMP RPC process is not ready"));
    }
    const id = `omp-${++this.requestCounter}`;
    const timeoutMs = opts.timeoutMs
      ?? (OMP_RPC_NO_TIMEOUT_COMMANDS.has(command.type) ? Number.POSITIVE_INFINITY : OMP_RPC_REQUEST_TIMEOUT_MS);

    let line: string;
    try {
      line = encodeOmpRpcFrame({ id, ...command }, { maxPhysicalFrameBytes: this.maxFrameBytes });
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<OmpRpcResponseFrame>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new OmpRpcRequestTimeoutError(command.type, id, timeoutMs));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      try {
        proc.stdin?.write(line);
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new OmpRpcProcessExitedError(null, null, `stdin write failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /**
   * Stop the runtime: best-effort abort FIRST (written straight to stdin —
   * request() would refuse because it tears the session down), then take down
   * the whole process tree (omp spawns bash tools, subagents, kernels) with
   * SIGTERM, SIGKILL after the grace period. The abort gets a head start so
   * the child can read it before the SIGTERM lands. The pid-addressed kills
   * reach the group even after the parent is gone. Idempotent.
   */
  stop(opts: { sigtermGraceMs?: number } = {}): void {
    const proc = this.process;
    if (!proc) return;
    const pid = proc.pid;

    if (this.ready && pid && proc.stdin?.writable) {
      try {
        const line = encodeOmpRpcFrame(
          { id: `omp-stop-${++this.requestCounter}`, type: "abort" },
          { maxPhysicalFrameBytes: this.maxFrameBytes },
        );
        proc.stdin.write(line);
      } catch {
        // The child is already gone; the tree kill below still runs.
      }
    }

    const failPending = () => {
      this.readyDeferred?.reject(new OmpRpcProtocolError("OMP RPC session stopped"));
      this.readyDeferred = null;
      this.failAllPending(new OmpRpcProtocolError("OMP RPC session stopped"));
    };

    if (!pid) {
      this.process = null;
      proc.kill();
      failPending();
      return;
    }

    // Give the abort a real head start: SIGTERM goes out after the write has
    // had a moment to be read, then SIGKILL after the grace period.
    const sigtermTimer = setTimeout(() => {
      killProcessTree(pid, "SIGTERM");
      const sigkillTimer = setTimeout(() => {
        killProcessTree(pid, "SIGKILL");
      }, opts.sigtermGraceMs ?? OMP_STOP_SIGTERM_GRACE_MS);
      sigkillTimer.unref?.();
    }, OMP_STOP_ABORT_HEAD_START_MS);
    sigtermTimer.unref?.();

    this.process = null;
    this.abortHostToolCalls();
    failPending();
  }

  private handleReady(frame: OmpRpcReadyFrame): void {
    this.clearReadyTimer();
    this.ready = true;
    this.protocolVersion = typeof frame.protocolVersion === "number" ? frame.protocolVersion : 1;
    if (typeof frame.maxFrameBytes === "number" && frame.maxFrameBytes > 0) {
      this.maxFrameBytes = frame.maxFrameBytes;
    }
    if (typeof frame.maxReassembledFrameBytes === "number" && frame.maxReassembledFrameBytes > 0) {
      this.maxReassembledFrameBytes = frame.maxReassembledFrameBytes;
      this.decoder.setMaxReassembledFrameBytes(frame.maxReassembledFrameBytes);
    }

    const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
    if (!supported.includes(2)) {
      // v1-only server: the 1 MiB physical cap stands, nothing to negotiate.
      this.negotiatedProtocolVersion = null;
      this.settleProtocol();
      return;
    }
    // The server advertised v2, so a failed handshake is an inconsistent peer,
    // not a downgrade path — mirror the official client's hard error.
    void this.request({ type: "negotiate_protocol", protocolVersion: 2 })
      .then((response) => {
        if (!response.success || response.command !== "negotiate_protocol") {
          throw new OmpRpcProtocolError(`OMP RPC protocol v2 negotiation failed: ${response.error ?? "refused"}`);
        }
        const data = response.data as { protocolVersion?: unknown } | undefined;
        if (data?.protocolVersion !== 2) {
          throw new OmpRpcProtocolError("OMP RPC protocol v2 negotiation failed: server did not confirm v2");
        }
        this.negotiatedProtocolVersion = 2;
        this.settleProtocol();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.recordProtocolError(message);
        this.readyDeferred?.reject(error instanceof Error ? error : new Error(message));
        this.readyDeferred = null;
        this.killProcess();
        this.failAllPending(error instanceof Error ? error : new Error(message));
      });
  }

  /**
   * The handshake is complete: turn sends are safe, host tools are mounted,
   * and the session identity can be read (get_state) so the daemon can
   * persist it for resume. Host tools register BEFORE whenReady resolves, so
   * the first model call of any launch already sees them (task #5).
   */
  private settleProtocol(): void {
    this.protocolSettled = true;
    void this.registerHostTools().then(() => {
      this.readyDeferred?.resolve();
      this.readyDeferred = null;
      void this.request({ type: "get_state" }).catch(() => {
        // get_state is best-effort identity capture; the turn machinery
        // surfaces real failures. Nothing to clean up.
      });
    });
  }

  /**
   * Mount the managed MCP snapshot as omp host tools (task #5). omp's
   * response replaces the previous set, so one send per process is complete.
   * Registration failure must not wedge the session: the agent continues
   * without managed tools and a diagnostic explains why.
   */
  private async registerHostTools(): Promise<void> {
    if (this.hostTools.length === 0) return;
    const tools: OmpHostToolDefinition[] = this.hostTools.map((tool) => ({
      name: tool.runtimeName,
      ...(tool.title ? { label: tool.title } : {}),
      description: tool.description || `Call ${tool.toolName} on the managed MCP server ${tool.serverName}.`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    try {
      await this.request({ type: "set_host_tools", tools });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[omp] set_host_tools failed: ${message}`);
      this.queuedEvents.push({
        kind: "runtime_diagnostic",
        severity: "warning",
        source: "omp_rpc_notification",
        itemType: "host_tools_registration",
        message: `OMP managed tools registration failed; the agent runs without managed tools this session: ${message}`,
      });
    }
  }

  /**
   * Execute one agent-initiated host tool call against the managed MCP
   * endpoint (task #5). Every accepted call gets EXACTLY ONE completion —
   * success, tool error, or transport error — because omp holds the turn's
   * tool call open until the result arrives; a late answer after a cancel is
   * dropped by the generation guard.
   */
  private handleHostToolCall(frame: OmpHostToolCallFrame): void {
    const tool = this.hostTools.find((candidate) => candidate.runtimeName === frame.toolName);
    if (!tool) {
      this.sendHostToolError(frame.id, `Managed MCP tool ${frame.toolName} is not currently available to this Agent`);
      return;
    }
    const endpoint = this.hostToolEndpoint;
    if (!endpoint) {
      this.sendHostToolError(frame.id, "Managed MCP endpoint unavailable for this session");
      return;
    }
    const controller = new AbortController();
    this.hostToolCalls.set(frame.id, { controller });
    void callManagedMcpTool(endpoint, tool, frame.arguments ?? {}, controller.signal)
      .then((result) => {
        if (this.hostToolCalls.get(frame.id)?.controller !== controller) return; // cancelled or process gone
        this.hostToolCalls.delete(frame.id);
        this.writeHostToolFrame({
          type: "host_tool_result",
          id: frame.id,
          result: { content: result.content },
          ...(result.isError ? { isError: true } : {}),
        });
      })
      .catch((error: unknown) => {
        if (this.hostToolCalls.get(frame.id)?.controller !== controller) return;
        this.hostToolCalls.delete(frame.id);
        const message = error instanceof Error ? error.message : String(error);
        this.sendHostToolError(frame.id, `Managed MCP call failed: ${message}`);
      });
  }

  /** Abort a pending host tool call; omp drops the request, so no result is sent. */
  private handleHostToolCancel(frame: OmpHostToolCancelFrame): void {
    const pending = this.hostToolCalls.get(frame.targetId);
    if (!pending) return;
    this.hostToolCalls.delete(frame.targetId);
    pending.controller.abort();
  }

  /** Completion frame with a plain-text error payload (docs/rpc.md: top-level isError). */
  private sendHostToolError(callId: string, message: string): void {
    this.writeHostToolFrame({
      type: "host_tool_result",
      id: callId,
      result: { content: [{ type: "text", text: message }] },
      isError: true,
    });
  }

  private writeHostToolFrame(frame: Record<string, unknown>): void {
    const proc = this.process;
    if (!proc?.stdin?.writable) return; // process gone mid-call: omp rejects pending calls at stdin close
    try {
      proc.stdin.write(encodeOmpRpcFrame(frame, { maxPhysicalFrameBytes: this.maxFrameBytes }));
    } catch {
      // Stdin died between the writability check and the write; the tree is
      // being torn down anyway.
    }
  }

  private abortHostToolCalls(): void {
    for (const pending of this.hostToolCalls.values()) pending.controller.abort();
    this.hostToolCalls.clear();
  }

  /** Write a 0600 launch file into the per-agent CLI transport dir. */
  private writeLaunchFile(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, content, { mode: 0o600 });
    return filePath;
  }

  private handleResponse(frame: OmpRpcResponseFrame): ParsedEvent[] {
    if (typeof frame.id !== "string") return [];
    const events: ParsedEvent[] = [];

    // Fire-and-forget deliveries (encodeStdinMessage lines written by the
    // session machinery) have no pending entry; a refusal must surface as an
    // error event instead of vanishing (PM task #4 review).
    if (this.deliveryIds.has(frame.id)) {
      const command = this.deliveryIds.get(frame.id)!;
      this.deliveryIds.delete(frame.id);
      if (frame.success === false) {
        events.push({
          kind: "error",
          message: `OMP refused ${command}: ${frame.error ?? "unknown error"}`,
        });
      }
    }

    // Session identity capture: settleProtocol's get_state announces the
    // runtime session exactly once, synchronously with the response frame so
    // the session machinery sees session_init on the parseLine channel.
    if (!this.sessionId && frame.success && frame.command === "get_state") {
      const data = frame.data as { sessionId?: unknown } | undefined;
      if (data && typeof data.sessionId === "string" && data.sessionId) {
        this.sessionId = data.sessionId;
        events.push({ kind: "session_init", sessionId: data.sessionId });
        if (this.resumeFallbackNotice) {
          events.push({
            kind: "runtime_diagnostic",
            severity: "warning",
            source: "omp_rpc_notification",
            itemType: "resume_fallback",
            message: this.resumeFallbackNotice,
          });
          this.resumeFallbackNotice = null;
        }
      }
    }

    const pending = this.pending.get(frame.id);
    if (!pending) return events;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(frame);
    return events;
  }

  private recordProtocolError(message: string): void {
    this.lastProtocolError = message;
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * Kill the current process tree (SIGTERM, then SIGKILL after the grace
   * period) — never just the parent: omp's bash tools / subagents must not be
   * left behind on a ready timeout or a failed negotiation.
   */
  private killProcess(): void {
    const proc = this.process;
    this.process = null;
    if (!proc?.pid) {
      proc?.kill();
      return;
    }
    const pid = proc.pid;
    killProcessTree(pid, "SIGTERM");
    const sigkillTimer = setTimeout(() => {
      killProcessTree(pid, "SIGKILL");
    }, OMP_STOP_SIGTERM_GRACE_MS);
    sigkillTimer.unref?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /**
   * Encode a live delivery: `prompt` when idle, `steer` when the agent is
   * busy (omp queues steering mid-run natively). The returned line carries NO
   * trailing newline — the session machinery appends one (PM task #4 review:
   * a doubled newline is an empty frame and a parse error on the wire).
   *
   * Early writes are safe: omp claims stdin at startup and parses buffered
   * lines once it is up (docs/rpc.md "Startup"), so a delivery raced against
   * the handshake is processed in wire order instead of being dropped —
   * returning null here would be permanent ("unsupported"), never a retry.
   * The delivery id is tracked so a refusal (success:false) surfaces as an
   * error event rather than vanishing.
   */
  encodeStdinMessage(
    text: string,
    _sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    const proc = this.process;
    if (!proc || !this.ready || this.lastProtocolError) return null;
    const commandType = opts?.mode === "idle" ? "prompt" : "steer";
    const id = `omp-${++this.requestCounter}`;
    let line: string;
    try {
      line = encodeOmpRpcFrame(
        { id, type: commandType, message: text },
        { maxPhysicalFrameBytes: this.maxFrameBytes },
      );
    } catch {
      return null;
    }
    this.deliveryIds.set(id, commandType);
    // Bound the tracking table: unanswered deliveries are rare and the
    // responses free their slots; overflow sheds the oldest.
    while (this.deliveryIds.size > 256) {
      const oldest = this.deliveryIds.keys().next().value;
      if (oldest === undefined) break;
      this.deliveryIds.delete(oldest);
    }
    return line.replace(/\n$/, "");
  }

  buildSystemPrompt(config: AgentConfig): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
