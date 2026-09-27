import assert from "node:assert/strict";
import test from "node:test";
import { viewKind } from "./viewKind.ts";

test("markdown matches extension or markdown MIME, including charset and case", () => {
  assert.equal(viewKind("Notes.MD", null), "markdown");
  assert.equal(viewKind("guide.markdown", "application/octet-stream"), "markdown");
  assert.equal(viewKind("readme", "Text/Markdown; charset=utf-8"), "markdown");
  assert.equal(viewKind("readme", "text/x-markdown"), "markdown");
});

test("text uses the shared candidate list and ignores markdown", () => {
  assert.equal(viewKind("notes.txt", null), "text");
  assert.equal(viewKind("app.log", "application/octet-stream"), "text");
  assert.equal(viewKind("data.json", "application/json"), "text");
  assert.equal(viewKind("notes", "text/plain; charset=utf-8"), "text");
  assert.equal(viewKind("notes.md", "text/markdown"), "markdown");
});

test("images follow an image MIME and everything else is none", () => {
  assert.equal(viewKind("photo.PNG", "image/png"), "image");
  assert.equal(viewKind("anim.gif", "IMAGE/GIF; charset=binary"), "image");
  assert.equal(viewKind("archive.zip", "application/zip"), "none");
  assert.equal(viewKind("file.pdf", "application/pdf"), "none");
  assert.equal(viewKind("picture.png", null), "none");
});
