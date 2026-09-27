import assert from "node:assert/strict";
import test from "node:test";
import { boardSummaryLine, type BoardSummaryStrings } from "./boardSummary.ts";
import type { RelativeTimeStrings } from "./relativeTime.ts";
import type { TaskActivity } from "./board.ts";

const STRINGS: BoardSummaryStrings = {
  updatedTask: "updated the task",
  createdAgo: (time) => `Created ${time}`,
  systemActor: "System",
};

const EN: RelativeTimeStrings = {
  justNow: "just now",
  minutesAgo: (n) => `${n} minute${n === 1 ? "" : "s"} ago`,
  hoursAgo: (n) => `${n} hour${n === 1 ? "" : "s"} ago`,
  daysAgo: (n) => `${n} day${n === 1 ? "" : "s"} ago`,
};

const ZH: RelativeTimeStrings = {
  justNow: "刚刚",
  minutesAgo: (n) => `${n} 分钟前`,
  hoursAgo: (n) => `${n} 小时前`,
  daysAgo: (n) => `${n} 天前`,
};

// formatRelativeTime reads the clock through Date.now(); pin it so the
// rendered bucket is stable regardless of when tests run.
const NOW = new Date("2026-09-27T12:00:00.000Z");
const clock = () => NOW;

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

test("reply summary reads Name · relative time : snippet", () => {
  const line = boardSummaryLine(activity(), "2026-09-27T08:00:00.000Z", "en", STRINGS, EN, clock);
  assert.equal(line, "Dev · 5 minutes ago: fixed the build");
});

test("zh locale gets full-width colon and spaced relative time", () => {
  const line = boardSummaryLine(activity(), "2026-09-27T08:00:00.000Z", "zh", STRINGS, ZH, clock);
  assert.equal(line, "Dev · 5 分钟前：fixed the build");
});

test("task events fall back to the updated-task label", () => {
  const line = boardSummaryLine(
    activity({ kind: "task_event", snippet: null, eventType: "status_changed" }),
    "2026-09-27T08:00:00.000Z",
    "en",
    STRINGS,
    EN,
    clock,
  );
  assert.equal(line, "Dev · 5 minutes ago: updated the task");
});

test("system actor without a name uses the system label", () => {
  const line = boardSummaryLine(activity({ actorType: "system", actorName: null }), "2026-09-27T08:00:00.000Z", "en", STRINGS, EN, clock);
  assert.equal(line, "System · 5 minutes ago: fixed the build");
});

test("no activity yet falls back to Created <relative time of createdAt>", () => {
  const line = boardSummaryLine(null, "2026-09-27T11:00:00.000Z", "en", STRINGS, EN, clock);
  assert.equal(line, "Created 1 hour ago");
});

test("fresh activity renders the just-now copy", () => {
  const line = boardSummaryLine(activity({ at: "2026-09-27T11:59:40.000Z" }), "2026-09-27T08:00:00.000Z", "zh", STRINGS, ZH, clock);
  assert.equal(line, "Dev · 刚刚：fixed the build");
});

test("an unusable activity timestamp yields null rather than a broken line", () => {
  assert.equal(boardSummaryLine(activity({ at: "bogus" }), "2026-09-27T11:00:00.000Z", "en", STRINGS, EN, clock), null);
});
