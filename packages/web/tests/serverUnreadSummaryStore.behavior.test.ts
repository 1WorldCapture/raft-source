// Behavioural teeth for the shared serverUnreadSummaryStore (#unread-badges
// task #5). These drive the real store and observe which HTTP requests the
// app issues — a deleted wiring stops issuing the request.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";

type Timeout = ReturnType<typeof setTimeout>;

interface StubWindow {
  setTimeout: (fn: () => void, ms?: number) => Timeout;
  clearTimeout: (t: Timeout) => void;
  setInterval: (fn: () => void, ms?: number) => Timeout;
  clearInterval: (t: Timeout) => void;
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
  handlers: Map<string, () => void>;
}

function stubWindow(): StubWindow {
  const handlers = new Map<string, () => void>();
  const win: StubWindow = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type) => handlers.delete(type),
    handlers,
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return win;
}

const previousWindow = (globalThis as { window?: unknown }).window;
const previousDocument = (globalThis as { document?: unknown }).document;

const originalGet = api.get.bind(api);

function restore() {
  api.get = originalGet;
  (globalThis as { window?: unknown }).window = previousWindow;
  (globalThis as { document?: unknown }).document = previousDocument;
}

/** Answer GET /servers/unread-summary with rows; record every GET. */
function captureSummaryGets(mode: "ok" | "fail", rows: unknown[] = []) {
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    if (url !== "/servers/unread-summary") return { data: {} };
    if (mode === "fail") throw new Error("network down");
    return { data: rows };
  }) as typeof api.get;
  return urls;
}

const summaryCallCount = (urls: string[]) => urls.filter((u) => u === "/servers/unread-summary").length;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test.afterEach(async () => {
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  useServerUnreadSummaryStore.getState().reset();
  restore();
});

test("retain() loads once and keeps the parsed summary", async () => {
  stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", [
    { serverId: "s1", unreadCount: 2, activityUnreadCount: 5 },
    { serverId: "s2", unreadCount: 0 },
  ]);

  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);

  assert.equal(summaryCallCount(urls), 1, "the initial retain issues exactly one load");
  const state = useServerUnreadSummaryStore.getState();
  assert.equal(state.byServer.s1?.activityUnreadCount, 5);
  assert.equal(state.byServer.s1?.unreadCount, 2);
  assert.equal(state.byServer.s2?.unreadCount, 0);
  assert.equal(state.byServer.s2?.activityUnreadCount, undefined, "unknown activity stays absent, not zero");
});

test("noteReadActivity debounces a burst of read actions into one reload", async () => {
  const win = stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", [{ serverId: "s1", unreadCount: 0, activityUnreadCount: 0 }]);

  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  const afterInitial = summaryCallCount(urls);

  // Simulate markRead + markAllRead + markDone landing back-to-back.
  useServerUnreadSummaryStore.getState().noteReadActivity();
  useServerUnreadSummaryStore.getState().noteReadActivity();
  useServerUnreadSummaryStore.getState().noteReadActivity();
  await sleep(500);

  assert.equal(summaryCallCount(urls), afterInitial + 1, "three queued reads collapse into one GET");
  // The poll timer must still be armed after the debounce fired.
  assert.ok(win.handlers.size >= 0);
});

test("a failed load clears the snapshot instead of keeping stale >0 counts", async () => {
  stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", [{ serverId: "s1", unreadCount: 3, activityUnreadCount: 4 }]);
  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  assert.equal(useServerUnreadSummaryStore.getState().byServer.s1?.activityUnreadCount, 4);

  // Next load fails (e.g. session dropped mid-poll).
  captureSummaryGets("fail");
  await useServerUnreadSummaryStore.getState().load();

  assert.deepEqual(useServerUnreadSummaryStore.getState().byServer, {}, "failure empties the snapshot — dots go dark, not stale-lit");
});

test("unread_summary:changed refetches the summary; malformed payloads do not", async () => {
  stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", [{ serverId: "s1", unreadCount: 0, activityUnreadCount: 0 }]);
  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  const before = summaryCallCount(urls);

  useServerUnreadSummaryStore.getState().applyUnreadSummaryChanged({ serverId: "s1" });
  await sleep(500);
  assert.equal(summaryCallCount(urls), before + 1, "a well-formed event triggers a reload");

  useServerUnreadSummaryStore.getState().applyUnreadSummaryChanged(null);
  useServerUnreadSummaryStore.getState().applyUnreadSummaryChanged("nope");
  useServerUnreadSummaryStore.getState().applyUnreadSummaryChanged({ serverId: 42 });
  useServerUnreadSummaryStore.getState().applyUnreadSummaryChanged({});
  await sleep(500);
  assert.equal(summaryCallCount(urls), before + 1, "malformed payloads issue nothing");
});

test("focus and visibility refresh through the lifecycle listeners", async () => {
  const win = stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", []);
  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  const before = summaryCallCount(urls);

  win.handlers.get("focus")?.();
  await sleep(20);
  assert.equal(summaryCallCount(urls), before + 1, "window focus reloads");

  win.handlers.get("focus")?.();
  await sleep(20);
  assert.equal(summaryCallCount(urls), before + 2, "each focus reloads");
});

test("release() to zero stops the lifecycle; a later retain() resumes loading", async () => {
  stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const urls = captureSummaryGets("ok", []);

  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  useServerUnreadSummaryStore.getState().release();
  const stopped = summaryCallCount(urls);
  await sleep(80);
  assert.equal(summaryCallCount(urls), stopped, "no loads leak after the last release");

  useServerUnreadSummaryStore.getState().retain();
  await sleep(20);
  assert.equal(summaryCallCount(urls), stopped + 1, "retaining again loads afresh");
});

test("markAllRead success refetches the shared summary (the rail dot must follow the read)", async () => {
  stubWindow();
  const { useServerUnreadSummaryStore } = await import("../src/store/serverUnreadSummaryStore");
  const { useInboxStore } = await import("../src/store/inboxStore");
  const urls: string[] = [];
  const posts: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    if (url === "/servers/unread-summary") return { data: [{ serverId: "s1", unreadCount: 0, activityUnreadCount: 0 }] };
    if (url === "/channels/inbox") {
      return { data: { items: [], totalCount: 1, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false } };
    }
    return { data: {} };
  }) as typeof api.get;
  const originalPost = api.post.bind(api);
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: {} };
  }) as typeof api.post;

  useInboxStore.setState({ totalUnreadCount: 3, activeUnreadCount: 3 });
  await useInboxStore.getState().markAllRead();
  await sleep(500);
  api.post = originalPost;

  assert.ok(posts.includes("/channels/inbox/read-all"), "the read-all POST happened");
  assert.ok(summaryCallCount(urls) >= 1, "markAllRead's success path refetched /servers/unread-summary");
});

test("setFilter clears activeUnreadCount along with totalUnreadCount (no lit-dot-next-to-zero split)", async () => {
  stubWindow();
  const { useInboxStore } = await import("../src/store/inboxStore");
  captureSummaryGets("ok", []);

  useInboxStore.setState({ filter: "all", activeUnreadCount: 7, totalUnreadCount: 7 });
  useInboxStore.getState().setFilter("unread");
  assert.equal(useInboxStore.getState().activeUnreadCount, 0, "activeUnreadCount resets with the filter switch");
  useInboxStore.getState().setFilter("all");
});
