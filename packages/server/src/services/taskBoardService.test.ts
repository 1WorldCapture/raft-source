import assert from "node:assert/strict";
import { test } from "vitest";
import { buildTaskActivitySnippet, decodeTaskBoardCursor, encodeTaskBoardCursor } from "./taskBoardService.js";

test("snippet strips Markdown and code fences, keeps mentions and collapses whitespace", () => {
  assert.equal(
    buildTaskActivitySnippet("## Status\n\n- **done**: `api`\n\n```ts\nconst a = 1;\n```\n\n<@Anna> see [the PR](https://example.test/pr/1)"),
    "Status done: api const a = 1; @Anna see the PR",
  );
});

test("snippet truncates by code point without splitting emoji", () => {
  const text = "😀".repeat(130);
  const snippet = buildTaskActivitySnippet(text, 120);
  const chars = Array.from(snippet);
  assert.equal(chars.length, 120);
  assert.equal(chars.at(-1), "…");
  assert.ok(chars.slice(0, -1).every((char) => char === "😀"), "no lone surrogate halves");
  assert.equal(buildTaskActivitySnippet("short"), "short");
});

test("board cursor round-trips and rejects malformed payloads", () => {
  const cursor = { activityMicros: "1790000000123456", id: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(decodeTaskBoardCursor(encodeTaskBoardCursor(cursor)), cursor);
  assert.equal(decodeTaskBoardCursor("%%%"), null);
  assert.equal(decodeTaskBoardCursor(Buffer.from(JSON.stringify({ a: 1, i: "x" })).toString("base64url")), null);
});
