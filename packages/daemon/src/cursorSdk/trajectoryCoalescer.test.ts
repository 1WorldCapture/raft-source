import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TRAJECTORY_HARD_CAP_MS,
  TRAJECTORY_MAX_CHARS,
  TRAJECTORY_QUIET_MS,
  TrajectoryCoalescer,
  endsAtBoundary,
  isBlankTrajectoryText,
} from "./trajectoryCoalescer.js";

function harness() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const out: Array<[string, string]> = [];
  const coalescer = new TrajectoryCoalescer({
    emit: (kind, text) => out.push([kind, text]),
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = target;
  };
  return { coalescer, out, advance, timers };
}

test("a sentence split by gaps longer than the old 350 ms window becomes one block", () => {
  const h = harness();
  h.coalescer.push("thinking", "I'll read the new PM message from the Raft thread where I was");
  h.advance(600);
  h.coalescer.push("thinking", " mentioned.");
  assert.deepEqual(h.out, [], "nothing visible while the sentence is still arriving");
  h.advance(TRAJECTORY_QUIET_MS);
  assert.deepEqual(h.out, [["thinking", "I'll read the new PM message from the Raft thread where I was mentioned."]]);
});

test("quiet in the middle of a sentence waits; the hard cap flushes it", () => {
  const h = harness();
  h.coalescer.push("text", "and then the plan is to");
  h.advance(TRAJECTORY_QUIET_MS + 10);
  assert.deepEqual(h.out, [], "no boundary: keep waiting");
  h.advance(TRAJECTORY_HARD_CAP_MS);
  assert.deepEqual(h.out, [["text", "and then the plan is to"]]);
});

test("a kind change flushes the previous block first", () => {
  const h = harness();
  h.coalescer.push("thinking", "pondering");
  h.coalescer.push("text", "answer");
  assert.deepEqual(h.out, [["thinking", "pondering"]]);
  h.coalescer.flush();
  assert.deepEqual(h.out, [["thinking", "pondering"], ["text", "answer"]]);
});

test("explicit flush (tool call, turn end) emits immediately and is idempotent", () => {
  const h = harness();
  h.coalescer.push("text", "partial without punctuation");
  h.coalescer.flush();
  h.coalescer.flush();
  assert.deepEqual(h.out, [["text", "partial without punctuation"]]);
  assert.equal(h.coalescer.pending, false);
  assert.equal(h.timers.size, 0, "no timer leaks after a flush");
});

test("blank, whitespace-only and ellipsis-only blocks are dropped; edges are trimmed", () => {
  const h = harness();
  for (const junk of ["\n\n", "  ", "…", "...", " … \n", "·"]) {
    h.coalescer.push("thinking", junk);
    h.coalescer.flush();
  }
  assert.deepEqual(h.out, []);
  h.coalescer.push("thinking", "\n\n  No reply is needed.\n");
  h.coalescer.flush();
  assert.deepEqual(h.out, [["thinking", "No reply is needed."]]);
  assert.equal(isBlankTrajectoryText("a"), false);
  assert.equal(isBlankTrajectoryText("…ok"), false);
});

test("chunks are joined verbatim (spaces between words survive)", () => {
  const h = harness();
  for (const chunk of ["The", " PM", " message", " does", " not", " need", " a", " reply."]) h.coalescer.push("text", chunk);
  h.coalescer.flush();
  assert.deepEqual(h.out, [["text", "The PM message does not need a reply."]]);
});

test("reaching the size cap flushes at once", () => {
  const h = harness();
  h.coalescer.push("text", "x".repeat(TRAJECTORY_MAX_CHARS));
  assert.equal(h.out.length, 1);
  assert.equal(h.out[0]?.[1].length, TRAJECTORY_MAX_CHARS);
});

test("endsAtBoundary: line breaks, Latin and CJK sentence ends, closing quotes", () => {
  for (const ok of ["done.", "really?", "好的。", "完成！", "line\n", "he said \"ok.\"", "wait…"]) assert.equal(endsAtBoundary(ok), true, ok);
  for (const no of ["and then", "x,"]) assert.equal(endsAtBoundary(no), false, no);
});

test("dispose drops the buffer without emitting", () => {
  const h = harness();
  h.coalescer.push("text", "never shown");
  h.coalescer.dispose();
  h.advance(TRAJECTORY_HARD_CAP_MS * 2);
  assert.deepEqual(h.out, []);
});
