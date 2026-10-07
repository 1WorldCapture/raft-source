import type { ParsedEvent } from "../drivers/types.js";
import {
  type CursorSdkParsedEvent,
  type CursorSdkRunEventPayload,
  type CursorSdkUsageAttrs,
} from "./protocol.js";

/**
 * Closed mapping from normalized Cursor SDK host events → Raft ParsedEvents.
 *
 * RS-004 closed-mapping discipline (mirrors `kimi-sdk.ts`): every member of
 * {@link CursorSdkRunEventPayload} maps to at most one ParsedEvent kind OR is
 * explicitly dropped. The default branch is a compile-time exhaustiveness
 * check so an upstream payload addition fails closed here.
 *
 * Turn boundaries are NOT produced by this mapper. Exactly one `turn_end` per
 * run is emitted by the session's settlement logic, which joins "native run
 * terminal + stream drained" (`run_settled`) with "ACK settled/unknown" — a
 * conjunction no single stream event can prove.
 */
export interface CursorSdkEventMappingState {
  sessionId: string | null;
  sessionAnnounced: boolean;
}

export function createCursorSdkEventMappingState(
  sessionId: string | null = null,
): CursorSdkEventMappingState {
  return { sessionId, sessionAnnounced: false };
}

/**
 * Announce `session_init` at most once per session id change. Returns the
 * events to emit (possibly empty) and mutates state.
 */
export function announceCursorSdkSessionInit(
  state: CursorSdkEventMappingState,
  sessionId: string,
): ParsedEvent[] {
  if (state.sessionAnnounced && state.sessionId === sessionId) return [];
  state.sessionId = sessionId;
  state.sessionAnnounced = true;
  return [{ kind: "session_init", sessionId }];
}

/** Bounded numeric extraction for usage attrs; never forwards raw objects. */
function usageAttrNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

const USAGE_ATTR_WHITELIST: readonly string[] = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "total_tokens",
  "turns_used",
  "max_turns",
  "cost_usd",
];

function mapUsagePayload(
  attrs: CursorSdkUsageAttrs,
  usageKind: "cumulative_session" | "per_turn" | "unknown" | undefined,
  state: CursorSdkEventMappingState,
): CursorSdkParsedEvent[] {
  const out: Record<string, string | number | boolean> = {};
  for (const key of USAGE_ATTR_WHITELIST) {
    const value = attrs[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length <= 64) out[key] = value;
  }
  if (Object.keys(out).length === 0) return [];
  return [
    {
      kind: "telemetry",
      name: "token_usage",
      source: "cursor_sdk",
      usageKind: usageKind ?? "unknown",
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      attrs: out,
    },
  ];
}

/**
 * Map one normalized run stream payload. Never throws on malformed input:
 * unknown shapes degrade to zero events (the session routes diagnostics to
 * stderr separately).
 */
export function mapCursorSdkRunEventPayload(
  payload: CursorSdkRunEventPayload,
  state: CursorSdkEventMappingState,
): CursorSdkParsedEvent[] {
  switch (payload.type) {
    // ── explicit drop ──
    // The current SDK echoes the submitted user turn back into the stream.
    // It is delivery feedback, not new user input: mapping it into any
    // trajectory-level event risks re-entering it as another user message on
    // downstream consumers. Drop with the payload size recorded nowhere but
    // the host's own accounting.
    case "user_echo":
      return [];

    // ── content streaming → ParsedEvent ──
    case "assistant_text":
      if (typeof payload.text === "string" && payload.text.length > 0) {
        return [{ kind: "text", text: payload.text }];
      }
      return [];
    case "assistant_thinking":
      if (typeof payload.text === "string" && payload.text.length > 0) {
        return [{ kind: "thinking", text: payload.text }];
      }
      return [];
    case "tool_call":
      return [
        {
          kind: "tool_call",
          name: (typeof payload.name === "string" && payload.name) || "unknown_tool",
          input: payload.input ?? {},
        },
      ];
    case "tool_result":
      return [{ kind: "tool_output", name: payload.name || "" }];

    // ── telemetry sidecar ──
    case "usage":
      return mapUsagePayload(payload.attrs, payload.usageKind, state);

    // ── explicit drop ──
    // Non-terminal SDK notices have no cursor_sdk-compatible diagnostic
    // ParsedEvent yet (runtime_diagnostic's source union is closed to other
    // runtimes). The session surfaces them on stderr; they must not refresh
    // progress or satisfy readiness.
    case "diagnostic":
      return [];

    default: {
      // Compile-time exhaustiveness. A new payload type without a deliberate
      // mapping decision must fail the build, not silently vanish.
      const _exhaustive: never = payload;
      void _exhaustive;
      return [];
    }
  }
}

/**
 * Defensive variant for untrusted wire input: validates the payload shape
 * before mapping. Used by the session on raw IPC `run_event` messages.
 */
export function mapCursorSdkRunEventWirePayload(
  payload: unknown,
  state: CursorSdkEventMappingState,
): CursorSdkParsedEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  switch (record["type"]) {
    case "user_echo":
      return mapCursorSdkRunEventPayload({ type: "user_echo", payloadBytes: 0 }, state);
    case "assistant_text":
    case "assistant_thinking":
      if (typeof record["text"] !== "string") return [];
      return mapCursorSdkRunEventPayload(
        { type: record["type"], text: record["text"] },
        state,
      );
    case "tool_call":
      return mapCursorSdkRunEventPayload(
        {
          type: "tool_call",
          name: typeof record["name"] === "string" ? record["name"] : "",
          input: record["input"],
        },
        state,
      );
    case "tool_result":
      return mapCursorSdkRunEventPayload(
        {
          type: "tool_result",
          name: typeof record["name"] === "string" ? record["name"] : "",
          ...(typeof record["payloadBytes"] === "number" ? { payloadBytes: record["payloadBytes"] } : {}),
        },
        state,
      );
    case "usage": {
      const rawAttrs = record["attrs"];
      if (typeof rawAttrs !== "object" || rawAttrs === null) return [];
      const attrs: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(rawAttrs)) {
        if (
          (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean" ||
          (typeof value === "string" && value.length <= 64)
        ) {
          attrs[key] = value;
        }
      }
      const usageKind =
        record["usageKind"] === "cumulative_session" ||
        record["usageKind"] === "per_turn" ||
        record["usageKind"] === "unknown"
          ? record["usageKind"]
          : undefined;
      return mapCursorSdkRunEventPayload({ type: "usage", attrs, ...(usageKind ? { usageKind } : {}) }, state);
    }
    case "diagnostic":
      return [];
    default:
      return [];
  }
}
