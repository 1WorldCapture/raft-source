import assert from "node:assert/strict";
import test from "node:test";
import { relaunchPreservingUserData } from "./relaunch.ts";

function fakeApp(userData: string) {
  const calls: Array<{ args: string[] } | undefined> = [];
  return { calls, app: { getPath: () => userData, relaunch: (options?: { args: string[] }) => { calls.push(options); } } };
}

test("the effective userData path is pinned on the relaunch command line", () => {
  const f = fakeApp("/tmp/iso/userData");
  relaunchPreservingUserData(f.app, ["/app/Raft", "--hidden"]);
  assert.deepEqual(f.calls, [{ args: ["--hidden", "--user-data-dir=/tmp/iso/userData"] }]);
});

test("an existing --user-data-dir (both spellings) is replaced, not duplicated", () => {
  const eq = fakeApp("/u");
  relaunchPreservingUserData(eq.app, ["/app/Raft", "--user-data-dir=/old", "--hidden"]);
  assert.deepEqual(eq.calls, [{ args: ["--hidden", "--user-data-dir=/u"] }]);
  const bare = fakeApp("/u");
  relaunchPreservingUserData(bare.app, ["/app/Raft", "--user-data-dir", "/old", "--hidden"]);
  assert.deepEqual(bare.calls, [{ args: ["--hidden", "--user-data-dir=/u"] }]);
});
