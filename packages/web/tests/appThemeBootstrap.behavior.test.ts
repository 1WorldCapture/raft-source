import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME_PREFERENCES,
  ELEGANT_DARK_ENABLED,
  THEME_PICKER_ENABLED,
} from "../src/theme/appTheme";

const pickerTest = (name: string, fn: () => void) => test(name, { skip: !THEME_PICKER_ENABLED }, fn);

function executeBootstrap({
  storageEntries,
  systemDark = false,
}: {
  storageEntries: Record<string, string>;
  systemDark?: boolean;
}) {
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    classList: {
      toggle(name: string, force?: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    style: {} as Record<string, string>,
  };
  const themeColor = { content: "#FFD440" };
  const script = readFileSync(new URL("../public/app-theme-bootstrap.js", import.meta.url), "utf8");
  vm.runInNewContext(script, {
    document: {
      documentElement: root,
      querySelector(selector: string) {
        return selector === 'meta[name="theme-color"]' ? themeColor : null;
      },
    },
    localStorage: {
      get length() {
        return Object.keys(storageEntries).length;
      },
      key(index: number) {
        return Object.keys(storageEntries)[index] ?? null;
      },
      getItem(key: string) {
        return storageEntries[key] ?? null;
      },
      setItem(key: string, value: string) {
        storageEntries[key] = value;
      },
    },
    matchMedia() {
      return { matches: systemDark };
    },
  });
  return { classes, root, script, storageEntries, themeColor };
}

test("the bootstrap is the served public script with no deployment or account input", () => {
  const { script } = executeBootstrap({ storageEntries: {} });

  assert.doesNotMatch(script, /VITE_RAFT_MULTITHEME_POLICY|allowLocalOverride|slock_access_token|multitheme_v0|__name/);
  assert.match(script, new RegExp(APP_THEME_PREFERENCES_STORAGE_KEY.replaceAll("-", "\\-")));
});

test("a browser with no saved choice stays light while Elegant dark is hidden", () => {
  assert.equal(DEFAULT_APP_THEME_PREFERENCES.mode, "light");
  assert.equal(DEFAULT_APP_THEME_PREFERENCES.lightThemeId, "brutal");
  assert.equal(DEFAULT_APP_THEME_PREFERENCES.darkThemeId, "elegant");

  const light = executeBootstrap({ storageEntries: {}, systemDark: false });
  assert.equal(light.root.dataset.theme, "brutal");
  assert.equal(light.classes.has("dark"), false);
  assert.equal(light.root.style.colorScheme, "light");
  assert.equal(light.themeColor.content, "#FFD440");

  // An OS in dark mode must not switch a user who never chose anything to Elegant dark.
  const dark = executeBootstrap({ storageEntries: {}, systemDark: true });
  assert.equal(dark.root.dataset.theme, "brutal");
  assert.equal(dark.classes.has("dark"), false);
  assert.equal(dark.root.style.colorScheme, "light");
  assert.equal(dark.themeColor.content, "#FFD440");
});

pickerTest("an explicit device preference overrides the system appearance", () => {
  const { root, classes, themeColor } = executeBootstrap({
    storageEntries: {
      [APP_THEME_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        mode: "light",
        lightThemeId: "elegant",
        darkThemeId: "elegant",
      }),
    },
    systemDark: true,
  });

  assert.equal(root.dataset.theme, "elegant");
  assert.equal(classes.has("light"), true);
  assert.equal(classes.has("dark"), false);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(themeColor.content, "#FFFFFF");
});

test("legacy brutal stays light when the system is dark and storage cannot be written", () => {
  const entries: Record<string, string> = { [APP_THEME_STORAGE_KEY]: "brutal" };
  const storageEntries = new Proxy(entries, {
    set() {
      throw new Error("storage is read-only");
    },
  });
  const { root, classes } = executeBootstrap({ storageEntries, systemDark: true });

  assert.equal(root.dataset.theme, "brutal");
  assert.equal(classes.has("dark"), false);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(entries[APP_THEME_PREFERENCES_STORAGE_KEY], undefined);
});

pickerTest("a legacy device preset is promoted once when the current key is empty", () => {
  const { root, classes, themeColor, storageEntries } = executeBootstrap({
    storageEntries: { [APP_THEME_STORAGE_KEY]: "elegant-dark" },
    systemDark: false,
  });

  // The saved choice is kept; it renders dark when Elegant dark is on, light while it is hidden.
  assert.equal(root.dataset.theme, "elegant");
  assert.equal(classes.has("dark"), ELEGANT_DARK_ENABLED);
  assert.equal(classes.has("light"), !ELEGANT_DARK_ENABLED);
  assert.equal(themeColor.content, ELEGANT_DARK_ENABLED ? "#141411" : "#FFFFFF");
  assert.equal(storageEntries[APP_THEME_PREFERENCES_STORAGE_KEY], JSON.stringify({
    mode: "dark",
    lightThemeId: "elegant",
    darkThemeId: "elegant",
  }));

  storageEntries[APP_THEME_STORAGE_KEY] = "brutal";
  const second = executeBootstrap({ storageEntries, systemDark: false });
  assert.equal(second.root.dataset.theme, "elegant");
  assert.equal(second.classes.has("dark"), ELEGANT_DARK_ENABLED);
});

pickerTest("one old account preference migrates, but several accounts do not", () => {
  const one = executeBootstrap({
    storageEntries: {
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`]: "elegant-light",
    },
    systemDark: true,
  });
  assert.equal(one.root.dataset.theme, "elegant");
  assert.equal(one.classes.has("light"), true);

  const many = executeBootstrap({
    storageEntries: {
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`]: "elegant-dark",
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-b`]: "elegant-light",
    },
    systemDark: false,
  });
  assert.equal(many.root.dataset.theme, "brutal");
  assert.equal(many.classes.has("dark"), false);
});

test("corrupt device storage falls back to the default", () => {
  const { root, classes } = executeBootstrap({
    storageEntries: { [APP_THEME_PREFERENCES_STORAGE_KEY]: "{" },
    systemDark: true,
  });

  assert.equal(root.dataset.theme, "brutal");
  assert.equal(classes.has("dark"), false);
});

// Only meaningful while the picker is switched off (the picker-on PR flips the constant).
test("with the theme picker off a saved Elegant preference renders Brutal and is not cleared", { skip: THEME_PICKER_ENABLED }, () => {
  const saved = JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" });
  const { root, classes, themeColor, storageEntries } = executeBootstrap({
    storageEntries: { [APP_THEME_PREFERENCES_STORAGE_KEY]: saved },
    systemDark: true,
  });
  assert.equal(root.dataset.theme, "brutal");
  assert.equal(classes.has("light"), false);
  assert.equal(classes.has("dark"), false);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(themeColor.content, "#FFD440");
  assert.equal(storageEntries[APP_THEME_PREFERENCES_STORAGE_KEY], saved, "the saved preference is left alone");

  const legacy = executeBootstrap({ storageEntries: { [APP_THEME_STORAGE_KEY]: "elegant-dark" }, systemDark: false });
  assert.equal(legacy.root.dataset.theme, "brutal");
});
