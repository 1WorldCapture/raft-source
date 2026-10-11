import assert from "node:assert/strict";
import test from "node:test";
import { preferLocalComputerVersion } from "./thisComputerLogic.ts";

const machine = { id: "m1", computerVersion: "1.0.41" };

test("a running local service's version wins over the (lagging) server record", () => {
  const shown = preferLocalComputerVersion(machine, { running: true, version: "1.0.42" });
  assert.equal(shown.computerVersion, "1.0.42");
  assert.equal(machine.computerVersion, "1.0.41", "the input record is not mutated");
});

test("falls back to the server record when the service is not running or reports no version", () => {
  assert.equal(preferLocalComputerVersion(machine, { running: false, version: "1.0.42" }), machine);
  assert.equal(preferLocalComputerVersion(machine, { running: true, version: null }), machine);
  assert.equal(preferLocalComputerVersion(machine, { running: true, version: undefined }), machine);
  assert.equal(preferLocalComputerVersion(machine, { running: true, version: "" }), machine);
});

test("the same version returns the record unchanged (no needless new object)", () => {
  assert.equal(preferLocalComputerVersion(machine, { running: true, version: "1.0.41" }), machine);
});

test("a server record with no version still gets the local one", () => {
  assert.equal(preferLocalComputerVersion<{ id: string; computerVersion?: string | null }>({ id: "m2" }, { running: true, version: "1.0.42" }).computerVersion, "1.0.42");
});
