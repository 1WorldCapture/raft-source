/**
 * Private IPC protocol between the Cursor SDK runtime session (daemon process,
 * `drivers/cursor-sdk.ts`) and the persistent Cursor SDK host (separate Node
 * process, `cursorSdk/runtimeHost.ts`, staged by the asset builder as
 * `host/runtimeHost.mjs` with `@cursor/sdk` external).
 *
 * Transport contract (docs/architecture/cursor-sdk-implementation.md):
 * - Node private IPC only (`stdio: ["ignore", "pipe", "pipe", "ipc"]`).
 * - NEVER stdout NDJSON, argv, or normal stdout for credentials: the API key
 *   lease travels inside the `init` IPC message and lives in host memory/env
 *   only. Every string that crosses the wire in either direction must already
 *   be sanitized via {@link sanitizeCursorSdkWireText}.
 * - All messages are plain JSON objects with a `kind` discriminator. Both ends
 *   parse defensively with the `is*Message` guards below; unknown or malformed
 *   messages are dropped (and surfaced as bounded diagnostics), never fatal.
 */

/** Bump on any breaking wire change. Host refuses mismatched versions. */
export const CURSOR_SDK_HOST_PROTOCOL_VERSION = 1;

/**
 * Entry guard env: the daemon sets it to "1" exactly when spawning the
 * runtime host. The host source module stays importable in test harnesses
 * without starting the host main loop.
 */
export const CURSOR_SDK_HOST_ENTRY_ENV = "RAFT_CURSOR_SDK_HOST_ENTRY";

// ── Bounded timing / queue constants ──
// Every wait in this subsystem is bounded; nothing may hang forever.

/** Default bound for the driver-side per-attempt ACK wait (unknown outcome). */
export const CURSOR_SDK_ATTEMPT_ACK_TIMEOUT_MS_DEFAULT = 15_000;
/** Default bound for host init (SDK import + agent construction) completion. */
export const CURSOR_SDK_HOST_INIT_TIMEOUT_MS_DEFAULT = 60_000;
/** Default bound for the host to finish graceful shutdown after `stop`. */
export const CURSOR_SDK_HOST_SHUTDOWN_GRACE_MS_DEFAULT = 5_000;
/** Bound for SIGKILL escalation after SIGTERM of the host process group. */
export const CURSOR_SDK_HOST_KILL_ESCALATION_MS_DEFAULT = 2_000;
/** Default bound for credential-lease resolution before host spawn. */
export const CURSOR_SDK_CREDENTIAL_LEASE_TIMEOUT_MS_DEFAULT = 30_000;
/**
 * Bound for the local outbound queue. The driver only ever enqueues
 * `run_submit` / `steer_submit` / `stop` — single-digit volume — so this cap
 * exists to fail loudly on a runaway producer, not as flow control.
 */
export const CURSOR_SDK_HOSTBOUND_QUEUE_MAX = 16;
/** Sanitized wire text bound (bytes). */
export const CURSOR_SDK_WIRE_TEXT_MAX_BYTES = 2_000;

// ── Attempt outcomes (APM delivery_outcome contract) ──

/**
 * Delivery outcome for an attempt, as consumed by the parent-owned
 * `ParsedEvent` addition:
 * `{kind:"delivery_outcome"; source:"cursor_sdk"; attemptId; outcome}`.
 * - `delivered`        — host confirmed the SDK consumed the attempt
 *                        (`complete_delivered`).
 * - `deferred_to_idle` — host reverted the attempt (SDK busy semantics); no
 *                        runtime error UI; further busy steering is suppressed
 *                        for the current run until true idle.
 * - `unknown`          — the bounded ACK wait expired (or the host died) with
 *                        no terminal answer. Deliberately NOT `deferred_to_idle`.
 */
export type CursorSdkAttemptOutcome = "delivered" | "deferred_to_idle" | "unknown";

// ── Sanitized error shape ──

/** Closed classification for wire-visible errors. */
export type CursorSdkWireErrorClass =
  | "protocol"
  | "assets"
  | "sdk_surface"
  | "auth"
  | "host_lock"
  | "busy"
  | "unknown_agent" // SDK UnknownAgentError: NOT not-found — busy semantics
  | "agent_not_found" // genuine AgentNotFoundError: distinct from the above
  | "aborted"
  | "host_internal";

/** Sanitized, bounded error payload. No stacks, no secrets, no raw payloads. */
export interface CursorSdkWireError {
  message: string;
  errorClass?: CursorSdkWireErrorClass;
}

// ── Normalized run stream payloads ──
// The host converts SDK stream message objects into this closed union; the
// daemon-side mapper (`eventMapper.ts`) never sees raw SDK shapes. Keeping the
// SDK surface confined to the host is what lets daemon-side tests run without
// the SDK package.

export interface CursorSdkUsageAttrs {
  readonly [key: string]: string | number | boolean;
}

export type CursorSdkRunEventPayload =
  /** Echo of the submitted user turn. MUST never become another user message. */
  | { type: "user_echo"; payloadBytes: number }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_thinking"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; payloadBytes?: number }
  | {
      type: "usage";
      attrs: CursorSdkUsageAttrs;
      usageKind?: "cumulative_session" | "per_turn" | "unknown";
    }
  /** Sanitized non-terminal SDK notice. Surfaced as stderr, never as APM state. */
  | { type: "diagnostic"; message: string };

// ── Driver → host messages ──

export interface CursorSdkHostAuthLease {
  /** Verified Cursor connection lease from the credential broker. */
  apiKey: string;
  backendUrl: string;
  connectionId: string;
  generation: number;
  principalId: string;
}

export interface CursorSdkRunOptions {
  /** Model id re-injected on EVERY submit (fresh and resumed runs). */
  model?: string;
  /** Managed MCP servers re-injected on every submit. */
  mcpServers?: Record<string, { url: string }>;
  /** Raft catalog reasoning effort from the agent config (host maps it to the model's own value). */
  reasoningEffort?: string;
  /** Fast-mode switch from the agent config. */
  fast?: boolean;
  maxTurns?: number;
  /**
   * Explicit settings-source policy forwarded to the SDK when supported.
   * Enterprise-managed mandatory settings must remain part of the SDK's own
   * resolution; this list only ADDS sources, never removes them.
   */
  settingSources?: string[];
}

export interface CursorSdkInitMessage {
  kind: "init";
  protocolVersion: number;
  agentId: string;
  /** Native resume target, or null for a fresh conversation. */
  sessionId: string | null;
  workspaceRoot: string;
  /**
   * User-data directory OUTSIDE the runtime assets where the host keeps its
   * single-writer lock and host state. Never inside the read-only asset tree.
   */
  hostDataDir: string;
  /** Credential lease. Absent lease must fail closed, not fall back. */
  auth: CursorSdkHostAuthLease | null;
  /** CLI-transport env (PATH with the per-agent `raft` wrapper, etc.). */
  env: Record<string, string>;
  runOptions: CursorSdkRunOptions;
  /**
   * Module specifier the host dynamically imports for the SDK. Defaults to
   * "@cursor/sdk"; the asset builder / tests may override with a file URL.
   * Deliberately data (not a static import): the host resolves the SDK from
   * the staged runtime-assets closure, not from daemon node_modules.
   */
  sdkModuleSpecifier: string;
}

export interface CursorSdkRunSubmitMessage {
  kind: "run_submit";
  /** Driver-owned opaque run id, echoed by `run_settled`. */
  runId: string;
  /** Parent-APM attempt watermark id, or null when the caller supplied none. */
  attemptId: string | null;
  text: string;
}

export interface CursorSdkSteerSubmitMessage {
  kind: "steer_submit";
  attemptId: string | null;
  text: string;
}

export interface CursorSdkStopMessage {
  kind: "stop";
  reason: string;
}

export type CursorSdkHostboundMessage =
  | CursorSdkInitMessage
  | CursorSdkRunSubmitMessage
  | CursorSdkSteerSubmitMessage
  | CursorSdkStopMessage;

// ── Host → driver messages ──

export interface CursorSdkHostReadyMessage {
  kind: "host_ready";
  protocolVersion: number;
}

export interface CursorSdkInitResultMessage {
  kind: "init_result";
  ok: boolean;
  /** Native session id when already known (resume), else null. */
  sessionId: string | null;
  error?: CursorSdkWireError;
}

/**
 * Terminal answer for one submitted attempt. `result`:
 * - `complete_delivered` → SDK consumed the attempt → outcome `delivered`.
 * - `revert`             → SDK busy semantics rejected it → outcome
 *                          `deferred_to_idle` (no runtime error UI).
 * - `failed`             → genuine delivery failure → `delivery_error`
 *                          ParsedEvent (source `cursor_sdk_response`).
 */
export interface CursorSdkAttemptResultMessage {
  kind: "attempt_result";
  /**
   * Attempt watermark id, or null when the submit carried none. Null-attempt
   * results never produce `delivery_outcome` (no invented APM debt); genuine
   * `failed` results still surface as `delivery_error`, and `revert` keeps
   * the existing turn.agent_busy debt semantics.
   */
  attemptId: string | null;
  result: "complete_delivered" | "revert" | "failed";
  error?: CursorSdkWireError;
}

export interface CursorSdkSessionInitMessage {
  kind: "session_init";
  sessionId: string;
}

export interface CursorSdkRunEventMessage {
  kind: "run_event";
  payload: CursorSdkRunEventPayload;
}

/**
 * The native run reached its terminal state AND its stream is fully drained.
 * Exactly the precondition the driver joins with ACK settlement to emit
 * exactly one Raft `turn_end`.
 */
export interface CursorSdkRunSettledMessage {
  kind: "run_settled";
  runId: string;
  finishReason: "completed" | "aborted" | "error";
  error?: CursorSdkWireError;
}

export interface CursorSdkHostLogMessage {
  kind: "host_log";
  level: "info" | "warn" | "error";
  message: string;
}

/**
 * Proof-bearing shutdown result. The driver may only report a clean stop when
 * this arrives; deadlines and forced kills say so honestly.
 */
export interface CursorSdkShutdownSettledMessage {
  kind: "shutdown_settled";
  outcome: "clean" | "deadline" | "forced";
}

export type CursorSdkHostToDriverMessage =
  | CursorSdkHostReadyMessage
  | CursorSdkInitResultMessage
  | CursorSdkAttemptResultMessage
  | CursorSdkSessionInitMessage
  | CursorSdkRunEventMessage
  | CursorSdkRunSettledMessage
  | CursorSdkHostLogMessage
  | CursorSdkShutdownSettledMessage;

// ── Wire guards ──
// Structural validation of untrusted IPC input. Bounded: guards check shape,
// never deep-validate payloads (mappers stay defensive for that).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxFactor = 16): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return Buffer.byteLength(value, "utf8") > CURSOR_SDK_WIRE_TEXT_MAX_BYTES * maxFactor ? null : value;
}

function isWireError(value: unknown): value is CursorSdkWireError {
  if (!isRecord(value)) return false;
  return boundedString(value["message"]) !== null;
}

export function isCursorSdkHostboundMessage(value: unknown): value is CursorSdkHostboundMessage {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "init":
      return (
        typeof value["protocolVersion"] === "number" &&
        boundedString(value["agentId"]) !== null &&
        typeof value["workspaceRoot"] === "string" &&
        typeof value["hostDataDir"] === "string" &&
        typeof value["env"] === "object" && value["env"] !== null &&
        typeof value["sdkModuleSpecifier"] === "string" &&
        (value["sessionId"] === null || typeof value["sessionId"] === "string")
      );
    case "run_submit":
      return (
        boundedString(value["runId"]) !== null &&
        (value["attemptId"] === null || typeof value["attemptId"] === "string") &&
        typeof value["text"] === "string"
      );
    case "steer_submit":
      return (
        (value["attemptId"] === null || typeof value["attemptId"] === "string") &&
        typeof value["text"] === "string"
      );
    case "stop":
      return typeof value["reason"] === "string";
    default:
      return false;
  }
}

export function isCursorSdkHostToDriverMessage(
  value: unknown,
): value is CursorSdkHostToDriverMessage {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "host_ready":
      return typeof value["protocolVersion"] === "number";
    case "init_result":
      return (
        typeof value["ok"] === "boolean" &&
        (value["sessionId"] === null || typeof value["sessionId"] === "string") &&
        (value["error"] === undefined || isWireError(value["error"]))
      );
    case "attempt_result":
      return (
        (value["attemptId"] === null || boundedString(value["attemptId"]) !== null) &&
        (value["result"] === "complete_delivered" ||
          value["result"] === "revert" ||
          value["result"] === "failed") &&
        (value["error"] === undefined || isWireError(value["error"]))
      );
    case "session_init":
      return boundedString(value["sessionId"]) !== null;
    case "run_event":
      return isRecord(value["payload"]) && typeof value["payload"]["type"] === "string";
    case "run_settled":
      return (
        boundedString(value["runId"]) !== null &&
        (value["finishReason"] === "completed" ||
          value["finishReason"] === "aborted" ||
          value["finishReason"] === "error") &&
        (value["error"] === undefined || isWireError(value["error"]))
      );
    case "host_log":
      return (
        (value["level"] === "info" || value["level"] === "warn" || value["level"] === "error") &&
        boundedString(value["message"]) !== null
      );
    case "shutdown_settled":
      return (
        value["outcome"] === "clean" ||
        value["outcome"] === "deadline" ||
        value["outcome"] === "forced"
      );
    default:
      return false;
  }
}

// ── Sanitization ──

/** Secret-shaped patterns that must never cross the wire or reach logs. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // Cursor/OpenAI-style keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /cursor-did-[^\s"']{8,}/gi,
];

/**
 * Sanitize arbitrary error/text data for the wire or stderr:
 * - stringify non-strings (dropping stacks),
 * - strip control characters,
 * - redact secret-shaped substrings,
 * - truncate to a bounded byte length (UTF-8 safe).
 */
export function sanitizeCursorSdkWireText(
  input: unknown,
  maxBytes: number = CURSOR_SDK_WIRE_TEXT_MAX_BYTES,
): string {
  if (input === undefined || input === null) return "unknown error";
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Error) {
    // Stack traces stay in the host; only the message crosses.
    text = `${input.name}: ${input.message}`;
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "unknown error";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  // Truncate on a UTF-8 boundary without splitting a code point.
  let cut = maxBytes;
  while (cut > 0 && Buffer.byteLength(text.slice(cut - 1, cut), "utf8") > 1 && cut < text.length) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}…[truncated ${bytes}B]`;
}

/** Build a sanitized wire error from anything thrown. */
export function toCursorSdkWireError(
  error: unknown,
  errorClass: CursorSdkWireErrorClass,
): CursorSdkWireError {
  return { message: sanitizeCursorSdkWireText(error), errorClass };
}

// ── ParsedEvent additions owned by the parent ──
// The parent owns `drivers/types.ts`; until the agreed additions land there,
// cursor-sdk emits them through these local structural types. They are
// intentionally assignment-compatible with the planned union members.

/**
 * Agreed ParsedEvent addition:
 * `{kind:"delivery_outcome"; source:"cursor_sdk"; attemptId; outcome}`.
 */
export interface CursorSdkDeliveryOutcomeEvent {
  kind: "delivery_outcome";
  source: "cursor_sdk";
  attemptId: string;
  outcome: CursorSdkAttemptOutcome;
}

/**
 * `delivery_error` with the agreed `cursor_sdk_response` source. Emitted only
 * for GENUINE delivery failures (never for SDK-busy reverts, which map to
 * `delivery_outcome: deferred_to_idle` without runtime error UI).
 */
export interface CursorSdkDeliveryErrorEvent {
  kind: "delivery_error";
  message: string;
  requestMethod: "turn/start" | "turn/steer";
  source: "cursor_sdk_response";
  code?: "turn.agent_busy" | "runtime.delivery_error";
  payloadBytes?: number;
}

/** Cursor-SDK-emitted ParsedEvent superset (existing union + agreed additions). */
export type CursorSdkParsedEvent =
  | import("../drivers/types.js").ParsedEvent
  | CursorSdkDeliveryOutcomeEvent
  | CursorSdkDeliveryErrorEvent;

/**
 * Narrow-to-ParsedEvent cast used at the single emission boundary. Once the
 * parent lands the union members in types.ts this cast becomes a no-op.
 */
export function cursorSdkEventAsParsedEvent(
  event: CursorSdkParsedEvent,
): import("../drivers/types.js").ParsedEvent {
  return event as import("../drivers/types.js").ParsedEvent;
}

/** Request-method label for attempts, used on delivery_error events. */
export function attemptRequestMethod(
  kind: "run_submit" | "steer_submit",
): "turn/start" | "turn/steer" {
  return kind === "run_submit" ? "turn/start" : "turn/steer";
}
