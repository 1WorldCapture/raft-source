// M4 realtime acceptance: the REAL Go application's Socket.IO surface
// driven by the repository's locked original socket.io-client@4.8.3,
// websocket-only, with fixtures from real flows only (accounts via
// register + private outbox verification, workspace + invite links,
// channels via HTTP). Every identity/message claim is backed by the
// actual application database — the mock spike is behind us.
//
// Bulk recovery volume (>500 messages) is seeded by the TEST-ONLY
// in-process Go helper tests/acceptance/m4-realtime-fixture (real
// message.Store.CreateTx inside db.WithWriteTx: full metadata,
// transaction seq and same-commit outbox) because the production send
// bucket is 60 writes/60s per user — neither twenty minutes of HTTP nor
// disabling a production limit is acceptable.
//
// Contract gates: docs/m4-socket-poc-report.md (verified transport),
// m4-compatibility-contract.md §4 (wire), m4-authority-contract.md
// (fence/proof), m4-socket-integration-notes.md (guard/budget/expiry).
//
// Standalone (isolated, disposable):  node tests/acceptance/m4-realtime.mjs
// Parent integration:                 verifyM4Realtime({origin,data,start,
//                                     stop,capture,executable,env})
//
// A not-yet-wired backend surface FAILS this suite loudly; it is never
// tolerated as an absent-feature pass. No browser/UI, no live 4301/5175.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createVerifiedAccount, createWorkspace, expectStatus, httpClient, pollUntil,
} from './m3-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const goRoot = path.resolve(here, '../..');
const root = path.dirname(goRoot);
const CLIENT_ENTRY = pathToFileURL(path.join(
  root, 'node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js')).href;
const { io } = await import(CLIENT_ENTRY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_FIELDS = ['channelId', 'content', 'createdAt', 'id', 'messageType',
  'randomId', 'senderId', 'senderType', 'seq', 'threadId'];

// ---------------------------------------------------------------------------
// Original-client-shaped socket helpers.
// ---------------------------------------------------------------------------

// Fresh socket mirroring packages/web/src/api/socket.ts (websocket-only,
// object auth {token, serverId, clientKind}). autoConnect stays off so
// listeners are ALWAYS attached before connect/disconnect triggers.
function freshSocket(origin, { token, serverId = null, extraHeaders } = {}) {
  const socket = io(origin, {
    autoConnect: false,
    forceNew: true,
    transports: ['websocket'],
    auth: { token, serverId, clientKind: 'web' },
    ...(extraHeaders ? { extraHeaders } : {}),
    reconnection: true, reconnectionAttempts: 10,
    reconnectionDelay: 120, reconnectionDelayMax: 800, timeout: 8000,
  });
  socket._disconnects = [];
  socket.on('disconnect', (reason, description) => {
    // Two-argument wire shape; both recorded, never printed with payloads.
    socket._disconnects.push(String(reason));
  });
  return socket;
}

// Collector: registers event listeners UP FRONT and buffers single-payload
// frames; waiters are matched on arrival (never after the fact).
class Collector {
  constructor(socket, events) {
    this.frames = new Map(events.map(name => [name, []]));
    this.waiters = [];
    for (const name of events) {
      socket.on(name, first => {
        // Payload-less events (rooms:joined) record undefined: waiters
        // resolve with exactly what the wire delivered.
        this.frames.get(name).push(first);
        for (const waiter of [...this.waiters]) {
          if (waiter.event !== name) continue;
          if (this.frames.get(name).length <= waiter.after) continue;
          if (waiter.pred && !waiter.pred(first)) continue;
          this.waiters = this.waiters.filter(w => w !== waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(first);
        }
      });
    }
  }
  wait(event, { timeoutMs = 10000, pred, after = 0, context = event } = {}) {
    // Match by occurrence, not by payload truthiness: rooms:joined has an
    // undefined payload, and repeated resume requests must never reuse an
    // earlier response. `after` is the number of frames already observed.
    const frames = this.frames.get(event);
    const index = frames.findIndex((frame, index) => index >= after && (!pred || pred(frame)));
    if (index >= 0) return Promise.resolve(frames[index]);
    return new Promise((resolve, reject) => {
      const waiter = { event, pred, after, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for socket event "${event}" (${context})`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  absent(event, { graceMs = 800, pred } = {}) {
    return sleep(graceMs).then(() => {
      const hits = pred ? this.frames.get(event).filter(pred) : this.frames.get(event);
      assert.equal(hits.length, 0,
        `event "${event}" must NOT arrive for this audience, but ${hits.length} frame(s) did`);
    });
  }
  count(event) { return this.frames.get(event).length; }
  all(event) { return this.frames.get(event); }
}

// The original web bridge behavior on (re)connect: rooms:joined gates the
// gap sync (socketBridge.ts roomsJoined → sync:resume {lastSeq}; hasMore
// loop driven by currentSeq). Returns every recovered message.
async function resumeFrom(collector, socket, lastSeq, { maxPages = 12, pageTimeoutMs = 15000 } = {}) {
  assert.ok(Number.isSafeInteger(lastSeq) && lastSeq > 0,
    'the original resume protocol requires a positive known cursor; cold load uses HTTP');
  const recovered = [];
  let cursor = lastSeq;
  for (let page = 0; page < maxPages; page++) {
    const responseP = collector.wait('sync:resume:response', {
      timeoutMs: pageTimeoutMs, after: collector.count('sync:resume:response'), context: `resume page ${page}`,
    });
    const disconnectBaseline = socket._disconnects.length;
    socket.emit('sync:resume', { lastSeq: cursor });
    let response;
    try {
      response = await responseP;
    } catch (error) {
      const reasons = socket._disconnects.slice(disconnectBaseline);
      throw new Error(`resume page ${page} failed; connected=${socket.connected}; transport closes=${JSON.stringify(reasons)}`, { cause: error });
    }
    assert.ok(Array.isArray(response.messages), 'resume page messages is an array');
    assert.ok(Number.isSafeInteger(response.currentSeq), 'resume currentSeq is a safe integer');
    assert.equal(typeof response.hasMore, 'boolean', 'resume hasMore is boolean');
    recovered.push(...response.messages);
    if (!response.hasMore) {
      if (response.currentSeq > cursor) cursor = response.currentSeq;
      return { messages: recovered, finalCursor: cursor };
    }
    assert.ok(response.currentSeq > cursor,
      `resume pagination must strictly advance (page ${page}: ${cursor} -> ${response.currentSeq})`);
    cursor = response.currentSeq;
  }
  throw new Error(`resume did not converge within ${maxPages} pages (endless-loop guard)`);
}

// Mutations that change subscription authority intentionally evict sockets.
// Establish an explicit fresh subscription barrier before testing live-only
// delivery; separate cases below test automatic reconnect and revocation.
async function reconnectScoped(socket, collector) {
  socket.disconnect();
  const ready = collector.wait('rooms:joined', {
    after: collector.count('rooms:joined'), timeoutMs: 15000, context: 'fresh workspace subscription',
  });
  socket.connect();
  await ready;
  assert.ok(socket.connected, 'fresh workspace subscription is connected');
}

function assertCanonicalLive(message, context) {
  for (const field of CANONICAL_FIELDS) {
    assert.ok(field in message, `${context}: live canonical field "${field}" present`);
  }
  assert.ok(Number.isSafeInteger(message.seq) && message.seq > 0, `${context}: live seq is a safe positive integer`);
}

// Owned temporary same-origin-style proxy: forwards HTTP and WebSocket
// upgrades verbatim to the target origin on a dynamic loopback port.
function startProxy(target) {
  const targetUrl = new URL(target);
  const connections = new Set();
  const trackConnection = socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  };
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers: req.headers },
      upstreamRes => { res.writeHead(upstreamRes.statusCode, upstreamRes.headers); upstreamRes.pipe(res); });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', trackConnection);
  server.on('upgrade', (req, socket, head) => {
    const upstream = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers: req.headers });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      trackConnection(upstreamSocket);
      const headers = [`HTTP/1.1 101 Switching Protocols`];
      for (const [key, value] of Object.entries(upstreamRes.headers)) headers.push(`${key}: ${value}`);
      socket.write(headers.join('\r\n') + '\r\n\r\n');
      // Each head contains bytes already read FROM its respective peer.
      // Forward them to the opposite peer before connecting the streams.
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      const drop = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', drop); upstreamSocket.on('error', drop);
      socket.on('close', drop); upstreamSocket.on('close', drop);
    });
    upstream.on('response', response => {
      response.resume();
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done, failed) => {
        // HTTP server.close does not own upgraded sockets. Close only this
        // test proxy's tracked transports so failure cleanup cannot hang.
        const timer = setTimeout(() => failed(new Error('temporary proxy cleanup timed out')), 5000);
        server.close(error => {
          clearTimeout(timer);
          if (error) failed(error); else done(null);
        });
        for (const socket of connections) socket.destroy();
      }),
    }));
  });
}

// ---------------------------------------------------------------------------
// The acceptance suite.
// ---------------------------------------------------------------------------

export async function verifyM4Realtime({ origin, data, start, stop, capture, executable, env }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const webOrigin = env.RAFT_GO_WEB_ORIGIN ?? 'http://127.0.0.1:5175';
  const sockets = [];
  const track = socket => { sockets.push(socket); return socket; };
  const closeAll = async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      try { socket.disconnect(); } catch {}
    }
    sockets.length = 0;
  };

  // ---- 0. Backend socket surface must be wired (never tolerate absence) --
  const surface = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`, { signal: AbortSignal.timeout(5000) });
  await surface.arrayBuffer();
  if (surface.status !== 400) {
    throw new Error(
      `M4 realtime requires the real Socket.IO surface; polling handshake returned HTTP ${surface.status} ` +
      `(expected the explicit websocket-only 400). If this is the not-enabled response, the app integration ` +
      `(deps.SocketIO, worker agt_18c13485) has not landed yet — that is a FAILURE of this suite, not a skip.`);
  }

  // ---- 1. Real-flow fixtures ------------------------------------------------
  const alice = await createVerifiedAccount(request, maildir, 'm4rtalice');
  const bob = await createVerifiedAccount(request, maildir, 'm4rtbob');
  const carol = await createVerifiedAccount(request, maildir, 'm4rtcarol');
  const outsider = await createVerifiedAccount(request, maildir, 'm4rtout');
  for (const account of [alice, bob, carol, outsider]) {
    // The harness signup response carries the pre-profile placeholder name;
    // every identity assertion below must use the COMPLETED real profile.
    const me = await request('/api/auth/me', { token: account.accessToken });
    expectStatus(me, 200, 'M4 realtime fixture reads the completed real profile');
    account.user = me.data;
  }
  const workspace = await createWorkspace(request, alice, 'm4rt');
  const ws = workspace.id;
  const strangerWorkspace = await createWorkspace(request, outsider, 'm4rtx');
  const joinLink = await request(`/api/servers/${ws}/join-links`, {
    method: 'POST', token: alice.accessToken, server: ws, body: { maxUses: null, expiresAt: null },
  });
  expectStatus(joinLink, 200, 'M4 realtime join link');
  for (const member of [bob, carol]) {
    expectStatus(await request('/api/auth/accept-invite', {
      method: 'POST', token: member.accessToken, body: { token: joinLink.data.token },
    }), 200, 'M4 realtime member joins via the real invite link');
  }
  const publicChannel = await request('/api/channels', {
    method: 'POST', token: alice.accessToken, server: ws,
    body: { name: 'm4rt-general', visibility: 'public' },
  });
  expectStatus(publicChannel, 200, 'M4 realtime public channel');
  const pub = publicChannel.data;
  const privateChannel = await request('/api/channels', {
    method: 'POST', token: alice.accessToken, server: ws,
    body: { name: 'm4rt-private', visibility: 'private' },
  });
  expectStatus(privateChannel, 200, 'M4 realtime private channel');
  const priv = privateChannel.data;
  expectStatus(await request(`/api/channels/${pub.id}/join`, {
    method: 'POST', token: bob.accessToken, server: ws, body: {},
  }), 200, 'bob joins the public channel');
  expectStatus(await request(`/api/channels/${priv.id}/members`, {
    method: 'POST', token: alice.accessToken, server: ws, body: { userId: bob.user.id },
  }), 200, 'bob is added to the private channel');

  const asAlice = { token: alice.accessToken, server: ws };
  const asBob = { token: bob.accessToken, server: ws };
  const asCarol = { token: carol.accessToken, server: ws };
  const send = actor => body => request('/api/v2/messages', { method: 'POST', ...actor, body });
  const sendAlice = send(asAlice);
  let rid = 0;
  const randomId = () => `m4rt-${Date.now().toString(36)}-${(rid++).toString(36)}`;

  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M4 realtime ${name}`); };

  try {
    // ---- 2. Exact handshake rejection keywords -----------------------------
    await check('handshake rejections carry the exact original keywords', async () => {
      const cases = [
        [{ token: null, serverId: ws }, 'Authentication required'],
        [{ token: 'definitely-not-a-real-token', serverId: ws }, 'Invalid or expired token'],
        [{ token: outsider.accessToken, serverId: ws }, 'Not a member of this server'],
      ];
      for (const [auth, wanted] of cases) {
        const socket = track(freshSocket(origin, auth));
        const error = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`connect_error timeout for case "${wanted}"`)), 10000);
          socket.once('connect_error', err => { clearTimeout(timer); resolve(err); });
          socket.connect();
        });
        assert.equal(error.message, wanted, `connect_error message (wanted exact "${wanted}")`);
        socket.disconnect();
      }
    });

    // ---- 3. Account-level connection: authenticated, zero workspace surface -
    await check('account-level connection joins no workspace surface', async () => {
      const socket = track(freshSocket(origin, { token: alice.accessToken, serverId: null }));
      const collector = new Collector(socket, ['rooms:joined', 'message:new', 'heartbeat', 'dm:new']);
      socket.connect();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('account-level connect timeout')), 10000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
      // The original server never emits rooms:joined/heartbeat for
      // account-level connections; a workspace message must not arrive.
      await sendAlice({ channelId: pub.id, content: 'm4rt account-level probe', randomId: randomId() })
        .then(result => expectStatus(result, 200, 'account-level probe message'));
      await collector.absent('rooms:joined', { graceMs: 1200 });
      await collector.absent('message:new', { graceMs: 1200 });
      await collector.absent('heartbeat', { graceMs: 1200 });
      socket.disconnect();
    });

    // ---- 4. rooms:joined barrier + live delivery, two accounts -------------
    let bobSocket, bobFeed;
    await check('rooms:joined barrier precedes live delivery for both accounts', async () => {
      bobSocket = track(freshSocket(origin, { token: bob.accessToken, serverId: ws }));
      bobFeed = new Collector(bobSocket, ['rooms:joined', 'message:new', 'message:updated', 'dm:new',
        'thread:updated', 'read_state:updated', 'notification_prefs:updated', 'message_display_prefs:updated',
        'reaction_viewer:updated', 'unread_summary:changed', 'heartbeat', 'sync:resume:response']);
      bobSocket.connect();
      const barrier = await bobFeed.wait('rooms:joined', { timeoutMs: 15000 });
      assert.equal(barrier, undefined, 'rooms:joined carries no business payload');
      // First live message AFTER the barrier, ID must equal the HTTP row.
      const sent = await sendAlice({ channelId: pub.id, content: 'm4rt live one', randomId: randomId() });
      expectStatus(sent, 200, 'live one send');
      const live = await bobFeed.wait('message:new', { pred: m => m.id === sent.data.message.id });
      assertCanonicalLive(live, 'live one');
      assert.equal(live.content, 'm4rt live one', 'live content verbatim');
      assert.equal(live.channelId, pub.id, 'live channelId');
      assert.equal(live.senderId, alice.user.id, 'live senderId is the verified principal');
      // No duplicate frames for the same ID.
      await sleep(700);
      assert.equal(bobFeed.all('message:new').filter(m => m.id === sent.data.message.id).length, 1,
        'exactly one live frame per committed message');
    });

    // ---- 5. HTTP-before-socket and socket-reconnect both deliver once ------
    await check('reconnect and HTTP ordering converge without duplicate ids', async () => {
      // bob was offline for this send (socket still open but the server-side
      // connection is dropped below), then resumes.
      const offline = await sendAlice({ channelId: pub.id, content: 'm4rt offline send', randomId: randomId() });
      expectStatus(offline, 200, 'offline send');
      // Force a transport-level reconnect the same way the server does for
      // revocation: close the raw client socket and let the original client
      // reconnect + re-authenticate by itself.
      const rejoined = bobFeed.wait('rooms:joined', {
        after: bobFeed.count('rooms:joined'), timeoutMs: 15000, context: 'automatic transport reconnect',
      });
      bobSocket.io.engine.close();
      await rejoined;
      const { messages } = await resumeFrom(bobFeed, bobSocket, offline.data.message.seq - 1);
      const offlineRows = messages.filter(m => m.id === offline.data.message.id);
      assert.equal(offlineRows.length, 1, 'offline message recovered exactly once via resume');
      const liveAgain = await sendAlice({ channelId: pub.id, content: 'm4rt after reconnect', randomId: randomId() });
      expectStatus(liveAgain, 200, 'after-reconnect send');
      await bobFeed.wait('message:new', { pred: m => m.id === liveAgain.data.message.id });
      const ids = new Set(bobFeed.all('message:new').map(m => m.id));
      assert.equal(ids.size, bobFeed.all('message:new').length, 'no duplicate live ids across reconnect');
    });

    // ---- 6. Private content never reaches non-members or other workspaces --
    await check('private channel, DM and thread audiences are enforced live', async () => {
      const carolSocket = track(freshSocket(origin, { token: carol.accessToken, serverId: ws }));
      const carolFeed = new Collector(carolSocket, ['message:new', 'dm:new', 'thread:updated', 'reaction_viewer:updated', 'rooms:joined', 'sync:resume:response']);
      carolSocket.connect();
      await carolFeed.wait('rooms:joined', { timeoutMs: 15000 });

      // Private channel: bob receives, carol does not.
      const privMsg = await sendAlice({ channelId: priv.id, content: 'm4rt secret one', randomId: randomId() });
      expectStatus(privMsg, 200, 'private send');
      await bobFeed.wait('message:new', { pred: m => m.id === privMsg.data.message.id });
      await carolFeed.absent('message:new', { graceMs: 1000 });

      // Human DM: only the two participants see the dm:new envelope
      // ({channelId}, NOT a full channel DTO).
      const dm = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: bob.user.id } });
      expectStatus(dm, 200, 'human DM create');
      assert.equal(dm.data.type, 'dm', 'DM channel type');
      // Creating a conversation advances workspace authority and evicts old
      // subscriptions. Both positive and negative audiences must be online
      // under the new generation before this live-delivery assertion.
      await Promise.all([reconnectScoped(bobSocket, bobFeed), reconnectScoped(carolSocket, carolFeed)]);
      const dmMsg = await request('/api/v2/messages', {
        method: 'POST', ...asAlice, body: { channelId: dm.data.id, content: 'm4rt dm hello', randomId: randomId() },
      });
      expectStatus(dmMsg, 200, 'DM send');
      // The DM is delivered to the participant over the DM room: either as
      // the dm:new envelope ({channelId} only) or as the live message row —
      // both must be a single object payload, never to carol.
      await Promise.race([
        bobFeed.wait('message:new', { pred: m => m.id === dmMsg.data.message.id, timeoutMs: 8000 }),
        bobFeed.wait('dm:new', { pred: p => p && p.channelId === dm.data.id, timeoutMs: 8000 }),
      ]).then(frame => {
        assert.equal(typeof frame, 'object', 'DM delivery is a single object payload');
        if ('channelId' in frame && !('id' in frame)) {
          assert.equal(frame.channelId, dm.data.id, 'dm:new carries exactly the DM channelId');
        }
      });
      await carolFeed.absent('message:new', { pred: m => m.channelId === dm.data.id, graceMs: 800 });
      await carolFeed.absent('dm:new', { pred: p => p && p.channelId === dm.data.id, graceMs: 800 });

      // Thread on a PUBLIC parent: a non-follower still receives thread
      // room live after an explicit join (public viewer), while the private
      // parent thread never reaches the non-member.
      const parent = await sendAlice({ channelId: pub.id, content: 'm4rt thread parent', randomId: randomId() });
      expectStatus(parent, 200, 'thread parent send');
      const thread = await request(`/api/channels/${pub.id}/threads`, {
        method: 'POST', ...asAlice, body: { parentMessageId: parent.data.message.id, content: 'm4rt thread reply' },
      });
      expectStatus(thread, 200, 'public thread create');
      // channels.ts:4042: {threadChannelId, replyCount, ...}.
      assert.ok(UUID_RE.test(thread.data.threadChannelId ?? ''), 'public thread channel id');
      const threadChannel = { id: thread.data.threadChannelId };
      const privParent = await sendAlice({ channelId: priv.id, content: 'm4rt private thread parent', randomId: randomId() });
      expectStatus(privParent, 200, 'private thread parent');
      const privThread = await request(`/api/channels/${priv.id}/threads`, {
        method: 'POST', ...asAlice, body: { parentMessageId: privParent.data.message.id, content: 'm4rt private thread reply' },
      });
      expectStatus(privThread, 200, 'private thread create');
      assert.ok(UUID_RE.test(privThread.data.threadChannelId ?? ''), 'private thread channel id');
      const privThreadChannel = { id: privThread.data.threadChannelId };
      await Promise.all([reconnectScoped(bobSocket, bobFeed), reconnectScoped(carolSocket, carolFeed)]);

      // Carol explicitly joins the PUBLIC thread room: viewer without follow.
      carolSocket.emit('join:channel', threadChannel.id);
      await resumeFrom(carolFeed, carolSocket, parent.data.message.seq);
      const reply = await request('/api/v2/messages', {
        method: 'POST', ...asBob, body: { channelId: threadChannel.id, content: 'm4rt public thread live reply', randomId: randomId() },
      });
      expectStatus(reply, 200, 'public thread reply');
      await carolFeed.wait('message:new', { pred: m => m.id === reply.data.message.id, timeoutMs: 8000, context: 'public thread explicit viewer' });
      // The private thread reply must never reach carol (not a member of
      // the private parent chain, not even with the thread id).
      carolSocket.emit('join:channel', privThreadChannel.id);
      await resumeFrom(carolFeed, carolSocket, parent.data.message.seq);
      const privReply = await request('/api/v2/messages', {
        method: 'POST', ...asAlice, body: { channelId: privThreadChannel.id, content: 'm4rt secret thread reply', randomId: randomId() },
      });
      expectStatus(privReply, 200, 'private thread reply send');
      // Private-thread live delivery requires active follow in addition to
      // parent read access. Bob can read the parent but has not followed yet.
      await bobFeed.absent('message:new', { pred: m => m.id === privReply.data.message.id, graceMs: 800 });
      await carolFeed.absent('message:new', { pred: m => m.channelId === privThreadChannel.id, graceMs: 800 });
      expectStatus(await request('/api/channels/threads/follow', {
        method: 'POST', ...asBob, body: { parentMessageId: privParent.data.message.id },
      }), 200, 'private thread follow');
      await reconnectScoped(bobSocket, bobFeed);
      const followedReply = await request('/api/v2/messages', {
        method: 'POST', ...asAlice, body: { channelId: privThreadChannel.id, content: 'm4rt followed private reply', randomId: randomId() },
      });
      expectStatus(followedReply, 200, 'followed private thread reply');
      await bobFeed.wait('message:new', { pred: m => m.id === followedReply.data.message.id, timeoutMs: 8000, context: 'private thread active follower' });
      assert.ok(carolSocket.connected, 'unauthorized audience remains online for the negative assertion');
      await carolFeed.absent('message:new', { pred: m => m.channelId === privThreadChannel.id, graceMs: 1000 });
      carolSocket.disconnect();
    });

    // ---- 7. Reaction: shared aggregate vs private viewer snapshot ---------
    await check('reaction emits shared message:updated and private viewer snapshot to the owner only', async () => {
      const target = await sendAlice({ channelId: pub.id, content: 'm4rt reaction target', randomId: randomId() });
      expectStatus(target, 200, 'reaction target send');
      const add = await request(`/api/messages/${target.data.message.id}/reactions`, {
        method: 'POST', ...asBob, body: { emoji: '🎉' },
      });
      expectStatus(add, 200, 'reaction add');
      // Shared aggregate: bob (and any channel member) sees message:updated
      // with the SAME message id, single payload.
      const updated = await bobFeed.wait('message:updated', { pred: m => m.id === target.data.message.id, timeoutMs: 8000 });
      assert.equal(typeof updated, 'object', 'message:updated single object payload');
      assertCanonicalLive(updated, 'message:updated');
      // Private viewer snapshot: only bob (the reactor) receives it.
      await bobFeed.wait('reaction_viewer:updated', { pred: m => (m.messageId ?? m.id) === target.data.message.id, timeoutMs: 8000 });
    });

    // ---- 8. Read / mute / display private events, exact first payload -----
    await check('read, mute and display prefs emit scoped private events with exact shapes', async () => {
      const read = await request(`/api/channels/${pub.id}/read`, {
        method: 'POST', ...asBob, body: { seq: bobFeed.all('message:new').reduce((max, m) => Math.max(max, m.seq), 0) },
      });
      expectStatus(read, 200, 'read advance');
      const readState = await bobFeed.wait('read_state:updated', { timeoutMs: 8000 });
      assert.equal(typeof readState, 'object', 'read_state:updated single object payload');

      const mute = await request(`/api/channels/${pub.id}/notification-settings`, {
        method: 'PATCH', ...asBob, body: { activityMuted: true },
      });
      expectStatus(mute, 200, 'mute patch');
      const prefs = await bobFeed.wait('notification_prefs:updated', { timeoutMs: 8000 });
      assert.equal(prefs.serverId, ws, 'notification_prefs serverId');
      assert.equal(prefs.scopeId, pub.id, 'notification_prefs scopeId');
      assert.equal(typeof prefs.prefs?.activityMuted, 'boolean', 'notification_prefs activityMuted');
      assert.ok('muteFromSeq' in prefs.prefs, 'notification_prefs muteFromSeq');
      assert.ok(prefs.prefsVersion !== undefined, 'notification_prefs prefsVersion');

      // The default is true; writing true again is an intentional no-op
      // and must not emit a fake version change. Exercise an actual change.
      const displayAfter = bobFeed.count('message_display_prefs:updated');
      const display = await request(`/api/channels/${pub.id}/message-display-settings`, {
        method: 'PATCH', ...asBob, body: { collapseLongMessages: false },
      });
      expectStatus(display, 200, 'display patch');
      const shown = await bobFeed.wait('message_display_prefs:updated', { timeoutMs: 8000, after: displayAfter });
      assert.equal(shown.serverId, ws, 'display prefs serverId');
      assert.equal(shown.scopeId, pub.id, 'display prefs scopeId');
      assert.equal(shown.prefs?.collapseLongMessages, false, 'display prefs collapse flag');
      assert.ok(shown.prefsVersion !== undefined, 'display prefs version');
    });

    // ---- 9. Application heartbeat (not Engine.IO ping) --------------------
    await check('application heartbeat carries workspace seq and ms timestamp', async () => {
      const hb = await bobFeed.wait('heartbeat', { timeoutMs: 25000 });
      assert.ok(Number.isSafeInteger(hb.seq) && hb.seq >= 0, 'heartbeat seq is a safe non-negative integer');
      assert.ok(Number.isSafeInteger(hb.ts) && hb.ts > 1_500_000_000_000, 'heartbeat ts is epoch milliseconds');
    });

    // ---- 10. Owned same-origin proxy + origin allowlist -------------------
    await check('owned temporary proxy carries the live stream; foreign origins are refused', async () => {
      const proxy = await startProxy(origin);
      try {
        const proxied = track(freshSocket(proxy.origin, {
          token: bob.accessToken, serverId: ws, extraHeaders: { Origin: webOrigin },
        }));
        const feed = new Collector(proxied, ['rooms:joined', 'message:new']);
        proxied.connect();
        await feed.wait('rooms:joined', { timeoutMs: 15000 });
        const sent = await sendAlice({ channelId: pub.id, content: 'm4rt via proxy', randomId: randomId() });
        expectStatus(sent, 200, 'proxy probe send');
        const live = await feed.wait('message:new', { pred: m => m.id === sent.data.message.id, timeoutMs: 10000 });
        assertCanonicalLive(live, 'proxied live');
        proxied.disconnect();
      } finally {
        await proxy.close();
      }
      // A foreign Origin is refused at the HTTP layer: the handshake never
      // establishes (transport-level failure, not an auth keyword).
      const foreign = track(freshSocket(origin, {
        token: bob.accessToken, serverId: ws, extraHeaders: { Origin: 'http://evil.example' },
      }));
      const refused = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('foreign-origin socket was not refused')), 10000);
        foreign.once('connect_error', err => { clearTimeout(timer); resolve(err); });
        foreign.once('connect', () => { clearTimeout(timer); reject(new Error('foreign origin established a socket')); });
        foreign.connect();
      });
      assert.ok(refused, 'foreign origin refused with a transport error');
      foreign.disconnect();
    });

    // ---- 11. Bulk corpus: >500 pages + 32000-CJK body, no endless loop ----
    const BULK_COUNT = 1200;
    const bulkInfo = { firstSeq: 0, lastSeq: 0 };
    await check('bulk corpus seeds through the real domain transaction (server stopped)', async () => {
      // Keep this consumer offline while the durable recovery corpus is
      // created; live delivery must not move the cursor under this test.
      bobSocket.disconnect();
      await stop();
      const dbPath = path.join(data, 'raft.db');
      const helper = path.join(here, 'm4-realtime-fixture');
      const build = await capture('go', ['build', '-o', path.join(data, 'm4rt-fixture'), './' + path.relative(goRoot, helper)], {
        cwd: goRoot, timeout: 300000,
        env: { ...process.env, CGO_ENABLED: '0' }, // ordinary compiler cache; runtime data stays isolated
      });
      if (build.code !== 0) {
        process.stderr.write(build.stdout + build.stderr);
        throw new Error('bulk fixture helper failed to build');
      }
      const seed = await capture(path.join(data, 'm4rt-fixture'), [
        '-db', dbPath, '-workspace', ws, '-channel', pub.id, '-user', alice.user.id,
        '-count', String(BULK_COUNT), '-cjk-units', '32000', '-prefix', 'm4bulk',
      ], { cwd: data, timeout: 300000 });
      if (seed.code !== 0) {
        process.stderr.write(seed.stderr.slice(-4000));
        throw new Error('bulk fixture seeding failed');
      }
      const summary = JSON.parse(seed.stdout.trim().split('\n').pop());
      bulkInfo.firstSeq = summary.firstSeq;
      bulkInfo.lastSeq = summary.lastSeq;
      assert.equal(summary.inserted, BULK_COUNT + 1, 'helper inserted the full corpus');
      await start();
      // Recovery paging is a different obligation from a 1201-event live
      // burst. Keep the consumer offline until the REAL worker drains its
      // durable intents; otherwise that deliberate burst legitimately trips
      // the bounded slow-consumer queue and disconnects during the first
      // resume. The helper observes counts only and never changes outbox rows.
      const drained = await capture(path.join(data, 'm4rt-fixture'), [
        '-db', dbPath, '-workspace', ws, '-channel', pub.id, '-wait-published',
      ], { cwd: data, timeout: 60000 });
      if (drained.code !== 0) {
        process.stderr.write(drained.stderr.slice(-2000));
        throw new Error('message publication backlog did not drain before recovery');
      }
      assert.equal(JSON.parse(drained.stdout.trim()).pendingMessages, 0, 'publisher processed the offline corpus');
    });

    await check('multi-page recovery of 1201 messages converges without duplicates', async () => {
      // bob reconnects into the restarted process and drives the original
      // resume loop from his last live seq. Disconnect counter baseline is
      // taken AFTER the reconnect: only transport stability during the
      // paging itself is under test here.
      await reconnectScoped(bobSocket, bobFeed);
      const disconnectBaseline = bobSocket._disconnects.length;
      const { messages, finalCursor } = await resumeFrom(bobFeed, bobSocket, bulkInfo.firstSeq - 1);
      assert.equal(messages.length, BULK_COUNT + 1, 'recovered every bulk row, including the CJK message');
      const ids = new Set(messages.map(m => m.id));
      assert.equal(ids.size, messages.length, 'resume produced no duplicate ids');
      for (const message of messages) assertCanonicalLive(message, 'bulk recovered');
      assert.ok(finalCursor >= bulkInfo.lastSeq, `final cursor ${finalCursor} covers bulk last seq ${bulkInfo.lastSeq}`);
      // Endless-reconnect guard: an oversized page would overflow the
      // bounded queue, disconnect the client and loop forever. The whole
      // multi-page recovery must ride ONE transport connection.
      const disconnectsDuring = bobSocket._disconnects.length - disconnectBaseline;
      assert.ok(disconnectsDuring === 0,
        `byte-budget recovery must not disconnect the client (saw ${disconnectsDuring} during paging)`);
    });

    await check('the 32000-unit CJK body survives recovery byte-exact', async () => {
      // Recovered rows are buffered by the collector; the CJK corpus row
      // must be present with its full 32000 UTF-16 units.
      const rows = bobFeed.all('sync:resume:response').flatMap(p => p.messages ?? []);
      const row = rows.find(m => typeof m.content === 'string' && m.content.length === 32000
        && [...m.content].every(ch => ch === '界'));
      assert.ok(row, 'the 32000-UTF-16-unit CJK message was recovered in full (not truncated, not dropped)');
      assertCanonicalLive(row, 'cjk recovered');
    });

    // ---- 12. Committed-before-shutdown message survives restart via outbox -
    await check('a message committed right before shutdown is recovered after restart', async () => {
      const last = await sendAlice({ channelId: pub.id, content: 'm4rt pre-restart commit', randomId: randomId() });
      expectStatus(last, 200, 'pre-restart send');
      const rejoined = bobFeed.wait('rooms:joined', {
        after: bobFeed.count('rooms:joined'), timeoutMs: 20000, context: 'automatic server-restart reconnect',
      });
      await stop();
      await start();
      bobSocket.connect();
      await rejoined;
      // Always replay the committed row itself. Observing a pre-shutdown
      // live frame alone is not evidence that it survived in storage.
      const { messages } = await resumeFrom(bobFeed, bobSocket, last.data.message.seq - 1);
      assert.equal(messages.filter(m => m.id === last.data.message.id).length, 1,
        'the committed-before-shutdown row is durably recovered exactly once');
    });

    // ---- 13. Logout closes exactly the revoked session family -------------
    await check('logout closes family A while independent family B stays connected', async () => {
      // A second, independent login creates a NEW family for alice.
      const second = await request('/api/auth/login', {
        method: 'POST', body: { email: alice.email, password: alice.password },
      });
      expectStatus(second, 200, 'second login (new family)');
      const socketA = track(freshSocket(origin, { token: alice.accessToken, serverId: ws }));
      const socketB = track(freshSocket(origin, { token: second.data.accessToken, serverId: ws }));
      const feedA = new Collector(socketA, ['rooms:joined', 'heartbeat', 'disconnect', 'connect_error']);
      const feedB = new Collector(socketB, ['rooms:joined', 'message:new']);
      socketA.connect(); socketB.connect();
      await feedA.wait('rooms:joined', { timeoutMs: 15000 });
      await feedB.wait('rooms:joined', { timeoutMs: 15000 });
      // Register both observations BEFORE the HTTP mutation: eviction can
      // be delivered before its response reaches the caller.
      const familyBDisconnects = socketB._disconnects.length;
      const [closed, refused, logout] = await Promise.all([
        feedA.wait('disconnect', { after: feedA.count('disconnect'), timeoutMs: 12000 }),
        feedA.wait('connect_error', { after: feedA.count('connect_error'), timeoutMs: 12000 }),
        request('/api/auth/logout', {
          method: 'POST', token: alice.accessToken, body: { refreshToken: alice.refreshToken },
        }),
      ]);
      expectStatus(logout, 200, 'family A logout');
      assert.equal(closed, 'transport close', 'revoked family closes the raw transport (auto-reconnect path)');
      assert.equal(refused.message, 'Invalid or expired token', 'revoked family cannot re-authenticate');
      expectStatus(await sendAlice({ channelId: pub.id, content: 'm4rt revoked family probe', randomId: randomId() }),
        401, 'revoked family A cannot write over HTTP either');
      const viaBob = await request('/api/v2/messages', {
        method: 'POST', ...asBob, body: { channelId: pub.id, content: 'm4rt familyB probe', randomId: randomId() },
      });
      expectStatus(viaBob, 200, 'familyB probe via bob');
      await feedB.wait('message:new', { pred: m => m.id === viaBob.data.message.id, timeoutMs: 8000 });
      assert.equal(socketB._disconnects.length, familyBDisconnects, 'independent family B was not evicted');
      // Later administration uses the surviving real login, never the
      // revoked credential. Family A remains revoked for the assertions.
      asAlice.token = second.data.accessToken;
      socketA.disconnect(); socketB.disconnect();
    });

    // ---- 14. Permission mutation evicts the open connection (real fence) ---
    await check('removing private membership evicts the live connection and the room', async () => {
      const bobPriv = track(freshSocket(origin, { token: bob.accessToken, serverId: ws }));
      const feed = new Collector(bobPriv, ['rooms:joined', 'message:new', 'disconnect']);
      bobPriv.connect();
      await feed.wait('rooms:joined', { timeoutMs: 15000 });
      const probe = await sendAlice({ channelId: priv.id, content: 'm4rt priv probe before removal', randomId: randomId() });
      expectStatus(probe, 200, 'priv probe before removal');
      await feed.wait('message:new', { pred: m => m.id === probe.data.message.id, timeoutMs: 8000 });

      const [closed, , removed] = await Promise.all([
        feed.wait('disconnect', { after: feed.count('disconnect'), timeoutMs: 12000 }),
        feed.wait('rooms:joined', { after: feed.count('rooms:joined'), timeoutMs: 15000, context: 'reauthorize after membership removal' }),
        request(`/api/channels/${priv.id}/members/user/${bob.user.id}`, {
          method: 'DELETE', ...asAlice,
        }),
      ]);
      expectStatus(removed, 200, 'private membership removal');
      assert.equal(closed, 'transport close', 'membership loss closes the raw transport');
      // Automatic reconnect succeeds, but its CURRENT room set excludes
      // the removed private scope. Check denial while the client is online.
      assert.ok(bobPriv.connected, 'removed member reconnected at workspace scope');
      const after = await sendAlice({ channelId: priv.id, content: 'm4rt priv probe after removal', randomId: randomId() });
      expectStatus(after, 200, 'priv probe after removal');
      await feed.absent('message:new', { pred: m => m.id === after.data.message.id, graceMs: 1200 });
      bobPriv.disconnect();
    });

    // The shared positive-audience socket intentionally spans the cases.
    bobSocket.disconnect();
    // ---- 15. Strict cleanup ------------------------------------------------
    await check('every client socket is closed before the suite returns', async () => {
      const open = sockets.filter(socket => socket.connected);
      await closeAll();
      assert.equal(open.length, 0,
        `${open.length} client socket(s) were still connected at suite end (each case must disconnect its own sockets)`);
      assert.equal(sockets.length, 0, 'tracked socket set cleared');
    });
  } finally {
    await closeAll();
  }
  return passed;
}

// ---------------------------------------------------------------------------
// Standalone execution: mirror of the m4-backend.mjs isolated runner — build
// the real server into a disposable dir, dynamic loopback port, disposable
// data, strict reaping. Development verification only; the parent's shared
// run.mjs stays the integration entry point.
// ---------------------------------------------------------------------------

async function standalone() {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-m4-realtime-'));
  let child;
  let logs = '';
  const stop = async () => {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exit = once(current, 'exit');
    let forced = false;
    const timer = setTimeout(() => { forced = true; current.kill('SIGKILL'); }, 12000);
    current.kill('SIGINT');
    try {
      const [code, signal] = await exit;
      assert.ok(!forced && (code === 0 || code === 130) && signal === null,
        'standalone server must stop gracefully (hijacked sockets reaped)');
    } finally { clearTimeout(timer); }
  };
  const capture = (program, args, { timeout = 300000, env = process.env, cwd = goRoot } = {}) =>
    new Promise(resolve => {
      const worker = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, timeout);
      worker.stdout.on('data', chunk => { stdout += chunk; });
      worker.stderr.on('data', chunk => { stderr += chunk; });
      worker.once('error', () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr }); });
      worker.once('close', code => {
        clearTimeout(timer);
        if (timedOut) stderr += '\n(acceptance: subprocess timed out and was stopped)';
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  const freePort = async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
  };
  try {
    const executable = path.join(dir, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
    const build = await capture('go', ['build', '-buildvcs=false', '-o', executable, './cmd/raft-server'], {
      env: { ...process.env, CGO_ENABLED: '0', GOCACHE: path.join(dir, 'gocache') },
    });
    if (build.code !== 0) {
      process.stderr.write(build.stdout + build.stderr);
      throw new Error('standalone build failed; see compiler output above');
    }
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const data = path.join(dir, 'data');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      RAFT_GO_LISTEN: `127.0.0.1:${port}`, RAFT_GO_DATA_DIR: data,
      RAFT_GO_WEB_ORIGIN: 'http://127.0.0.1:5175', RAFT_GO_MAIL_MODE: 'outbox',
    };
    const start = async () => {
      if (child) throw new Error('Refusing to start a duplicate standalone process');
      child = spawn(executable, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Standalone server exited before readiness (see its log tail of ${logs.length} bytes)`);
        }
        try {
          const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          if (response.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error('Standalone server readiness timed out');
    };
    await start();
    await verifyM4Realtime({ origin, data, start, stop, capture, executable, env });
    if (/[?&](verify|reset)=|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(logs)) {
      throw new Error('Server emitted credential-like material to logs');
    }
    await stop();
    console.log('PASS standalone M4 realtime run shut down cleanly with credential-safe output');
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await standalone();
}
