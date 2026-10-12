import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { headlessUserDataDir } from "./headlessUserData.ts";

const home = "/h/.slock";
const root = path.join(home, "computer", "electron-userdata");

test("a normal GUI launch gets no override", () => {
  assert.equal(headlessUserDataDir(home, null), null);
});

test("__service and each __run child get their own userData under the Computer home", () => {
  assert.equal(headlessUserDataDir(home, { mode: "__service", rest: [] }), path.join(root, "service"));
  assert.equal(headlessUserDataDir(home, { mode: "__run", rest: ["2f1a05e0-0000-4000-8000-000000000001"] }), path.join(root, "run-2f1a05e0-0000-4000-8000-000000000001"));
  assert.notEqual(
    headlessUserDataDir(home, { mode: "__run", rest: ["a"] }),
    headlessUserDataDir(home, { mode: "__run", rest: ["b"] }),
  );
});

test("a hostile or missing server id can never escape the userData root", () => {
  for (const bad of ["../../x", "a/b", "..", ".", "", "x y", "a\0b"]) {
    const dir = headlessUserDataDir(home, { mode: "__run", rest: [bad] })!;
    assert.equal(path.dirname(dir), root, JSON.stringify(bad));
    assert.equal(path.basename(dir), "run-unknown", JSON.stringify(bad));
  }
  assert.equal(path.basename(headlessUserDataDir(home, { mode: "__run", rest: [] })!), "run-unknown");
});
