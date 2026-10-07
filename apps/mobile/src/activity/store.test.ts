import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ApiClient } from "../api/client";
import { useActivityStore } from "./store";

function client(handlers: Record<string, () => unknown>): ApiClient {
  const get = (async (path: string) => {
    const handler = handlers[`GET ${path}`];
    if (!handler) throw new Error(`unexpected GET ${path}`);
    return handler();
  }) as ApiClient["get"];
  const post = (async (path: string, body?: unknown) => {
    const handler = handlers[`POST ${path}`];
    if (!handler) throw new Error(`unexpected POST ${path} ${JSON.stringify(body)}`);
    return handler();
  }) as ApiClient["post"];
  return { get, post } as ApiClient;
}

const row = {
  kind: "channel",
  channelId: "all",
  channelName: "all",
  lastMessagePreview: "hello",
  unreadCount: 2,
  doneFrontierSeq: "8",
};

test("load and loadMore replace, then append without duplicates", async () => {
  useActivityStore.getState().reset();
  const api = client({
    "GET /channels/inbox?filter=all&limit=30&offset=0": () => ({
      items: [row, { ...row, channelId: "second" }],
      hasMore: true,
      totalCount: 3,
      totalUnreadCount: 2,
      activeUnreadCount: 2,
    }),
    "GET /channels/inbox?filter=all&limit=30&offset=2": () => ({
      items: [{ ...row, channelId: "second" }, { ...row, channelId: "third" }],
      hasMore: false,
      totalCount: 3,
      totalUnreadCount: 2,
      activeUnreadCount: 2,
    }),
  });
  await useActivityStore.getState().load(api, "all");
  assert.deepEqual(useActivityStore.getState().items.map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId), ["all", "second"]);
  await useActivityStore.getState().loadMore(api);
  assert.deepEqual(useActivityStore.getState().items.map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId), ["all", "second", "third"]);
  assert.equal(useActivityStore.getState().hasMore, false);
});

test("mark read rolls back when the request and the follow-up refresh both fail", async () => {
  useActivityStore.getState().reset();
  let gets = 0;
  let posts = 0;
  const api = client({
    "GET /channels/inbox?filter=unread&limit=30&offset=0": () => {
      gets += 1;
      if (gets > 1) throw new Error("refresh failed");
      return {
        items: [row],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 2,
        activeUnreadCount: 2,
      };
    },
    "POST /channels/all/read-all": () => {
      posts += 1;
      throw new Error("offline");
    },
  });
  await useActivityStore.getState().load(api, "unread");
  const item = useActivityStore.getState().items[0];
  assert.ok(item);
  await useActivityStore.getState().markRead(api, item);
  assert.equal(posts, 1);
  assert.equal(useActivityStore.getState().items[0]?.unreadCount, 2);
  assert.equal(useActivityStore.getState().error, "refresh failed");
});

test("an illegal done frontier refreshes and does not post", async () => {
  useActivityStore.getState().reset();
  let posts = 0;
  let refreshes = 0;
  const api = client({
    "GET /channels/inbox?filter=all&limit=30&offset=0": () => {
      refreshes += 1;
      return {
        items: [{ ...row, doneFrontierSeq: "nope" }],
        hasMore: false,
        totalCount: 1,
        totalUnreadCount: 1,
        activeUnreadCount: 1,
      };
    },
    "POST /channels/inbox/done": () => {
      posts += 1;
      return {};
    },
  });
  await useActivityStore.getState().load(api, "all");
  refreshes = 0;
  const item = useActivityStore.getState().items[0];
  assert.ok(item);
  await useActivityStore.getState().markDone(api, item);
  assert.equal(posts, 0);
  assert.equal(refreshes, 1);
});

test("message refresh is debounced into one request", async () => {
  useActivityStore.getState().reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  let refreshes = 0;
  const api = client({
    "GET /channels/inbox?filter=all&limit=30&offset=0": () => {
      refreshes += 1;
      return { items: [row], hasMore: false, totalCount: 1, totalUnreadCount: 2, activeUnreadCount: 2 };
    },
  });
  try {
    await useActivityStore.getState().load(api, "all");
    refreshes = 0;
    useActivityStore.getState().scheduleRefresh(api);
    useActivityStore.getState().scheduleRefresh(api);
    mock.timers.tick(149);
    assert.equal(refreshes, 0);
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(refreshes, 1);
  } finally {
    mock.timers.reset();
    useActivityStore.getState().reset();
  }
});
