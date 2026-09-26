import assert from "node:assert/strict";
import test from "node:test";
import { markdownPieces } from "./markdown";

test("markdown keeps fenced code, headings, and quotes separate from inline code", () => {
  const pieces = markdownPieces("# Title\n> quoted\n`inline`\n```\nblock\n```");
  assert.deepEqual(
    pieces.filter((piece) => piece.type !== "text").map((piece) => piece.type),
    ["heading", "quote", "code", "codeBlock"],
  );
  assert.equal(pieces.find((piece) => piece.type === "codeBlock")?.text, "block");
});
