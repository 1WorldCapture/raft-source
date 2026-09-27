import assert from "node:assert/strict";
import test from "node:test";
import { boardSummaryLine, type BoardSummaryStrings } from "./boardSummary.ts";
import type { TaskActivity } from "./board.ts";

const STRINGS: BoardSummaryStrings = {
  updatedTask: "updated the task",
  createdAgo: (time) => `Created ${time}`,
  systemActor: "System",
};

// formatRelativeTime reads the wall clock (Date.now via the shared clock);
// pin it so "5 minutes ago" is stable regardless of when tests run.
const NOW = new Date("2026-09-27T12:00:00.000Z").getTime();

function activity(overrides: Partial<TaskActivity> = {}): TaskActivity {
  return {
    kind: "reply",
    at: "2026-09-27T11:55:00.000Z",
    actorType: "agent",
    actorId: "a1",
    actorName: "Dev",
    snippet: "fixed the build",
    eventType: null,
    ...overrides,
  };
}

test("reply summary reads Name · relative time : snippet", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const line = boardSummaryLine(activity(), "2026-09-27T08:00:00.000Z", "en", STRINGS);
  assert.equal(line, "Dev · 5 minutes ago: fixed the build");
});

test("zh locale gets full-width colon and spaced relative time", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const line = boardSummaryLine(activity(), "2026-09-27T08:00:00.000Z", "zh", STRINGS);
  assert.equal(line, "Dev · 5 分钟前：fixed the build");
});

test("task events fall back to the updated-task label", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const line = boardSummaryLine(
    activity({ kind: "task_event", snippet: null, eventType: "status_changed" }),
    "2026-09-27T08:00:00.000Z",
    "en",
    STRINGS,
  );
  assert.equal(line, "Dev · 5 minutes ago: updated the task");
});

test("system actor without a name uses the system label", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const line = boardSummaryLine(activity({ actorType: "system", actorName: null }), "2026-09-27T08:00:00.000Z", "en", STRINGS);
  assert.equal(line, "System · 5 minutes ago: fixed the build");
});

test("no activity yet falls back to Created <relative time of createdAt>", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const line = boardSummaryLine(null, "2026-09-27T11:00:00.000Z", "en", STRINGS);
  assert.equal(line, "Created 1 hour ago");
});

test("an unusable activity timestamp yields null rather than a broken line", (t) => {
  t.mock.method(Date, "now", () => NOW);
  assert.equal(boardSummaryLine(activity({ at: "bogus" }), "2026-09-27T11:00:00.000Z", "en", STRINGS), null);
});
