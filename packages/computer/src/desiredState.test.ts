import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  desiredStatePath,
  parseDesiredState,
  readDesiredState,
  writeDesiredState,
} from "./desiredState.js";

test("parseDesiredState: stopped is honored; anything else falls back to running", () => {
  assert.equal(parseDesiredState({ state: "stopped" }), "stopped");
  assert.equal(parseDesiredState({ state: "running" }), "running");
  assert.equal(parseDesiredState({}), "running");
  assert.equal(parseDesiredState(null), "running");
  assert.equal(parseDesiredState("stopped"), "running");
  assert.equal(parseDesiredState(undefined), "running");
});

test("readDesiredState: missing file reads as running (pre-extract behaviour)", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desired-state-"));
  try {
    assert.equal(await readDesiredState(home), "running");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("readDesiredState: unreadable/corrupt file reads as running", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desired-state-"));
  try {
    await mkdir(path.dirname(desiredStatePath(home)), { recursive: true });
    await writeFile(desiredStatePath(home), "{ not json", "utf8");
    assert.equal(await readDesiredState(home), "running");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("writeDesiredState: round-trips and stamps schemaVersion, creates dirs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desired-state-"));
  try {
    await writeDesiredState(home, "stopped");
    const raw = JSON.parse(await readFile(desiredStatePath(home), "utf8")) as {
      schemaVersion: number;
      state: string;
      updatedAt: string;
    };
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.state, "stopped");
    assert.ok(!Number.isNaN(Date.parse(raw.updatedAt)));
    assert.equal(await readDesiredState(home), "stopped");

    await writeDesiredState(home, "running");
    assert.equal(await readDesiredState(home), "running");
    // No .tmp leftovers after rename.
    await assert.rejects(() => readFile(`${desiredStatePath(home)}.tmp`, "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
