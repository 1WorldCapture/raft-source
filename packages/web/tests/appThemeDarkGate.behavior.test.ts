import test from "node:test";
import assert from "node:assert/strict";

import {
  ELEGANT_DARK_ENABLED,
  THEME_PICKER_ENABLED,
  resolveAppThemePreferences,
  resolveAppThemePreset,
} from "../src/theme/appTheme";

// Only meaningful while Elegant dark is switched off (the dark-on PR flips the constant).
test("Elegant dark is hidden: dark and system preferences resolve to light", { skip: ELEGANT_DARK_ENABLED }, () => {
  const dark = resolveAppThemePreferences({ mode: "dark", lightThemeId: "elegant", darkThemeId: "elegant" }, "dark");
  assert.equal(dark.resolvedMode, "light");
  assert.equal(dark.preset, THEME_PICKER_ENABLED ? "elegant-light" : "brutal");
  const system = resolveAppThemePreferences({ mode: "system", lightThemeId: "brutal", darkThemeId: "elegant" }, "dark");
  assert.equal(system.resolvedMode, "light");
  assert.equal(system.themeId, "brutal");
  assert.equal(resolveAppThemePreset("elegant-dark").resolvedMode, "light");
});

// Only meaningful while the picker is switched off (the picker-on PR flips the constant).
test("with the picker off a saved Elegant preference resolves to Brutal and nothing rewrites it", { skip: THEME_PICKER_ENABLED }, () => {
  const saved = { mode: "light" as const, lightThemeId: "elegant" as const, darkThemeId: "elegant" as const };
  const resolved = resolveAppThemePreferences(saved, "light");
  assert.equal(resolved.themeId, "brutal");
  assert.equal(resolved.theme, "brutal");
  assert.equal(resolved.preset, "brutal");
  assert.deepEqual(saved, { mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" });
});
