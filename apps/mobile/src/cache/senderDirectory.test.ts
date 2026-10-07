// Sender-directory cache tests (#desktop-data-cache task #3): write, read,
// overwrite and wipe through the REAL repo (node:sqlite), plus the merge
// rules of collectSenderDirectory.
import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import { createCacheRepo } from "./repo.ts";
import { readSenderDirectory, writeSenderDirectory } from "./senderDirectory.ts";
import { collectSenderDirectory, senderDirectoryStep } from "../screens/senderAvatars.ts";

function repoWithScope() {
  const repo = createCacheRepo({ db: openNodeSqliteDb(":memory:") });
  const scope = repo.openScopeSync("https://raft.example", "user-1", "srv-a");
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
  const other = repo.openScopeSync("https://raft.example", "user-1", "srv-b");
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

test("the directory gate re-seeds and refetches after clearServerData (logout / server switch)", async () => {
  const { useRaftStore } = await import("../state/store.ts");
  const resetGate = () => useRaftStore.getState().clearServerData();

  // Fresh process: seed + fetch on the first channel open.
  assert.deepEqual(senderDirectoryStep({ seededServer: null, freshServer: null }, "srv-a"), { seed: true, fetch: true });
  // Seeded but network not yet answered: no double seed, fetch still due.
  assert.deepEqual(senderDirectoryStep({ seededServer: "srv-a", freshServer: null }, "srv-a"), { seed: false, fetch: true });
  // Fresh network load: nothing more to do this process.
  assert.deepEqual(senderDirectoryStep({ seededServer: "srv-a", freshServer: "srv-a" }, "srv-a"), { seed: false, fetch: false });
  // Another server (switch): seed + fetch for it, old server's marks irrelevant.
  assert.deepEqual(senderDirectoryStep({ seededServer: "srv-a", freshServer: "srv-a" }, "srv-b"), { seed: true, fetch: true });

  // The store fields drive the gate and clearServerData resets them — the
  // re-login-on-same-server bug the review caught.
  useRaftStore.getState().markSenderDirectory("seeded", "srv-a");
  useRaftStore.getState().markSenderDirectory("fresh", "srv-a");
  useRaftStore.getState().setSenderAvatars({ a: "pixel:x" });
  assert.equal(useRaftStore.getState().senderDirectoryFreshServer, "srv-a");
  resetGate();
  assert.equal(useRaftStore.getState().senderAvatars.a, undefined, "logout clears the painted avatars");
  assert.equal(useRaftStore.getState().senderDirectorySeededServer, null, "seed gate cleared");
  assert.equal(useRaftStore.getState().senderDirectoryFreshServer, null, "fresh gate cleared");
  const gate = {
    seededServer: useRaftStore.getState().senderDirectorySeededServer,
    freshServer: useRaftStore.getState().senderDirectoryFreshServer,
  };
  assert.deepEqual(senderDirectoryStep(gate, "srv-a"), { seed: true, fetch: true }, "re-login on the same server reseeds and refetches");
});
