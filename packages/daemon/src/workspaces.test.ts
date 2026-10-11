import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces.js";

test("scanWorkspaceDirectories summarizes workspace directories recursively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-"));
  try {
    const firstDir = path.join(root, "agent-one");
    const secondDir = path.join(root, "agent-two");
    await mkdir(firstDir);
    await mkdir(secondDir);
    await writeFile(path.join(firstDir, "notes.md"), "hello");
    await writeFile(path.join(firstDir, "config.json"), "{\"ok\":true}");
    await mkdir(path.join(firstDir, "nested"));
    await writeFile(path.join(firstDir, "nested", "child.txt"), "nested");
    await writeFile(path.join(secondDir, "README.txt"), "x");

    const directories = await scanWorkspaceDirectories(root);
    const first = directories.find((entry) => entry.directoryName === "agent-one");
    const second = directories.find((entry) => entry.directoryName === "agent-two");

    assert.ok(first);
    assert.equal(first.fileCount, 3);
    assert.equal(
      first.totalSizeBytes,
      Buffer.byteLength("hello") + Buffer.byteLength("{\"ok\":true}") + Buffer.byteLength("nested"),
    );
    assert.notEqual(first.lastModified, new Date(0).toISOString());

    assert.ok(second);
    assert.equal(second.fileCount, 1);
    assert.equal(second.totalSizeBytes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceDirectoryPath rejects path traversal", () => {
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1"), path.join("/tmp/daemon", "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "../agent-1"), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "nested/agent-1"), null);
});

test("deleteWorkspaceDirectory removes only valid workspace directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-delete-"));
  try {
    const targetDir = path.join(root, "agent-delete");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "delete-me");

    assert.equal(await deleteWorkspaceDirectory(root, "agent-delete"), true);
    assert.deepEqual(await scanWorkspaceDirectories(root), []);
    assert.equal(await deleteWorkspaceDirectory(root, "../outside"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceDirectoryPath only accepts exactly one path segment below the data dir", () => {
  const dataDir = path.join(path.sep, "tmp", "daemon");
  for (const bad of [".", "", "..", "../x", "nested/x", "a\\b", "x/..", "./x", "x/", "/abs", "a\0b"]) {
    assert.equal(resolveWorkspaceDirectoryPath(dataDir, bad), null, JSON.stringify(bad));
  }
  assert.equal(resolveWorkspaceDirectoryPath(dataDir, "agent-1"), path.join(dataDir, "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath(dataDir, "3fa7c2d2-e3a8-42fe-bfb4-ee706129c53b"), path.join(dataDir, "3fa7c2d2-e3a8-42fe-bfb4-ee706129c53b"));
  assert.equal(resolveWorkspaceDirectoryPath(`${dataDir}${path.sep}`, "agent-1"), path.join(dataDir, "agent-1"), "a trailing separator on the data dir is fine");
});

test("deleteWorkspaceDirectory refuses '.', '' and traversal and deletes nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-guard-"));
  try {
    const keepA = path.join(root, "agent-a");
    const keepB = path.join(root, "agent-b");
    await mkdir(keepA);
    await mkdir(keepB);
    await writeFile(path.join(keepA, "MEMORY.md"), "a");
    await writeFile(path.join(keepB, "MEMORY.md"), "b");
    await writeFile(path.join(root, "outside-sibling.txt"), "x");
    for (const bad of [".", "", "..", "../x", "nested/x", "agent-a/..", "./agent-a"]) {
      assert.equal(await deleteWorkspaceDirectory(root, bad), false, JSON.stringify(bad));
    }
    const left = (await scanWorkspaceDirectories(root)).map((entry) => entry.directoryName).sort();
    assert.deepEqual(left, ["agent-a", "agent-b"]);
    assert.equal((await scanWorkspaceDirectories(root)).length, 2);
    // A legitimate single-segment delete still works and touches only that directory.
    assert.equal(await deleteWorkspaceDirectory(root, "agent-a"), true);
    assert.deepEqual((await scanWorkspaceDirectories(root)).map((entry) => entry.directoryName), ["agent-b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
