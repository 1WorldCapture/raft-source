import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "./portNode.ts";
import type { ApiClient } from "../api/client";
import { initCacheRuntime, getCacheRuntime } from "./runtime.ts";
import {
  cancelCacheSync,
  invalidateOverlayMarksForDisconnect,
  noteReadState,
  refreshOverlayIntoStore,
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

test("gap-sync raw payloads carry a NUMBER seq inside bodyRaw (seed-path contract)", async () => {
  // Postmortem #2: the fetcher normalized only the outer {seq} but stored the
  // raw payload as-is — bodyRaw.seq stayed a string, parseMessage dropped it
  // to undefined on the seed path, and minSeq(visible) came back null so the
  // overlay refresh (and markRead / window logic) never fired.
  const runtime = freshRuntime();
  const page: unknown[] = [
    { seq: "11", id: "m11", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "x" },
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
  const rows = runtime.repo.getLatestMessages(runtime.scopeId!, "c1", 5);
  assert.equal(rows.length, 1);
  const raw = rows[0]!.raw as Record<string, unknown>;
  assert.equal(typeof raw.seq, "number", "bodyRaw.seq must be a number for the seed path");
  assert.equal(raw.seq, 11);
});

test("refreshOverlayIntoStore lands the fetched page in the UI store in place", async () => {
  const runtime = freshRuntime();
  await runtime.repo.appendPage(runtime.scopeId!, "c1", {
    messages: [{ seq: 1, id: "m1", raw: { id: "m1", seq: 1, channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "old", reactions: [] } }],
    window: { coveredFromSeq: 1, coveredThroughSeq: 1, hasGap: false },
  });
  const client: FakeClient = {
    syncCalls: 0,
    get: (path: string) => {
      if (path.startsWith("/messages/channel/")) {
        return Promise.resolve({
          messages: [
            { id: "m1", seq: 1, channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "old", reactions: [{ emoji: "👍", count: 1 }] },
          ],
          messageWindow: { coveredFromSeq: 1, coveredThroughSeq: 1, hasGap: false },
          threadSummariesByParentMessageId: {},
        });
      }
      if (!path.startsWith("/messages/sync")) return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
  const { useRaftStore } = await import("../state/store.ts");
  const before = useRaftStore.getState().messagesByChannel["c1"] ?? [];
  assert.equal(before.length, 0, "store starts empty for this channel");
  const out = await refreshOverlayIntoStore(client as unknown as ApiClient, "c1", 1, 1);
  assert.deepEqual(out, { refreshed: true, reason: "done" });
  const after = useRaftStore.getState().messagesByChannel["c1"] ?? [];
  assert.equal(after.length, 1, "the refreshed page is upserted into the store");
  assert.equal(after[0]!.reactions?.[0]?.emoji, "👍");
  assert.equal(after[0]!.reactions?.[0]?.count, 1, "fresh reaction data is visible in place");
});

test("a disconnect clears the once-per-boot overlay markers so reconnect re-refreshes", async () => {
  // desktop-data-cache task #2: a page refreshed earlier this boot used to
  // stay stale across a disconnect→reconnect cycle (the marker survived).
  const runtime = freshRuntime();
  let fetches = 0;
  const page = (): unknown[] => [
    { seq: 3, id: "m3", channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "x" },
  ];
  const client: FakeClient = {
    syncCalls: 0,
    get: (path: string) => {
      if (path.startsWith("/messages/channel/")) {
        fetches += 1;
        return Promise.resolve({ messages: page(), messageWindow: { coveredFromSeq: 3, coveredThroughSeq: 3, hasGap: false } });
      }
      if (!path.startsWith("/messages/sync")) return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
  await runtime.repo.appendPage(runtime.scopeId!, "c1", {
    messages: [{ seq: 3, id: "m3", raw: { id: "m3", seq: 3, channelId: "c1", senderId: "u", senderType: "user", createdAt: "t", content: "x" } }],
    window: { coveredFromSeq: 3, coveredThroughSeq: 3, hasGap: false },
  });
  await refreshOverlayIntoStore(client as unknown as ApiClient, "c1", 3, 3);
  assert.equal(fetches, 1);
  // Gated: same boot, marker present.
  await refreshOverlayIntoStore(client as unknown as ApiClient, "c1", 3, 3);
  assert.equal(fetches, 1, "same-boot refresh is gated by the marker");
  // Disconnect clears the markers (data kept)...
  await invalidateOverlayMarksForDisconnect();
  // ...so the reconnect refresh re-pulls.
  await refreshOverlayIntoStore(client as unknown as ApiClient, "c1", 3, 3);
  assert.equal(fetches, 2, "after a disconnect the refresh re-pulls");
});
