// Task #11 (G2): promote's aside-move must PRESERVE the original rename
// error instead of swallowing it. The pre-fix bare catch(() => {}) destroyed
// the errno, so any first-step failure (permissions / IO / cross-device)
// resurfaced later as a misleading ENOTEMPTY on the NEXT rename — the
// evidence gone exactly when diagnosis needed it. These tests run the REAL
// fileSlotStore.promoteExperiment of the actually-installed patched
// dependency, with deterministic fault injection:
//   - EACCES on the aside-move rethrows as K_PROMOTE_FAILED with the original
//     errno as the cause (never变形 as ENOTEMPTY);
//   - the crash-redo idempotence shape (stable already moved aside) still
//     completes;
//   - the happy path promotes atomically end to end.
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { fileSlotStore } from "@botiverse/k-carrier";

async function slotsFixture(): Promise<string> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-promote-"));
  const stable = path.join(stateDir, "slots", "stable");
  const experiment = path.join(stateDir, "slots", "experiment");
  await mkdir(stable, { recursive: true });
  await mkdir(experiment, { recursive: true });
  await writeFile(path.join(stable, "VERSION"), "9.9.90");
  await writeFile(path.join(stable, "artifact.bin"), "old-bytes");
  await writeFile(path.join(experiment, "VERSION"), "9.9.91");
  await writeFile(path.join(experiment, "artifact.bin"), "new-bytes");
  return stateDir;
}

test("injected EACCES on the aside-move rethrows with the ORIGINAL errno, never ENOTEMPTY", { timeout: 10_000 }, async () => {
  const stateDir = await slotsFixture();
  const slots = path.join(stateDir, "slots");
  // Deterministic fault injection: make the PARENT directory non-writable so
  // rename(stable -> stable.old) fails with EACCES on a real filesystem.
  await chmod(slots, 0o555);
  try {
    const store = fileSlotStore(stateDir);
    await assert.rejects(
      store.promoteExperiment(),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
        assert.match(message, /K_PROMOTE_FAILED/);
        assert.equal(cause?.code, "EACCES", "the ORIGINAL errno must survive as the cause");
        assert.doesNotMatch(message, /ENOTEMPTY/, "the failure must not变形 into the next rename's ENOTEMPTY");
        return true;
      },
    );
  } finally {
    await chmod(slots, 0o755);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("crash-redo idempotence: stable already moved aside still completes the promote", { timeout: 10_000 }, async () => {
  const stateDir = await slotsFixture();
  try {
    // The mid-promote crash shape: step 1 happened (stable -> stable.old),
    // steps 2/3 did not. The redo must proceed, not fail on the missing
    // stable directory.
    await chmod(path.join(stateDir, "slots"), 0o755).catch(() => {});
    const { rename } = await import("node:fs/promises");
    await rename(path.join(stateDir, "slots", "stable"), path.join(stateDir, "slots", "stable.old"));
    const store = fileSlotStore(stateDir);
    await store.promoteExperiment();
    const promoted = await readFile(path.join(stateDir, "slots", "stable", "VERSION"), "utf8");
    assert.equal(promoted, "9.9.91");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("happy path: promote swaps atomically and cleans the aside copy", { timeout: 10_000 }, async () => {
  const stateDir = await slotsFixture();
  try {
    const store = fileSlotStore(stateDir);
    await store.promoteExperiment();
    const promoted = await readFile(path.join(stateDir, "slots", "stable", "VERSION"), "utf8");
    assert.equal(promoted, "9.9.91");
    const versions = await store.slotVersions();
    assert.equal(versions.stable, "9.9.91");
    assert.equal(versions.experiment, null);
    await assert.rejects(
      readFile(path.join(stateDir, "slots", "stable.old", "VERSION")),
      /ENOENT/,
      "the aside copy must be cleaned",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
