// Pins the window-geometry restore's display validation: saved bounds that no
// longer land on a connected display (monitor unplugged, saved from another
// machine) must be rejected so the window centers on a visible screen instead
// of restoring into the void. Bounds with enough overlap stay; undersized or
// malformed state falls back to defaults.
//
// One controllable electron mock backs the whole file: windowState.ts is
// imported once (module cache), and its `screen`/`app` reads go through the
// mutable CURRENT_* closures below, so each test just moves the world.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// One 2560x1440 display at the origin, like a typical single-monitor Mac.
const BUILT_IN_DISPLAY = { workArea: { x: 0, y: 0, width: 2560, height: 1440 } };
const displays: { workArea: { x: number; y: number; width: number; height: number } }[] = [BUILT_IN_DISPLAY];
let userDataDir = "";

test("window-geometry restore validates bounds against connected displays", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-window-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  userDataDir = dir;
  const statePath = () => path.join(userDataDir, "window-state.json");

  t.mock.module("electron", { namedExports: {
    app: { getPath: () => userDataDir },
    screen: { getAllDisplays: () => displays },
  } });
  const { loadWindowState } = await import("./windowState.ts");

  const writeState = (state: unknown) => writeFile(statePath(), JSON.stringify(state));

  await t.test("bounds on a connected display are restored", async () => {
    displays.splice(0, displays.length, BUILT_IN_DISPLAY);
    await writeState({ bounds: { x: 100, y: 100, width: 1280, height: 800 }, maximized: true, fullscreen: false });
    const state = loadWindowState();
    assert.deepEqual(state.bounds, { x: 100, y: 100, width: 1280, height: 800 });
    assert.equal(state.maximized, true);
  });

  await t.test("bounds on a disconnected display are rejected", async () => {
    displays.splice(0, displays.length); // monitor unplugged
    await writeState({ bounds: { x: 100, y: 100, width: 1280, height: 800 }, maximized: true, fullscreen: false });
    const state = loadWindowState();
    assert.equal(state.bounds, null, "off-display bounds must fall back to centered defaults");
    // maximized/fullscreen are deliberately independent of bounds validity —
    // maximizing onto the current display is still the right restore.
    assert.equal(state.maximized, true);
  });

  await t.test("bounds fully beyond the display edge are rejected", async () => {
    displays.splice(0, displays.length, BUILT_IN_DISPLAY);
    await writeState({ bounds: { x: 2560, y: 100, width: 1280, height: 800 }, maximized: false, fullscreen: false });
    assert.equal(loadWindowState().bounds, null);
  });

  await t.test("bounds with a sliver on-screen (40px < MIN_ON_SCREEN) are rejected", async () => {
    await writeState({ bounds: { x: 2520, y: 100, width: 1280, height: 800 }, maximized: false, fullscreen: false });
    assert.equal(loadWindowState().bounds, null);
  });

  await t.test("undersized bounds fall back to defaults", async () => {
    await writeState({ bounds: { x: 0, y: 0, width: 400, height: 200 }, maximized: true, fullscreen: false });
    const state = loadWindowState();
    assert.equal(state.bounds, null, "undersized bounds must be rejected");
  });

  await t.test("malformed file falls back to defaults", async () => {
    await writeFile(statePath(), "{not json");
    const state = loadWindowState();
    assert.equal(state.bounds, null);
  });
});
