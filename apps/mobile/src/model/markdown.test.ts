import assert from "node:assert/strict";
import test from "node:test";
import { inlinePieces, markdownPieces } from "./markdown";

test("markdown keeps fenced code, headings, and quotes separate from inline code", () => {
  const pieces = markdownPieces("# Title\n> quoted\n`inline`\n```\nblock\n```");
  assert.deepEqual(
    pieces.filter((piece) => piece.type !== "text").map((piece) => piece.type),
    ["heading", "quote", "code", "codeBlock"],
  );
  assert.equal(pieces.find((piece) => piece.type === "codeBlock")?.text, "block");
});

const boldTexts = (pieces: ReturnType<typeof markdownPieces>) => pieces.filter((piece) => piece.type === "bold").map((piece) => piece.text);

test("bold: plain, CJK, single * inside, and code inside render as bold pieces", () => {
  assert.deepEqual(boldTexts(markdownPieces("前面**粗体**后面")), ["粗体"]);
  assert.deepEqual(boldTexts(markdownPieces("**a*b** x")), ["a*b"]);
  const withCode = markdownPieces("**含`代码`的粗体**")[0];
  assert.equal(withCode?.type, "bold");
  assert.deepEqual(withCode?.type === "bold" ? withCode.children.map((child) => child.type) : [], ["text", "code", "text"]);
  // Not bold: spaces hugging the markers, or an unclosed marker.
  assert.deepEqual(boldTexts(markdownPieces("a ** b ** c")), []);
  assert.deepEqual(boldTexts(markdownPieces("**unclosed")), []);
});

test("list items keep their marker and indent, and their body is still raw text for the renderer to parse inline", () => {
  const pieces = markdownPieces("- **标题**: 说明\n  - 嵌套\n1. 第一步\n2) 第二步\n* 星号项\n+ 加号项");
  const lists = pieces.filter((piece) => piece.type === "list");
  assert.deepEqual(lists.map((piece) => (piece.type === "list" ? [piece.marker, piece.indent, piece.text] : [])), [
    ["•", 0, "**标题**: 说明"],
    ["•", 1, "嵌套"],
    ["1.", 0, "第一步"],
    ["2)", 0, "第二步"],
    ["•", 0, "星号项"],
    ["•", 0, "加号项"],
  ]);
});

test("a bold marker at line start is not a list item", () => {
  const pieces = markdownPieces("**粗体** 开头");
  assert.deepEqual(pieces.map((piece) => piece.type), ["bold", "text"]);
});

test("inlinePieces handles bold inside list, heading and quote bodies", () => {
  assert.deepEqual(boldTexts(inlinePieces("**步骤一** 做事")), ["步骤一"]);
  assert.deepEqual(boldTexts(inlinePieces("**大标题**")), ["大标题"]);
});
