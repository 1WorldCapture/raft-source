import { readFile } from "node:fs/promises";

/**
 * Token before/after evidence for the wake recycle (RFC 070): reads Claude session
 * transcripts (the same JSONL the recycle decision reads) and reports, for every cold
 * wake, how many input tokens the FIRST request after the wake cost and how large the
 * context was.
 *
 * - "before" = a RESUMED session: the first assistant record after an idle gap carries the
 *   old context again (mostly cache_creation, since the 1h cache expired).
 * - "after" = a RECYCLED session: a new transcript whose first assistant record carries only
 *   the fresh start (standing prompt + memory block + panel + the wake input).
 *
 * Everything is derived from `message.usage` records that are already on disk, so no new
 * instrumentation is needed. `weighted` converts to input-token equivalents with the
 * provider's published cache ratios (cache write 1.25x, cache read 0.1x, plain input 1x);
 * override with `weights` if the price list changes.
 */

export interface Usage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface ColdWake {
  /** Gap since the previous record, ms. */
  idleMs: number;
  /** ISO time of the first record after the gap. */
  wakeAt: string;
  /** Context size of the last request before the gap (input + cache_read + cache_creation). */
  priorContextTokens: number | null;
  /** Usage of the first assistant request after the gap. */
  firstTurn: Usage | null;
}

export interface TranscriptReport {
  records: number;
  /** First assistant request of the file (for a recycled/new session this IS the post-wake first turn). */
  firstRequest: Usage | null;
  coldWakes: ColdWake[];
}

export interface Weights { input: number; cacheRead: number; cacheCreation: number }
export const DEFAULT_WEIGHTS: Weights = { input: 1, cacheRead: 0.1, cacheCreation: 1.25 };
export const DEFAULT_COLD_GAP_MS = 60 * 60_000;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(record: Record<string, unknown>): Usage | null {
  if (record.type !== "assistant") return null;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const parsed = {
    input: finite(u.input_tokens),
    cacheRead: finite(u.cache_read_input_tokens),
    cacheCreation: finite(u.cache_creation_input_tokens),
    output: finite(u.output_tokens),
  };
  return parsed.input + parsed.cacheRead + parsed.cacheCreation > 0 ? parsed : null;
}

export function contextTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheCreation;
}

export function weightedInputTokens(usage: Usage, weights: Weights = DEFAULT_WEIGHTS): number {
  return usage.input * weights.input + usage.cacheRead * weights.cacheRead + usage.cacheCreation * weights.cacheCreation;
}

export function analyzeTranscriptText(text: string, coldGapMs: number = DEFAULT_COLD_GAP_MS): TranscriptReport {
  const report: TranscriptReport = { records: 0, firstRequest: null, coldWakes: [] };
  let previousAtMs: number | null = null;
  let lastContext: number | null = null;
  let pendingWake: ColdWake | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    report.records += 1;
    const atMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isFinite(atMs)) {
      if (previousAtMs !== null && atMs - previousAtMs > coldGapMs) {
        pendingWake = { idleMs: atMs - previousAtMs, wakeAt: new Date(atMs).toISOString(), priorContextTokens: lastContext, firstTurn: null };
        report.coldWakes.push(pendingWake);
      }
      previousAtMs = Math.max(previousAtMs ?? atMs, atMs);
    }
    const usage = usageOf(record);
    if (!usage) continue;
    if (!report.firstRequest) report.firstRequest = usage;
    if (pendingWake && !pendingWake.firstTurn) pendingWake.firstTurn = usage;
    lastContext = contextTokens(usage);
  }
  return report;
}

export async function analyzeTranscriptFile(path: string, coldGapMs?: number): Promise<TranscriptReport> {
  return analyzeTranscriptText(await readFile(path, "utf8"), coldGapMs);
}

export interface WakeComparison {
  beforeFirstTurn: Usage | null;
  afterFirstTurn: Usage | null;
  beforeContextTokens: number | null;
  afterContextTokens: number | null;
  beforeWeighted: number | null;
  afterWeighted: number | null;
  /** 1 - after/before on the weighted figure; null when either side is missing. */
  weightedSavingsRatio: number | null;
}

/** Compare the first request after a resumed cold wake with the first request of the recycled session. */
export function compareWake(before: Usage | null, after: Usage | null, weights: Weights = DEFAULT_WEIGHTS): WakeComparison {
  const beforeWeighted = before ? weightedInputTokens(before, weights) : null;
  const afterWeighted = after ? weightedInputTokens(after, weights) : null;
  return {
    beforeFirstTurn: before,
    afterFirstTurn: after,
    beforeContextTokens: before ? contextTokens(before) : null,
    afterContextTokens: after ? contextTokens(after) : null,
    beforeWeighted,
    afterWeighted,
    weightedSavingsRatio: beforeWeighted && afterWeighted !== null ? 1 - afterWeighted / beforeWeighted : null,
  };
}

function fmt(usage: Usage | null): string {
  return usage
    ? `input=${usage.input} cache_read=${usage.cacheRead} cache_creation=${usage.cacheCreation} (context ${contextTokens(usage)})`
    : "n/a";
}

export function formatReport(label: string, report: TranscriptReport): string {
  const lines = [`${label}: ${report.records} records, first request: ${fmt(report.firstRequest)}`];
  for (const wake of report.coldWakes) {
    lines.push(
      `  cold wake ${wake.wakeAt} after ${Math.round(wake.idleMs / 60_000)} min idle; prior context ${wake.priorContextTokens ?? "n/a"}; first turn ${fmt(wake.firstTurn)}`
        + (wake.firstTurn ? `; weighted ${Math.round(weightedInputTokens(wake.firstTurn))}` : ""),
    );
  }
  return lines.join("\n");
}
