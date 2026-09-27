import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime } from "./relativeTime.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");

test("minute/hour/day buckets with numeric auto", () => {
  assert.equal(formatRelativeTime("2026-09-27T11:55:00.000Z", "en", () => NOW), "5 minutes ago");
  assert.equal(formatRelativeTime("2026-09-27T11:00:00.000Z", "en", () => NOW), "1 hour ago");
  assert.equal(formatRelativeTime("2026-09-24T12:00:00.000Z", "en", () => NOW), "3 days ago");
  assert.equal(formatRelativeTime("2026-09-27T12:05:00.000Z", "en", () => NOW), "in 5 minutes");
});

test("exactly now renders the auto form, not 0 minutes", () => {
  const rendered = formatRelativeTime("2026-09-27T12:00:00.000Z", "en", () => NOW);
  assert.equal(rendered, "this minute");
});

test("zh gets the CJK digit spacing (盘古之白)", () => {
  assert.equal(formatRelativeTime("2026-09-27T11:55:00.000Z", "zh", () => NOW), "5 分钟前");
  assert.equal(formatRelativeTime("2026-09-27T13:00:00.000Z", "zh", () => NOW), "1 小时后");
});

test("absent and invalid inputs yield null", () => {
  assert.equal(formatRelativeTime(null, "en", () => NOW), null);
  assert.equal(formatRelativeTime(undefined, "en", () => NOW), null);
  assert.equal(formatRelativeTime("not-a-date", "en", () => NOW), null);
});

test("the clock is injectable — same input, different now, different bucket", () => {
  const value = "2026-09-27T11:30:00.000Z";
  assert.equal(formatRelativeTime(value, "en", () => new Date("2026-09-27T11:45:00.000Z")), "15 minutes ago");
  assert.equal(formatRelativeTime(value, "en", () => new Date("2026-09-27T13:30:00.000Z")), "2 hours ago");
});
