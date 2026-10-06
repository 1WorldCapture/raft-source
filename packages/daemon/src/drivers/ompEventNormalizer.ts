// OMP RPC event → ParsedEvent mapping (phase-1 task #3).
//
// Modeled on the pi SDK mapping (pi.ts mapPiSdkEventToParsedEvents): a
// per-session state object buffers thinking/text deltas per content index,
// announces a block with an empty event on its first delta, and closes it with
// the buffered (or declared) full text on *_end. Turn ends differ from pi: omp
// has no agent_settled — a turn closes exactly once, driven by prompt_result
// (sessionSettled) and session_settled, never early on agent_end with
// yielded=false / awaitingAsyncWork (background work may still wake the run).
//
// advisor_*, subagent_*, btw_*, live_*, and friends are deliberately unmapped
// in phase 1; the driver logs dropped categories at debug level.

import { normalizeRuntimeCompactionReason } from "../runtimeCompactionProjection.js";
import type { ParsedEvent } from "./types.js";

/** Result text longer than this is truncated (with an ellipsis marker). */
export const OMP_TOOL_OUTPUT_TEXT_LIMIT = 32_000;

export interface OmpEventMappingState {
  pendingTurnEnd: boolean;
  turnClosed: boolean;
  pendingProviderError: string | null;
  providerErrorOwnedByCompaction: boolean;
  thinkingBuffers: Map<number, string>;
  announcedThinkingIndexes: Set<number>;
  textBuffers: Map<number, string>;
  announcedTextIndexes: Set<number>;
}

export function createOmpEventMappingState(): OmpEventMappingState {
  return {
    pendingTurnEnd: false,
    turnClosed: false,
    pendingProviderError: null,
    providerErrorOwnedByCompaction: false,
    thinkingBuffers: new Map(),
    announcedThinkingIndexes: new Set(),
    textBuffers: new Map(),
    announcedTextIndexes: new Set(),
  };
}

type WireFrame = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentIndexOf(event: Record<string, unknown>): number {
  return typeof event.contentIndex === "number" ? event.contentIndex : 0;
}

/**
 * Flatten a tool result payload into display text. omp results are either
 * strings or pi-shaped content block arrays ({ type: "text", text }).
 */
export function ompToolResultText(result: unknown, limit = OMP_TOOL_OUTPUT_TEXT_LIMIT): string | undefined {
  let text: string | undefined;
  if (typeof result === "string") {
    text = result;
  } else if (Array.isArray(result)) {
    text = textFromContentBlocks(result);
  } else if (isRecord(result)) {
    if (typeof result.content === "string") {
      text = result.content;
    } else if (Array.isArray(result.content)) {
      text = textFromContentBlocks(result.content);
    }
  }
  if (text === undefined || text.length === 0) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}

function textFromContentBlocks(blocks: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function assistantUsageAttrs(message: Record<string, unknown>): Record<string, number> {
  const usage = isRecord(message.usage) ? message.usage : null;
  if (!usage) return {};
  const attrs: Record<string, number> = {};
  const numeric = (key: string): void => {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) attrs[key] = value;
  };
  numeric("input");
  numeric("output");
  numeric("cacheRead");
  numeric("cacheWrite");
  numeric("totalTokens");
  numeric("reasoningTokens");
  const cost = isRecord(usage.cost) ? usage.cost : null;
  if (cost && typeof cost.total === "number" && Number.isFinite(cost.total)) {
    attrs.costTotal = cost.total;
  }
  return attrs;
}

/**
 * Map one decoded omp RPC frame to ParsedEvents. Transport frames (ready,
 * response, negotiate, chunks) are handled by the driver and never reach here.
 */
export function mapOmpRpcFrameToParsedEvents(frame: object, state: OmpEventMappingState): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const type = (frame as WireFrame).type;

  switch (type) {
    case "message_start":
    case "message_update": {
      const message = (frame as WireFrame).message;
      if (!isRecord(message) || message.role !== "assistant") return events;
      const update = (frame as WireFrame).assistantMessageEvent;
      if (!isRecord(update)) return events;
      events.push(...mapAssistantMessageEvent(update, state));
      return events;
    }
    case "message_end": {
      const message = (frame as WireFrame).message;
      if (!isRecord(message)) return events;
      if (message.role !== "assistant") return events;

      // Usage telemetry: mark-absent, never zero-filled.
      const usageAttrs = assistantUsageAttrs(message);
      if (Object.keys(usageAttrs).length > 0) {
        events.push({
          kind: "telemetry",
          name: "token_usage",
          source: "omp_message_end_usage",
          usageKind: "per_turn",
          attrs: usageAttrs,
        });
      }

      if (message.stopReason === "error") {
        // A provider rejection here must not terminalize the daemon before
        // compaction / retry can recover: hold it and let auto_retry_end or
        // the compaction outcome decide, mirroring the pi mapping.
        state.pendingProviderError = typeof message.errorMessage === "string" && message.errorMessage.trim()
          ? message.errorMessage.trim()
          : "OMP assistant turn ended with an unknown provider error";
      }
      return events;
    }
    case "tool_execution_start": {
      const wire = frame as WireFrame;
      const toolName = typeof wire.toolName === "string" ? wire.toolName : "unknown_tool";
      events.push({
        kind: "tool_call",
        name: toolName,
        input: wire.args ?? {},
      });
      return events;
    }
    case "tool_execution_end": {
      const wire = frame as WireFrame;
      const toolName = typeof wire.toolName === "string" ? wire.toolName : "unknown_tool";
      const text = ompToolResultText(wire.result);
      events.push({
        kind: "tool_output",
        name: toolName,
        ...(text !== undefined ? { text } : {}),
        ...(wire.isError === true ? { isError: true } : {}),
      });
      return events;
    }
    case "tool_execution_update":
    case "tool_stream_update":
      return events;
    case "auto_compaction_start": {
      events.push({ kind: "compaction_started" });
      return events;
    }
    case "auto_compaction_end": {
      const aborted = (frame as WireFrame).aborted === true;
      if (aborted) {
        events.push({ kind: "compaction_interrupted", outcome: "aborted", reason: normalizeRuntimeCompactionReason((frame as WireFrame).reason) });
        return events;
      }
      if ((frame as WireFrame).result === undefined && (frame as WireFrame).errorMessage !== undefined) {
        events.push({
          kind: "compaction_interrupted",
          outcome: "compaction_failed_or_exhausted",
          reason: normalizeRuntimeCompactionReason((frame as WireFrame).reason),
        });
        return events;
      }
      events.push({ kind: "compaction_finished" });
      return events;
    }
    case "auto_retry_start":
      return events;
    case "auto_retry_end": {
      const wire = frame as WireFrame;
      if (wire.success === true) {
        // The retry succeeded; only this lifecycle event authorizes dropping
        // the buffered provider failure (pi parity).
        state.pendingProviderError = null;
        state.providerErrorOwnedByCompaction = false;
        return events;
      }
      if (state.providerErrorOwnedByCompaction) {
        state.providerErrorOwnedByCompaction = false;
        return events;
      }
      const finalError = typeof wire.finalError === "string" ? wire.finalError.trim() : "";
      events.push({
        kind: "error",
        message: finalError
          || state.pendingProviderError
          || "OMP assistant turn ended with an unknown provider error",
      });
      state.pendingProviderError = null;
      return events;
    }
    case "retry_fallback_applied":
    case "retry_fallback_succeeded": {
      const wire = frame as WireFrame;
      const from = typeof wire.from === "string" ? wire.from : "unknown";
      const to = typeof wire.to === "string" ? wire.to : "unknown";
      events.push({
        kind: "runtime_diagnostic",
        severity: "warning",
        source: "omp_rpc_notification",
        itemType: String(type),
        message: `Model fallback ${type === "retry_fallback_applied" ? "applied" : "succeeded"}: ${from} → ${to}`,
      });
      return events;
    }
    case "agent_start": {
      // A new run reopens the turn machine. pendingTurnEnd is deliberately
      // preserved: a held turn (sessionSettled=false) flushes on
      // session_settled, and per the protocol a background follow-up run's
      // agent_start arrives BEFORE that flush — clearing the pending end here
      // would strand the turn.
      state.turnClosed = false;
      return events;
    }
    case "prompt_result": {
      const agentInvoked = (frame as WireFrame).agentInvoked === true;
      if (!agentInvoked) {
        // Local-only completion (slash command finished without a run): not a
        // turn, so no turn events. An error still surfaces.
        const error = (frame as WireFrame).error;
        if ((frame as WireFrame).status === "error" && isRecord(error) && typeof error.message === "string") {
          events.push({ kind: "error", message: error.message });
        }
        return events;
      }
      // Exactly one turn_end per turn: sessionSettled=true closes now, false
      // holds for session_settled (background work may still wake the run).
      if (state.turnClosed) return events;
      state.pendingTurnEnd = true;
      const error = (frame as WireFrame).error;
      if ((frame as WireFrame).status === "error" && isRecord(error) && typeof error.message === "string") {
        events.push({ kind: "error", message: error.message });
      } else if ((frame as WireFrame).status === "aborted") {
        events.push({ kind: "error", message: "OMP turn aborted" });
      }
      if ((frame as WireFrame).sessionSettled === true) {
        state.pendingTurnEnd = false;
        state.turnClosed = true;
        events.push({ kind: "turn_end" });
      }
      return events;
    }
    case "session_settled": {
      if (state.pendingTurnEnd) {
        state.pendingTurnEnd = false;
        state.turnClosed = true;
        events.push({ kind: "turn_end" });
      }
      return events;
    }
    case "agent_end": {
      // Turn ends are owned by prompt_result/session_settled. yielded=false
      // (retry / compaction continuation) and awaitingAsyncWork=true must not
      // close anything early; terminal yielded ends wait for prompt_result.
      return events;
    }
    case "notice": {
      const wire = frame as WireFrame;
      if (wire.level === "error") {
        const message = typeof wire.message === "string" ? wire.message : "OMP notice";
        events.push({ kind: "error", message });
      }
      return events;
    }
    // Lifecycle noise and phase-1 log-only categories (advisor, subagents,
    // side questions, live voice, command side channels) map to nothing; the
    // driver logs the dropped types at debug level.
    default:
      return events;
  }
}

function mapAssistantMessageEvent(update: Record<string, unknown>, state: OmpEventMappingState): ParsedEvent[] {
  const index = contentIndexOf(update);
  switch (update.type) {
    case "thinking_start": {
      state.thinkingBuffers.delete(index);
      const events: ParsedEvent[] = [];
      if (!state.announcedThinkingIndexes.has(index)) {
        state.announcedThinkingIndexes.add(index);
        events.push({ kind: "thinking", text: "" });
      }
      return events;
    }
    case "thinking_delta": {
      const events: ParsedEvent[] = [];
      if (!state.announcedThinkingIndexes.has(index)) {
        state.announcedThinkingIndexes.add(index);
        events.push({ kind: "thinking", text: "" });
      }
      if (typeof update.delta === "string" && update.delta.length > 0) {
        state.thinkingBuffers.set(index, `${state.thinkingBuffers.get(index) ?? ""}${update.delta}`);
      }
      return events;
    }
    case "thinking_end": {
      const buffered = state.thinkingBuffers.get(index) ?? "";
      const text = typeof update.content === "string" && update.content.length > 0 ? update.content : buffered;
      state.thinkingBuffers.delete(index);
      state.announcedThinkingIndexes.delete(index);
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "text_start": {
      state.textBuffers.delete(index);
      const events: ParsedEvent[] = [];
      if (!state.announcedTextIndexes.has(index)) {
        state.announcedTextIndexes.add(index);
        events.push({ kind: "text", text: "" });
      }
      return events;
    }
    case "text_delta": {
      const events: ParsedEvent[] = [];
      if (!state.announcedTextIndexes.has(index)) {
        state.announcedTextIndexes.add(index);
        events.push({ kind: "text", text: "" });
      }
      if (typeof update.delta === "string" && update.delta.length > 0) {
        state.textBuffers.set(index, `${state.textBuffers.get(index) ?? ""}${update.delta}`);
      }
      return events;
    }
    case "text_end": {
      const buffered = state.textBuffers.get(index) ?? "";
      const text = typeof update.content === "string" && update.content.length > 0 ? update.content : buffered;
      state.textBuffers.delete(index);
      state.announcedTextIndexes.delete(index);
      return text ? [{ kind: "text", text }] : [];
    }
    case "error": {
      const error = isRecord(update.error) ? update.error : {};
      const message = typeof error.errorMessage === "string" && error.errorMessage.trim()
        ? error.errorMessage.trim()
        : "OMP assistant stream error";
      return [{ kind: "error", message }];
    }
    case "start":
    case "done":
    case "image_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return [];
    default:
      return [];
  }
}

/**
 * Close a turn when the process dies with a settled-pending turn (PM task #3:
 * an interrupted turn must end exactly once, with an error and a turn_end —
 * never left hanging). Open means prompt_result confirmed agent work whose
 * session_settled never arrived. No-op when nothing is open or already closed.
 * Task #4 wires this into the turn layer; it lives here so the exactly-once
 * rule is testable against synthetic frames.
 */
export function closeOmpTurnOnProcessExit(state: OmpEventMappingState, reason: string): ParsedEvent[] {
  if (state.turnClosed || !state.pendingTurnEnd) return [];
  state.turnClosed = true;
  state.pendingTurnEnd = false;
  return [
    { kind: "error", message: `OMP process exited before the turn settled: ${reason}` },
    { kind: "turn_end" },
  ];
}
