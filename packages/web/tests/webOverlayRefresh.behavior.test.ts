// desktop-data-cache task #5: opening a channel refreshes the newest 200
// messages of dynamic data; scrolling to an older page refreshes that page
// once per boot; a failed fetch leaves no marker; disconnect clears markers.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";
import {
  OVERLAY_PAGE_SIZE,
  invalidateOverlayMarksForDisconnect,
  overlayPagesFromSeqs,
  refreshLatestOverlayPages,
  refreshVisibleOverlayPages,
} from "../src/cache/overlayRefresh";
import { activeWebCache, clearActiveWebCache, setActiveWebCache } from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";

const SERIAL = { concurrency: false };

function message(seq: number, channelId = "c1"): Message {
  return {
    id: `m${seq}`,
    seq,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Tester",
    content: `message ${seq}`,
    createdAt: "2026-09-29T00:00:00.000Z",
  } as Message;
}

async function attach() {
  clearActiveWebCache();
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "srv-1");
  setActiveWebCache(repo, scopeId, "srv-1");
  return { repo, scopeId };
}

async function seedSeqs(scopeId: number, seqs: number[]) {
  const repo = activeWebCache()!.repo;
  await repo.appendPage(scopeId, "c1", {
    messages: seqs.map((seq) => ({
      seq,
      id: `m${seq}`,
      raw: message(seq) as unknown as Record<string, unknown>,
    })),
  });
}

function resetStore() {
  useMessageStore.setState({
    channelMessages: {},
    messages: [],
    currentChannelId: null,
    lastSeq: 0,
  });
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function afterParams(urls: string[]): number[] {
  return urls.map((url) => Number(new URL(url, "http://local").searchParams.get("after"))).sort((a, b) => a - b);
}

test("overlay pages are groups of 50, newest first, capped at 200", () => {
  const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
  const pages = overlayPagesFromSeqs(seqs, 200);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((page) => page.fromSeq), [201, 151, 101, 51]);
  assert.equal(pages[0]!.seqs.length, OVERLAY_PAGE_SIZE);
  assert.equal(overlayPagesFromSeqs(seqs).length, 5, "without the open cap the older page stays");
});

test("opening a channel refreshes four pages once, and paints reactions without moving lastSeq", SERIAL, async (t) => {
  const { scopeId } = await attach();
  const urls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    urls.push(url);
    const after = Number(new URL(url, "http://local").searchParams.get("after"));
    const seq = after + OVERLAY_PAGE_SIZE;
    return {
      data: {
        messages: [{ ...message(seq), reactions: [{ emoji: "👍", count: 2 }] }],
      },
    };
  });
  try {
    await seedSeqs(scopeId, Array.from({ length: 200 }, (_, index) => index + 1));
    const visible = message(200);
    useMessageStore.setState({
      currentChannelId: "c1",
      channelMessages: { c1: [visible] },
      messages: [visible],
      lastSeq: 999,
    });

    await refreshLatestOverlayPages("c1");
    assert.deepEqual(afterParams(urls), [0, 50, 100, 150]);
    assert.equal(
      (useMessageStore.getState().messages[0] as { reactions?: Array<{ emoji: string }> }).reactions?.[0]?.emoji,
      "👍",
    );
    assert.equal(useMessageStore.getState().lastSeq, 999, "an overlay refresh is not a seq catch-up");

    await refreshLatestOverlayPages("c1");
    assert.equal(urls.length, 4, "the same boot does not refresh a page twice");
  } finally {
    resetStore();
    clearActiveWebCache();
  }
});

test("scrolling to an older page refreshes it once per boot", SERIAL, async (t) => {
  await attach();
  const urls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    urls.push(url);
    return { data: { messages: [message(1)] } };
  });
  try {
    const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
    useMessageStore.setState({
      currentChannelId: "c1",
      channelMessages: { c1: seqs.map((seq) => message(seq)) },
      messages: seqs.map((seq) => message(seq)),
      lastSeq: 250,
    });
    refreshVisibleOverlayPages("c1", ["m1"]);
    await flush();
    assert.deepEqual(afterParams(urls), [0], "the oldest page is the one that scrolled into view");
    refreshVisibleOverlayPages("c1", ["m1"]);
    await flush();
    assert.equal(urls.length, 1);
  } finally {
    resetStore();
    clearActiveWebCache();
  }
});

test("a failed refresh does not stamp, and disconnect clears a stamp", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  let fail = true;
  let calls = 0;
  t.mock.method(api, "get", async () => {
    calls += 1;
    if (fail) throw new Error("offline");
    return { data: { messages: [message(50)] } };
  });
  try {
    await seedSeqs(scopeId, Array.from({ length: 50 }, (_, index) => index + 1));
    await refreshLatestOverlayPages("c1");
    assert.equal(calls, 1);
    assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 1), null, "failure leaves the marker unset");

    fail = false;
    await refreshLatestOverlayPages("c1");
    assert.equal(calls, 2);
    assert.equal((await repo.getOverlayPageInfo(scopeId, "c1", 1))?.bootId, repo.bootId);

    await refreshLatestOverlayPages("c1");
    assert.equal(calls, 2, "stamped page is skipped");

    await invalidateOverlayMarksForDisconnect();
    assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 1), null);
    const kept = await repo.getLatestMessages(scopeId, "c1", 1);
    assert.equal(kept.length, 1, "clearing markers keeps the cached messages");

    await refreshLatestOverlayPages("c1");
    assert.equal(calls, 3, "after disconnect the page refreshes again");
  } finally {
    resetStore();
    clearActiveWebCache();
  }
});

test("disconnect binding clears overlay marks for the attached scope", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  t.mock.method(api, "get", async () => ({ data: { messages: [message(10)] } }));
  const socket: MainLayoutSocketBridgeSocket = {
    connected: true,
    emit() { return undefined; },
    on() { return undefined; },
    off() { return undefined; },
    onAny() { return undefined; },
    offAny() { return undefined; },
    disconnect() { return undefined; },
  };
  try {
    await seedSeqs(scopeId, [10]);
    await refreshLatestOverlayPages("c1");
    assert.ok(await repo.getOverlayPageInfo(scopeId, "c1", 10));
    const bindings = buildMainLayoutSocketBindings(
      socket,
      () => undefined,
      async () => undefined,
      () => undefined,
      () => undefined,
    );
    const disconnect = bindings.find((binding: SocketBinding) => binding.event === "disconnect");
    assert.ok(disconnect);
    disconnect!.handler(undefined);
    await flush();
    assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 10), null);
  } finally {
    resetStore();
    clearActiveWebCache();
  }
});

test("a scope change during the fetch does not stamp the page", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  let release: (() => void) | null = null;
  t.mock.method(api, "get", () => new Promise((resolve) => {
    release = () => resolve({ data: { messages: [message(10)] } });
  }));
  try {
    await seedSeqs(scopeId, [10]);
    const pending = refreshLatestOverlayPages("c1");
    await flush();
    clearActiveWebCache();
    release!();
    await pending;
    setActiveWebCache(repo, scopeId, "srv-1");
    assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 10), null);
  } finally {
    resetStore();
    clearActiveWebCache();
  }
});
