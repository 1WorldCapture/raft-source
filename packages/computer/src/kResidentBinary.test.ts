import assert from "node:assert/strict";
import { test } from "vitest";

import { kSlotBinaryPath } from "./kPaths.js";
import { resolveKResidentBinary } from "./kResidentBinary.js";

const HOME = "/test/home";

function accessible(...paths: string[]): (filePath: string) => Promise<void> {
  const allowed = new Set(paths);
  return async (filePath) => {
    if (!allowed.has(filePath)) throw new Error("ENOENT");
  };
}

function canonical(...paths: string[]): (filePath: string) => string {
  const allowed = new Set(paths);
  return (filePath) => {
    if (!allowed.has(filePath)) throw new Error("ENOENT");
    return filePath;
  };
}

test("non-SEA development keeps node as the resident command", async () => {
  assert.equal(
    await resolveKResidentBinary(HOME, "/usr/bin/node", false, accessible()),
    "/usr/bin/node",
  );
});

test("pre-K carrier uses itself until a stable slot exists", async () => {
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(),
      "linux",
      canonical("/opt/raft-computer"),
    ),
    "/opt/raft-computer",
  );
});

test("cold dispatcher selects K stable instead of its stale embedded core", async () => {
  const stable = kSlotBinaryPath(HOME, "stable");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(stable),
      "linux",
      canonical("/opt/raft-computer", stable),
    ),
    stable,
  );
});

test("cold dispatcher never mistakes an unpromoted experiment for stable", async () => {
  const experiment = kSlotBinaryPath(HOME, "experiment");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      "/opt/raft-computer",
      true,
      accessible(experiment),
      "linux",
      canonical("/opt/raft-computer", experiment),
    ),
    "/opt/raft-computer",
  );
});

test("live experiment uses itself before promote, then stable after its path is renamed", async () => {
  const stable = kSlotBinaryPath(HOME, "stable");
  const experiment = kSlotBinaryPath(HOME, "experiment");
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      experiment,
      true,
      accessible(stable, experiment),
      "linux",
      canonical(stable, experiment),
    ),
    experiment,
  );
  assert.equal(
    await resolveKResidentBinary(
      HOME,
      experiment,
      true,
      accessible(stable),
      "linux",
      canonical(stable),
    ),
    stable,
  );
});

test("live macOS experiment recognizes its /private/var real file alias", async () => {
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const current = `/private${experiment}`;
  const canonicalExperiment = `/private${experiment}`;
  const resolveRealPath = (filePath: string): string => {
    if (filePath === experiment || filePath === current) return canonicalExperiment;
    if (filePath === stable) return stable;
    throw new Error("ENOENT");
  };

  assert.equal(
    await resolveKResidentBinary(
      home,
      current,
      true,
      accessible(stable, experiment),
      "darwin",
      resolveRealPath,
    ),
    current,
  );
});

test("an unresolvable slot alias stays on the current binary", async () => {
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const current = `/private${experiment}`;

  assert.equal(
    await resolveKResidentBinary(
      home,
      current,
      true,
      accessible(stable, experiment),
      "darwin",
      () => { throw new Error("EACCES"); },
    ),
    current,
  );
});

test("Windows path casing cannot make a running stable SEA dispatch to itself forever", async () => {
  const stable = kSlotBinaryPath("C:\\Users\\Raft", "stable");
  const current = stable.toUpperCase();
  const chosen = await resolveKResidentBinary(
    "C:\\Users\\Raft",
    current,
    true,
    accessible(stable),
    "win32",
    canonical(stable, current),
  );
  assert.equal(chosen, current);
});

test("a re-staged experiment slot is not mistaken for the running binary (identity guard)", async () => {
  // K promoted the running experiment to stable, then staged the NEXT
  // candidate into the experiment path again: the startup path exists but its
  // bytes are the new candidate. The startup identity must route later spawns
  // to stable (upstream liveExecutable semantics; the spelling-based path
  // returned the experiment path — i.e. re-exec of an UNTESTED candidate).
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const chosen = await resolveKResidentBinary(
    home,
    experiment,
    true,
    accessible(experiment, stable),
    "darwin",
    () => { throw new Error("EACCES"); },
    {
      startupIdentity: () => "1:100",
      identityOf: (p) => (p === stable ? "1:100" : p === experiment ? "1:200" : null),
    },
  );
  assert.equal(chosen, stable, "the running bytes live at stable — spawns must follow the rename, not the re-staged path");
});

test("the identity guard does not override a genuine running experiment", async () => {
  // Before any promotion the running binary IS the experiment file: identity
  // matches the startup path and the resolver keeps using its own path.
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const chosen = await resolveKResidentBinary(
    home,
    experiment,
    true,
    accessible(experiment, stable),
    "darwin",
    () => { throw new Error("EACCES"); },
    {
      startupIdentity: () => "1:200",
      identityOf: (p) => (p === stable ? "1:100" : p === experiment ? "1:200" : null),
    },
  );
  assert.equal(chosen, experiment);
});

test("no usable startup identity keeps the spelling-based behavior", async () => {
  const home = "/var/folders/fixture/home/.slock";
  const experiment = kSlotBinaryPath(home, "experiment");
  const stable = kSlotBinaryPath(home, "stable");
  const chosen = await resolveKResidentBinary(
    home,
    experiment,
    true,
    accessible(experiment, stable),
    "darwin",
    () => { throw new Error("EACCES"); },
    {
      startupIdentity: () => null,
      identityOf: () => null,
    },
  );
  assert.equal(chosen, experiment, "without identity the experiment spelling still wins (pre-guard semantics)");
});
