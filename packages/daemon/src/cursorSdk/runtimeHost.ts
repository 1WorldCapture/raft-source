/**
 * Cursor SDK runtime host — persistent separate Node process.
 *
 * ONE host process owns ONE SDKAgent and executes Runs sequentially. The
 * daemon-side session (`drivers/cursor-sdk.ts`) spawns the asset builder's
 * transpilation of this file (`host/runtimeHost.mjs`, `@cursor/sdk` external)
 * under the staged Node from the runtime assets, with private IPC
 * (`stdio: ["ignore", "pipe", "pipe", "ipc"]`) and the entry guard env
 * `RAFT_CURSOR_SDK_HOST_ENTRY=1` (see {@link CURSOR_SDK_HOST_ENTRY_ENV}).
 *
 * Invariants (docs/architecture/cursor-sdk-implementation.md):
 * - The SDK is imported ONLY here, dynamically, from the staged closure. The
 *   daemon never imports `@cursor/sdk`, and this file never statically
 *   references it, so daemon-side typecheck/tests run without the package.
 * - No business inbox, no follow-up queue: at most one active Run and one
 *   pending steer. Everything else is rejected with typed busy semantics.
 * - Credentials NEVER touch argv, stdout, or logs. The API key arrives via
 *   the `init` IPC message and is passed to `Agent.create({ apiKey })` /
 *   `CURSOR_API_KEY` env; `CURSOR_BACKEND_URL` selects the verified backend.
 *   stdout is never written; stderr carries sanitized, bounded diagnostics.
 * - Single-writer lock on the host data dir: a second live host fails closed
 *   with a typed error — never a broad catch into a fresh session, and never
 *   an unconditional `local.force` of the SDK's own store.
 * - `run_settled` is sent only after the native run is terminal AND its
 *   stream is fully drained. Shutdown answers `shutdown_settled` with proof;
 *   every wait is bounded and every timer is cleared.
 *
 * SDK binding (verified against the staged @cursor/sdk@1.0.36 .d.ts):
 * - `Agent.create(options) / Agent.resume(agentId, options) -> SDKAgent`
 * - `agent.send(text, { model?, mcpServers? }) -> Promise<Run>`
 * - `run.stream() -> AsyncGenerator<SDKMessage>`, `run.wait() -> RunResult`,
 *   `run.steer?(text) -> Promise<SteerAckOutcome>` where
 *   `SteerAckOutcome = "complete_delivered" | "revert_to_followup"`,
 *   `run.cancel() -> Promise<void>`.
 * - `UnknownAgentError` is NOT not-found (the SDK uses it for busy steering);
 *   genuine `AgentNotFoundError` is distinct. `AgentBusyError` (409) marks a
 *   new run attempted while another is active.
 */

import { buildModelSelection } from "./modelTiers.js";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  CURSOR_SDK_HOST_ENTRY_ENV,
  CURSOR_SDK_HOST_PROTOCOL_VERSION,
  CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT,
  isCursorSdkHostboundMessage,
  sanitizeCursorSdkWireText,
  toCursorSdkWireError,
  type CursorSdkHostAuthLease,
  type CursorSdkHostboundMessage,
  type CursorSdkHostToDriverMessage,
  type CursorSdkInitMessage,
  type CursorSdkRunEventPayload,
  type CursorSdkRunOptions,
  type CursorSdkWireError,
  type CursorSdkWireErrorClass,
} from "./protocol.js";

// Entry guard re-exported for tests: {@link CURSOR_SDK_HOST_ENTRY_ENV} in
// protocol.ts is the canonical definition (the daemon-side driver also needs
// it, and must not depend on the host source module).
export { CURSOR_SDK_HOST_ENTRY_ENV };

// ─────────────────────────────────────────────────────────────────────────────
// Structural SDK binding — mirrors the pinned @cursor/sdk@1.0.36 surface
// (dist/esm/{agent,run,messages,options,errors}.d.ts). Structural on purpose:
// the host loads the SDK dynamically from the staged closure, and the shapes
// below are validated at runtime by describeSdkModuleSurface.
// ─────────────────────────────────────────────────────────────────────────────

/** SDKMessage (messages.d.ts) — structural view; unknown fields ignored. */
type CursorSdkStreamMessage = Record<string, unknown>;

/** RunResult.status (run.d.ts). */
type CursorSdkRunStatus = "running" | "finished" | "error" | "cancelled";

interface CursorSdkRunResultLike {
  id?: unknown;
  status?: CursorSdkRunStatus;
  error?: { message?: unknown; code?: unknown } | undefined;
}

interface CursorSdkRunLike {
  id?: unknown;
  stream?: () => AsyncGenerator<CursorSdkStreamMessage, void>;
  wait?: () => Promise<CursorSdkRunResultLike>;
  steer?: (text: string) => Promise<string>;
  cancel?: () => Promise<void>;
}

interface CursorSdkAgentLike {
  agentId?: unknown;
  send: (message: string, options?: Record<string, unknown>) => Promise<CursorSdkRunLike>;
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

interface CursorSdkModuleLike {
  Agent?: {
    create?: (options: Record<string, unknown>) => Promise<CursorSdkAgentLike>;
    resume?: (agentId: string, options?: Record<string, unknown>) => Promise<CursorSdkAgentLike>;
  };
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Await any SDK call result, normalizing sync returns and voids. */
async function awaitCall(value: Promise<unknown> | unknown): Promise<void> {
  if (isThenable(value)) await value;
}

// ── Error classification ──

/**
 * Classify an SDK rejection WITHOUT relying on cross-instance instanceof.
 * `UnknownAgentError` is NOT not-found (the SDK's own docblock says so — it is
 * the generic unclassified bucket / busy steering signal); genuine
 * `AgentNotFoundError` is the missing-agent case. `AgentBusyError` (409) is a
 * new run attempted while another is active.
 */
export function classifyCursorSdkError(error: unknown): CursorSdkWireErrorClass {
  const name = (error as { name?: unknown } | null)?.name;
  const nameText = typeof name === "string" ? name : "";
  const message = error instanceof Error ? error.message : sanitizeCursorSdkWireText(error);
  if (nameText.includes("AgentNotFoundError") || /AgentNotFoundError/i.test(message)) {
    return "agent_not_found";
  }
  if (nameText.includes("UnknownAgentError") || /UnknownAgentError/i.test(message)) {
    return "unknown_agent";
  }
  if (nameText.includes("AgentBusyError") || /AgentBusyError/i.test(message)) {
    return "busy";
  }
  if (nameText.includes("AuthenticationError") || /AuthenticationError/i.test(message)) {
    return "auth";
  }
  if (/agent is busy|currently running|already (an? )?active (run|turn)/i.test(message)) {
    return "busy";
  }
  return "host_internal";
}

// ── Stream message normalization (SDKMessage → protocol payload) ──

/** Bounded non-empty string extraction. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function payloadBytesOf(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/**
 * Convert one SDKMessage into zero or more protocol payloads. Shapes mirror
 * messages.d.ts: `user` (echo), `assistant` (content blocks: text/tool_use),
 * `tool_call` (status running|completed|error), `thinking`, `usage` (TokenUsage
 * camelCase → whitelisted snake_case attrs). Unknown shapes degrade to bounded
 * diagnostics carrying the type NAME only.
 */
export function normalizeCursorSdkStreamMessage(
  message: CursorSdkStreamMessage,
): CursorSdkRunEventPayload[] {
  const out: CursorSdkRunEventPayload[] = [];
  const type = textOf(message["type"]);
  switch (type) {
    case "user": {
      // The SDK echoing our own submitted turn. Forward as user_echo so the
      // daemon side can DROP it — it must never become another user message.
      const content = (message["message"] as Record<string, unknown> | undefined)?.["content"];
      out.push({ type: "user_echo", payloadBytes: payloadBytesOf(content) });
      return out;
    }
    case "assistant": {
      const content = (message["message"] as Record<string, unknown> | undefined)?.["content"];
      if (!Array.isArray(content)) return out;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const record = block as Record<string, unknown>;
        const blockType = record["type"];
        if (blockType === "text") {
          const text = textOf(record["text"]);
          if (text) out.push({ type: "assistant_text", text: sanitizeCursorSdkWireText(text, 64_000) });
        } else if (blockType === "tool_use") {
          const name = textOf(record["name"]) ?? "unknown_tool";
          out.push({ type: "tool_call", name, input: record["input"] ?? {} });
        }
      }
      return out;
    }
    case "thinking":
    case "reasoning": {
      const text =
        textOf(message["text"]) ?? textOf(message["content"]) ?? textOf(message["thinking"]);
      if (text) out.push({ type: "assistant_thinking", text: sanitizeCursorSdkWireText(text, 64_000) });
      return out;
    }
    case "tool_call": {
      const name = textOf(message["name"]) ?? "unknown_tool";
      const status = textOf(message["status"]);
      if (status === "completed" || status === "error") {
        out.push({
          type: "tool_result",
          name,
          payloadBytes: payloadBytesOf(message["result"]),
        });
        return out;
      }
      out.push({ type: "tool_call", name, input: message["args"] ?? {} });
      return out;
    }
    case "usage": {
      const usage = message["usage"] as Record<string, unknown> | undefined;
      const attrs: Record<string, string | number | boolean> = {};
      if (usage && typeof usage === "object") {
        const camelToSnake: Array<[string, string]> = [
          ["inputTokens", "input_tokens"],
          ["outputTokens", "output_tokens"],
          ["cacheReadTokens", "cache_read_input_tokens"],
          ["cacheWriteTokens", "cache_creation_input_tokens"],
          ["totalTokens", "total_tokens"],
          ["reasoningTokens", "reasoning_tokens"],
        ];
        for (const [camel, snake] of camelToSnake) {
          const value = usage[camel];
          if (typeof value === "number" && Number.isFinite(value)) attrs[snake] = value;
        }
      }
      if (Object.keys(attrs).length > 0) {
        out.push({ type: "usage", attrs, usageKind: "per_turn" });
      }
      return out;
    }
    case "system":
    case "status":
    case "request":
    case "task":
    default: {
      // system(init) carries the agent identity, handled by the host before
      // normalization. Everything else here is a bounded, payload-free notice.
      out.push({
        type: "diagnostic",
        message: sanitizeCursorSdkWireText(`sdk stream message type=${type ?? "unknown"}`),
      });
      return out;
    }
  }
}

/** Extract the native agent identity (resume handle) from a system message. */
export function agentIdOfSystemMessage(message: CursorSdkStreamMessage): string | null {
  if (message["type"] !== "system") return null;
  const agentId = message["agent_id"] ?? message["agentId"];
  return typeof agentId === "string" && agentId.length > 0 ? agentId : null;
}

// ── SDK module surface validation ──

/**
 * Runtime half of the pinned-type contract: verify the dynamically imported
 * module exposes the agent factory the host drives. A mismatch names the
 * missing export surface precisely (errorClass "sdk_surface").
 */
export function describeSdkModuleSurface(mod: CursorSdkModuleLike): {
  usable: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  // NOTE: `Agent` is exported as a class (typeof "function") with static
  // create/resume — accept function or object shapes.
  if (!mod || (typeof mod !== "object" && typeof mod !== "function")) {
    return { usable: false, missing: ["module"] };
  }
  const agentNamespace = (mod as Record<string, unknown>)["Agent"] as
    | Record<string, unknown>
    | undefined;
  if (!agentNamespace || (typeof agentNamespace !== "function" && typeof agentNamespace !== "object")) {
    missing.push("Agent");
  } else {
    if (typeof agentNamespace["create"] !== "function") missing.push("Agent.create");
    if (typeof agentNamespace["resume"] !== "function") missing.push("Agent.resume");
  }
  return { usable: missing.length === 0, missing };
}

// ── Bounded waits ──

const activeTimers = new Set<NodeJS.Timeout>();

function boundedTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      resolve();
    }, Math.max(0, ms));
    activeTimers.add(timer);
  });
}

async function withBoundedWait(promise: Promise<unknown> | unknown, ms: number): Promise<void> {
  await Promise.race([
    awaitCall(promise).then(
      () => undefined,
      () => undefined,
    ),
    boundedTimeout(ms),
  ]);
}

function clearAllTimers(): void {
  for (const timer of activeTimers) clearTimeout(timer);
  activeTimers.clear();
}

// ── Single-writer host lock ──

interface HostLock {
  path: string;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function asWireError(error: unknown, fallbackClass: CursorSdkWireErrorClass): CursorSdkWireError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CursorSdkWireError).message === "string" &&
    typeof (error as CursorSdkWireError).errorClass === "string"
  ) {
    return error as CursorSdkWireError;
  }
  return toCursorSdkWireError(error, fallbackClass);
}

/**
 * Acquire the single-writer lock for this host's data dir. Store execution
 * has exactly one writer: a lock held by a LIVE process fails closed with
 * errorClass "host_lock" (the driver surfaces it — no silent fresh session).
 * A lock left by a dead process is stale and may be replaced once.
 */
export function acquireHostLock(hostDataDir: string, bootId: string): HostLock {
  mkdirSync(hostDataDir, { recursive: true });
  const lockPath = path.join(hostDataDir, "host.lock");
  const payload = `${process.pid}\n${bootId}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, payload, { mode: 0o600 });
      } finally {
        closeSync(fd);
      }
      return {
        path: lockPath,
        release() {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone (crash cleanup, manual removal). Not fatal.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      // Lock exists. Stale (dead owner) → replace once. Live owner → fail closed.
      let heldByLiveProcess = true;
      try {
        const existing = readFileSync(lockPath, "utf8");
        const pid = Number.parseInt(existing.split("\n")[0] ?? "", 10);
        heldByLiveProcess = Number.isInteger(pid) && pid > 0 && processAlive(pid);
      } catch {
        heldByLiveProcess = false;
      }
      if (heldByLiveProcess) {
        throw toCursorSdkWireError("cursor sdk host lock held by a live process", "host_lock");
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Racing another reclaim; the next openSync attempt decides.
      }
    }
  }
  throw toCursorSdkWireError("cursor sdk host lock could not be acquired", "host_lock");
}

// ── Host state ──

interface ActiveRun {
  runId: string;
  run: CursorSdkRunLike;
  finishReason: "completed" | "aborted" | "error";
}

class CursorSdkHost {
  private initialized = false;
  private stopping = false;
  private lock: HostLock | null = null;
  private agent: CursorSdkAgentLike | null = null;
  private runOptions: CursorSdkRunOptions = {};
  private auth: CursorSdkHostAuthLease | null = null;
  private activeRun: ActiveRun | null = null;
  /** Exactly one steer may be pending its ACK at a time. */
  private pendingSteerAttempt: string | null | undefined = undefined;
  private announcedSessionId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly bootId = `boot_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly init: CursorSdkInitMessage) {}

  // ── Wire plumbing ──

  private send(message: CursorSdkHostToDriverMessage): void {
    if (!process.send) return;
    try {
      process.send(message);
    } catch {
      // Channel closed (driver gone). Exit handling owns teardown.
    }
  }

  private sendAttemptResult(
    attemptId: string | null,
    result: "complete_delivered" | "revert" | "failed",
    error?: CursorSdkWireError,
  ): void {
    // ALWAYS report, including null-attempt submits: the driver needs every
    // terminal answer for its one-pending-steer gate and run settlement.
    // The "no invented APM debt" rule is enforced driver-side (null-attempt
    // results never produce delivery_outcome events).
    this.send({ kind: "attempt_result", attemptId, result, ...(error ? { error } : {}) });
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    const sanitized = sanitizeCursorSdkWireText(message);
    this.send({ kind: "host_log", level, message: sanitized });
    // Local mirror on stderr (never stdout). Bounded by the sanitizer.
    try {
      process.stderr.write(`[cursor-sdk-host:${level}] ${sanitized}\n`);
    } catch {
      // stderr gone too; the IPC copy above already tried.
    }
  }

  private maybeAnnounceSessionId(sessionId: string): void {
    if (sessionId.length === 0 || sessionId === this.announcedSessionId) return;
    this.announcedSessionId = sessionId;
    this.send({ kind: "session_init", sessionId });
  }

  // ── Boot ──

  async run(): Promise<void> {
    // NOTE: host_ready is sent exactly once, proactively, by main() BEFORE
    // the init wait — a second announcement here made drivers that react to
    // host_ready (e.g. by sending init) dispatch duplicate init messages.
    if (this.init.protocolVersion !== CURSOR_SDK_HOST_PROTOCOL_VERSION) {
      this.send({
        kind: "init_result",
        ok: false,
        sessionId: null,
        error: toCursorSdkWireError(
          `protocol version mismatch: driver=${this.init.protocolVersion} host=${CURSOR_SDK_HOST_PROTOCOL_VERSION}`,
          "protocol",
        ),
      });
      return;
    }
    process.on("message", (message: unknown) => {
      if (!isCursorSdkHostboundMessage(message)) {
        this.log("warn", "dropped malformed driver message");
        return;
      }
      // Serialize handling: each submission must observe the previous state
      // transition before deciding, and no handler may interleave.
      this.queue = this.queue.then(
        () => this.handleDriverMessage(message),
        () => this.handleDriverMessage(message),
      );
    });
    await this.initialize();
  }

  private applyProcessEnv(): void {
    // The SDK resolves its backend from CURSOR_BACKEND_URL (executor-common)
    // and can fall back to CURSOR_API_KEY. The verified lease is authoritative
    // for both; ambient values were already stripped daemon-side.
    for (const [key, value] of Object.entries(this.init.env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    const auth = this.auth;
    if (auth) {
      if (auth.apiKey) process.env["CURSOR_API_KEY"] = auth.apiKey;
      if (auth.backendUrl) process.env["CURSOR_BACKEND_URL"] = auth.backendUrl;
    }
  }

  private async importSdkModule(): Promise<CursorSdkModuleLike> {
    // Non-literal specifier: the daemon package must NOT resolve the SDK at
    // typecheck/test time. The staged host resolves "@cursor/sdk" from the
    // runtime-assets closure (host/runtimeHost.mjs → ../node_modules).
    const specifier = this.init.sdkModuleSpecifier || "@cursor/sdk";
    return (await import(/* @vite-ignore */ specifier)) as CursorSdkModuleLike;
  }

  /**
   * Agent-level options, re-applied identically on create and resume:
   * model/settings/tools/MCP must be re-injected on resume, never trusted to
   * persisted defaults. NOTE: `systemPrompt` is deliberately never set (no
   * systemPrompt replacement — the standing prompt is mounted as a Cursor
   * project rule by the driver on every launch), and no force-like flag is
   * ever passed. NOTE: the production run host is NativeCursorHost
   * (nativeRuntimeHost.ts, started via runtimeHostEntry.ts); this class is
   * kept for its helpers and tests only.
   */
  // NOTE: this non-production helper path passes no tier info, so a configured
  // reasoning effort / fast mode is intentionally NOT applied here (bare model id).
  // Production is NativeCursorHost (nativeRuntimeHost.ts), which resolves tiers.
  private buildAgentOptions(): Record<string, unknown> {
    const ro = this.runOptions;
    return {
      ...(this.auth?.apiKey ? { apiKey: this.auth.apiKey } : {}),
      ...(ro.model ? { model: buildModelSelection(ro.model, null, { reasoningEffort: ro.reasoningEffort, fast: ro.fast }) } : {}),
      ...(ro.mcpServers && Object.keys(ro.mcpServers).length > 0
        ? { mcpServers: ro.mcpServers }
        : {}),
      local: {
        cwd: this.init.workspaceRoot,
        ...(ro.settingSources && ro.settingSources.length > 0
          ? { settingSources: ro.settingSources }
          : {}),
        // NOTE: never a force-like flag: the SDK's own store state is
        // respected; conflicts fail visibly instead of being forced away.
      },
    };
  }

  private buildSendOptions(): Record<string, unknown> {
    // Re-injected on EVERY send: a resumed conversation must not silently
    // fall back to persisted defaults for model or MCP wiring.
    const ro = this.runOptions;
    return {
      ...(ro.model ? { model: buildModelSelection(ro.model, null, { reasoningEffort: ro.reasoningEffort, fast: ro.fast }) } : {}),
      ...(ro.mcpServers && Object.keys(ro.mcpServers).length > 0
        ? { mcpServers: ro.mcpServers }
        : {}),
    };
  }

  private async constructAgent(mod: CursorSdkModuleLike): Promise<CursorSdkAgentLike> {
    const surface = describeSdkModuleSurface(mod);
    if (!surface.usable) {
      throw toCursorSdkWireError(
        `@cursor/sdk surface mismatch: missing [${surface.missing.join(", ")}]`,
        "sdk_surface",
      );
    }
    const agentFactory = mod.Agent!;
    const options = this.buildAgentOptions();
    if (this.init.sessionId) {
      try {
        return await agentFactory.resume!(this.init.sessionId, options);
      } catch (error) {
        // NARROW recovery only: a typed not-found resume may cold-start.
        // Anything else (auth, network, lock…) stays visible — never a broad
        // catch into a fresh session.
        if (classifyCursorSdkError(error) !== "agent_not_found") throw error;
        this.log("info", "native session not found; cold-starting a fresh agent");
      }
    }
    return await agentFactory.create!(options);
  }

  private async initialize(): Promise<void> {
    try {
      this.lock = acquireHostLock(this.init.hostDataDir, this.bootId);
      this.auth = this.init.auth;
      this.applyProcessEnv();
      const mod = await this.importSdkModule();
      this.agent = await this.constructAgent(mod);
      this.runOptions = this.init.runOptions ?? {};
      this.initialized = true;
      const agentId = this.agent?.agentId;
      if (typeof agentId === "string" && agentId.length > 0) {
        this.maybeAnnounceSessionId(agentId);
      }
      this.send({
        kind: "init_result",
        ok: true,
        sessionId: this.announcedSessionId ?? this.init.sessionId,
      });
    } catch (error) {
      const wireError = asWireError(error, classifyCursorSdkError(error));
      this.log("error", `init failed: ${wireError.message}`);
      this.send({ kind: "init_result", ok: false, sessionId: null, error: wireError });
      await this.shutdown("init_failed");
    }
  }

  // ── Message dispatch (serialized) ──

  private async handleDriverMessage(message: CursorSdkHostboundMessage): Promise<void> {
    if (this.stopping) return;
    switch (message.kind) {
      case "init":
        // Re-init on a live host is a protocol violation; fail loudly.
        this.log("error", "duplicate init message dropped");
        return;
      case "run_submit":
        await this.handleRunSubmit(message.runId, message.attemptId, message.text);
        return;
      case "steer_submit":
        await this.handleSteerSubmit(message.attemptId, message.text);
        return;
      case "stop":
        await this.shutdown(message.reason);
        return;
    }
  }

  private async handleRunSubmit(
    runId: string,
    attemptId: string | null,
    text: string,
  ): Promise<void> {
    if (!this.initialized || !this.agent) {
      this.sendAttemptResult(attemptId, "failed", toCursorSdkWireError("host not initialized", "protocol"));
      return;
    }
    if (this.activeRun) {
      // Sequential runs only: a new Run while one is active reverts (the SDK
      // would raise AgentBusyError here). APM debt semantics apply upstream.
      this.sendAttemptResult(attemptId, "revert", toCursorSdkWireError("another run is active", "busy"));
      return;
    }
    let run: CursorSdkRunLike;
    try {
      run = await this.agent.send(text, this.buildSendOptions());
    } catch (error) {
      const errorClass = classifyCursorSdkError(error);
      if (errorClass === "unknown_agent" || errorClass === "busy") {
        this.sendAttemptResult(attemptId, "revert", toCursorSdkWireError(error, errorClass));
      } else {
        this.sendAttemptResult(attemptId, "failed", toCursorSdkWireError(error, errorClass));
      }
      return;
    }
    const active: ActiveRun = { runId, run, finishReason: "completed" };
    this.activeRun = active;
    this.sendAttemptResult(attemptId, "complete_delivered");
    // Pump outside the serialization queue: stream events must flow while
    // later submissions (steer) are being processed.
    void this.pumpRun(active);
  }

  private async pumpRun(active: ActiveRun): Promise<void> {
    let streamError: unknown = null;
    try {
      if (typeof active.run.stream === "function") {
        for await (const message of active.run.stream()) {
          if (this.stopping) break;
          if (!message || typeof message !== "object") continue;
          const agentId = agentIdOfSystemMessage(message);
          if (agentId) this.maybeAnnounceSessionId(agentId);
          for (const payload of normalizeCursorSdkStreamMessage(message)) {
            if (payload.type === "diagnostic") {
              this.log("info", payload.message);
              continue;
            }
            this.send({ kind: "run_event", payload });
          }
        }
      }
    } catch (error) {
      streamError = error;
    }
    try {
      // Stream drained. Await terminal evidence (bounded) before settling:
      // run_settled means terminal AND drained, never one before the other.
      let terminal: CursorSdkRunResultLike | undefined;
      if (typeof active.run.wait === "function") {
        await Promise.race([
          active.run.wait().then(
            (result) => {
              terminal = result;
            },
            (error: unknown) => {
              streamError = streamError ?? error;
            },
          ),
          boundedTimeout(10_000),
        ]);
      }
      const status = terminal?.status;
      if (streamError !== null) {
        active.finishReason = "error";
      } else if (this.stopping || status === "cancelled") {
        active.finishReason = "aborted";
      } else if (status === "error") {
        active.finishReason = "error";
      } else {
        active.finishReason = "completed";
      }
      if (this.activeRun === active) {
        this.activeRun = null;
        this.send({
          kind: "run_settled",
          runId: active.runId,
          finishReason: active.finishReason,
          ...(active.finishReason === "error"
            ? {
                error: toCursorSdkWireError(
                  streamError ??
                    (terminal?.error && typeof terminal.error.message === "string"
                      ? terminal.error.message
                      : "cursor sdk run failed"),
                  classifyCursorSdkError(streamError ?? terminal?.error ?? "run failed"),
                ),
              }
            : {}),
        });
      }
    } catch (error) {
      if (this.activeRun === active) {
        this.activeRun = null;
        this.send({
          kind: "run_settled",
          runId: active.runId,
          finishReason: "error",
          error: toCursorSdkWireError(error, classifyCursorSdkError(error)),
        });
      }
    }
  }

  private async handleSteerSubmit(attemptId: string | null, text: string): Promise<void> {
    if (!this.initialized) {
      this.sendAttemptResult(attemptId, "failed", toCursorSdkWireError("host not initialized", "protocol"));
      return;
    }
    const active = this.activeRun;
    if (!active) {
      this.sendAttemptResult(attemptId, "revert", toCursorSdkWireError("no active run to steer", "busy"));
      return;
    }
    if (this.pendingSteerAttempt !== undefined) {
      // Exactly one steer ACK pending — a second concurrent steer reverts.
      this.sendAttemptResult(
        attemptId,
        "revert",
        toCursorSdkWireError("a steer is already pending", "busy"),
      );
      return;
    }
    const steer = active.run.steer;
    if (typeof steer !== "function") {
      this.sendAttemptResult(
        attemptId,
        "failed",
        toCursorSdkWireError("@cursor/sdk surface mismatch: run exposes no steer()", "sdk_surface"),
      );
      return;
    }
    this.pendingSteerAttempt = attemptId;
    try {
      // SDK steer resolves with the terminal SteerAckOutcome
      // ("complete_delivered" | "revert_to_followup"); "confirm_steering"
      // intermediates keep the promise pending by design, so a settled value
      // here is always terminal.
      const outcome = await steer.call(active.run, text);
      this.pendingSteerAttempt = undefined;
      if (outcome === "complete_delivered") {
        this.sendAttemptResult(attemptId, "complete_delivered");
      } else {
        // "revert_to_followup": the turn did NOT take the message — the
        // caller must resend it as an ordinary follow-up (deferred_to_idle).
        this.sendAttemptResult(
          attemptId,
          "revert",
          toCursorSdkWireError("steer reverted to follow-up", "busy"),
        );
      }
    } catch (error) {
      const errorClass = classifyCursorSdkError(error);
      this.pendingSteerAttempt = undefined;
      if (errorClass === "unknown_agent" || errorClass === "busy") {
        // UnknownAgentError is busy semantics here, NOT not-found: revert
        // without runtime error UI upstream.
        this.sendAttemptResult(attemptId, "revert", toCursorSdkWireError(error, errorClass));
      } else {
        this.sendAttemptResult(attemptId, "failed", toCursorSdkWireError(error, errorClass));
      }
    }
  }

  // ── Shutdown ──

  private async requestRunCancel(): Promise<void> {
    const active = this.activeRun;
    const agent = this.agent;
    // Cancellation does NOT guarantee custom callbacks finished: every await
    // below is bounded, and a rejecting candidate never stops the sequence.
    if (active && typeof active.run.cancel === "function") {
      await withBoundedWait(active.run.cancel(), 1_000);
    }
    if (agent) {
      try {
        agent.close?.();
      } catch {
        // close() is advisory; asyncDispose below is the durable path.
      }
      if (typeof agent[Symbol.asyncDispose] === "function") {
        await withBoundedWait(agent[Symbol.asyncDispose]!(), 1_000);
      }
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    let outcome: "clean" | "deadline" = "clean";
    try {
      // Invalidate inputs first: new submissions are refused from here on.
      const graceful = (async () => {
        await this.requestRunCancel();
        // Give the active pump a bounded chance to observe cancellation and
        // drain, and any pending steer promise to settle.
        const deadline = Date.now() + CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT;
        while (
          Date.now() < deadline &&
          (this.activeRun || this.pendingSteerAttempt !== undefined)
        ) {
          await boundedTimeout(50);
        }
      })();
      await Promise.race([graceful, boundedTimeout(CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT + 500)]);
      if (this.activeRun || this.pendingSteerAttempt !== undefined) outcome = "deadline";
    } catch (error) {
      outcome = "deadline";
      this.log("warn", `shutdown path error: ${sanitizeCursorSdkWireText(error)}`);
    }
    try {
      this.lock?.release();
    } catch {
      // Lock release is best-effort; a stale lock is reclaimable.
    }
    this.send({ kind: "shutdown_settled", outcome });
    this.log("info", `shutdown settled reason=${sanitizeCursorSdkWireText(reason)} outcome=${outcome}`);
    clearAllTimers();
    // Let the message flush before dropping the channel.
    setImmediate(() => {
      try {
        process.disconnect?.();
      } catch {
        // Already disconnected.
      }
      process.exit(0);
    });
  }
}

// ── Entry (guarded) ──

function sanitizedFatal(message: string): never {
  process.stderr.write(`[cursor-sdk-host:fatal] ${sanitizeCursorSdkWireText(message)}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!process.send) {
    sanitizedFatal("host requires an IPC channel (spawn with stdio ipc)");
  }
  // Announce the channel proactively, BEFORE any credential-bearing init:
  // the driver may verify the protocol version before sending the lease.
  // (The CursorSdkHost.run() handshake below tolerates the duplicate send.)
  try {
    process.send({ kind: "host_ready", protocolVersion: CURSOR_SDK_HOST_PROTOCOL_VERSION });
  } catch {
    sanitizedFatal("host ipc channel closed before ready");
  }
  const init = await new Promise<CursorSdkInitMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for init message"));
    }, 30_000);
    const onMessage = (message: unknown): void => {
      if (!isCursorSdkHostboundMessage(message) || message.kind !== "init") return;
      clearTimeout(timeout);
      cleanup();
      resolve(message);
    };
    const cleanup = (): void => {
      process.off("message", onMessage);
    };
    process.on("message", onMessage);
  });
  const host = new CursorSdkHost(init);
  registerExitHandlers(host);
  await host.run();
}

function registerExitHandlers(host: CursorSdkHost): void {
  process.on("disconnect", () => {
    // Driver gone: bounded best-effort cleanup, then exit. Never keep a
    // locked host alive without its supervisor.
    const deadline = setTimeout(() => process.exit(1), 1_500);
    deadline.unref?.();
    void host
      .shutdown("disconnect")
      .catch(() => process.exit(1))
      .finally(() => process.exit(0));
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[cursor-sdk-host:uncaught] ${sanitizeCursorSdkWireText(error)}\n`);
    void host
      .shutdown("uncaught_exception")
      .catch(() => process.exit(1))
      .then(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[cursor-sdk-host:unhandled] ${sanitizeCursorSdkWireText(reason)}\n`);
  });
}

if (process.env[CURSOR_SDK_HOST_ENTRY_ENV] === "1") {
  void main().catch((error) => {
    sanitizedFatal(error instanceof Error ? error.message : String(error));
  });
}

// Pure host-side logic re-exported for focused unit tests. Importing this
// module in a test harness does not start the host loop (entry guard above).
export const __internals = {
  normalizeCursorSdkStreamMessage,
  agentIdOfSystemMessage,
  classifyCursorSdkError,
  describeSdkModuleSurface,
  acquireHostLock,
};
