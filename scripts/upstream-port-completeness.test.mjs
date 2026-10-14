import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectUses,
  loadOmissions,
  missingUses,
} from "./upstream-port-completeness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const UPSTREAM_MANIFEST = `import { PROVIDER_PROBE_CAPABILITY } from "@botiverse/raft-shared";

export const BUILT_IN_READY_CAPABILITIES = [
  REMINDER_FIRE_REQUEST_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
] as const;
`;

const OURS_WITHOUT = `export const BUILT_IN_READY_CAPABILITIES = [
  REMINDER_FIRE_REQUEST_CAPABILITY,
] as const;
`;

const OURS_WITH = `import {
  PROVIDER_PROBE_CAPABILITY,
} from "@botiverse/raft-shared";

export const BUILT_IN_READY_CAPABILITIES = [
  REMINDER_FIRE_REQUEST_CAPABILITY,
  PROVIDER_PROBE_CAPABILITY,
] as const;
`;

test("import lines are not uses", () => {
  const uses = collectUses(UPSTREAM_MANIFEST, "PROVIDER_PROBE_CAPABILITY");
  assert.deepEqual(uses.map((use) => use.normalized), ["PROVIDER_PROBE_CAPABILITY,"]);
});

test("a dropped ready-list line is reported against that file", () => {
  const missing = missingUses({
    upstreamText: UPSTREAM_MANIFEST,
    oursText: OURS_WITHOUT,
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/daemon/src/registry.manifest.ts",
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "packages/daemon/src/registry.manifest.ts");
  assert.match(missing[0].text, /PROVIDER_PROBE_CAPABILITY/);
});

test("the same use in our file is clean, including a different import shape", () => {
  const missing = missingUses({
    upstreamText: UPSTREAM_MANIFEST,
    oursText: OURS_WITH,
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/daemon/src/registry.manifest.ts",
  });
  assert.deepEqual(missing, []);
});

test("an unused upstream import does not count as a missing use", () => {
  const upstream = `import {\n  PROVIDER_PROBE_CAPABILITY,\n} from "@botiverse/raft-shared";\nexport const route = 1;\n`;
  const ours = `export const route = 1;\n`;
  assert.deepEqual(missingUses({
    upstreamText: upstream,
    oursText: ours,
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/server/src/routes/providerConnections.ts",
  }), []);
});

test("a repeated use must occur the same number of times", () => {
  const upstream = `const a = includes(PROVIDER_PROBE_CAPABILITY);\nconst b = includes(PROVIDER_PROBE_CAPABILITY);\n`;
  const ours = `const a = includes(PROVIDER_PROBE_CAPABILITY);\n`;
  const missing = missingUses({
    upstreamText: upstream,
    oursText: ours,
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/server/src/services/providerProbeService.ts",
  });
  assert.equal(missing.length, 1);
});

test("whitespace differences still match", () => {
  const missing = missingUses({
    upstreamText: "  PROVIDER_PROBE_CAPABILITY,\n",
    oursText: "\tPROVIDER_PROBE_CAPABILITY,\n",
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/daemon/src/registry.manifest.ts",
  });
  assert.deepEqual(missing, []);
});

test("an allowlist entry with a reason suppresses that use", () => {
  const missing = missingUses({
    upstreamText: UPSTREAM_MANIFEST,
    oursText: OURS_WITHOUT,
    name: "PROVIDER_PROBE_CAPABILITY",
    path: "packages/daemon/src/registry.manifest.ts",
    omissions: [{
      name: "PROVIDER_PROBE_CAPABILITY",
      path: "packages/daemon/src/registry.manifest.ts",
      use: "PROVIDER_PROBE_CAPABILITY,",
      reason: "example only",
    }],
  });
  assert.deepEqual(missing, []);
});

test("an allowlist entry without a reason is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "upstream-port-omissions-"));
  const file = join(dir, "omissions.json");
  writeFileSync(file, JSON.stringify({
    omissions: [{ name: "X", path: "a.ts", reason: "   " }],
  }));
  assert.throws(() => loadOmissions(file), /needs a reason/);
});

test("checked-in allowlist is an empty omissions list", () => {
  assert.deepEqual(loadOmissions(join(repoRoot, "scripts/upstream-port-omissions.json")), []);
});

function tagExists() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "upstream/v1.21.2-source.1"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

test("0297ecbd flags registry.manifest.ts and current HEAD is clean", { skip: !tagExists() }, () => {
  const script = join(repoRoot, "scripts/upstream-port-completeness.mjs");
  const common = [
    script,
    "--upstream",
    "upstream/v1.21.2-source.1",
    "--name",
    "PROVIDER_PROBE_CAPABILITY",
    "--repo",
    repoRoot,
  ];
  const before = spawnSync(process.execPath, [...common, "--ours", "0297ecbd"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /packages\/daemon\/src\/registry\.manifest\.ts:\d+/);
  assert.match(before.stdout, /missing 1/);
  assert.doesNotMatch(before.stdout, /providerProbeService\.ts/);

  const current = spawnSync(process.execPath, [...common, "--ours", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /missing 0/);
  assert.doesNotMatch(current.stdout, /registry\.manifest\.ts:\d+/);
});
