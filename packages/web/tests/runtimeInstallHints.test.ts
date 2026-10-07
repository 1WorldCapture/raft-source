import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNTIMES } from "@botiverse/raft-shared";
import { runtimeInstallHintFor } from "../src/utils/runtimeInstallHints";

const OMP_RUNTIME = RUNTIMES.find((runtime) => runtime.id === "omp");

test("omp ships an install hint with both documented commands", () => {
  assert.ok(OMP_RUNTIME, "RUNTIMES must register omp");
  const hint = runtimeInstallHintFor("omp", []);
  assert.equal(hint?.introId, "runtime.installHint.omp");
  assert.deepEqual(hint?.commands, [
    "curl -fsSL https://omp.sh/install | sh",
    "brew install can1357/tap/omp",
  ]);
});

test("the install hint appears only while the machine reports omp missing", () => {
  assert.deepEqual(runtimeInstallHintFor("omp", ["omp"]), null);
  assert.deepEqual(runtimeInstallHintFor("omp", ["claude"]), {
    introId: "runtime.installHint.omp",
    commands: [
      "curl -fsSL https://omp.sh/install | sh",
      "brew install can1357/tap/omp",
    ],
  });
});

test("runtimes without a hint entry stay hint-free in both states", () => {
  assert.deepEqual(runtimeInstallHintFor("pi", []), null);
  assert.deepEqual(runtimeInstallHintFor("claude", []), null);
  assert.deepEqual(runtimeInstallHintFor(null, []), null);
  assert.deepEqual(runtimeInstallHintFor(undefined, ["omp"]), null);
});
