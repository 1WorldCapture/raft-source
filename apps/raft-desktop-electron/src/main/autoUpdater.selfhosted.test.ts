// Self-hosted builds (VITE_API_URL configured to a non-official origin) must
// never touch the official update feed: applying an official update would
// replace the self-hosted app with an official one pointed at the official
// backend. updaterAllowed is injected via UpdaterDeps (no build-config import
// here), so this test just passes false.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("self-hosted build disables the updater even with an update feed present", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "raft-selfhosted-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "dev-app-update.yml"), "provider: generic\n");
  let checks = 0;
  t.mock.module("electron", { namedExports: {
    app: { isPackaged: false, getAppPath: () => root, getPath: () => root },
    dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  } });
  t.mock.module("electron-updater", { namedExports: { autoUpdater: {
    on: () => {},
    checkForUpdates: async () => { checks++; return null; },
  } } });
  const deps = { markQuitting() {}, updaterAllowed: false };
  const updater = await import("./autoUpdater.ts");
  updater.initializeAutoUpdater(deps);
  assert.equal(updater.getUpdateStatus().state, "unsupported");
  await updater.triggerBackgroundCheck(deps);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(checks, 0, "a self-hosted build must not contact the official update feed");
  await updater.checkForUpdatesManually(deps);
  assert.equal(checks, 0, "manual check degrades to the info dialog, not the feed");
});
