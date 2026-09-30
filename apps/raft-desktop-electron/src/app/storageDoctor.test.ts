import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localStorageDir,
  requestStorageWipeAndRelaunch,
  resolvePendingStorageWipe,
  STORAGE_WIPE_MARKER_NAME,
  wipeMarkerPath,
} from "./storageDoctor.js";

/**
 * Behavior (desktop-data-cache task #12): a pending wipe marker is consumed
 * at module scope — BEFORE any window exists and thus before any renderer can
 * open the profile's Local Storage. Deleting the directory is the only way
 * out of the corrupted-journal write-loss loop; the marker itself is a plain
 * file so the LevelDB corruption can never eat it. Every wipe is logged.
 */

type Fs = {
  files: Map<string, true>;
  removed: string[];
  logs: string[];
};

function fakeFs(seed: string[] = []): Fs & {
  existsSync(p: string): boolean;
  rmSync(p: string): void;
  writeFileSync(p: string): void;
} {
  const state = { files: new Map(seed.map((p) => [p, true] as const)), removed: [] as string[], logs: [] as string[] };
  return {
    ...state,
    existsSync: (p) => state.files.has(p),
    rmSync: (p) => {
      state.files.delete(p);
      state.removed.push(p);
    },
    writeFileSync: (p) => {
      state.files.set(p, true);
    },
  };
}

const USER_DATA = "/tmp/user-data";

test("no marker: nothing happens, returns false", () => {
  const fs = fakeFs([localStorageDir(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    log: (m) => fs.logs.push(m),
  });
  assert.equal(wiped, false);
  assert.deepEqual(fs.removed, []);
  assert.equal(fs.logs.length, 0);
});

test("marker present: marker and Local Storage dir are removed before window creation, and it logs", () => {
  const fs = fakeFs([wipeMarkerPath(USER_DATA), localStorageDir(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    log: (m) => fs.logs.push(m),
  });
  assert.equal(wiped, true);
  assert.deepEqual(fs.removed.sort(), [localStorageDir(USER_DATA), wipeMarkerPath(USER_DATA)].sort());
  assert.equal(fs.logs.length, 1);
  assert.match(fs.logs[0], /storage doctor/);
});

test("marker present but directory already gone: still consumes the marker and reports the wipe", () => {
  const fs = fakeFs([wipeMarkerPath(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    log: (m) => fs.logs.push(m),
  });
  assert.equal(wiped, true);
  assert.deepEqual(fs.removed, [wipeMarkerPath(USER_DATA)]);
  assert.match(fs.logs[0], /hadDir=false/);
});

test("request: writes the marker file, then relaunches and exits", () => {
  const fs = fakeFs();
  const calls: string[] = [];
  requestStorageWipeAndRelaunch(
    USER_DATA,
    () => void calls.push("relaunch"),
    (code) => void calls.push("exit:" + code),
    {
      writeFileSync: fs.writeFileSync,
      log: (m) => fs.logs.push(m),
    },
  );
  assert.equal(fs.files.has(wipeMarkerPath(USER_DATA)), true);
  assert.deepEqual(calls, ["relaunch", "exit:0"]);
  assert.equal(fs.logs.length, 1);
});

test("the marker path is a plain file under userData, independent of Local Storage naming", () => {
  assert.equal(wipeMarkerPath(USER_DATA), USER_DATA + "/" + STORAGE_WIPE_MARKER_NAME);
  assert.notEqual(wipeMarkerPath(USER_DATA), localStorageDir(USER_DATA));
});
