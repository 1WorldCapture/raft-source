// desktop-data-cache task #5: opening a channel refreshes the newest 200
// messages of dynamic data; scrolling to older messages refreshes them once
// per boot; a failed fetch leaves no mark and backs off; disconnect clears
// the marks and invalidates in-flight fetches.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import api from "../src/api/client";
import {
  OVERLAY_MAX_FAILURES,
  OVERLAY_PAGE_SIZE,
  OVERLAY_RETRY_BASE_MS,
  invalidateOverlayMarksForDisconnect,
  overlayFetchPlan,
  refreshLatestOverlayPages,
  refreshVisibleOverlayPages,
  resetOverlayRefreshForTest,
  setOverlayRefreshClockForTest,
} from "../src/cache/overlayRefresh";
import { activeWebCache, clearActiveWebCache, setActiveWebCache } from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useThreadStore } from "../src/store/threadStore";

const SERIAL = { concurrency: false };

function message(seq: number, extra: Record<string, unknown> = {}): Message {
  return {
    id: `m${seq}`,
    seq,
    channelId: "c1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Tester",
    content: `message ${seq}`,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...extra,
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

function showInStore(seqs: number[]) {
  const rows = seqs.map((seq) => message(seq));
  useMessageStore.setState({ currentChannelId: "c1", channelMessages: { c1: rows }, messages: rows });
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

function afterParam(url: string): number {
  return Number(new URL(url, "http://local").searchParams.get("after"));
}

/** A fake GET /messages/channel/c1?after=&limit= over the channel's seqs. */
function channelServer(seqs: number[], decorate: (seq: number) => Record<string, unknown> = () => ({})) {
  const ordered = [...seqs].sort((a, b) => a - b);
  const urls: string[] = [];
  const handler = async (url: string) => {
    urls.push(url);
    const after = afterParam(url);
    const page = ordered.filter((seq) => seq > after).slice(0, OVERLAY_PAGE_SIZE);
    return { data: { messages: page.map((seq) => ({ ...message(seq), ...decorate(seq) })) } };
  };
  return { urls, handler };
}

afterEach(() => {
  resetOverlayRefreshForTest();
  resetStore();
  clearActiveWebCache();
});

test("fetch plan groups known seqs by 50, whatever their spacing in the global sequence", () => {
  const sparse = Array.from({ length: 120 }, (_, index) => 1_000 + index * 37);
  const plan = overlayFetchPlan(sparse);
  assert.deepEqual(plan.map((entry) => entry.fromSeq), [sparse[0], sparse[50], sparse[100]]);
  assert.equal(plan[0]!.expectedThroughSeq, sparse[49]);
  assert.equal(plan[2]!.expectedThroughSeq, Number.MAX_SAFE_INTEGER, "the newest group runs to the end of the channel");
});

test("opening a channel refreshes the newest 200 once, paints reactions, and leaves lastSeq alone", SERIAL, async (t) => {
  const { scopeId } = await attach();
  const seqs = Array.from({ length: 250 }, (_, index) => (index + 1) * 7);
  const server = channelServer(seqs, () => ({ reactions: [{ emoji: "👍", count: 2 }] }));
  t.mock.method(api, "get", server.handler);
  await seedSeqs(scopeId, seqs);
  showInStore([seqs.at(-1)!]);
  useMessageStore.setState({ lastSeq: 9_999 });

  await refreshLatestOverlayPages("c1");
  assert.deepEqual(server.urls.map(afterParam).sort((a, b) => a - b), [seqs[50]! - 1, seqs[100]! - 1, seqs[150]! - 1, seqs[200]! - 1]);
  assert.equal(
    (useMessageStore.getState().messages[0] as { reactions?: Array<{ emoji: string }> }).reactions?.[0]?.emoji,
    "👍",
  );
  assert.equal(useMessageStore.getState().lastSeq, 9_999, "an overlay refresh is not a seq catch-up");

  await refreshLatestOverlayPages("c1");
  assert.equal(server.urls.length, 4, "the same boot does not refresh the newest 200 twice");
});

test("new messages do not shift marks: covered messages never refetch", SERIAL, async (t) => {
  const { scopeId } = await attach();
  const seqs = Array.from({ length: 90 }, (_, index) => index + 1);
  const server = channelServer(seqs);
  t.mock.method(api, "get", server.handler);
  await seedSeqs(scopeId, seqs);
  showInStore(seqs);
  await refreshLatestOverlayPages("c1");
  assert.equal(server.urls.length, 2);

  // Two live messages arrive; every older message keeps its coverage.
  await seedSeqs(scopeId, [91, 92]);
  showInStore([...seqs, 91, 92]);
  refreshVisibleOverlayPages("c1", ["m1", "m60", "m92"]);
  await refreshLatestOverlayPages("c1");
  await flush();
  assert.equal(server.urls.length, 2, "the short newest page covered the channel's tail, including later arrivals");
});

test("scrolling refreshes an older, uncovered range once per boot", SERIAL, async (t) => {
  await attach();
  const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
  const server = channelServer(seqs);
  t.mock.method(api, "get", server.handler);
  showInStore(seqs);

  refreshVisibleOverlayPages("c1", ["m1", "m2"]);
  await flush();
  assert.deepEqual(server.urls.map(afterParam), [0]);
  refreshVisibleOverlayPages("c1", ["m1", "m30", "m50"]);
  await flush();
  assert.equal(server.urls.length, 1, "seqs 1-50 were covered by that fetch");
  refreshVisibleOverlayPages("c1", ["m51"]);
  await flush();
  assert.deepEqual(server.urls.map(afterParam), [0, 50]);
});

test("reconnect refreshes only the newest 200, however many messages are in memory", SERIAL, async (t) => {
  const { scopeId } = await attach();
  const seqs = Array.from({ length: 1_001 }, (_, index) => index + 1);
  const server = channelServer(seqs);
  t.mock.method(api, "get", server.handler);
  await seedSeqs(scopeId, seqs);
  showInStore(seqs);
  const socket = {
    connected: true,
    emit() { return undefined; },
    on() { return undefined; },
    off() { return undefined; },
    onAny() { return undefined; },
    offAny() { return undefined; },
    disconnect() { return undefined; },
    connect() { return undefined; },
  } as MainLayoutSocketBridgeSocket;
  const bindings = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined);
  bindings.find((binding: SocketBinding) => binding.event === "connect")!.handler(undefined);
  for (let i = 0; i < 5; i += 1) await flush();
  // The connect handler also reloads agents etc.; count channel page fetches only.
  const pageFetches = server.urls.filter((url) => url.startsWith("/messages/channel/c1?"));
  assert.equal(pageFetches.length, 4);
  assert.ok(pageFetches.map(afterParam).every((after) => after >= 801), "only the newest 200 seqs");
});

test("a failing page backs off and gives up after the retry budget; success clears it", SERIAL, async (t) => {
  await attach();
  let clock = 1_000_000;
  setOverlayRefreshClockForTest(() => clock);
  let calls = 0;
  let fail = true;
  t.mock.method(api, "get", async () => {
    calls += 1;
    if (fail) throw Object.assign(new Error("forbidden"), { response: { status: 403 } });
    return { data: { messages: [message(1)] } };
  });
  showInStore([1]);

  for (let i = 0; i < 10; i += 1) {
    refreshVisibleOverlayPages("c1", ["m1"]);
    await flush();
  }
  assert.equal(calls, 1, "ten scroll callbacks inside the backoff issue one request");

  for (let attempt = 1; attempt < OVERLAY_MAX_FAILURES; attempt += 1) {
    clock += OVERLAY_RETRY_BASE_MS * 2 ** (attempt - 1) + 1;
    refreshVisibleOverlayPages("c1", ["m1"]);
    await flush();
  }
  assert.equal(calls, OVERLAY_MAX_FAILURES);
  clock += OVERLAY_RETRY_BASE_MS * 2 ** OVERLAY_MAX_FAILURES;
  refreshVisibleOverlayPages("c1", ["m1"]);
  await flush();
  assert.equal(calls, OVERLAY_MAX_FAILURES, "the budget is spent for this boot");

  // A disconnect resets the budget; success then covers the page.
  await invalidateOverlayMarksForDisconnect();
  fail = false;
  refreshVisibleOverlayPages("c1", ["m1"]);
  await flush();
  refreshVisibleOverlayPages("c1", ["m1"]);
  await flush();
  assert.equal(calls, OVERLAY_MAX_FAILURES + 1);
});

test("an empty page (messages deleted server-side) counts as refreshed", SERIAL, async (t) => {
  await attach();
  let calls = 0;
  t.mock.method(api, "get", async () => {
    calls += 1;
    return { data: { messages: [] } };
  });
  showInStore([5, 6]);
  refreshVisibleOverlayPages("c1", ["m5"]);
  await flush();
  refreshVisibleOverlayPages("c1", ["m5", "m6"]);
  await flush();
  assert.equal(calls, 1);
});

test("a response that lands after a disconnect marks nothing, and reconnect fetches afresh", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  const releases: Array<() => void> = [];
  t.mock.method(api, "get", () => new Promise((resolve) => {
    releases.push(() => resolve({ data: { messages: [message(10)] } }));
  }));
  await seedSeqs(scopeId, [10]);
  showInStore([10]);

  const first = refreshLatestOverlayPages("c1");
  await flush();
  assert.equal(releases.length, 1);
  await invalidateOverlayMarksForDisconnect();
  releases[0]!();
  await first;
  assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 10), null, "the pre-disconnect response is dropped");

  const second = refreshLatestOverlayPages("c1");
  await flush();
  assert.equal(releases.length, 2, "reconnect does not reuse the pre-disconnect in-flight request");
  releases[1]!();
  await second;
  assert.equal((await repo.getOverlayPageInfo(scopeId, "c1", 10))?.bootId, repo.bootId);
});

test("thread summaries go through the bundled-summary hydrator", SERIAL, async (t) => {
  await attach();
  const summary = { threadChannelId: "t-10", replyCount: 3, lastReplyAt: "2026-09-29T00:00:00.000Z" };
  t.mock.method(api, "get", async () => ({
    data: { messages: [message(10)], threadSummariesByParentMessageId: { m10: summary } },
  }));
  showInStore([10]);
  refreshVisibleOverlayPages("c1", ["m10"]);
  await flush();
  assert.equal(useThreadStore.getState().summaries.m10?.replyCount, 3);
});

test("the store keeps rows updated while the request was in flight, or newer by updatedAt", SERIAL, async (t) => {
  await attach();
  let release: (() => void) | null = null;
  t.mock.method(api, "get", () => new Promise((resolve) => {
    release = () => resolve({
      data: {
        messages: [
          message(1, { reactions: [{ emoji: "👀", count: 1 }], updatedAt: "2026-09-29T00:00:01.000Z" }),
          message(2, { reactions: [{ emoji: "👀", count: 1 }], updatedAt: "2026-09-29T00:00:01.000Z" }),
          message(3, { updatedAt: "2026-09-29T00:00:01.000Z" }),
        ],
      },
    });
  }));
  const newer = message(2, { reactions: [{ emoji: "🎉", count: 5 }], updatedAt: "2026-09-29T00:00:09.000Z" });
  const unchanged = message(3, { updatedAt: "2026-09-29T00:00:01.000Z" });
  useMessageStore.setState({
    currentChannelId: "c1",
    channelMessages: { c1: [message(1), newer, unchanged] },
    messages: [message(1), newer, unchanged],
  });

  refreshVisibleOverlayPages("c1", ["m1", "m2", "m3"]);
  await flush();
  // message:updated lands for m1 while the page request is in flight.
  const live = message(1, { reactions: [{ emoji: "🔥", count: 1 }] });
  useMessageStore.setState((state) => ({
    channelMessages: { c1: [live, ...state.channelMessages.c1!.slice(1)] },
  }));
  release!();
  await flush();

  const rows = useMessageStore.getState().channelMessages.c1!;
  assert.equal((rows[0] as { reactions?: Array<{ emoji: string }> }).reactions?.[0]?.emoji, "🔥", "in-flight live update wins");
  assert.equal((rows[1] as { reactions?: Array<{ emoji: string }> }).reactions?.[0]?.emoji, "🎉", "newer updatedAt wins");
  assert.equal(rows[2], unchanged, "a structurally equal row keeps its reference");
});

test("disconnect binding clears overlay marks for the attached scope", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  t.mock.method(api, "get", async () => ({ data: { messages: [message(10)] } }));
  const socket = {
    connected: true,
    emit() { return undefined; },
    on() { return undefined; },
    off() { return undefined; },
    onAny() { return undefined; },
    offAny() { return undefined; },
    disconnect() { return undefined; },
    connect() { return undefined; },
  } as MainLayoutSocketBridgeSocket;
  await seedSeqs(scopeId, [10]);
  await refreshLatestOverlayPages("c1");
  assert.ok(await repo.getOverlayPageInfo(scopeId, "c1", 10));
  const bindings = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined);
  bindings.find((binding: SocketBinding) => binding.event === "disconnect")!.handler(undefined);
  await flush();
  assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 10), null);
});

test("a scope change during the fetch marks nothing", SERIAL, async (t) => {
  const { repo, scopeId } = await attach();
  let release: (() => void) | null = null;
  t.mock.method(api, "get", () => new Promise((resolve) => {
    release = () => resolve({ data: { messages: [message(10)] } });
  }));
  await seedSeqs(scopeId, [10]);
  const pending = refreshLatestOverlayPages("c1");
  await flush();
  clearActiveWebCache();
  release!();
  await pending;
  setActiveWebCache(repo, scopeId, "srv-1");
  assert.equal(await repo.getOverlayPageInfo(scopeId, "c1", 10), null);
});
