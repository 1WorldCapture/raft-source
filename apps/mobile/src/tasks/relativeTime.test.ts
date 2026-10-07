import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime, relativeTimeStrings, type RelativeTimeStrings } from "./relativeTime.ts";
import { mobileEn, mobileZh } from "../i18n/catalog.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");

/** English ICU behavior reproduced by hand — same output the device gets from react-intl. */
const EN: RelativeTimeStrings = {
  justNow: "just now",
  minutesAgo: (n) => `${n} minute${n === 1 ? "" : "s"} ago`,
  hoursAgo: (n) => `${n} hour${n === 1 ? "" : "s"} ago`,
  daysAgo: (n) => `${n} day${n === 1 ? "" : "s"} ago`,
};

test("minute/hour/day buckets with rounding", () => {
  assert.equal(formatRelativeTime("2026-09-27T11:55:00.000Z", EN, () => NOW), "5 minutes ago");
  assert.equal(formatRelativeTime("2026-09-27T11:00:00.000Z", EN, () => NOW), "1 hour ago");
  assert.equal(formatRelativeTime("2026-09-24T12:00:00.000Z", EN, () => NOW), "3 days ago");
  assert.equal(formatRelativeTime("2026-09-27T11:38:00.000Z", EN, () => NOW), "22 minutes ago", "rounds to nearest minute");
});

test("under a minute and future timestamps render just-now (clock-skew safe)", () => {
  assert.equal(formatRelativeTime("2026-09-27T12:00:00.000Z", EN, () => NOW), "just now");
  assert.equal(formatRelativeTime("2026-09-27T12:05:00.000Z", EN, () => NOW), "just now", "future collapses to just now");
});

test("absent and invalid inputs yield null", () => {
  assert.equal(formatRelativeTime(null, EN, () => NOW), null);
  assert.equal(formatRelativeTime(undefined, EN, () => NOW), null);
  assert.equal(formatRelativeTime("not-a-date", EN, () => NOW), null);
});

test("the clock is injectable — same input, different now, different bucket", () => {
  const value = "2026-09-27T11:30:00.000Z";
  assert.equal(formatRelativeTime(value, EN, () => new Date("2026-09-27T11:45:00.000Z")), "15 minutes ago");
  assert.equal(formatRelativeTime(value, EN, () => new Date("2026-09-27T13:30:00.000Z")), "2 hours ago");
});

test("catalog strings feed the same formatter (zh keeps the CJK-digit space in the copy)", () => {
  const zh = relativeTimeStrings((id, values) => {
    const table = mobileZh as Record<string, string>;
    let out = table[id] ?? "";
    for (const [key, value] of Object.entries(values ?? {})) out = out.replace(`{${key}}`, String(value));
    return out;
  });
  assert.equal(zh.justNow, "刚刚");
  assert.equal(formatRelativeTime("2026-09-27T11:55:00.000Z", zh, () => NOW), "5 分钟前");
  assert.equal(formatRelativeTime("2026-09-27T13:00:00.000Z", zh, () => new Date("2026-09-27T15:00:00.000Z")), "2 小时前");
  assert.ok(mobileEn["mobile.time.minutesAgo"].includes("plural"), "en uses ICU plural so PluralRules' polyfill path is the device path");
});
