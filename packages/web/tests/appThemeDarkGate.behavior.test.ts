import test from "node:test";
import assert from "node:assert/strict";

import {
  ELEGANT_DARK_ENABLED,
  resolveAppThemePreferences,
  resolveAppThemePreset,
} from "../src/theme/appTheme";

test("Elegant dark is hidden: dark and system preferences resolve to light", () => {
  assert.equal(ELEGANT_DARK_ENABLED, false);
  const dark = resolveAppThemePreferences({ mode: "dark", lightThemeId: "elegant", darkThemeId: "elegant" }, "dark");
  assert.equal(dark.resolvedMode, "light");
  assert.equal(dark.preset, "elegant-light");
  const system = resolveAppThemePreferences({ mode: "system", lightThemeId: "brutal", darkThemeId: "elegant" }, "dark");
  assert.equal(system.resolvedMode, "light");
  assert.equal(system.themeId, "brutal");
  assert.equal(resolveAppThemePreset("elegant-dark").resolvedMode, "light");
});
