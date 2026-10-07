import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localStorageDir,
  requestStorageWipeAndRelaunch,
  resolvePendingStorageWipe,
  STORAGE_DOCTOR_LOG_NAME,
  STORAGE_WIPE_MARKER_NAME,
  wipeMarkerPath,
} from "./storageDoctor.js";

/**
 * Behavior (desktop-data-cache task #12, review items 3+4): a pending wipe
 * marker is consumed only once this process holds the single-instance lock —
 * BEFORE any window exists and thus before any renderer can open the
 * profile's Local Storage. The directory is removed first and the marker
 * only after success, so a locked file retries next boot instead of
 * silently skipping. Every decision is logged to <userData>/storage-doctor.log
 * because a packaged app has no console.
 */

type FakeFs = {
  files: Map<string, true>;
  removed: string[];
  logs: string[];
  logFile: string[];
  failOn: string | null;
};

function fakeFs(seed: string[] = []): FakeFs & {
  existsSync(p: string): boolean;
  rmSync(p: string): void;
  writeFileSync(p: string): void;
  appendFileSync(p: string, data: string): void;
} {
  const state: FakeFs = {
    files: new Map(seed.map((p) => [p, true] as const)),
    removed: [],
    logs: [],
    logFile: [],
    failOn: null,
  };
  return {
    ...state,
    get failOn() {
      return state.failOn;
    },
    set failOn(v: string | null) {
      state.failOn = v;
    },
    existsSync: (p) => state.files.has(p),
    rmSync: (p) => {
      if (state.failOn === p) throw new Error("EBUSY: resource busy or locked");
      state.files.delete(p);
      state.removed.push(p);
    },
    writeFileSync: (p) => {
      state.files.set(p, true);
    },
    appendFileSync: (p, data) => {
      if (p.endsWith(STORAGE_DOCTOR_LOG_NAME)) state.logFile.push(data);
    },
    log: undefined,
  } as FakeFs & {
    existsSync(p: string): boolean;
    rmSync(p: string): void;
    writeFileSync(p: string): void;
    appendFileSync(p: string, data: string): void;
  };
}

function depsOf(fs: ReturnType<typeof fakeFs>) {
  return {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync as (p: string, options: { recursive: true; force: true }) => void,
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    log: (m: string) => fs.logs.push(m),
  };
}

const USER_DATA = "/tmp/user-data";

test("no marker: nothing happens, returns false, nothing logged", () => {
  const fs = fakeFs([localStorageDir(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, depsOf(fs));
  assert.equal(wiped, false);
  assert.deepEqual(fs.removed, []);
  assert.equal(fs.logs.length, 0);
});

test("marker present: Local Storage dir removed FIRST, then the marker; logs to console and file", () => {
  const fs = fakeFs([wipeMarkerPath(USER_DATA), localStorageDir(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, depsOf(fs));
  assert.equal(wiped, true);
  assert.equal(fs.removed.indexOf(localStorageDir(USER_DATA)) < fs.removed.indexOf(wipeMarkerPath(USER_DATA)), true);
  assert.equal(fs.logs.length, 1);
  assert.match(fs.logs[0], /storage doctor/);
  assert.equal(fs.logFile.length, 1);
});

test("marker present but directory already gone: still consumes the marker and reports the wipe", () => {
  const fs = fakeFs([wipeMarkerPath(USER_DATA)]);
  const wiped = resolvePendingStorageWipe(USER_DATA, depsOf(fs));
  assert.equal(wiped, true);
  assert.deepEqual(fs.removed, [wipeMarkerPath(USER_DATA)]);
  assert.match(fs.logs[0], /hadDir=false/);
});

test("a locked Local Storage dir (EBUSY): marker survives for a next-boot retry, returns false", () => {
  const fs = fakeFs([wipeMarkerPath(USER_DATA), localStorageDir(USER_DATA)]);
  fs.failOn = localStorageDir(USER_DATA);
  const wiped = resolvePendingStorageWipe(USER_DATA, depsOf(fs));
  assert.equal(wiped, false);
  assert.equal(fs.files.has(wipeMarkerPath(USER_DATA)), true, "marker kept for retry");
  assert.equal(fs.files.has(localStorageDir(USER_DATA)), true, "dir untouched");
  assert.match(fs.logs[0], /removal failed/);
});

test("request: writes the marker file, then relaunches and exits, all logged", () => {
  const fs = fakeFs();
  const calls: string[] = [];
  requestStorageWipeAndRelaunch(
    USER_DATA,
    () => void calls.push("relaunch"),
    (code) => void calls.push("exit:" + code),
    depsOf(fs),
  );
  assert.equal(fs.files.has(wipeMarkerPath(USER_DATA)), true);
  assert.deepEqual(calls, ["relaunch", "exit:0"]);
  assert.equal(fs.logs.length, 1);
  assert.equal(fs.logFile.length, 1);
});

test("the marker path is a plain file under userData, independent of Local Storage naming", () => {
  assert.equal(wipeMarkerPath(USER_DATA), USER_DATA + "/" + STORAGE_WIPE_MARKER_NAME);
  assert.notEqual(wipeMarkerPath(USER_DATA), localStorageDir(USER_DATA));
});
