import assert from "node:assert/strict";
import { test } from "vitest";
import { SKINS } from "@botiverse/raft-shared/src/skins.js";
import { parsePreferredSkin } from "./skinPreference.js";

test("parsePreferredSkin: undefined/null/blank, valid (case-insensitive), invalid", () => {
  assert.equal(parsePreferredSkin(undefined), undefined);
  assert.equal(parsePreferredSkin(null), null);
  assert.equal(parsePreferredSkin("  "), null);
  assert.equal(parsePreferredSkin(" Sky "), "sky");
  for (const skin of SKINS) assert.equal(parsePreferredSkin(skin.id), skin.id, "every shared skin id is accepted");
  for (const bad of ["nope", "rose2", 1, false, [], {}]) assert.throws(() => parsePreferredSkin(bad), /preferredSkin/);
});
