import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
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
// lands with task #3, session control with #4.
export const MIN_SUPPORTED_OMP_VERSION = "18.6.0";

const OMP_BINARY = "omp";

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
  /** Test seam: replace the omp argument list entirely. */
  args?: string[];
  /** Test seam: bound the ready-frame wait instead of the 30s default. */
  readyTimeoutMs?: number;
}

const STDERR_TAIL_LIMIT = 4000;

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

  // Transport state, exposed for observability and the phase-1 turn work (#3+).
  private ready = false;
  private protocolVersion = 0;
  private negotiatedProtocolVersion: number | null = null;
  private maxFrameBytes: number = MAX_OMP_RPC_FRAME_BYTES;
  private maxReassembledFrameBytes: number = MAX_OMP_RPC_REASSEMBLED_BYTES;
  private frameErrorCount = 0;
  private lastFrameError: string | null = null;
  private lastProtocolError: string | null = null;

  /** True once the ready frame has been seen (and negotiation dispatched if offered). */
  get isReady(): boolean {
    return this.ready;
  }

  private createReadyDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
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
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });

    this.process = null;
    this.decoder = new OmpRpcFrameDecoder();
    this.requestCounter = 0;
    this.pending.clear();
    this.clearReadyTimer();
    this.stderrTail = "";
    this.ready = false;
    this.protocolVersion = 0;
    this.negotiatedProtocolVersion = null;
    this.maxFrameBytes = MAX_OMP_RPC_FRAME_BYTES;
    this.maxReassembledFrameBytes = MAX_OMP_RPC_REASSEMBLED_BYTES;
    this.frameErrorCount = 0;
    this.lastFrameError = null;
    this.lastProtocolError = null;
    this.readyDeferred = this.createReadyDeferred();

    const command = launchOverrides.command ?? resolveOmpCommand() ?? OMP_BINARY;
    const args = launchOverrides.args ?? ["--mode", "rpc"];

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
      this.process = null;
      this.readyDeferred?.reject(new OmpRpcProcessExitedError(code, signal, this.stderrTail));
      this.readyDeferred = null;
      this.failAllPending(new OmpRpcProcessExitedError(code, signal, this.stderrTail));
    });

    // The ready frame must arrive on its own; nothing the daemon sends can
    // prompt it. A launch that never becomes ready is killed here instead of
    // leaving a silent child behind for the session watchdog.
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

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    if (!this.process) return [];

    let frame: object;
    try {
      const decoded = this.decoder.pushLine(line);
      // An in-progress rpc_chunk sequence has nothing to dispatch yet.
      if (!decoded) return [];
      frame = decoded;
    } catch (error) {
      const message = error instanceof OmpRpcFrameError ? error.message : String(error);
      this.frameErrorCount += 1;
      this.lastFrameError = message;
      return [];
    }

    const type = (frame as { type?: unknown }).type;
    if (type === "ready") {
      this.handleReady(frame as unknown as OmpRpcReadyFrame);
      return [];
    }
    if (type === "response") {
      this.handleResponse(frame as unknown as OmpRpcResponseFrame);
      return [];
    }
    // Agent/session events and every other outbound category are event-mapping
    // territory (phase-1 task #3); the transport ignores them for now.
    return [];
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
      this.readyDeferred?.resolve();
      this.readyDeferred = null;
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
        this.readyDeferred?.resolve();
        this.readyDeferred = null;
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

  private handleResponse(frame: OmpRpcResponseFrame): void {
    if (typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(frame);
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

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
