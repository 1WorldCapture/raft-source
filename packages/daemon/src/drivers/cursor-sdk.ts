import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURSOR_SDK_RESUME_UNUSABLE_MARKER } from "../cursorSdk/sessionReset.js";
import { TrajectoryCoalescer, type TrajectoryCoalescerDeps } from "../cursorSdk/trajectoryCoalescer.js";
import {
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  type AgentConfig,
  type AxSurfaceText,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";
import {
  CURSOR_SDK_ATTEMPT_ACK_TIMEOUT_MS_DEFAULT,
  CURSOR_SDK_CREDENTIAL_LEASE_TIMEOUT_MS_DEFAULT,
  CURSOR_SDK_HOST_ENTRY_ENV,
  CURSOR_SDK_HOST_INIT_TIMEOUT_MS_DEFAULT,
  CURSOR_SDK_HOST_KILL_ESCALATION_MS_DEFAULT,
  CURSOR_SDK_HOST_PROTOCOL_VERSION,
  CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT,
  attemptRequestMethod,
  cursorSdkEventAsParsedEvent,
  isCursorSdkHostToDriverMessage,
  sanitizeCursorSdkWireText,
  type CursorSdkAttemptResultMessage,
  type CursorSdkAttemptOutcome,
  type CursorSdkHostToDriverMessage,
  type CursorSdkHostboundMessage,
  type CursorSdkInitMessage,
  type CursorSdkRunOptions,
} from "../cursorSdk/protocol.js";
import {
  announceCursorSdkSessionInit,
  createCursorSdkEventMappingState,
  mapCursorSdkRunEventWirePayload,
} from "../cursorSdk/eventMapper.js";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import { prepareManagedMcpRuntimeProxy } from "../managedMcpRuntimeProxy.js";
import { resolveCursorSdkAssets, probeCursorSdkAssets, verifyCursorSdkAssetsIntegrity } from "../cursorSdk/assets.js";
import { resolveCursorCredentialLease, detectCursorSdkModels } from "../runtimeAuth/cursor/nativeCredentialBroker.js";
import type {
  ParsedEvent,
  RuntimeBusyDeliveryReadiness,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeModelDetectionContext,
  RuntimeProbeResult,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  SpawnContext,
  SpawnResult,
} from "./types.js";

/**
 * Cursor SDK driver — persistent private-IPC Node host owning one SDKAgent.
 *
 * Runtime id `cursor-sdk` (shared registry entry shipped by the parent). The
 * legacy `cursor` CLI driver stays independently registered. This driver has
 * NO vendor CLI print adapter: `createSession` returns a native
 * {@link CursorSdkRuntimeSession} that drives the staged host over Node IPC.
 */

// ── Cross-worker seams ──────────────────────────────────────────────────────
// The asset resolver (assets worker: cursorSdk/assets.ts) and the credential
// broker (auth worker: runtimeAuth/cursor/credentialBroker.ts) are concurrent
// deliverables. They are reached through dynamic, NON-literal imports so this
// file compiles and its focused tests run before those modules land; the
// shapes below mirror the contract signatures exactly. When the siblings are
// staged, production wiring can swap the seams for static imports (parent
// coordination point) — behavior is identical.

/** Contract shape of `resolveCursorSdkAssets()` (assets worker). */
export interface CursorSdkAssetsResolution {
  root: string;
  nodePath: string;
  runtimeEntryPath: string;
  authEntryPath: string;
  sdkVersion: string;
  nodeVersion: string;
}

/** Contract shape of `resolveCursorCredentialLease()` (auth worker). */
export interface CursorSdkCredentialLease {
  apiKey: string;
  connectionId: string;
  generation: number;
  principalId: string;
  backendUrl: string;
}

export class CursorSdkAssetsUnavailableError extends Error {
  readonly kind = "cursor_sdk_assets_unavailable" as const;
  constructor(detail: string) {
    super(`Cursor SDK runtime assets are unavailable on this Computer: ${detail}`);
    this.name = "CursorSdkAssetsUnavailableError";
  }
}

/** Consecutive run_submit failures (no run created) that make a session suspect. */
export const CURSOR_SDK_SUBMIT_FAILURE_LIMIT = 3;
/** The failures must fall inside this window to count as consecutive. */
export const CURSOR_SDK_SUBMIT_FAILURE_WINDOW_MS = 2 * 60_000;
/** Submit backoff once a fresh (non-resumed) session hit the limit / twice the limit. */
export const CURSOR_SDK_SUBMIT_BACKOFF_MS = [60_000, 5 * 60_000] as const;

/**
 * Internal marker: start() was superseded by an explicit stop()/dispose()
 * while lease resolution or the init handshake was still in flight. The stop
 * path owns teardown; the aborted start must neither spawn/init further nor
 * surface as a runtime error.
 */
class CursorSdkStartSupersededError extends Error {
  readonly superseded = true as const;
  constructor() {
    super("cursor sdk start superseded by stop");
    this.name = "CursorSdkStartSupersededError";
  }
}

function isStartSuperseded(error: unknown): boolean {
  return (error as { superseded?: unknown } | null)?.superseded === true;
}

export async function resolveCursorSdkAssetsViaModule(): Promise<CursorSdkAssetsResolution> {
  const assets = resolveCursorSdkAssets();
  const integrity = verifyCursorSdkAssetsIntegrity();
  if (!integrity.ok) throw new CursorSdkAssetsUnavailableError("integrity verification failed; reinstall the runtime assets");
  return assets;
}

export async function probeCursorSdkAssetsViaModule(): Promise<RuntimeProbeResult> {
  return probeCursorSdkAssets();
}

export async function resolveCursorCredentialLeaseViaModule(input: {
  slockHome: string;
  serverId?: string;
  signal?: AbortSignal;
}): Promise<CursorSdkCredentialLease> {
  return resolveCursorCredentialLease(input);
}

async function detectCursorSdkModelsViaModule(): Promise<RuntimeModelSourceOutcome> {
  return detectCursorSdkModels();
}

// ── Host connection abstraction ─────────────────────────────────────────────

export interface CursorSdkHostExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The private IPC channel to the runtime host. Production uses a real child
 * process; focused tests install scripted or fixture-backed fakes.
 */
export interface CursorSdkHostConnection {
  readonly pid?: number;
  /** Best-effort synchronous send. false → not delivered (closed/congested). */
  send(message: CursorSdkHostboundMessage): boolean;
  /** Signal the host process itself. */
  terminate(signal: NodeJS.Signals): void;
  /** Signal the host's whole process group (detached spawn). */
  terminateGroup(signal: NodeJS.Signals): void;
  onMessage(cb: (message: unknown) => void): void;
  onStderr(cb: (text: string) => void): void;
  onExit(cb: (info: CursorSdkHostExitInfo) => void): void;
}

export interface CursorSdkHostSpawnInput {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Bounded SIGKILL escalation for a host group abandoned mid-race (spawned but
 * superseded by stop before it was ever initialized). The timer is unref'd so
 * it can never keep the daemon alive; it only guarantees the group dies even
 * if its SIGTERM handler hangs.
 */
function scheduleGroupKillEscalation(
  connection: CursorSdkHostConnection,
  boundMs: number,
): void {
  const timer = setTimeout(() => connection.terminateGroup("SIGKILL"), Math.max(0, boundMs));
  timer.unref?.();
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

class ChildProcessHostConnection implements CursorSdkHostConnection {
  private readonly child: ChildProcess;
  private readonly bus = new EventEmitter();
  private didExit = false;

  constructor(input: CursorSdkHostSpawnInput) {
    // Private IPC per contract: stdin ignored; stdout/stderr piped for
    // sanitized diagnostics only (never protocol, never credentials); ipc
    // channel carries the protocol. Detached on POSIX so stop() can kill the
    // whole process group (the SDK may keep worker children alive past the
    // host process itself).
    this.child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    this.child.on("message", (message: unknown) => {
      if (!this.didExit) this.bus.emit("message", message);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = sanitizeCursorSdkWireText(String(chunk ?? ""), 4_000);
      if (text && text !== "unknown error") this.bus.emit("stderr", text);
    });
    // stdout is intentionally never parsed: the host writes no protocol and
    // no credentials there. Drain it so a misbehaving SDK closure cannot
    // stall on backpressure.
    this.child.stdout?.resume();
    this.child.on("error", (error: Error) => {
      // Spawn failure (ENOENT etc.) also produces a synthetic exit event.
      this.bus.emit("stderr", sanitizeCursorSdkWireText(error));
    });
    this.child.on("exit", (code, signal) => {
      this.didExit = true;
      this.bus.emit("exit", { code, signal } satisfies CursorSdkHostExitInfo);
      this.bus.removeAllListeners();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  send(message: CursorSdkHostboundMessage): boolean {
    if (this.didExit || !this.child.connected || !this.child.send) return false;
    try {
      // Node's false is BACKPRESSURE, not rejection: the message is already
      // queued. Retrying it would submit the same prompt twice.
      this.child.send(message, (error) => {
        if (error && !this.didExit) this.terminateGroup("SIGTERM");
      });
      return true;
    } catch {
      return false;
    }
  }

  terminate(signal: NodeJS.Signals): void {
    signalProcess(this.child.pid, signal);
  }

  terminateGroup(signal: NodeJS.Signals): void {
    if (!signalProcessGroup(this.child.pid, signal)) {
      signalProcess(this.child.pid, signal);
    }
  }

  onMessage(cb: (message: unknown) => void): void {
    this.bus.on("message", cb);
  }

  onStderr(cb: (text: string) => void): void {
    this.bus.on("stderr", cb);
  }

  onExit(cb: (info: CursorSdkHostExitInfo) => void): void {
    this.bus.on("exit", cb);
  }
}

// ── Session descriptor ──────────────────────────────────────────────────────

export const CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR = {
  transport: "child_process",
  lifecycle: "sdk_session",
  stdout: {
    channel: "diagnostic",
  },
  input: {
    initial: "request",
    idle: "request",
    busy: "request",
  },
  readiness: "sdk_ready",
  turnBoundary: "sdk_event",
  startPolicy: "immediate",
  inFlightWake: "steer",
  busyDelivery: "direct",
  postTurn: "keep_alive",
} as const satisfies RuntimeSessionDescriptor;

// ── Session internals ───────────────────────────────────────────────────────

interface SubmittedAttempt {
  kind: "run_submit" | "steer_submit";
  runId: string;
  epoch: number;
  timer: NodeJS.Timeout | null;
}

interface ActiveRunState {
  runId: string;
  terminal: boolean;
  finishReason: "completed" | "aborted" | "error";
  finishError: { message: string; errorClass?: string } | null;
  turnEndEmitted: boolean;
  /** Outstanding (un-settled) steer submissions to the host for this run. */
  pendingSteerCount: number;
  /** Revert seen → refuse further busy steering until true idle. */
  steeringSuppressed: boolean;
}

type SessionPhase = "constructed" | "starting" | "ready" | "stopping" | "closed";

type SessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

export interface CursorSdkRuntimeSessionDeps {
  resolveAssets?: () => CursorSdkAssetsResolution | Promise<CursorSdkAssetsResolution>;
  resolveCredentialLease?: (input: {
    slockHome: string;
    signal?: AbortSignal;
  }) => Promise<CursorSdkCredentialLease>;
  prepareTransport?: typeof prepareCliTransport;
  prepareManagedMcp?: typeof prepareManagedMcpRuntimeProxy;
  spawnHost?: (input: CursorSdkHostSpawnInput) => CursorSdkHostConnection;
  /** SDK module specifier for the host's dynamic import (tests: fixture URL). */
  sdkModuleSpecifier?: string;
  ackTimeoutMs?: number;
  hostInitTimeoutMs?: number;
  shutdownGraceMs?: number;
  /** SIGKILL escalation bound after the stop deadline signal. */
  killEscalationMs?: number;
  nowMs?: () => number;
  /** Timer seam for the stream coalescer (tests drive it with fake timers). */
  coalescerTimers?: Pick<TrajectoryCoalescerDeps, "setTimer" | "clearTimer" | "now">;
}

/**
 * Runtime session over the persistent Cursor SDK host.
 *
 * Contract highlights enforced here:
 * - `send` returns SYNCHRONOUSLY; acceptance means the submission entered the
 *   bounded local queue — it is NOT a native ACK.
 * - At most one active run; at most one pending steer; NO adapter-side
 *   follow-up queue — the APM owns follow-ups.
 * - `turn_end` is emitted exactly once per run, only after the native run is
 *   terminal + stream drained (`run_settled`) AND every outstanding attempt
 *   ACK is settled or classified unknown.
 * - Busy readiness closes (`no_active_turn`) only when TRULY idle — never
 *   while a turn is active or ACK-pending.
 */
export class CursorSdkRuntimeSession implements RuntimeSession {
  readonly descriptor = CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR;

  private readonly events = new EventEmitter();
  private readonly mappingState = createCursorSdkEventMappingState();
  private readonly deps: CursorSdkRuntimeSessionDeps;
  private readonly ackTimeoutMs: number;
  private readonly hostInitTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killEscalationMs: number;
  private readonly nowMs: () => number;

  private phase: SessionPhase = "constructed";
  private started = false;
  private connection: CursorSdkHostConnection | null = null;
  private hostReady = false;
  private sessionId: string | null;
  private currentRun: ActiveRunState | null = null;
  private readonly attempts = new Map<string, SubmittedAttempt>();
  /**
   * The single outstanding null-attempt submit (at most one can exist: a run
   * submit only happens with no active run, a steer only with no pending
   * steer). Null attempts never block turn settlement — they carry no
   * delivery_outcome watermark — but their terminal answers still drive the
   * one-pending-steer gate, suppression, and delivery_error debt.
   */
  private pendingNullAttempt: SubmittedAttempt | null = null;
  private epoch = 0;
  /** Consecutive failed run_submits (the host never obtained a run). */
  /** Steer attempts whose ack timed out (settled `unknown`); a late ack is still honored. */
  private readonly lateSteerAttempts = new Map<string, { runId: string; epoch: number; timedOutAtMs: number }>();
  private lastHostMessageAtMs = 0;
  private lastRunEventAtMs = 0;
  private currentRunStartedAtMs = 0;
  private readonly stderrTail: string[] = [];
  /** Merges streamed text/thinking chunks into whole blocks (see trajectoryCoalescer.ts). */
  private readonly trajectory: TrajectoryCoalescer;
  private submitFailures = 0;
  private submitFailuresSinceMs = 0;
  private submitBackoffUntilMs = 0;
  private runEverAccepted = false;
  private exitInfo: RuntimeExitInfo | null = null;
  private stopReason: string | undefined;
  private shutdownSettled: { outcome: "clean" | "deadline" | "forced" } | null = null;
  private shutdownWaiters: Array<() => void> = [];
  private hostExitInfo: CursorSdkHostExitInfo | null = null;
  private initWaiter: {
    resolve: (sessionId: string | null) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(
    private readonly ctx: SpawnContext,
    private readonly setCurrentSessionId: (sessionId: string | null) => void,
    deps: CursorSdkRuntimeSessionDeps = {},
  ) {
    this.deps = deps;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? CURSOR_SDK_ATTEMPT_ACK_TIMEOUT_MS_DEFAULT;
    this.hostInitTimeoutMs = deps.hostInitTimeoutMs ?? CURSOR_SDK_HOST_INIT_TIMEOUT_MS_DEFAULT;
    this.shutdownGraceMs = deps.shutdownGraceMs ?? CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT;
    this.killEscalationMs =
      deps.killEscalationMs ?? CURSOR_SDK_HOST_KILL_ESCALATION_MS_DEFAULT;
    this.nowMs = deps.nowMs ?? Date.now;
    this.sessionId = ctx.config.sessionId || null;
    this.mappingState.sessionId = this.sessionId;
    this.trajectory = new TrajectoryCoalescer({
      ...deps.coalescerTimers,
      emit: (kind, text) => {
        this.events.emit(
          "runtime_event",
          cursorSdkEventAsParsedEvent(kind === "text" ? { kind: "text", text } : { kind: "thinking", text }),
        );
      },
    });
    this.events.on("stderr", (text: string) => {
      this.stderrTail.push(sanitizeCursorSdkWireText(text).slice(0, 160));
      if (this.stderrTail.length > 3) this.stderrTail.shift();
    });
  }

  get pid(): number | undefined {
    return this.connection?.pid;
  }

  /** Metadata only (counts, ages, phases) for the stall watchdog log; never message content. */
  describeStallState(): Record<string, string | number | boolean> {
    const now = this.nowMs();
    const age = (at: number) => (at > 0 ? Math.max(0, now - at) : -1);
    const run = this.currentRun;
    return {
      phase: this.phase,
      hostReady: this.hostReady,
      hasRun: run !== null,
      runTerminal: run?.terminal ?? false,
      runAgeMs: run ? age(this.currentRunStartedAtMs) : -1,
      lastRunEventAgeMs: age(this.lastRunEventAtMs),
      lastHostMessageAgeMs: age(this.lastHostMessageAtMs),
      pendingAttempts: this.attempts.size,
      pendingSteerCount: run?.pendingSteerCount ?? 0,
      timedOutSteers: this.lateSteerAttempts.size,
      submitFailures: this.submitFailures,
      stderrTail: this.stderrTail.join(" | "),
    };
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentRuntimeHomeDir(): string | null {
    return null;
  }

  get exitCode(): number | null {
    return this.exitInfo?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exitInfo?.signal ?? null;
  }

  get closed(): boolean {
    return this.phase === "closed";
  }

  isAlive(): boolean | undefined {
    const pid = this.connection?.pid;
    if (!pid) return undefined;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  on<T extends keyof SessionEvents>(event: T, cb: (...args: SessionEvents[T]) => void): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  /**
   * Driver-owned live busy-delivery gate. Closes (`no_active_turn`) ONLY when
   * truly idle: no active run and no pending ACK settlement. While a run is
   * active — including the ACK-pending window after its terminal — the gate
   * stays open so the APM never reconciles to idle prematurely.
   */
  busyDeliveryReadiness(): RuntimeBusyDeliveryReadiness {
    if (this.phase !== "ready") return { ready: true };
    if (this.currentRun) return { ready: true };
    return { ready: false, reason: "no_active_turn" };
  }

  // ── start ────────────────────────────────────────────────────────────────

  async start(input: {
    text: string;
    sessionId?: string | null;
    attemptId?: string;
  }): Promise<RuntimeSendResult> {
    if (this.phase === "closed") return { ok: false, reason: "closed" };
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    this.started = true;
    this.phase = "starting";
    try {
      await this.launchHost();
    } catch (error) {
      if (isStartSuperseded(error)) {
        // stop() owns teardown from here (it may already have finalized).
        // The aborted start must not spawn, init, submit, or surface as a
        // runtime error — the owner asked for shutdown, not a failure.
        return { ok: false, reason: "closed" };
      }
      const message = sanitizeCursorSdkWireText(error);
      this.events.emit("runtime_event", { kind: "error", message } satisfies ParsedEvent);
      // An init failure must never leave a live spawned child behind (it may
      // hold the single-writer host lock): bounded graceful stop, then
      // verified group termination with SIGKILL escalation.
      if (this.connection && this.hostExitInfo === null) {
        this.postToHost({ kind: "stop", reason: "init_failed" });
        await this.waitShutdownSettled(Math.min(this.shutdownGraceMs, 1_000));
        await this.terminateHostGroupVerified("SIGTERM");
      }
      await this.finalizeClose({
        code: this.hostExitInfo?.code ?? null,
        signal: this.hostExitInfo?.signal ?? null,
        reason: "error",
      });
      throw new Error(message);
    }
    if (this.phase !== "starting") {
      // stop() landed between the last handshake await and here: never reopen
      // a session that a stop already closed/stopped.
      return { ok: false, reason: "closed" };
    }
    this.phase = "ready";
    // Existing start-success path, normal for no-attempt first turns: the
    // first run carries only the user text. The standing prompt rides the
    // registered prompt path via ctx.prompt — no SDK systemPrompt replacement
    // and no native standing-prompt layer is used for cursor-sdk.
    const accepted = this.submitRun(input.attemptId ?? null, input.text);
    if (!accepted) {
      return { ok: false, reason: "closed", error: "cursor sdk host channel rejected the first run" };
    }
    return { ok: true, acceptedAs: "prompt" };
  }

  /**
   * Throws {@link CursorSdkStartSupersededError} when a stop()/dispose()
   * landed while this start's async steps were in flight. Called after EVERY
   * await resumption in launchHost so a stopped session can never later
   * spawn or initialize a host.
   */
  private assertStartAlive(): void {
    if (this.phase === "stopping" || this.phase === "closed") {
      throw new CursorSdkStartSupersededError();
    }
  }

  private async launchHost(): Promise<void> {
    const resolveAssetsImpl = this.deps.resolveAssets ?? resolveCursorSdkAssetsViaModule;
    const assets = await resolveAssetsImpl();
    this.assertStartAlive();
    if (!assets?.nodePath || !assets?.runtimeEntryPath) {
      throw new CursorSdkAssetsUnavailableError(
        "asset resolution returned no node/runtime entry paths",
      );
    }

    const transport = await (this.deps.prepareTransport ?? prepareCliTransport)(this.ctx, {
      NO_COLOR: "1",
    });
    this.assertStartAlive();
    const slockHome = transport.slockHome;

    // Mount the standing prompt as a Cursor project rule BEFORE the host
    // starts, on every launch (create and resume): rules load through the
    // project setting source at agent creation/resume, and the prompt may
    // have changed since the previous launch.
    this.assertStartAlive();
    writeStandingPromptRuleFile(this.ctx.workingDirectory, this.ctx.standingPrompt);

    // Credential lease: bounded, fail closed. No ambient-key fallback and no
    // access-token-as-API-key substitution — the broker owns that boundary.
    const leaseAbort = new AbortController();
    const leaseTimer = setTimeout(
      () => leaseAbort.abort(),
      CURSOR_SDK_CREDENTIAL_LEASE_TIMEOUT_MS_DEFAULT,
    );
    let lease: CursorSdkCredentialLease;
    try {
      const resolveLease =
        this.deps.resolveCredentialLease ?? resolveCursorCredentialLeaseViaModule;
      lease = await resolveLease({ slockHome, signal: leaseAbort.signal });
    } finally {
      clearTimeout(leaseTimer);
    }
    this.assertStartAlive();
    if (!lease?.apiKey || !lease?.backendUrl) {
      throw new Error("cursor credential lease failed closed (no usable bound connection)");
    }

    const managedMcp = await (this.deps.prepareManagedMcp ?? prepareManagedMcpRuntimeProxy)({
      agentId: this.ctx.agentId,
      launchId: this.ctx.launchId,
      serverUrl: this.ctx.config.serverUrl,
      agentCredentialKey: this.ctx.config.agentCredentialKey,
    });
    this.assertStartAlive();

    const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(this.ctx.config));
    const model =
      launchFields.model && launchFields.model !== "default" ? launchFields.model : undefined;
    const runOptions: CursorSdkRunOptions = {
      ...(model ? { model } : {}),
      ...(launchFields.reasoningEffort ? { reasoningEffort: launchFields.reasoningEffort } : {}),
      ...(launchFields.mode.kind === "fast" ? { fast: true } : {}),
      ...(managedMcp
        ? { mcpServers: { [managedMcp.name]: { url: managedMcp.url } } }
        : {}),
    };

    const hostDataDir = path.join(slockHome, "cursor-sdk-host", safePathPart(this.ctx.agentId));
    const initMessage: CursorSdkInitMessage = {
      kind: "init",
      protocolVersion: CURSOR_SDK_HOST_PROTOCOL_VERSION,
      agentId: this.ctx.agentId,
      sessionId: this.ctx.config.sessionId || null,
      workspaceRoot: this.ctx.workingDirectory,
      hostDataDir,
      auth: {
        apiKey: lease.apiKey,
        backendUrl: lease.backendUrl,
        connectionId: lease.connectionId,
        generation: lease.generation,
        principalId: lease.principalId,
      },
      env: sanitizeEnvForWire(transport.spawnEnv),
      runOptions,
      sdkModuleSpecifier: this.deps.sdkModuleSpecifier ?? "@cursor/sdk",
    };

    const spawnHost =
      this.deps.spawnHost ??
      ((input: CursorSdkHostSpawnInput) => new ChildProcessHostConnection(input));
    // Cursor identity/backend/asset selection belongs to the local owner
    // control plane: ambient controlled values are stripped; the host
    // re-applies the verified lease from the init message BEFORE importing
    // the SDK.
    const baseEnv = stripControlledCursorEnv({ ...transport.spawnEnv });
    this.assertStartAlive();
    const connection = spawnHost({
      command: assets.nodePath,
      args: [assets.runtimeEntryPath],
      env: { ...baseEnv, [CURSOR_SDK_HOST_ENTRY_ENV]: "1" },
      cwd: this.ctx.workingDirectory,
    });
    if (this.phase === "stopping" || this.phase === "closed") {
      // Raced with stop() across the spawn boundary: kill the fresh group
      // immediately (never initialized, never bound) — defense in depth for
      // any future await inserted between spawn and bind.
      connection.terminateGroup("SIGTERM");
      scheduleGroupKillEscalation(connection, this.killEscalationMs);
      throw new CursorSdkStartSupersededError();
    }
    this.connection = connection;
    this.bindConnection();
    if (!this.postToHost(initMessage)) {
      throw new Error("cursor sdk host channel rejected the init message");
    }
    const announcedSessionId = await this.waitForHostInit();
    if (announcedSessionId) {
      this.applySessionInit(announcedSessionId);
    }
  }

  private bindConnection(): void {
    const connection = this.connection;
    if (!connection) return;
    connection.onMessage((message) => this.handleHostMessage(message));
    connection.onStderr((text) => this.events.emit("stderr", text));
    connection.onExit((info) => this.handleHostExit(info));
  }

  private waitForHostInit(): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initWaiter = null;
        reject(new Error("cursor sdk host init timed out"));
      }, this.hostInitTimeoutMs);
      this.initWaiter = {
        resolve: (sessionId) => {
          clearTimeout(timer);
          this.initWaiter = null;
          resolve(sessionId);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.initWaiter = null;
          reject(error);
        },
      };
    });
  }

  private applySessionInit(sessionId: string): void {
    this.sessionId = sessionId;
    this.mappingState.sessionId = sessionId;
    this.setCurrentSessionId(sessionId);
    for (const event of announceCursorSdkSessionInit(this.mappingState, sessionId)) {
      this.events.emit("runtime_event", event);
    }
  }

  // ── send (synchronous contract) ──────────────────────────────────────────

  send(input: CursorSdkSendInput): RuntimeSendResult {
    if (this.phase === "closed" || this.phase === "stopping") {
      return { ok: false, reason: "closed" };
    }
    if (this.phase !== "ready" || !this.hostReady) {
      // Host not yet (or no longer) ready for submissions. busy_rejected (not
      // closed) keeps the APM's retry/debt semantics intact.
      return { ok: false, reason: "busy_rejected" };
    }
    const attemptId =
      typeof input.attemptId === "string" && input.attemptId.length > 0 ? input.attemptId : null;
    if (!this.currentRun && this.nowMs() < this.submitBackoffUntilMs) {
      // Repeated immediate submit failures: stop hammering the SDK every
      // retry tick; the APM keeps the message pending and retries later.
      return { ok: false, reason: "busy_rejected" };
    }
    if (this.currentRun) {
      // A run is active or its ACK settlement is pending: every follow-up is
      // a steer. No adapter follow-up queue — the APM owns rescheduling.
      if (this.currentRun.steeringSuppressed) {
        return { ok: false, reason: "busy_rejected" };
      }
      if (this.currentRun.pendingSteerCount > 0) {
        return { ok: false, reason: "busy_rejected" };
      }
      const accepted = this.submitSteer(attemptId, input.text);
      return accepted ? { ok: true, acceptedAs: "steer" } : { ok: false, reason: "closed" };
    }
    const accepted = this.submitRun(attemptId, input.text);
    return accepted ? { ok: true, acceptedAs: "prompt" } : { ok: false, reason: "closed" };
  }

  // ── submissions ──────────────────────────────────────────────────────────

  private submitRun(attemptId: string | null, text: string): boolean {
    const runId = randomUUID();
    if (!this.postToHost({ kind: "run_submit", runId, attemptId, text })) return false;
    this.currentRunStartedAtMs = this.nowMs();
    this.currentRun = {
      runId,
      terminal: false,
      finishReason: "completed",
      finishError: null,
      turnEndEmitted: false,
      pendingSteerCount: 0,
      steeringSuppressed: false,
    };
    this.trackAttempt(attemptId, "run_submit", runId);
    return true;
  }

  private submitSteer(attemptId: string | null, text: string): boolean {
    const run = this.currentRun;
    if (!run) return false;
    if (!this.postToHost({ kind: "steer_submit", attemptId, text })) return false;
    run.pendingSteerCount += 1;
    this.trackAttempt(attemptId, "steer_submit", run.runId);
    return true;
  }

  private trackAttempt(
    attemptId: string | null,
    kind: "run_submit" | "steer_submit",
    runId: string,
  ): void {
    if (attemptId === null) {
      this.pendingNullAttempt = { kind, runId, epoch: this.epoch, timer: null };
      return;
    }
    const timer = setTimeout(() => this.onAttemptAckTimeout(attemptId), this.ackTimeoutMs);
    this.attempts.set(attemptId, { kind, runId, epoch: this.epoch, timer });
  }

  /**
   * Bounded local acceptance over the private IPC channel.
   *
   * `connection.send()` false means the channel refused the message. For the
   * production child-process channel, Node's `child.send()` returning false
   * is BACKPRESSURE — the message is already queued by Node and must never be
   * re-sent (see ChildProcessHostConnection.send); false therefore only
   * surfaces when the channel is closed or unwritable. Either way this
   * method must NOT park the message for a later retry: a retried submission
   * could deliver the same prompt twice. Acceptance is exactly one
   * hand-off to the channel, bounded by Node's own send queue.
   */
  private postToHost(message: CursorSdkHostboundMessage): boolean {
    const connection = this.connection;
    if (!connection) return false;
    return connection.send(message);
  }

  // ── host message handling ────────────────────────────────────────────────

  private handleHostMessage(message: unknown): void {
    this.lastHostMessageAtMs = this.nowMs();
    if (!isCursorSdkHostToDriverMessage(message)) return;
    const typed = message as CursorSdkHostToDriverMessage;
    switch (typed.kind) {
      case "host_ready":
        this.hostReady = true;
        return;
      case "init_result":
        if (typed.ok) {
          this.initWaiter?.resolve(typed.sessionId ?? null);
        } else {
          const detail = typed.error;
          this.initWaiter?.reject(
            new Error(
              `${detail?.errorClass ?? "error"}: ${detail?.message ?? "cursor sdk host init failed"}`,
            ),
          );
        }
        return;
      case "session_init":
        this.applySessionInit(typed.sessionId);
        return;
      case "run_event":
        this.handleRunEvent(typed.payload);
        return;
      case "attempt_result":
        this.handleAttemptResult(typed);
        return;
      case "run_settled":
        this.handleRunSettled(typed);
        return;
      case "host_log":
        this.events.emit("stderr", `[cursor-sdk-host:${typed.level}] ${typed.message}`);
        return;
      case "shutdown_settled":
        this.shutdownSettled = { outcome: typed.outcome };
        // Proof-bearing stop diagnostics: only `clean` is a clean-stop
        // receipt. `deadline`/`forced` are the host ADMITTING incomplete
        // cleanup — the driver still verifies the real process exit (or
        // escalates) before reporting the stop as complete.
        this.events.emit(
          "stderr",
          `[cursor-sdk] shutdown settled outcome=${typed.outcome}` +
            (typed.outcome === "clean" ? "" : " (not clean; verifying real exit)"),
        );
        for (const notify of this.shutdownWaiters.splice(0)) notify();
        return;
    }
  }

  private handleRunEvent(payload: unknown): void {
    this.lastRunEventAtMs = this.nowMs();
    const type = (payload as { type?: unknown } | null)?.type;
    if (type === "assistant_text" || type === "assistant_thinking") {
      const text = (payload as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) return;
      // Every chunk is still progress (stall detection, error-backoff reset);
      // the visible text is emitted later, merged, by the coalescer.
      this.events.emit("runtime_event", cursorSdkEventAsParsedEvent({
        kind: "internal_progress",
        source: "cursor_sdk_stream",
        itemType: type,
        payloadBytes: Buffer.byteLength(text, "utf8"),
      }));
      this.trajectory.push(type === "assistant_text" ? "text" : "thinking", text);
      return;
    }
    // Any other run event is a boundary: the text before it is complete.
    this.trajectory.flush();
    if (type === "diagnostic") {
      const message = (payload as { message?: unknown }).message;
      this.events.emit("stderr", `[cursor-sdk-host] ${sanitizeCursorSdkWireText(message)}`);
      return;
    }
    for (const event of mapCursorSdkRunEventWirePayload(payload, this.mappingState)) {
      this.events.emit("runtime_event", cursorSdkEventAsParsedEvent(event));
    }
  }

  private handleAttemptResult(message: CursorSdkAttemptResultMessage): void {
    if (message.attemptId === null) {
      const pending = this.pendingNullAttempt;
      this.pendingNullAttempt = null;
      if (!pending || pending.epoch !== this.epoch) {
        this.events.emit(
          "stderr",
          "[cursor-sdk] discarded stale null-attempt result",
        );
        return;
      }
      this.applyAttemptTerminal(pending.kind, pending.runId, message, null);
      return;
    }
    const attempt = this.attempts.get(message.attemptId);
    const late = !attempt ? this.lateSteerAttempts.get(message.attemptId) : undefined;
    if (late) {
      this.lateSteerAttempts.delete(message.attemptId);
      this.handleLateSteerAck(message, late);
      return;
    }
    if (!attempt) {
      // Old epoch/run/attempt results are discarded — bounded stderr note.
      this.events.emit(
        "stderr",
        `[cursor-sdk] discarded stale attempt result (${sanitizeCursorSdkWireText(message.result)})`,
      );
      return;
    }
    this.attempts.delete(message.attemptId);
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.epoch !== this.epoch) return;
    this.applyAttemptTerminal(attempt.kind, attempt.runId, message, message.attemptId);
  }

  /**
   * The SDK's steer ack arrived after the bounded wait already settled the
   * attempt `unknown`. Only now is the one-pending-steer gate released (never
   * at the timeout, so a steer the SDK might still apply cannot be doubled),
   * and a confirmed delivery is reported so the APM does not re-notify.
   */
  private handleLateSteerAck(
    message: CursorSdkAttemptResultMessage,
    late: { runId: string; epoch: number; timedOutAtMs: number },
  ): void {
    if (late.epoch !== this.epoch) return;
    this.events.emit(
      "stderr",
      `[cursor-sdk] late steer ack after ${Math.max(0, this.nowMs() - late.timedOutAtMs)}ms past the bound (${sanitizeCursorSdkWireText(message.result)})`,
    );
    const run = this.currentRun;
    if (run && run.runId === late.runId) {
      run.pendingSteerCount = Math.max(0, run.pendingSteerCount - 1);
      if (message.result === "revert") run.steeringSuppressed = true;
    }
    if (message.result === "complete_delivered" && message.attemptId !== null) {
      this.events.emit(
        "runtime_event",
        cursorSdkEventAsParsedEvent({
          kind: "delivery_outcome",
          source: "cursor_sdk",
          attemptId: message.attemptId,
          outcome: "delivered",
          late: true,
        }),
      );
    }
    this.maybeSettleTurn();
  }

  /**
   * Apply one terminal attempt answer: emit the outcome (watermarked
   * attempts) or the legacy delivery_error (null attempts), maintain the
   * one-pending-steer gate and revert suppression, unwind an optimistically
   * submitted run the SDK refused, and re-check turn settlement.
   */
  private applyAttemptTerminal(
    kind: "run_submit" | "steer_submit",
    runId: string,
    message: Pick<CursorSdkAttemptResultMessage, "result" | "error">,
    attemptId: string | null,
  ): void {
    const run = this.currentRun;
    const runStillCurrent = run !== null && run.runId === runId;
    if (message.result === "failed") {
      this.events.emit(
        "stderr",
        `[cursor-sdk] ${kind} failed (${sanitizeCursorSdkWireText(message.error?.errorClass ?? "unknown")})`,
      );
    }
    if (attemptId !== null) {
      this.emitOutcomeForAttempt(attemptId, kind, message);
    } else if (message.result === "failed") {
      // Genuine failure without an attempt watermark: preserve the existing
      // delivery-debt semantics via delivery_error (kimi/codex parity).
      this.emitDeliveryError(attemptRequestMethod(kind), message.error);
    } else if (message.result === "revert") {
      this.emitDeliveryError(attemptRequestMethod(kind), {
        message: "cursor sdk agent busy",
        errorClass: "busy",
      });
    }
    if (message.result === "revert" && kind === "steer_submit" && runStillCurrent) {
      // Suppress further busy steering for this run until true idle.
      run!.steeringSuppressed = true;
    }
    if (kind === "run_submit") this.trackSubmitOutcome(message.result, message.error?.errorClass);
    if (kind === "run_submit" && runStillCurrent && !run!.terminal &&
        (message.result === "revert" || message.result === "failed")) {
      // The optimistic run never started — the SDK refused the submission.
      // Unwind it WITHOUT a turn_end: the delivery outcome/error above
      // preserves APM debt, and busy readiness reopens the idle path.
      this.currentRun = null;
      return;
    }
    if (kind === "steer_submit" && runStillCurrent) {
      run!.pendingSteerCount = Math.max(0, run!.pendingSteerCount - 1);
    }
    this.maybeSettleTurn();
  }

  /**
   * Count consecutive run_submit failures. The host answers `failed` only when
   * agent.send rejected before returning a run, so a counted failure always
   * means no run object exists (nothing was accepted, nothing can duplicate).
   * `revert` (busy) and anything after a run started are never counted.
   */
  private trackSubmitOutcome(result: CursorSdkAttemptResultMessage["result"], errorClass?: string): void {
    if (result === "complete_delivered") {
      this.runEverAccepted = true;
      this.submitFailures = 0;
      this.submitBackoffUntilMs = 0;
      return;
    }
    if (result !== "failed") return;
    const now = this.nowMs();
    if (this.submitFailures === 0 || (this.submitFailures < CURSOR_SDK_SUBMIT_FAILURE_LIMIT && now - this.submitFailuresSinceMs > CURSOR_SDK_SUBMIT_FAILURE_WINDOW_MS)) {
      this.submitFailures = 0;
      this.submitFailuresSinceMs = now;
    }
    this.submitFailures += 1;
    const resumed = Boolean(this.ctx.config.sessionId);
    // UnknownAgentError on a resumed session that has not accepted a single run in this launch: the SDK no longer
    // knows the saved conversation. One occurrence is proof enough; waiting for more attempts left a restarted agent
    // silent until the next stall (and the one-restart-per-window stall guard then paused it for good).
    const sessionUnknown = errorClass === "unknown_agent" && resumed && !this.runEverAccepted;
    if (this.submitFailures < CURSOR_SDK_SUBMIT_FAILURE_LIMIT && !sessionUnknown) return;
    if (resumed && !this.runEverAccepted) {
      // A resumed session that never accepted a run in this launch: the saved
      // conversation itself is suspect. Ask the daemon to reset it.
      this.events.emit(
        "stderr",
        `${CURSOR_SDK_RESUME_UNUSABLE_MARKER} (${this.submitFailures} consecutive submit failures); requesting session reset`,
      );
      void this.stop({ reason: "resume_submit_failed" });
      return;
    }
    const twice = this.submitFailures >= CURSOR_SDK_SUBMIT_FAILURE_LIMIT * 2;
    this.submitBackoffUntilMs = now + CURSOR_SDK_SUBMIT_BACKOFF_MS[twice ? 1 : 0];
    this.events.emit("stderr", `[cursor-sdk] ${this.submitFailures} consecutive submit failures; backing off`);
    if (this.submitFailures === CURSOR_SDK_SUBMIT_FAILURE_LIMIT * 2) {
      this.events.emit("runtime_event", {
        kind: "error",
        message: "Cursor runtime cannot accept messages (repeated submit failures); retrying every few minutes.",
      } satisfies ParsedEvent);
    }
  }

  private onAttemptAckTimeout(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return;
    this.attempts.delete(attemptId);
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.epoch === this.epoch && attempt.kind === "steer_submit") {
      this.lateSteerAttempts.set(attemptId, { runId: attempt.runId, epoch: attempt.epoch, timedOutAtMs: this.nowMs() });
      if (this.lateSteerAttempts.size > 16) {
        const oldest = this.lateSteerAttempts.keys().next();
        if (!oldest.done) this.lateSteerAttempts.delete(oldest.value);
      }
    }
    if (attempt.epoch === this.epoch) {
      // ACK timeout → unknown. Deliberately NOT revert: we cannot prove the
      // SDK refused the attempt, so we must not claim a deferred delivery.
      this.events.emit(
        "runtime_event",
        cursorSdkEventAsParsedEvent({
          kind: "delivery_outcome",
          source: "cursor_sdk",
          attemptId,
          outcome: "unknown",
        }),
      );
    }
    this.maybeSettleTurn();
  }

  private emitOutcomeForAttempt(
    attemptId: string,
    kind: "run_submit" | "steer_submit",
    message: Pick<CursorSdkAttemptResultMessage, "result" | "error">,
  ): void {
    let outcome: CursorSdkAttemptOutcome;
    if (message.result === "complete_delivered") {
      outcome = "delivered";
    } else if (message.result === "revert") {
      outcome = "deferred_to_idle";
    } else {
      // Genuine failure: visible delivery_error first (no invented success),
      // then the attempt watermark settles honestly as unknown.
      this.emitDeliveryError(attemptRequestMethod(kind), message.error);
      outcome = "unknown";
    }
    this.events.emit(
      "runtime_event",
      cursorSdkEventAsParsedEvent({
        kind: "delivery_outcome",
        source: "cursor_sdk",
        attemptId,
        outcome,
      }),
    );
  }

  private emitDeliveryError(
    requestMethod: "turn/start" | "turn/steer",
    error: { message: string; errorClass?: string } | undefined,
  ): void {
    this.events.emit(
      "runtime_event",
      cursorSdkEventAsParsedEvent({
        kind: "delivery_error",
        message: error?.message ?? "cursor sdk delivery failed",
        requestMethod,
        source: "cursor_sdk_response",
        code:
          error?.errorClass === "unknown_agent" || error?.errorClass === "busy"
            ? "turn.agent_busy"
            : "runtime.delivery_error",
      }),
    );
  }

  private handleRunSettled(message: {
    runId: string;
    finishReason: "completed" | "aborted" | "error";
    error?: { message: string; errorClass?: string };
  }): void {
    const run = this.currentRun;
    if (run && run.runId === message.runId) this.trajectory.flush();
    if (!run || run.runId !== message.runId) {
      this.events.emit(
        "stderr",
        `[cursor-sdk] discarded stale run settlement (${sanitizeCursorSdkWireText(message.runId)}, ${message.finishReason}${message.error?.errorClass ? `, ${sanitizeCursorSdkWireText(message.error.errorClass)}` : ""})`,
      );
      return;
    }
    run.terminal = true;
    run.finishReason = message.finishReason;
    run.finishError = message.error ?? null;
    this.maybeSettleTurn();
  }

  /**
   * THE turn boundary. Emits exactly one `turn_end` per run, and only when:
   * the native run is terminal + stream drained (`run_settled`) AND every
   * outstanding attempt ACK for this run is settled or timed out (unknown).
   */
  private maybeSettleTurn(): void {
    const run = this.currentRun;
    if (!run || !run.terminal || run.turnEndEmitted) return;
    for (const attempt of this.attempts.values()) {
      if (attempt.runId === run.runId && attempt.epoch === this.epoch) return;
    }
    // The last block must reach the APM before the turn ends (never after idle).
    this.trajectory.flush();
    run.turnEndEmitted = true;
    if (run.finishReason === "error") {
      this.events.emit("runtime_event", {
        kind: "error",
        message: run.finishError?.message ?? "cursor sdk run failed",
        nativeReasonPresent: Boolean(run.finishError),
      } satisfies ParsedEvent);
    }
    this.events.emit("runtime_event", {
      kind: "turn_end",
      sessionId: this.sessionId ?? undefined,
    } satisfies ParsedEvent);
    // True idle: steering suppression and the one-pending-steer gate lift.
    this.currentRun = null;
  }

  // ── stop / dispose ───────────────────────────────────────────────────────

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    if (this.phase === "closed") return;
    this.trajectory.flush();
    this.stopReason = opts?.reason;
    this.phase = "stopping";
    // Invalidate inputs and epochs: new sends are refused, and any in-flight
    // results from the old epoch are discarded on arrival.
    this.epoch += 1;
    // Unblock an in-flight init handshake so the aborted start() returns
    // promptly instead of burning its full init timeout.
    this.initWaiter?.reject(new CursorSdkStartSupersededError());
    if (!this.connection) {
      // Nothing was spawned yet (stop raced lease/init resolution): no host
      // to shut down — finalize immediately and never spawn one later.
      await this.finalizeClose({ code: null, signal: null, reason: "requested" });
      return;
    }
    this.postToHost({ kind: "stop", reason: opts?.reason ?? "stop" });

    const graceMs = opts?.forceAfterMs ?? this.shutdownGraceMs;
    await this.waitShutdownSettled(graceMs);
    const ack = this.shutdownSettled;
    if (ack?.outcome === "clean") {
      // Clean ACK is necessary but NOT sufficient proof: the host may still
      // crash between settling and exiting. Verify the REAL process exit,
      // with the same bounded group-kill escalation if it never comes.
      await this.waitHostExit(this.killEscalationMs);
    }
    if (this.hostExitInfo === null) {
      // No ACK by the deadline, a deadline/forced ACK (the host itself
      // admitting incomplete cleanup), or a clean ACK whose process never
      // actually exited: none of these is a clean stop. Terminate the whole
      // process group with bounded SIGKILL escalation — cleanup is only ever
      // reported as complete against a real observed exit.
      this.events.emit(
        "stderr",
        !ack
          ? "[cursor-sdk] stop without clean proof (ack=timeout); terminating host process group"
          : ack.outcome === "clean"
            ? "[cursor-sdk] clean ACK without observed exit; terminating host process group"
            : `[cursor-sdk] stop without clean proof (ack=${ack.outcome}); terminating host process group`,
      );
      await this.terminateHostGroupVerified(opts?.signal ?? "SIGTERM");
    }
    await this.finalizeClose({
      code: this.hostExitInfo?.code ?? null,
      signal: this.hostExitInfo?.signal ?? null,
      reason: "requested",
    });
  }

  /**
   * Terminate the host process group with bounded escalation and verify the
   * real exit: group SIGTERM → bounded wait → group SIGKILL → bounded wait.
   * Never fabricates an exit: when nothing is observed, hostExitInfo stays
   * null and callers report that honestly.
   */
  private async terminateHostGroupVerified(signal: NodeJS.Signals): Promise<void> {
    this.connection?.terminateGroup(signal);
    await this.waitHostExit(this.killEscalationMs);
    if (this.hostExitInfo === null) {
      this.connection?.terminateGroup("SIGKILL");
      await this.waitHostExit(1_000);
    }
    if (this.hostExitInfo === null) {
      this.events.emit(
        "stderr",
        "[cursor-sdk] host process did not exit after group SIGKILL",
      );
    }
  }

  async dispose(): Promise<void> {
    await this.stop({ reason: "dispose" });
  }

  private waitShutdownSettled(graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.shutdownSettled) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        this.shutdownWaiters = this.shutdownWaiters.filter((waiter) => waiter !== done);
        resolve(this.shutdownSettled !== null);
      }, Math.max(0, graceMs));
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.shutdownWaiters.push(done);
    });
  }

  private async waitHostExit(boundMs: number): Promise<void> {
    const deadline = this.nowMs() + boundMs;
    while (this.hostExitInfo === null && this.nowMs() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private handleHostExit(info: CursorSdkHostExitInfo): void {
    if (this.phase === "closed") return;
    this.hostExitInfo = info;
    this.hostReady = false;
    const stopping = this.phase === "stopping";
    // Invalidate epochs: results still in flight from the dead host are old.
    this.epoch += 1;
    // Settle outstanding attempt watermarks honestly as unknown.
    for (const [attemptId, attempt] of [...this.attempts]) {
      this.attempts.delete(attemptId);
      if (attempt.timer) clearTimeout(attempt.timer);
      this.events.emit(
        "runtime_event",
        cursorSdkEventAsParsedEvent({
          kind: "delivery_outcome",
          source: "cursor_sdk",
          attemptId,
          outcome: "unknown",
        }),
      );
    }
    this.trajectory.flush();
    const run = this.currentRun;
    if (run && !run.turnEndEmitted) {
      if (!stopping) {
        this.events.emit("runtime_event", {
          kind: "error",
          message: `cursor sdk host exited unexpectedly (code=${info.code ?? "null"} signal=${info.signal ?? "none"})`,
        } satisfies ParsedEvent);
      }
      run.turnEndEmitted = true;
      this.events.emit("runtime_event", {
        kind: "turn_end",
        sessionId: this.sessionId ?? undefined,
      } satisfies ParsedEvent);
      this.currentRun = null;
    }
    this.initWaiter?.reject(new Error("cursor sdk host exited during init"));
    void this.finalizeClose({
      code: info.code,
      signal: info.signal,
      reason: stopping ? "requested" : "runtime_exit",
    });
  }

  private async finalizeClose(info: RuntimeExitInfo): Promise<void> {
    if (this.phase === "closed") return;
    this.trajectory.flush();
    this.trajectory.dispose();
    this.phase = "closed";
    // Any attempt still pending at close settles as unknown (bounded honesty:
    // never claim delivered, never claim deferred without evidence).
    for (const [attemptId, attempt] of [...this.attempts]) {
      this.attempts.delete(attemptId);
      if (attempt.timer) clearTimeout(attempt.timer);
      this.events.emit(
        "runtime_event",
        cursorSdkEventAsParsedEvent({
          kind: "delivery_outcome",
          source: "cursor_sdk",
          attemptId,
          outcome: "unknown",
        }),
      );
    }
    this.pendingNullAttempt = null;
    const finalInfo: RuntimeExitInfo = {
      code: info.code,
      signal: info.signal,
      reason: info.reason ?? (this.stopReason ? "requested" : "runtime_exit"),
    };
    this.exitInfo = finalInfo;
    // Let queued IPC settle so listeners observe ordering before close.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.events.emit("exit", finalInfo);
    this.events.emit("close", finalInfo);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safePathPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "agent";
}

/**
 * Relative path (inside the agent workspace) of the project rule file that
 * carries the Raft standing prompt. Loaded by the SDK through the "project"
 * setting source (alwaysApply), never through an SDK systemPrompt
 * replacement.
 */
const STANDING_PROMPT_RULE_RELATIVE_PATH = path.join(".cursor", "rules", "raft-agent.mdc");

/**
 * Mount the Raft standing prompt as a Cursor project rule so it reaches the
 * SDK agent as ambient context. This is the cursor-sdk standing-prompt
 * surface: the SDK systemPrompt option would replace the whole harness
 * prompt (dropping the tool protocol) and requires server permission, and
 * without any mount a message-woken agent would never see the Raft/CLI
 * guidance at all (the APM wake path only sends the inbox notice).
 *
 * Re-written on EVERY host launch (create and resume): the standing prompt
 * may change between runs, and rules load at agent creation/resume, so the
 * file must reflect the latest prompt before the host reads it.
 */
function writeStandingPromptRuleFile(workingDirectory: string, standingPrompt: string): void {
  const rulePath = path.join(workingDirectory, STANDING_PROMPT_RULE_RELATIVE_PATH);
  mkdirSync(path.dirname(rulePath), { recursive: true });
  writeFileSync(
    rulePath,
    ["---", "alwaysApply: true", "---", "", standingPrompt.trim(), ""].join("\n"),
    "utf8",
  );
}

/**
 * Cursor identity/backend/asset env keys are owner-controlled (mirrors the
 * shared registry's CONTROLLED_RUNTIME_ENV_KEYS for cursor-sdk): ambient or
 * remote-config values must never reach the host.
 */
function stripControlledCursorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const controlled = [
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "CURSOR_BACKEND_URL",
    "CURSOR_API_BASE_URL",
    "CURSOR_WEBSITE_URL",
    "RAFT_CURSOR_SDK_ASSETS",
    "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "ELECTRON_RUN_AS_NODE",
  ];
  for (const key of controlled) delete env[key];
  return env;
}

/** String-only env projection for the init IPC message (no undefined holes). */
function sanitizeEnvForWire(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(env)) {
    if (count >= 256) break;
    if (typeof value === "string") {
      out[key] = value;
      count += 1;
    }
  }
  return out;
}

/** Extra input carried by send(); the parent adds it to RuntimeSession.send. */
export interface CursorSdkSendInput {
  mode: "idle" | "busy";
  text: string;
  sessionId?: string | null;
  /**
   * Optional parent-APM attempt watermark. When present, the session emits
   * exactly one `delivery_outcome` ParsedEvent for this attempt: delivered /
   * deferred_to_idle / unknown.
   */
  attemptId?: string;
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface CursorSdkDriverDeps {
  /** Synchronous probe override (assets worker's probeCursorSdkAssets). */
  probe?: () => RuntimeProbeResult;
  /** Hermetic tests supply this; production uses the bound credential broker. */
  detectModels?: () => Promise<RuntimeModelSourceOutcome>;
}

/**
 * Cursor SDK driver.
 *
 * Slock runs Cursor through the staged @cursor/sdk Node host as a native
 * RuntimeSession (child_process transport over private IPC). Visible
 * chat/task/attachment communication goes through the workspace-local `raft`
 * CLI wrapper on the host's PATH (prepareCliTransport), plus the managed MCP
 * proxy re-injected on every run submit.
 */
export class CursorSdkDriver implements RuntimeDriver {
  readonly id = "cursor-sdk";
  /**
   * Legacy booleans (persistent/direct/steer) kept explicit during the
   * contract transition, matching the structured lifecycle below.
   */
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    // Detected models come from the credential broker's ONLINE verification
    // against the bound Cursor connection (not an offline config scan), so
    // they are launchable. The shared registry's static "default" entry stays
    // suggestion_only — it only seeds, never selects.
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };
  /**
   * The daemon can keep the persistent host alive and deliver follow-ups via
   * request-style IPC (sync send accepted into the bounded local queue).
   */
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  /**
   * Attempt-protocol driver: the APM attaches a monotonic `attemptId` to
   * follow-up sends and this session settles exactly one `delivery_outcome`
   * event per attempt (delivered / deferred_to_idle / unknown).
   */
  readonly deliveryOutcomeAttempts = true;
  // Parent-APM delivery-outcome protocol seam (drivers/types.ts): opts this
  // runtime into attempt watermarks. The APM attaches a monotonic attemptId to
  // follow-up sends and settles the session's delivery_outcome events
  // (delivered / deferred_to_idle / unknown); no other driver is affected.
  /**
   * The standing prompt reaches the SDK agent as a Cursor project rule
   * (writeStandingPromptRuleFile, mounted on every launch), so the APM may
   * use the native standing-prompt startup input on cold starts instead of
   * duplicating the whole prompt as a first user message. Deliberately NOT
   * an SDK systemPrompt replacement: that would drop the harness prompt
   * (tool protocol) and requires server permission. The current SDK user
   * echo never becomes another user message.
   */
  readonly supportsNativeStandingPrompt = true;

  private sessionId: string | null = null;
  private activeSession: CursorSdkRuntimeSession | null = null;
  private readonly deps: CursorSdkDriverDeps;

  constructor(deps: CursorSdkDriverDeps = {}) {
    this.deps = deps;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Driver-owned live busy gate: delegates to the active session. Never
   * claims no_active_turn while a turn is active or ACK-pending.
   */
  busyDeliveryReadiness(): RuntimeBusyDeliveryReadiness {
    return this.activeSession?.busyDeliveryReadiness() ?? { ready: true };
  }

  probe(): RuntimeProbeResult {
    return this.deps.probe ? this.deps.probe() : probeCursorSdkAssets();
  }

  async detectModels(_ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    // The selectable catalog comes from the bound, verified Cursor connection
    // (credential broker) — never from a static offline fallback.
    return this.deps.detectModels ? this.deps.detectModels() : detectCursorSdkModelsViaModule();
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    const session = new CursorSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    });
    this.activeSession = session;
    return session;
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error("CursorSdkDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
