#!/usr/bin/env node
// Usage (from packages/daemon):
//   npx tsx src/wakeTokenReportCli.ts <resumed-transcript.jsonl> [<recycled-transcript.jsonl>] [--cold-gap-min=60]
// Prints each cold wake of the first transcript (the "before": a resumed session) and, when a second
// transcript is given, the weighted first-turn comparison against the recycled session ("after").
import { DEFAULT_COLD_GAP_MS, analyzeTranscriptFile, compareWake, formatReport } from "./wakeTokenReport.js";

const args = process.argv.slice(2);
const gapArg = args.find((arg) => arg.startsWith("--cold-gap-min="));
const coldGapMs = gapArg ? Number(gapArg.split("=")[1]) * 60_000 : DEFAULT_COLD_GAP_MS;
const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length === 0 || !Number.isFinite(coldGapMs)) {
  console.error("usage: wakeTokenReportCli <resumed.jsonl> [<recycled.jsonl>] [--cold-gap-min=60]");
  process.exit(2);
}
const before = await analyzeTranscriptFile(files[0]!, coldGapMs);
console.log(formatReport("resumed (before)", before));
if (files[1]) {
  const after = await analyzeTranscriptFile(files[1], coldGapMs);
  console.log(formatReport("recycled (after)", after));
  const firstColdWake = before.coldWakes.find((wake) => wake.firstTurn)?.firstTurn ?? null;
  const cmp = compareWake(firstColdWake, after.firstRequest);
  console.log(JSON.stringify(cmp, null, 2));
}
