import assert from "node:assert/strict";
import test from "node:test";
import { formatDayLabel, formatMessageStamp } from "./messageTime";

const now = new Date("2026-09-26T15:00:00.000Z");
const base = { now, timeZone: "UTC", yesterdayLabel: "Yesterday", todayLabel: "Today", locale: "en-US" };

test("message stamps follow today, yesterday, same year, and another year", () => {
  assert.equal(formatMessageStamp("2026-09-26T08:05:00.000Z", base), "08:05");
  assert.equal(formatMessageStamp("2026-09-26T15:05:00.000Z", { ...base, hour12: true }), "03:05 PM");
  assert.equal(formatMessageStamp("2026-09-25T08:05:00.000Z", base), "Yesterday 08:05");
  assert.equal(formatMessageStamp("2026-01-02T08:05:00.000Z", base), "01/02 08:05");
  assert.equal(formatMessageStamp("2025-12-31T08:05:00.000Z", base), "2025/12/31 08:05");
});

test("day labels use today, yesterday, or a weekday date", () => {
  assert.equal(formatDayLabel("2026-09-26T08:00:00.000Z", base), "Today");
  assert.equal(formatDayLabel("2026-09-25T08:00:00.000Z", base), "Yesterday");
  assert.match(formatDayLabel("2026-01-06T08:00:00.000Z", base), /Tuesday, January 6/);
});
