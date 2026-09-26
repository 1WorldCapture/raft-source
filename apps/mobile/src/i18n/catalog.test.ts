import assert from "node:assert/strict";
import test from "node:test";
import { mobileEn, mobileZh, resolveLocale } from "./catalog.ts";

test("resolveLocale prefers the user setting, then the system, then English", () => {
  assert.equal(resolveLocale("zh-CN", "en-US"), "zh-cn");
  assert.equal(resolveLocale(null, "zh-Hans-CN"), "zh-cn");
  assert.equal(resolveLocale(null, "en-US"), "en");
  assert.equal(resolveLocale(undefined, null), "en");
});

test("mobile copy has the same keys in English and Chinese", () => {
  assert.deepEqual(Object.keys(mobileZh).sort(), Object.keys(mobileEn).sort());
});
