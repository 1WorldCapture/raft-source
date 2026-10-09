import assert from "node:assert/strict";
import { test } from "vitest";
import { SKINS } from "../../../../apps/raft-desktop-electron/frontend/src/desktop/skins.js";
import { KNOWN_SKIN_IDS, parsePreferredSkin } from "./skinPreference.js";

test("the accepted skin ids are exactly the desktop's SKINS (until the shared module replaces both)", () => {
  assert.deepEqual([...KNOWN_SKIN_IDS], SKINS.map((skin) => skin.id));
});

test("parsePreferredSkin: undefined/null/blank, valid (case-insensitive), invalid", () => {
  assert.equal(parsePreferredSkin(undefined), undefined);
  assert.equal(parsePreferredSkin(null), null);
  assert.equal(parsePreferredSkin("  "), null);
  assert.equal(parsePreferredSkin(" Sky "), "sky");
  for (const id of KNOWN_SKIN_IDS) assert.equal(parsePreferredSkin(id), id);
  for (const bad of ["nope", "rose2", 1, false, [], {}]) assert.throws(() => parsePreferredSkin(bad), /preferredSkin/);
});
