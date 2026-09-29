// desktop-data-cache task #5: the server-wide webResumeCursor, not one
// channel's seeded max, is the sync:resume floor.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";
import {
  activeWebCache,
  clearActiveWebCache,
  readWebResumeCursor,
  recordMessagePage,
  setActiveCacheProvider,
  setActiveWebCache,
  writeWebResumeCursor,
} from "../src/cache/messageCache";
import { createWebCacheRepo } from "../src/cache/webCacheRepo";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";

const SERIAL = { concurrency: false };

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }
  on() { return undefined; }
  off() { return undefined; }
  onAny() { return undefined; }
  offAny() { return undefined; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
}

function msg(seq: number, channelId: string): Message {
  return {
    id: `m-${channelId}-${seq}`,
    seq,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Tester",
    content: `message ${seq}`,
    createdAt: "2026-09-29T00:00:00.000Z",
  } as Message;
}

function bind(socket: FakeSocket) {
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const binding of bindings) byEvent.set(binding.event, binding.handler);
  return {
    connect: byEvent.get("connect")!,
    roomsJoined: byEvent.get("rooms:joined")!,
    resumeResponse: byEvent.get("sync:resume:response")!,
    messageNew: byEvent.get("message:new")!,
  };
}

function stubLoaders() {
  const saved = {
    unread: useMessageStore.getState().loadUnreadCounts,
    inbox: useInboxStore.getState().loadInbox,
    channels: useChannelStore.getState().loadChannels,
  };
  useMessageStore.setState({ loadUnreadCounts: async () => undefined } as never);
  useInboxStore.setState({ loadInbox: async () => undefined } as never);
  useChannelStore.setState({ loadChannels: async () => undefined } as never);
  return () => {
    useMessageStore.setState({ loadUnreadCounts: saved.unread } as never);
    useInboxStore.setState({ loadInbox: saved.inbox } as never);
    useChannelStore.setState({ loadChannels: saved.channels } as never);
  };
}

function resetMessageStore() {
  useMessageStore.setState({
    channelMessages: {},
    channelWindowMeta: {},
    messages: [],
    loading: false,
    lastSeq: 0,
    currentChannelId: null,
    unreadCounts: {},
  });
}

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function resumeEmits(socket: FakeSocket): number[] {
  return socket.emitted
    .filter((entry) => entry.event === "sync:resume")
    .map((entry) => (entry.args[0] as { lastSeq: number }).lastSeq);
}

async function attach(serverId = "srv-1", userId = "user-1") {
  clearActiveWebCache();
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", userId, serverId);
  setActiveWebCache(repo, scopeId, serverId);
  return { repo, scopeId };
}

test("reconnect resumes from the cursor when a seeded channel has a higher seq", SERIAL, async (t) => {
  const { repo } = await attach();
  const restore = stubLoaders();
  t.mock.method(api, "get", async () => {
    throw new Error("offline");
  });
  try {
    await writeWebResumeCursor(10);
    await recordMessagePage("channel-a", { messages: [msg(100, "channel-a")] });
    resetMessageStore();
    await useMessageStore.getState().loadMessages("channel-a");
    assert.equal(useMessageStore.getState().lastSeq, 100, "seed paints channel A's tail into lastSeq");
    assert.equal(await readWebResumeCursor(), 10, "seeding a channel does not move the cursor");

    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();

    assert.deepEqual(resumeEmits(socket), [10], "resume uses min(lastSeq, cursor), not the seeded tail");

    handlers.resumeResponse({
      messages: [msg(50, "channel-b")],
      currentSeq: 50,
      hasMore: false,
    });
    await flush();

    assert.equal(useMessageStore.getState().channelMessages["channel-b"]?.[0]?.seq, 50,
      "channel B's smaller-seq message is applied from the resume");
    assert.equal(await readWebResumeCursor(), 50, "a finished resume advances the cursor to currentSeq");
    assert.equal(repo, activeWebCache()?.repo);
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("hasMore keeps resuming until a short page, and the cursor waits for that", SERIAL, async () => {
  await attach();
  const restore = stubLoaders();
  try {
    await writeWebResumeCursor(10);
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 100 });
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [10]);

    handlers.resumeResponse({
      messages: [msg(20, "channel-a")],
      currentSeq: 20,
      hasMore: true,
    });
    await flush();
    assert.deepEqual(resumeEmits(socket), [10, 20], "a full page requests the next seq");
    assert.equal(await readWebResumeCursor(), 10, "hasMore true does not advance the cursor");

    handlers.resumeResponse({
      messages: [msg(40, "channel-b")],
      currentSeq: 40,
      hasMore: false,
    });
    await flush();
    assert.equal(useMessageStore.getState().channelMessages["channel-b"]?.[0]?.seq, 40);
    assert.equal(await readWebResumeCursor(), 40);
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("a resume page that does not pass the requested seq stops instead of looping", SERIAL, async () => {
  await attach();
  const restore = stubLoaders();
  try {
    await writeWebResumeCursor(10);
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 100 });
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();

    handlers.resumeResponse({
      messages: [],
      currentSeq: 10,
      hasMore: true,
    });
    await flush();

    assert.deepEqual(resumeEmits(socket), [10], "no progress means the history window is already covered");
    assert.equal(await readWebResumeCursor(), 10);
    handlers.messageNew(msg(11, "channel-b"));
    await flush();
    assert.equal(await readWebResumeCursor(), 11, "once the stalled resume is accepted, live messages move the cursor");
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("disconnect freezes the cursor until the next resume finishes", SERIAL, async () => {
  await attach();
  const restore = stubLoaders();
  try {
    await writeWebResumeCursor(10);
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 10 });
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    handlers.resumeResponse({ messages: [], currentSeq: 10, hasMore: false });
    await flush();
    assert.equal(await readWebResumeCursor(), 10);

    handlers.messageNew(msg(12, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), 12, "a live message:new advances the cursor");

    handlers.connect(undefined);
    handlers.messageNew(msg(30, "channel-b"));
    await flush();
    assert.equal(await readWebResumeCursor(), 12, "after disconnect the cursor stays put");
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("without a cursor, roomsJoined does not resume from the seeded lastSeq", SERIAL, async () => {
  await attach();
  const restore = stubLoaders();
  try {
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 100 });
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [], "no cursor ⇒ no resume from one channel's lastSeq");

    handlers.messageNew(msg(30, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), 30, "the first live message:new starts the cursor");
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("logout wipe drops the cursor; another server keeps its own", SERIAL, async () => {
  const repo = createWebCacheRepo();
  const scopeA = await repo.openScope("https://raft.example", "user-1", "srv-a");
  const scopeB = await repo.openScope("https://raft.example", "user-1", "srv-b");
  try {
    setActiveWebCache(repo, scopeA, "srv-a");
    await writeWebResumeCursor(10);
    setActiveWebCache(repo, scopeB, "srv-b");
    assert.equal(await readWebResumeCursor(), null, "a different server does not see the other cursor");
    await writeWebResumeCursor(4);
    setActiveWebCache(repo, scopeA, "srv-a");
    assert.equal(await readWebResumeCursor(), 10);

    await repo.wipeAll();
    assert.equal(await readWebResumeCursor(), null, "wipeAll (explicit logout) clears the cursor with the rest of the kv");
    setActiveWebCache(repo, scopeB, "srv-b");
    assert.equal(await readWebResumeCursor(), null);
  } finally {
    clearActiveWebCache();
  }
});

test("a detached generation cannot write a cursor back into the scope", SERIAL, async () => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "srv-1");
  try {
    setActiveWebCache(repo, scopeId, "srv-1");
    await writeWebResumeCursor(9);
    clearActiveWebCache();
    await writeWebResumeCursor(20);
    setActiveWebCache(repo, scopeId, "srv-1");
    assert.equal(await readWebResumeCursor(), 9, "the write after detach did not land");
  } finally {
    clearActiveWebCache();
  }
});

test("a user switch during the kv read drops the cursor result and the write", SERIAL, async () => {
  const repo = createWebCacheRepo();
  const scopeId = await repo.openScope("https://raft.example", "user-1", "srv-1");
  const originalGetKv = repo.getKv.bind(repo);
  let releaseRead: (() => void) | null = null;
  repo.getKv = (id, key) => new Promise((resolve) => {
    releaseRead = () => resolve(originalGetKv(id, key));
  });
  let holder = {
    repo,
    scopeId,
    serverId: "srv-1" as string | null,
    userId: "user-1" as string | null,
    generation: 1,
  };
  setActiveCacheProvider(() => holder);
  try {
    repo.getKv = originalGetKv;
    await writeWebResumeCursor(5);
    repo.getKv = (id, key) => new Promise((resolve) => {
      releaseRead = () => resolve(originalGetKv(id, key));
    });
    const pendingRead = readWebResumeCursor();
    holder = { ...holder, userId: "user-2", generation: 2 };
    releaseRead!();
    assert.equal(await pendingRead, null, "the cursor belongs to the user who started the read");

    const pendingWrite = writeWebResumeCursor(8);
    holder = { ...holder, userId: "user-1", generation: 1 };
    releaseRead!();
    await pendingWrite;
    repo.getKv = originalGetKv;
    assert.equal(await readWebResumeCursor(), 5, "a write that races an account switch does not land");
  } finally {
    setActiveCacheProvider(null);
    clearActiveWebCache();
  }
});
