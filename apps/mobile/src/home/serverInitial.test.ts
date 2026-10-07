import assert from "node:assert/strict";
import test from "node:test";
import { serverInitial } from "./serverInitial.ts";

test("serverInitial upper-cases the first letter and keeps CJK", () => {
  assert.equal(serverInitial("raftBuild"), "R");
  assert.equal(serverInitial("  localllm"), "L");
  assert.equal(serverInitial("研发"), "研");
  assert.equal(serverInitial("🚀 launch"), "🚀");
  assert.equal(serverInitial("   "), "?");
});
