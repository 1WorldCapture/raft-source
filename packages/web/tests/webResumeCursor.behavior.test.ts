// desktop-data-cache task #5: the server-wide webResumeCursor, not one
// channel's seeded max, is the sync:resume floor.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";
import {
  activeWebCache,
  captureResumeCursorToken,
  clearActiveWebCache,
  readWebResumeCursor as readCursorFor,
  recordMessagePage,
  setActiveCacheProvider,
  setActiveWebCache,
  writeWebResumeCursor as writeCursorFor,
} from "../src/cache/messageCache";
import type { ResumeCursorToken } from "../src/cache/messageCache";
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
  auth: { serverId: string | null };
  constructor(serverId: string | null = "srv-1") {
    this.auth = { serverId };
  }
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

async function readWebResumeCursor(token: ResumeCursorToken | null = captureResumeCursorToken(activeWebCache()?.serverId ?? null)) {
  return token ? readCursorFor(token) : null;
}

async function writeWebResumeCursor(maxSeq: number, token: ResumeCursorToken | null = captureResumeCursorToken(activeWebCache()?.serverId ?? null)) {
  if (token) await writeCursorFor(token, maxSeq);
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
    assert.equal(useMessageStore.getState().lastSeq, 0, "a cache seed does not move the network lastSeq");
    assert.equal(await readWebResumeCursor(), 10, "seeding a channel does not move the cursor");

    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();

    assert.deepEqual(resumeEmits(socket), [10], "resume uses the cursor, not the seeded tail");

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

test("cold start without a cursor: a seed alone never resumes, and live messages do not start the cursor", SERIAL, async (t) => {
  await attach();
  const restore = stubLoaders();
  t.mock.method(api, "get", async () => {
    throw new Error("offline");
  });
  try {
    await recordMessagePage("channel-a", { messages: [msg(100, "channel-a")] });
    resetMessageStore();
    await useMessageStore.getState().loadMessages("channel-a");
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [], "nothing network-seen to resume from; the seed is not a floor");

    handlers.messageNew(msg(130, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), null, "no resume has finished, so live traffic cannot start the cursor");
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("cold start without a cursor resumes from the network seq and starts the cursor when that resume finishes", SERIAL, async (t) => {
  await attach();
  const restore = stubLoaders();
  t.mock.method(api, "get", async () => {
    throw new Error("offline");
  });
  try {
    await recordMessagePage("channel-a", { messages: [msg(100, "channel-a")] });
    resetMessageStore();
    // Seen over the network before the drop (e.g. restored from the last page).
    useMessageStore.setState({ lastSeq: 40 });
    await useMessageStore.getState().loadMessages("channel-a");
    assert.equal(useMessageStore.getState().lastSeq, 40);

    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [40], "resume from the network seq, below channel A's seeded 100");

    handlers.messageNew(msg(120, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), null, "message:new during the resume does not start the cursor");

    handlers.resumeResponse({ messages: [msg(50, "channel-b")], currentSeq: 120, hasMore: false });
    await flush();
    assert.equal(useMessageStore.getState().channelMessages["channel-b"]?.[0]?.seq, 50,
      "channel B's message missed while offline comes back");
    assert.equal(await readWebResumeCursor(), 120, "the finished resume starts the cursor");

    handlers.messageNew(msg(121, "channel-b"));
    await flush();
    assert.equal(await readWebResumeCursor(), 121);
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("server switch: server A's late traffic never moves server B's cursor", SERIAL, async () => {
  const repo = createWebCacheRepo();
  const scopeA = await repo.openScope("https://raft.example", "user-1", "srv-a");
  const scopeB = await repo.openScope("https://raft.example", "user-1", "srv-b");
  const restore = stubLoaders();
  try {
    setActiveWebCache(repo, scopeA, "srv-a");
    await writeWebResumeCursor(10);
    setActiveWebCache(repo, scopeB, "srv-b");
    await writeWebResumeCursor(5);
    setActiveWebCache(repo, scopeA, "srv-a");
    resetMessageStore();

    const socketA = new FakeSocket("srv-a");
    const handlers = bind(socketA);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socketA), [10]);

    // The cache moves to B before A's listeners are torn down.
    setActiveWebCache(repo, scopeB, "srv-b");
    handlers.resumeResponse({ messages: [], currentSeq: 900, hasMore: false });
    handlers.messageNew(msg(901, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), 5, "B's cursor is untouched by A's seqs");
    setActiveWebCache(repo, scopeA, "srv-a");
    assert.equal(await readWebResumeCursor(), 10, "A's writes were dropped once its scope was detached");
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("a socket for another server than the attached scope resumes without touching any cursor", SERIAL, async () => {
  await attach("srv-b");
  const restore = stubLoaders();
  try {
    await writeWebResumeCursor(5);
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 70 });
    const socket = new FakeSocket("srv-a");
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [70], "no scope for this socket's server: plain network-seq resume");
    handlers.resumeResponse({ messages: [], currentSeq: 80, hasMore: false });
    handlers.messageNew(msg(81, "channel-a"));
    await flush();
    assert.equal(await readWebResumeCursor(), 5);
  } finally {
    restore();
    resetMessageStore();
    clearActiveWebCache();
  }
});

test("a failing cursor read still resumes from the network seq", SERIAL, async () => {
  const { repo } = await attach();
  const restore = stubLoaders();
  const originalGetKv = repo.getKv.bind(repo);
  repo.getKv = async () => {
    throw new Error("IndexedDB unavailable");
  };
  try {
    resetMessageStore();
    useMessageStore.setState({ lastSeq: 33 });
    const socket = new FakeSocket();
    const handlers = bind(socket);
    handlers.connect(undefined);
    handlers.roomsJoined(undefined);
    await flush();
    assert.deepEqual(resumeEmits(socket), [33]);
  } finally {
    repo.getKv = originalGetKv;
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
