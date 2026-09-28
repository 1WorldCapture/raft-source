import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import type { ApiClient } from "../api/client";
import { initCacheRuntime, getCacheRuntime } from "./runtime.ts";
import {
  cancelCacheSync,
  noteReadState,
  runCacheGapSync,
} from "./cacheSyncRuntime.ts";

// client-data-cache task #3 review fixes — the runtime bridge tested against
// a REAL node:sqlite runtime (initCacheRuntime injected) and a fake ApiClient
// whose /messages/sync answers we control, including deferred promises.

const SCOPE = { origin: "https://a.example", userId: "user-1", serverId: "srv-1" };

type FakeClient = {
  get: (path: string) => Promise<unknown>;
  syncCalls: number;
};

function makeClient(pages: Array<() => Promise<unknown[]>>): FakeClient {
  let call = 0;
  const client: FakeClient = {
    syncCalls: 0,
    get: (path: string) => {
      if (!path.startsWith("/messages/sync")) return Promise.resolve({});
      client.syncCalls += 1;
      const responder = call < pages.length ? pages[call] : undefined;
      call += 1;
      // Beyond the scripted pages: empty page (the loop terminates).
      return responder ? responder().then((messages) => ({ messages })) : Promise.resolve({ messages: [] });
    },
  };
  return client;
}

function freshRuntime() {
  const runtime = initCacheRuntime({ openDb: () => openNodeSqliteDb(":memory:") });
  runtime.attach(SCOPE.origin, SCOPE.userId, SCOPE.serverId);
  return runtime;
}

test("cancelCacheSync aborts an in-flight gap sync before its next batch", async () => {
  const runtime = freshRuntime();
  let releaseSecond: (() => void) | null = null;
  const client = makeClient([
    () => Promise.resolve([{ seq: 1, id: "m1", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t" }]),
    () => new Promise((resolve) => { releaseSecond = () => resolve([{ seq: 900, id: "m900", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t" }]); }),
  ]);

  const running = runCacheGapSync(client as unknown as ApiClient);
  void running;
  await new Promise((r) => setTimeout(r, 0));
  // While the second fetch is parked, cancel — the logout path.
  cancelCacheSync();
  releaseSecond?.();
  await running;

  const repo = getCacheRuntime().repo;
  assert.equal(repo.getLatestMessages(runtime.scopeId!, "c1", 100).some((m) => m.seq === 900), false,
    "cancelled round must not land the post-cancel batch");
});

test("runCacheGapSync is single-flight: concurrent calls share one loop", async () => {
  freshRuntime();
  let releaseFirst: (() => void) | null = null;
  const client = makeClient([
    () => new Promise((resolve) => { releaseFirst = () => resolve([{ seq: 1, id: "m1", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t" }]); }),
  ]);

  const first = runCacheGapSync(client as unknown as ApiClient);
  const second = runCacheGapSync(client as unknown as ApiClient);
  assert.equal(first === second, true, "second call joins the in-flight round");
  releaseFirst?.();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(client.syncCalls <= 3, true, "no unbounded extra rounds");
});

test("noteReadState writes server-provided values only while a scope is attached", async () => {
  const runtime = freshRuntime();
  const client = makeClient([]);
  noteReadState(client as unknown as ApiClient, [{ channelId: "c1", maxReadSeq: 42, readStateVersion: 7, serverId: SCOPE.serverId }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(getCacheRuntime().repo.getReadStates(runtime.scopeId!).c1, { maxReadSeq: 42, version: 7 });

  await runtime.logout();
  noteReadState(client as unknown as ApiClient, [{ channelId: "c1", maxReadSeq: 99, readStateVersion: 8, serverId: SCOPE.serverId }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(getCacheRuntime().repo.getReadStates(runtime.scopeId!), {},
    "no scope attached — the write is dropped, wiped data stays wiped");
});

test("fetchSyncPage persists rows with string seqs from the live /messages/sync shape", async () => {
  // Device postmortem: the server's /messages/sync returns a BARE array
  // (unlike /messages/channel) and serializes seq as a JSON string (pg
  // bigserial via the raw row path). Both shapes must persist — the old
  // parseMessage-based path silently dropped every row and the gap sync
  // converged at cursor maxSeq=0 with zero messages cached.
  const runtime = freshRuntime();
  // One page mixing the live bare-array shape with string seqs and a
  // numeric seq, plus the {messages:[...]} wrapper shape seen in fixtures —
  // all must land. (A short page ends the loop, so everything rides one response.)
  const page: unknown[] = [
    { seq: "7", id: "m7", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "bare-string" },
    { seq: 8, id: "m8", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "number" },
    { seq: "not-a-number", id: "m9", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "junk" },
  ];
  const client: FakeClient = {
    syncCalls: 0,
    get: (path: string) => {
      if (!path.startsWith("/messages/sync")) return Promise.resolve({});
      client.syncCalls += 1;
      return Promise.resolve(client.syncCalls === 1 ? page : []);
    },
  };
  await runCacheGapSync(client as unknown as ApiClient);
  const scopeId = runtime.scopeId!;
  const rows = runtime.repo.getLatestMessages(scopeId, "c1", 10);
  assert.deepEqual(rows.map((r) => r.seq), [8, 7], "string seq 7, number seq 8 land; junk seq dropped");
  const cursor = runtime.repo.getKv(scopeId, "syncCursor");
  assert.match(JSON.stringify(cursor), /"maxSeq":8/, "cursor advances to the normalized max");
});
