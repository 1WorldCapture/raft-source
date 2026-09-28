// Sender-directory cache tests (#desktop-data-cache task #3): write, read,
// overwrite and wipe through the REAL repo (node:sqlite), plus the merge
// rules of collectSenderDirectory.
import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRepo } from "./repo.ts";
import { readSenderDirectory, writeSenderDirectory } from "./senderDirectory.ts";
import { collectSenderDirectory } from "../screens/senderAvatars.ts";

function repoWithScope() {
  const repo = createCacheRepo({ db: openNodeSqliteDb(":memory:") });
  const scope = repo.openScope("https://raft.example", "user-1", "srv-a");
  return { repo, scope };
}

test("write → read round-trips avatars and names", async () => {
  const { repo, scope } = repoWithScope();
  await writeSenderDirectory(repo, scope, {
    avatars: { "agent-1": "pixel:random:42", "user-2": "https://cdn.example/p.png" },
    names: { "agent-1": "Firstmate", "user-2": "lyonliang" },
  });
  assert.deepEqual(readSenderDirectory(repo, scope), {
    avatars: { "agent-1": "pixel:random:42", "user-2": "https://cdn.example/p.png" },
    names: { "agent-1": "Firstmate", "user-2": "lyonliang" },
  });
});

test("a newer write overwrites the snapshot wholesale (network truth wins)", async () => {
  const { repo, scope } = repoWithScope();
  await writeSenderDirectory(repo, scope, { avatars: { a: "pixel:x" }, names: { a: "A" } });
  await writeSenderDirectory(repo, scope, { avatars: { b: "pixel:y" }, names: {} });
  const cached = readSenderDirectory(repo, scope);
  assert.deepEqual(cached?.avatars, { b: "pixel:y" }, "removed senders disappear, not merge");
  assert.deepEqual(cached?.names, {});
});

test("absent value and malformed rows degrade to null / dropped entries", () => {
  const { repo, scope } = repoWithScope();
  assert.equal(readSenderDirectory(repo, scope), null, "nothing cached yet");
  const other = repo.openScope("https://raft.example", "user-1", "srv-b");
  assert.equal(readSenderDirectory(repo, other), null, "scopes are isolated per server");
});

test("wipeAll (logout / origin change) clears the directory", async () => {
  const { repo, scope } = repoWithScope();
  await writeSenderDirectory(repo, scope, { avatars: { a: "pixel:x" }, names: { a: "A" } });
  await repo.wipeAll();
  assert.equal(readSenderDirectory(repo, scope), null);
});

test("collectSenderDirectory merges agents (id) and members (userId), skipping deleted rows", () => {
  const directory = collectSenderDirectory(
    { agents: [{ id: "agent-1", name: "Firstmate", avatarUrl: "pixel:random:1" }, { id: "agent-2", name: "Gone", avatarUrl: "pixel:random:2", deletedAt: "2026-01-01" }] },
    { members: [{ userId: "user-1", displayName: "Lyon", avatarUrl: null }, { userId: "user-2", name: "Anna" }] },
  );
  assert.deepEqual(directory.avatars, { "agent-1": "pixel:random:1" }, "deleted agents and empty urls dropped");
  assert.deepEqual(directory.names, { "agent-1": "Firstmate", "user-1": "Lyon", "user-2": "Anna" }, "displayName preferred over name");
});
