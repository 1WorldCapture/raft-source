import assert from "node:assert/strict";
import test from "node:test";
import { chunkTextLines } from "./textChunks.ts";

test("an empty file has no chunks", () => {
  assert.deepEqual(chunkTextLines(""), []);
});

test("line breaks stay inside chunks, including a blank line and a trailing break", () => {
  assert.deepEqual(chunkTextLines("a\r\n\nb\n"), ["a\n\nb\n"]);
});

test("rows split on the line count and the last row can be short", () => {
  assert.deepEqual(chunkTextLines("a\nb\nc\nd", 2), ["a\nb", "c\nd"]);
  assert.deepEqual(chunkTextLines("a\nb\nc", 2), ["a\nb", "c"]);
});

test("a one-line file longer than the char cap is hard-split, never one Text", () => {
  const line = "x".repeat(96 * 1024);
  const chunks = chunkTextLines(line);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), line);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
});

test("hard splits land on a surrogate-pair-safe boundary", () => {
  // "😀" spans char indexes 1999-2000, so a plain 2000-char cut would split the pair.
  const line = "x".repeat(1999) + "😀" + "y".repeat(3000);
  const chunks = chunkTextLines(line, 1);
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk)));
  assert.equal(chunks.join(""), line);
});
