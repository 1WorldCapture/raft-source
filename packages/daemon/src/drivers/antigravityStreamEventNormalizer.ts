import type { ParsedEvent } from "./types.js";

const PRINT_TIMEOUT_RE = /print timeout/i;

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  seen: boolean;
};

const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["thinking_tokens", "thinkingTokens"],
  ["cache_read_tokens", "cachedInputTokens"],
  ["total_tokens", "totalTokens"],
] as const;

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    seen: false,
  };
}

function addUsage(totals: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const record = usage as Record<string, unknown>;
  for (const [wireKey, attrKey] of USAGE_FIELDS) {
    const value = record[wireKey];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    totals[attrKey] += value;
    totals.seen = true;
  }
}

function telemetryEvent(totals: UsageTotals, sessionId: string | null): ParsedEvent | null {
  if (!totals.seen) return null;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "antigravity_stream_step_usage",
    usageKind: "per_turn",
    ...(sessionId ? { sessionId } : {}),
    attrs: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      thinkingTokens: totals.thinkingTokens,
      cachedInputTokens: totals.cachedInputTokens,
      totalTokens: totals.totalTokens,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Maps agy 1.3.2 stream-json stdout into ParsedEvents.
 *
 * Step `usage` is the latest snapshot for that `step_index`, not a delta.
 * ACTIVE and DONE for the same index must not both be added. `result.usage`
 * is cumulative for the process, so a turn's telemetry sums the kept step
 * snapshots only.
 */
export class AntigravityStreamEventNormalizer {
  private sessionId: string | null = null;
  /** Last usage object seen for each step_index in the open turn. */
  private stepUsage = new Map<number, Record<string, unknown>>();
  /** Usage on a step_update that did not carry a step_index. */
  private anonymousUsage: Record<string, unknown>[] = [];
  private printTimeoutEmitted = false;
  private turnClosed = false;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get sawPrintTimeout(): boolean {
    return this.printTimeoutEmitted;
  }

  noteStderr(text: string): ParsedEvent[] {
    if (this.printTimeoutEmitted || !PRINT_TIMEOUT_RE.test(text)) return [];
    this.printTimeoutEmitted = true;
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => PRINT_TIMEOUT_RE.test(entry));
    const events: ParsedEvent[] = [];
    const telemetry = this.takeTurnTelemetry();
    if (telemetry) events.push(telemetry);
    events.push({ kind: "error", message: line || text.trim() });
    const end = this.endTurn();
    if (end) events.push(end);
    return events;
  }

  normalizeLine(line: string): ParsedEvent[] {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const record = asRecord(event);
    if (!record) return [];

    const kind = asString(record.event);
    if (kind === "init") return this.normalizeInit(record);
    if (kind === "step_update") return this.normalizeStep(record);
    if (kind === "result") return this.normalizeResult(record);
    return [];
  }

  private rememberSession(sessionId: string | null): void {
    if (sessionId) this.sessionId = sessionId;
  }

  private normalizeInit(record: Record<string, unknown>): ParsedEvent[] {
    const sessionId = asString(record.conversation_id);
    this.rememberSession(sessionId);
    return sessionId ? [{ kind: "session_init", sessionId }] : [];
  }

  private normalizeStep(record: Record<string, unknown>): ParsedEvent[] {
    const step = asRecord(record.step_update);
    if (!step) return [];
    this.rememberSession(asString(step.conversation_id));
    const stepType = asString(step.step_type);
    if (stepType === "system_message") return [];
    if (stepType === "user_input") {
      if (this.turnClosed) this.printTimeoutEmitted = false;
      this.clearStepUsage();
      this.turnClosed = false;
      return [];
    }

    if (this.turnClosed) {
      this.clearStepUsage();
      this.turnClosed = false;
    }

    this.noteStepUsage(step);

    if (stepType === "agent_response") {
      const text = asString(step.text_delta);
      return text ? [{ kind: "text", text }] : [];
    }

    if (stepType === "tool") {
      const toolInfo = asRecord(step.tool_info);
      const name = asString(step.tool_name) || asString(toolInfo?.name) || "tool";
      const state = asString(step.state);
      if (state === "DONE") {
        const output = asString(toolInfo?.output);
        return [{
          kind: "tool_output",
          name,
          ...(output !== null ? { text: output } : {}),
        }];
      }
      if (state === "ACTIVE") {
        return [{
          kind: "tool_call",
          name,
          input: toolInfo?.parameters ?? {},
        }];
      }
    }

    return [];
  }

  private normalizeResult(record: Record<string, unknown>): ParsedEvent[] {
    const result = asRecord(record.result);
    if (!result) return [];
    const sessionId = asString(result.conversation_id);
    this.rememberSession(sessionId);
    // A print-timeout already closed this turn from stderr. result.usage is
    // cumulative and this SUCCESS is not a normal completion.
    if (this.printTimeoutEmitted) {
      this.clearStepUsage();
      return [];
    }

    const events: ParsedEvent[] = [];
    const telemetry = this.takeTurnTelemetry();
    if (telemetry) events.push(telemetry);

    // result.usage is cumulative for the whole process. The turn total is the
    // step accumulator above; adding result.usage would count earlier turns again.
    const status = asString(result.status);
    if (status === "ERROR") {
      const message = asString(result.error)?.trim() || "agy result error";
      events.push({ kind: "error", message });
    }

    const end = this.endTurn();
    if (end) events.push(end);
    return events;
  }

  private noteStepUsage(step: Record<string, unknown>): void {
    const usage = asRecord(step.usage);
    if (!usage) return;
    const index = step.step_index;
    if (typeof index === "number" && Number.isInteger(index)) {
      this.stepUsage.set(index, usage);
      return;
    }
    this.anonymousUsage.push(usage);
  }

  private clearStepUsage(): void {
    this.stepUsage.clear();
    this.anonymousUsage = [];
  }

  private takeTurnTelemetry(): ParsedEvent | null {
    const totals = emptyTotals();
    for (const usage of this.stepUsage.values()) addUsage(totals, usage);
    for (const usage of this.anonymousUsage) addUsage(totals, usage);
    this.clearStepUsage();
    return telemetryEvent(totals, this.sessionId);
  }

  private endTurn(): ParsedEvent | null {
    if (this.turnClosed) return null;
    this.turnClosed = true;
    return {
      kind: "turn_end",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }
}
