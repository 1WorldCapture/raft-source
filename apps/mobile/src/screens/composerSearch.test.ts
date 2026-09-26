import assert from "node:assert/strict";
import test from "node:test";
import { rankComposerSuggestions } from "../../../../packages/web/src/utils/composerSuggestionSearch";

test("pinyin initials rank 张三 ahead of an unrelated name", () => {
  const ranked = rankComposerSuggestions("zs", [
    { index: 0, suggestion: "李四", fields: [{ raw: "李四", priority: 0 }] },
    { index: 1, suggestion: "张三", fields: [{ raw: "张三", priority: 0 }] },
  ]);
  assert.equal(ranked[0], "张三");
});
