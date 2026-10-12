import assert from "node:assert/strict";
import { test } from "vitest";
import { analyzeTranscriptText, compareWake, weightedInputTokens } from "./wakeTokenReport.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-12T00:00:00Z");

function assistant(atMs: number, input: number, cacheRead: number, cacheCreation: number) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(atMs).toISOString(),
    message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 50 } },
  });
}
const user = (atMs: number) => JSON.stringify({ type: "user", timestamp: new Date(atMs).toISOString(), message: { content: "hi" } });

test("a cold wake reports the prior context and the first request after the gap; warm turns are not wakes", () => {
  const text = [
    assistant(T0, 10, 400_000, 1_000),
    user(T0 + 5 * 60_000),
    assistant(T0 + 6 * 60_000, 8, 401_000, 300),
    user(T0 + 3 * HOUR),
    assistant(T0 + 3 * HOUR + 4_000, 12, 5_000, 396_000),
  ].join("\n");
  const report = analyzeTranscriptText(text);
  assert.equal(report.records, 5);
  assert.equal(report.coldWakes.length, 1);
  const wake = report.coldWakes[0]!;
  assert.equal(wake.priorContextTokens, 401_308);
  assert.equal(wake.firstTurn?.cacheCreation, 396_000, "the 1h cache expired, so the resumed context is re-written");
  assert.ok(wake.idleMs > 2.5 * HOUR);
});

test("garbage lines and non-assistant records are skipped; no usage means no first turn", () => {
  const report = analyzeTranscriptText(["not json", "[]", user(T0), user(T0 + 2 * HOUR)].join("\n"));
  assert.equal(report.firstRequest, null);
  assert.equal(report.coldWakes.length, 1);
  assert.equal(report.coldWakes[0]!.firstTurn, null);
  assert.equal(report.coldWakes[0]!.priorContextTokens, null);
});

test("the recycled session's first request is compared with the resumed cold wake on weighted input tokens", () => {
  const before = analyzeTranscriptText([assistant(T0, 10, 400_000, 0), assistant(T0 + 2 * HOUR, 12, 0, 400_000)].join("\n")).coldWakes[0]!.firstTurn;
  const after = analyzeTranscriptText(assistant(T0 + 2 * HOUR, 20, 0, 42_000)).firstRequest;
  const cmp = compareWake(before, after);
  assert.equal(cmp.beforeContextTokens, 400_012);
  assert.equal(cmp.afterContextTokens, 42_020);
  assert.equal(cmp.beforeWeighted, weightedInputTokens(before!));
  assert.ok((cmp.weightedSavingsRatio ?? 0) > 0.89 && (cmp.weightedSavingsRatio ?? 0) < 0.9, "a 400k resumed cold wake vs a 42k fresh start saves about 89.5% of weighted input");
  assert.equal(compareWake(null, after).weightedSavingsRatio, null);
});
