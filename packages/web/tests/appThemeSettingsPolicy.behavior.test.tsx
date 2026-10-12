import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AppearanceThemeSettingsControl } from "../src/components/settings/SettingsPanel";
import { AppThemeProvider } from "../src/theme/AppThemeProvider";
import { useAppTheme } from "../src/hooks/useAppTheme";
import { useAuthStore } from "../src/store/authStore";
import {
  ELEGANT_DARK_ENABLED,
  THEME_PICKER_ENABLED,
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
} from "../src/theme/appTheme";
import { TestIntlProvider } from "./helpers/intl";

const originalMatchMedia = window.matchMedia;

function accessToken(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, type: "access" })).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.matchMedia = originalMatchMedia;
  useAuthStore.setState({ accessToken: null, user: null });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.removeProperty("color-scheme");
});

beforeEach(() => {
  useAuthStore.setState({ accessToken: accessToken("appearance-account"), user: null });
});

let observedPreset = "";

function PolicyProbe() {
  const { preset } = useAppTheme();
  observedPreset = preset;
  return null;
}

function ProductAppearance() {
  return (
    <TestIntlProvider locale="en">
      <AppThemeProvider>
        <PolicyProbe />
        <AppearanceThemeSettingsControl />
      </AppThemeProvider>
    </TestIntlProvider>
  );
}

const darkTest = (name: string, fn: () => void | Promise<void>) => test(name, { skip: !(ELEGANT_DARK_ENABLED && THEME_PICKER_ENABLED) }, fn);
const pickerTest = (name: string, fn: () => void | Promise<void>) => test(name, { skip: !THEME_PICKER_ENABLED }, fn);

darkTest("the real Settings Appearance path saves the device preference", () => {
  window.localStorage.setItem(APP_THEME_STORAGE_KEY, "brutal");
  observedPreset = "";
  render(<ProductAppearance />);

  fireEvent.click(screen.getByTestId("appearance-mode-dark"));
  fireEvent.click(screen.getByTestId("appearance-dark-theme-elegant"));
  assert.equal(observedPreset, "elegant-dark", "the settings control received the preset mutation");
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY) ?? "null"),
    { mode: "dark", lightThemeId: "brutal", darkThemeId: "elegant" },
  );
  assert.equal(document.documentElement.dataset.theme, "elegant");
  assert.equal(document.documentElement.classList.contains("dark"), true);
  assert.ok(screen.queryByRole("status") === null, "there is no deployment rollback notice");
});

darkTest("Light, Dark, and System mode preserve independent theme choices across remount", () => {
  window.localStorage.setItem(
    APP_THEME_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" }),
  );
  const view = render(<ProductAppearance />);

  fireEvent.click(screen.getByTestId("appearance-light-theme-brutal"));
  fireEvent.click(screen.getByTestId("appearance-mode-system"));
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY) ?? "null"),
    { mode: "system", lightThemeId: "brutal", darkThemeId: "elegant" },
    "switching mode does not overwrite either per-mode theme choice",
  );

  view.unmount();
  render(<ProductAppearance />);
  assert.equal(screen.getByTestId("appearance-mode-system").getAttribute("aria-checked"), "true");
  assert.equal(screen.getByTestId("appearance-light-theme-brutal").getAttribute("aria-checked"), "true");
  assert.equal(screen.getByTestId("appearance-dark-theme-elegant").getAttribute("aria-checked"), "true");
});

pickerTest("selected theme cards use their own visual personality", () => {
  render(<ProductAppearance />);
  const brutalRadio = screen.getByTestId("appearance-light-theme-brutal");
  const elegantRadio = screen.getByTestId("appearance-light-theme-elegant");
  const brutalCard = brutalRadio.parentElement?.querySelector<HTMLElement>("[data-theme='brutal']");
  const elegantCard = elegantRadio.parentElement?.querySelector<HTMLElement>("[data-theme='elegant']");
  assert.ok(brutalCard);
  assert.ok(elegantCard);

  assert.match(brutalCard.className, /shadow-raft-md/);
  assert.match(brutalCard.className, /border-line-strong/);
  assert.doesNotMatch(brutalCard.className, /border-primary-400/);
  assert.match(elegantCard.className, /shadow-none/);
  assert.match(elegantCard.className, /border-line-muted/);

  const brutalPreview = brutalCard.querySelector<HTMLElement>('[aria-hidden="true"]');
  assert.ok(brutalPreview?.classList.contains("rounded-none"), "brutal preview must be rounded-none");
  assert.ok(brutalPreview?.firstElementChild?.classList.contains("shadow-brutal-xs"), "brutal inner mock must have shadow-brutal-xs");

  const elegantPreview = elegantCard.querySelector<HTMLElement>('[aria-hidden="true"]');
  assert.ok(elegantPreview?.classList.contains("rounded-md"), "elegant preview must be rounded-md");
  assert.equal(elegantPreview?.classList.contains("rounded-none"), false, "elegant preview must not be rounded-none");
  assert.ok(elegantPreview?.firstElementChild?.classList.contains("shadow-raft-xs"), "elegant inner mock must have shadow-raft-xs");

  fireEvent.click(elegantRadio);
  // The selected elegant card reads the accent pair (task #623): accent-strong
  // in elegant, soft-signal kept under brutal via the theme-brutal override.
  assert.match(elegantCard.className, /border-accent-strong/);
  assert.match(elegantCard.className, /shadow-none/);
  assert.match(brutalCard.className, /shadow-none/);
  assert.doesNotMatch(brutalCard.className, /border-line-strong/);
  assert.match(brutalCard.className, /border-line-muted/);
});

pickerTest("while Elegant dark is hidden Settings offers only the Brutal and Elegant light themes and saves the choice", () => {
  window.localStorage.setItem(APP_THEME_STORAGE_KEY, "brutal");
  observedPreset = "";
  render(<ProductAppearance />);

  assert.equal(screen.queryByTestId("appearance-mode-dark"), null);
  assert.equal(screen.queryByTestId("appearance-mode-system"), null);
  assert.equal(screen.queryByTestId("appearance-theme-group-dark"), null);
  assert.ok(screen.getByTestId("appearance-theme-group-light"));
  assert.equal(screen.getByTestId("appearance-light-theme-brutal").getAttribute("aria-checked"), "true");

  fireEvent.click(screen.getByTestId("appearance-light-theme-elegant"));
  assert.equal(observedPreset, "elegant-light");
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY) ?? "null"),
    { mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" },
  );
  assert.equal(document.documentElement.dataset.theme, "elegant");
  assert.equal(document.documentElement.classList.contains("dark"), false);
});

test("with the theme picker off Settings shows no theme controls", () => {
  assert.equal(THEME_PICKER_ENABLED, false);
  render(<ProductAppearance />);
  assert.equal(screen.queryByTestId("appearance-theme-picker"), null);
  assert.equal(screen.queryByTestId("appearance-theme-group-light"), null);
  assert.equal(screen.queryByText("Theme"), null);
});
