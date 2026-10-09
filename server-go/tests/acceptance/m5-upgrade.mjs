// M4 -> M5 real-process upgrade acceptance (m5-execution-lock.md worker F).
//
// The FROZEN M4 stabilization binary (336b5c8, the last commit before any M5
// schema) creates real data through its own HTTP APIs — accounts, workspace,
// join, channels, a message with reactions, a thread, a human DM, read
// frontier, notification/display preferences, an Agent + credential, a
// Computer attach and a pending invite — then the CURRENT executable upgrades
// that data in place (migration 0014+). Phase-5-delivery.md §12 defines the
// acceptance: signing key/session/message.seq/readstate survive; the old
// binary refuses the newer schema (fail closed); restoring the matching cold
// backup makes the old binary work AND resume writes. Only temp copies and
// ephemeral loopback ports are touched; no var*/, no running instance.
//
// Pending-delivery persistence honesty: the HTTP mention->intent surface
// (messaging S2 / agentapi S4) is probed and REPORTED, but this suite never
// fakes it. The persistence-layer guarantee (unconfirmed agent_deliveries
// rows surviving reopen) is asserted at the database level by
// internal/platform/db/m5_upgrade_test.go. When the agentapi surfaces are
// wired, the parent executor should extend this suite to drive them end to
// end; the probe below prints exactly what is available today.
//
// Parent wiring (run.mjs, parent-executor owned — this file must stay
// importable standalone):
//   import { verifyM4ToM5Upgrade } from './m5-upgrade.mjs';
//   ... RAFT_GO_TEST_SUITE=m5-upgrade branch calling
//   verifyM4ToM5Upgrade({ executable, capture })
// Standalone: node tests/acceptance/m5-upgrade.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  attachComputer, createVerifiedAccount, createWorkspace, deviceLogin,
  expectStatus, httpClient,
} from './m3-harness.mjs';

const execFile = promisify((await import('node:child_process')).execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const repo = path.dirname(root);

// The frozen M4 stabilization baseline (docs/m5-execution-lock.md common
// input; the M5 design names 336b5c8 as the completed-stabilization commit).
// Its embedded migration chain ends at 0013 — everything newer is M5.
export const FROZEN_M4_COMMIT = '336b5c81b8d67c1c5d3cec2ef7e6fcb0bd2fed1c';
const FROZEN_M4_LAST_MIGRATION = '0013_activity_mute_epochs.sql';

// Migrations newer than the frozen M4 chain currently on disk. This is the
// structural gate for the whole suite: without an 0014+ there is no M5
// upgrade to accept, and the suite must fail loudly instead of silently
// passing a no-op open.
export async function m5MigrationsOnDisk(dir = root) {
  const names = (await readdir(path.join(dir, 'internal/platform/db/migrations')))
    .filter((n) => n.endsWith('.sql')).sort();
  const frozen = names.filter((n) => n <= FROZEN_M4_LAST_MIGRATION);
  return { names, frozen, pending: names.filter((n) => n > FROZEN_M4_LAST_MIGRATION) };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// Real M4 world through the frozen binary's own APIs.
// ---------------------------------------------------------------------------
async function seedM4World(request, data) {
  const maildir = path.join(data, 'outbox');
  const owner = await createVerifiedAccount(request, maildir, 'm5-up-owner');
  const member = await createVerifiedAccount(request, maildir, 'm5-up-member');
  const workspace = await createWorkspace(request, owner, 'm5-upgrade');
  const ws = workspace.id;
  const asOwner = { token: owner.accessToken, server: ws };
  const asMember = { token: member.accessToken, server: ws };
  const link = await request(`/api/servers/${ws}/join-links`, { ...asOwner, method: 'POST', body: { maxUses: null, expiresAt: null } });
  expectStatus(link, 200, 'frozen M4 creates a join link');
  expectStatus(await request('/api/auth/accept-invite', {
    token: member.accessToken, method: 'POST', body: { token: link.data.token },
  }), 200, 'frozen M4 joins the member via the invitation protocol');

  const channel = await request('/api/channels', {
    ...asOwner, method: 'POST', body: { name: 'm5-upgrade-general', visibility: 'public' },
  });
  expectStatus(channel, 200, 'frozen M4 creates the public channel');
  const channelId = channel.data.id;
  expectStatus(await request(`/api/channels/${channelId}/join`, { ...asMember, method: 'POST', body: {} }), 200, 'member joins the channel');
  const privateChannel = await request('/api/channels', {
    ...asOwner, method: 'POST', body: { name: 'm5-upgrade-private', visibility: 'private' },
  });
  expectStatus(privateChannel, 200, 'frozen M4 creates the private channel');

  const originalBody = { channelId, content: 'message created by the frozen M4 binary', randomId: 'm5-upgrade-original' };
  const sent = await request('/api/v2/messages', { ...asOwner, method: 'POST', body: originalBody });
  expectStatus(sent, 200, 'frozen M4 sends the original message');
  const original = sent.data.message;
  for (const actor of [asOwner, asMember]) {
    expectStatus(await request(`/api/messages/${original.id}/reactions`, {
      ...actor, method: 'POST', body: { emoji: '👍' },
    }), 200, 'frozen M4 persists two reaction actors');
  }
  const thread = await request(`/api/channels/${channelId}/threads`, {
    ...asMember, method: 'POST', body: { parentMessageId: original.id, content: 'frozen M4 thread reply' },
  });
  expectStatus(thread, 200, 'frozen M4 atomically creates thread and reply');
  const threadId = thread.data.threadChannelId;
  const dm = await request('/api/channels/dm', { ...asOwner, method: 'POST', body: { userId: member.user.id } });
  expectStatus(dm, 200, 'frozen M4 creates the human DM');
  expectStatus(await request('/api/v2/messages', {
    ...asOwner, method: 'POST', body: { channelId: dm.data.id, content: 'frozen M4 DM', randomId: 'm5-up-dm' },
  }), 200, 'frozen M4 persists a DM message');
  // Readstate facts the upgrade must preserve: frontier, mute, display.
  expectStatus(await request(`/api/channels/${channelId}/read`, {
    ...asMember, method: 'POST', body: { seq: original.seq },
  }), 200, 'frozen M4 persists a read frontier');
  expectStatus(await request(`/api/channels/${channelId}/notification-settings`, {
    ...asMember, method: 'PATCH', body: { activityMuted: true },
  }), 200, 'frozen M4 persists notification preferences');
  expectStatus(await request(`/api/channels/${channelId}/message-display-settings`, {
    ...asMember, method: 'PATCH', body: { collapseLongMessages: false },
  }), 200, 'frozen M4 persists display preferences');

  const agent = await request('/api/agents', { ...asOwner, method: 'POST', body: { name: 'm5-upgrade-relay', external: true } });
  expectStatus(agent, 200, 'frozen M4 creates an external agent');
  const credential = await request(`/api/agents/${agent.data.id}/credentials`, { token: owner.accessToken, method: 'POST', body: {} });
  expectStatus(credential, 201, 'frozen M4 mints an agent credential');
  const device = await deviceLogin(request, { approveToken: owner.accessToken, clientName: 'm5-upgrade-computer' });
  const computer = await attachComputer(request, {
    userToken: device.session.accessToken, serverSlug: workspace.slug, name: 'M5 upgrade Computer',
  });
  const invite = await request(`/api/servers/${ws}/invites`, { ...asOwner, method: 'POST', body: { email: 'm5-upgrade-pending@example.test' } });
  expectStatus(invite, 200, 'frozen M4 persists an unconsumed invitation');

  return {
    owner, member, workspace, asOwner, asMember, channelId, threadId, dmId: dm.data.id,
    privateId: privateChannel.data.id, original, originalBody,
    agentId: agent.data.id, agentKey: credential.data.apiKey, computerKey: computer.apiKey,
    jwtKey: await readFile(path.join(data, 'keys', 'jwt-secret')),
  };
}

// The persisted HTTP views whose byte-stable survival proves key/session/
// message/readstate integrity across the binary swap. historyCutoff is a
// rolling request-clock value: its day-window semantics are validated, then
// only that field is normalized for cross-process comparison (same approach
// as the stabilization suite).
async function persistedViews(request, world) {
  const { asOwner, asMember, channelId, threadId, dmId, workspace, original } = world;
  const queries = [
    ['profile', '/api/auth/me', { token: world.owner.accessToken }],
    ['servers', '/api/servers', { token: world.owner.accessToken }],
    ['unread', '/api/servers/unread-summary', asMember],
    ['channels', '/api/channels', asMember],
    ['history', `/api/messages/channel/${channelId}`, asMember],
    ['threadHistory', `/api/messages/channel/${threadId}`, asMember],
    ['dmHistory', `/api/messages/channel/${dmId}`, asMember],
    ['dmList', '/api/channels/dm', asMember],
    ['followed', '/api/channels/threads/followed', asMember],
    ['notification', `/api/channels/${channelId}/notification-settings`, asMember],
    ['display', `/api/channels/${channelId}/message-display-settings`, asMember],
    ['viewer', `/api/messages/${original.id}/reactions/viewer`, asMember],
    ['invitations', `/api/servers/${workspace.id}/invites`, asOwner],
  ];
  const state = {};
  for (const [name, route, actor] of queries) {
    const startedAt = Date.now();
    const response = await request(route, actor);
    const endedAt = Date.now();
    expectStatus(response, 200, `read persisted ${name}`);
    let data = response.data;
    if (name === 'servers') {
      assert.ok(Array.isArray(data), 'servers view returns an array');
      data = data.map(server => {
        assert.ok(Number.isInteger(server.messageHistoryDays), 'server history day-window is integral');
        if (server.messageHistoryDays < 0) {
          assert.equal(server.historyCutoff, null, 'unlimited history has an explicit null cutoff');
          return server;
        }
        assert.match(server.historyCutoff ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'history cutoff retains millisecond UTC wire shape');
        const cutoff = Date.parse(server.historyCutoff);
        const offset = server.messageHistoryDays * 24 * 60 * 60 * 1000;
        assert.ok(cutoff >= startedAt - offset && cutoff <= endedAt - offset,
          'history cutoff is exactly the current UTC day-window');
        return { ...server, historyCutoff: '<validated-current-history-window>' };
      });
    }
    state[name] = data;
  }
  return state;
}

async function credentialsStillAuthenticate(request, world) {
  const whoami = await request('/internal/agent-api/', { token: world.agentKey });
  expectStatus(whoami, 200, 'the pre-upgrade Agent credential still authenticates');
  expectStatus(await request('/internal/computer/preflight', {
    method: 'POST', token: world.computerKey, body: {},
  }), 200, 'the pre-upgrade Computer credential still authenticates');
  expectStatus(await request('/internal/agent-api', { token: world.owner.accessToken }), 401, 'human tokens never become Agent credentials');
}

// M5 closure requires these routes to be live after an actual M4 upgrade.
// An empty send/history/resolve body must reach contract validation (400),
// never quietly remain an unimplemented 501 while the upgrade gate passes.
async function probeM5DeliverySurfaces(request, world) {
  const probes = {};
  for (const [name, route, input, expected] of [
    ['agent-whoami', '/internal/agent-api/', { token: world.agentKey }, 200],
    ['agent-send', '/internal/agent-api/send', { token: world.agentKey, method: 'POST', body: {} }, 400],
    ['agent-v2-send', '/internal/agent-api/v2/send', { token: world.agentKey, method: 'POST', body: {} }, 400],
    ['agent-history', '/internal/agent-api/history', { token: world.agentKey }, 400],
    ['agent-resolve', '/internal/agent-api/resolve-channel', { token: world.agentKey, method: 'POST', body: {} }, 400],
    ['agent-events-check', '/internal/agent-api/events', { token: world.agentKey }, 200],
    ['agent-events-claim', '/internal/agent-api/events/claim', { token: world.agentKey }, 200],
    ['agent-events-ack', '/internal/agent-api/events/ack', { token: world.agentKey, method: 'POST', body: {} }, 200],
    ['agent-events-head', '/internal/agent-api/events', { token: world.agentKey, method: 'HEAD' }, 405],
    ['agent-claim-head', '/internal/agent-api/events/claim', { token: world.agentKey, method: 'HEAD' }, 405],
  ]) {
    const response = await request(route, input);
    expectStatus(response, expected, `upgraded M5 production surface ${name}`);
    probes[name] = response.status;
  }
  return probes;
}

// Exercise the NEW capability with credentials and identities minted by the
// frozen M4 process. Restart before claim, after claim, and after the reply:
// migration preservation alone is not proof that durable delivery is wired.
async function verifyUpgradedAgentDelivery(request, world, restart) {
  const dm = await request('/api/channels/dm', {
    ...world.asOwner, method: 'POST', body: { agentId: world.agentId },
  });
  expectStatus(dm, 200, 'a migrated Agent can enter a canonical human-Agent DM');
  assert.equal(dm.data.peerType, 'agent');
  assert.equal(dm.data.peerId, world.agentId);
  const dmId = dm.data.id;
  const input = { channelId: dmId, content: 'Durable Agent input on migrated M4 data', randomId: 'm5-upgrade-agent-input' };
  const sent = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: input });
  expectStatus(sent, 200, 'migrated human identity atomically persists a message and Agent recipient');
  const message = sent.data.message;
  await restart();
  const replay = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: input });
  expectStatus(replay, 200, 'post-restart replay preserves the exact source identity');
  assert.equal(replay.data.message.id, message.id);
  assert.equal(replay.data.message.seq, message.seq);
  const claim = await request('/internal/agent-api/events/claim', { token: world.agentKey });
  expectStatus(claim, 200, 'pending migrated-data delivery survives server restart');
  assert.equal(claim.data.events.length, 1, 'source replay cannot create a second logical recipient');
  assert.equal(claim.data.events[0].message_id, message.id);
  assert.equal(claim.data.events[0].content, input.content);
  // Original server wire: positive-seq messages use seqs; message_ids is
  // reserved for transient/non-positive-seq notices, not duplicate message IDs.
  assert.deepEqual(claim.data.ack, { seqs: [message.seq], message_ids: [], third_party_event_ids: [] });
  await restart();
  const reclaim = await request('/internal/agent-api/events/claim', { token: world.agentKey });
  expectStatus(reclaim, 200, 'a persisted open claim is reissued after process restart');
  assert.deepEqual(reclaim.data.ack, claim.data.ack);
  const ack = await request('/internal/agent-api/events/ack', {
    token: world.agentKey, method: 'POST', body: reclaim.data.ack,
  });
  expectStatus(ack, 200, 'the pre-upgrade credential acknowledges only its claimed delivery');
  assert.equal(ack.data.removed_count, 1);
  const duplicateAck = await request('/internal/agent-api/events/ack', {
    token: world.agentKey, method: 'POST', body: reclaim.data.ack,
  });
  expectStatus(duplicateAck, 200, 'the same original-wire ACK remains idempotent');
  assert.equal(duplicateAck.data.removed_count, 0);
  const profile = await request('/api/auth/me', { token: world.owner.accessToken });
  expectStatus(profile, 200, 'read the migrated human handle for the original Agent target DSL');
  assert.ok(typeof profile.data.name === 'string' && profile.data.name.length > 0);
  const replyBody = { target: `dm:@${profile.data.name}`, content: 'Real Agent-credential reply after M4 upgrade', idempotencyKey: 'm5-upgrade-agent-reply' };
  const reply = await request('/internal/agent-api/v2/send', { token: world.agentKey, method: 'POST', body: replyBody });
  expectStatus(reply, 200, 'the migrated Agent sends a real persisted reply');
  assert.equal(reply.data.state, 'sent');
  await restart();
  const repeatReply = await request('/internal/agent-api/v2/send', { token: world.agentKey, method: 'POST', body: replyBody });
  expectStatus(repeatReply, 200, 'Agent reply idempotency survives restart');
  assert.equal(repeatReply.data.messageId, reply.data.messageId);
  assert.equal(repeatReply.data.messageSeq, reply.data.messageSeq);
  const history = await request(`/api/messages/channel/${dmId}`, world.asOwner);
  expectStatus(history, 200, 'original Web-compatible history exposes the actual Agent reply');
  assert.equal(history.data.messages.length, 2, 'one human input and one Agent reply, no duplicate messages');
  const actualReply = history.data.messages.find(row => row.id === reply.data.messageId);
  assert.ok(actualReply, 'Agent send success refers to a real visible message');
  assert.equal(actualReply.senderType, 'agent');
  assert.equal(actualReply.senderId, world.agentId);
  assert.equal(actualReply.content, replyBody.content);
  const unread = await request('/api/channels/unread', world.asOwner);
  expectStatus(unread, 200, 'human readstate accepts migrated Agent DM');
  assert.equal(unread.data[dmId], 1, 'Agent reply increases human unread exactly once');
  const stranger = await request(`/api/messages/channel/${dmId}`, world.asMember);
  assert.ok([403, 404].includes(stranger.status), 'other M4 workspace members cannot read a private Agent DM');
  console.log('PASS upgraded M4 credentials: pending input and open claim survive restarts, exact ACK removes once, Agent reply persists/replays once, and DM history/unread stay participant-scoped');
}

export async function verifyM4ToM5Upgrade({ executable, capture }) {
  const { pending } = await m5MigrationsOnDisk();
  assert.ok(pending.length > 0,
    `the M5 upgrade acceptance requires at least one migration newer than ${FROZEN_M4_LAST_MIGRATION} (found only ${pending.length}); nothing to upgrade would make this suite a silent no-op pass`);
  console.log(`M5 migrations under acceptance: ${pending.join(', ')}`);

  const dir = await mkdtemp(path.join(tmpdir(), 'raft-m4-m5-upgrade-'));
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
    current.kill('SIGTERM');
    try {
      const [code, signal] = await exit;
      assert.ok(!forced && code === 0 && signal === null, 'owned test server must stop gracefully');
    } finally { clearTimeout(timer); }
  };
  try {
    // 1. Frozen M4 binary from committed source only (working tree untouched).
    const snapshot = path.join(dir, 'm4-source');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(snapshot);
    const archive = await execFile('git', ['archive', '--format=tar', FROZEN_M4_COMMIT, 'server-go'], {
      cwd: repo, encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    const tar = path.join(dir, 'm4.tar');
    await writeFile(tar, archive.stdout, { mode: 0o600 });
    await execFile('tar', ['-xf', tar, '-C', snapshot], { timeout: 30000 });
    const oldBinary = path.join(dir, process.platform === 'win32' ? 'm4-server.exe' : 'm4-server');
    const built = await capture('go', ['build', '-buildvcs=false', '-o', oldBinary, './cmd/raft-server'], {
      cwd: path.join(snapshot, 'server-go'), env: { ...process.env, CGO_ENABLED: '0' }, timeout: 180000,
    });
    assert.equal(built.code, 0, `the frozen M4 source at ${FROZEN_M4_COMMIT.slice(0, 7)} must build independently`);

    // 2. The frozen binary creates real data, then we snapshot every view.
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const data = path.join(dir, 'data');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      RAFT_GO_LISTEN: `127.0.0.1:${port}`, RAFT_GO_DATA_DIR: data,
      RAFT_GO_WEB_ORIGIN: 'http://127.0.0.1:5175', RAFT_GO_MAIL_MODE: 'outbox',
    };
    const start = async binary => {
      if (child) throw new Error('refusing to start a duplicate test process');
      child = spawn(binary, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('owned test server exited before readiness');
        try {
          const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await ready.arrayBuffer();
          if (ready.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error('owned test server readiness timed out');
    };
    const request = httpClient(origin);

    await start(oldBinary);
    const world = await seedM4World(request, data);
    await credentialsStillAuthenticate(request, world);
    const before = await persistedViews(request, world);
    await stop();

    // 3. Cold backup of the M4-schema data (checkpointed by graceful stop),
    //    taken BEFORE the new binary ever touches it.
    const backup = path.join(dir, 'cold-backup');
    await cp(data, backup, { recursive: true });

    // 4. The current executable upgrades the real data in place.
    await start(executable);
    assert.ok((await readFile(path.join(data, 'keys', 'jwt-secret'))).equals(world.jwtKey),
      'the M5 upgrade must not rotate the signing key');
    await credentialsStillAuthenticate(request, world);
    const after = await persistedViews(request, world);
    assert.deepEqual(after, before, 'the M5 upgrade preserves all thirteen persisted HTTP views (key/session/message/readstate integrity)');
    // Session integrity end to end: refresh lineage and the password verifier.
    expectStatus(await request('/api/auth/refresh', {
      method: 'POST', body: { refreshToken: world.owner.refreshToken },
    }), 200, 'the pre-upgrade refresh token survives the upgrade');
    expectStatus(await request('/api/auth/login', {
      method: 'POST', body: { email: world.owner.email, password: world.owner.password },
    }), 200, 'the pre-upgrade password verifier survives the upgrade');
    // randomId replay: same stable id, no duplicate seq.
    const replay = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: world.originalBody });
    expectStatus(replay, 200, 'the upgraded binary recognizes the M4 idempotency key/digest');
    assert.equal(replay.data.message.id, world.original.id, 'replay returns the original stable message id');
    assert.equal(replay.data.message.seq, world.original.seq, 'replay does not allocate another seq');
    // Writes resume on the M5 schema: a fresh message continues the channel.
    const added = await request('/api/v2/messages', {
      ...world.asMember, method: 'POST',
      body: { channelId: world.channelId, content: 'first M5-era message on upgraded data', randomId: 'm5-upgrade-new' },
    });
    expectStatus(added, 200, 'the upgraded binary extends the migrated channel');
    assert.ok(added.data.message.seq > world.original.seq, 'the new message continues the channel seq without gaps');
    const extended = await persistedViews(request, world);
    // 5. Server restart on the upgraded data: unconfirmed state survives.
    await stop();
    await start(executable);
    assert.ok((await readFile(path.join(data, 'keys', 'jwt-secret'))).equals(world.jwtKey),
      'restart keeps the signing key stable');
    const afterRestart = await persistedViews(request, world);
    assert.deepEqual(afterRestart, extended, 'a server restart on upgraded data preserves every persisted view (no in-memory-only state)');
    await credentialsStillAuthenticate(request, world);
    const surfaces = await probeM5DeliverySurfaces(request, world);
    await verifyUpgradedAgentDelivery(request, world, async () => {
      await stop();
      await start(executable);
    });
    await stop();

    // 6. The frozen M4 binary refuses the M5 schema (fail closed, no damage).
    const rejected = await capture(oldBinary, [], { cwd: dir, env, timeout: 30000 });
    assert.notEqual(rejected.code, 0, 'the frozen M4 binary must refuse the M5 schema');
    assert.match(rejected.stdout + rejected.stderr, /schema version.*newer than this binary/,
      'the refusal must be the migration guard, not an unrelated startup failure');

    // 7. Restoring the matching cold backup makes the old binary work again
    //    AND resume writes (phase-5-delivery.md §12).
    await rm(data, { recursive: true, force: true });
    await cp(backup, data, { recursive: true });
    await start(oldBinary);
    const restored = await persistedViews(request, world);
    assert.deepEqual(restored, before, 'the cold backup restores the original pre-upgrade views under the old binary');
    await credentialsStillAuthenticate(request, world);
    const resumed = await request('/api/v2/messages', {
      ...world.asOwner, method: 'POST',
      body: { channelId: world.channelId, content: 'old binary resumes writing after the restore', randomId: 'm5-upgrade-rollback-write' },
    });
    expectStatus(resumed, 200, 'the restored old binary resumes writes, not merely reads');
    const resumedReplay = await request('/api/v2/messages', {
      ...world.asOwner, method: 'POST',
      body: { channelId: world.channelId, content: 'old binary resumes writing after the restore', randomId: 'm5-upgrade-rollback-write' },
    });
    expectStatus(resumedReplay, 200, 'idempotent replay still holds on the restored instance');
    assert.equal(resumedReplay.data.message.id, resumed.data.message.id, 'the replay does not duplicate the resumed write');
    await stop();

    for (const secret of [world.owner.password, world.owner.accessToken, world.owner.refreshToken, world.agentKey, world.computerKey]) {
      assert.ok(!logs.includes(secret), 'process logs must not contain test credentials');
    }

    console.log(`PASS frozen M4 (${FROZEN_M4_COMMIT.slice(0, 7)}) real data upgraded in place by the current executable: signing key, sessions, credentials, messages/seq, thread/DM, readstate and invitations preserved across ${pending.length} M5 migration(s)`);
    console.log('PASS upgraded instance keeps idempotent replay, resumes writes on the M5 schema and survives a server restart with all views stable');
    console.log('PASS the frozen M4 binary refuses the M5 schema with the migration guard, and the matching cold backup restores a writable old instance');
    const surfaceLine = Object.entries(surfaces).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`PASS required M5 HTTP delivery surfaces on the upgraded instance: ${surfaceLine}; successful persisted Agent input/claim/ACK/reply verified with original M4 credentials`);
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

// ---------------------------------------------------------------------------
// Standalone execution: build the current tree once into a temp dir (with an
// isolated GOCACHE), then run the exported verifier. run.mjs stays the shared
// entry for the parent gate.
// ---------------------------------------------------------------------------
async function standalone() {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-m4-m5-runner-'));
  const executable = path.join(dir, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
  const capture = (program, args, { timeout = 240000, env = process.env, cwd = root } = {}) => new Promise((resolve, reject) => {
    const worker = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, timeout);
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${path.basename(program)} timed out; subprocess was stopped`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
  try {
    const built = await capture('go', ['build', '-buildvcs=false', '-o', executable, './cmd/raft-server'], {
      env: { ...process.env, CGO_ENABLED: '0', GOCACHE: path.join(dir, 'gocache') },
    });
    if (built.code !== 0) { process.stderr.write(built.stdout + built.stderr); throw new Error('standalone build of the current tree failed'); }
    await verifyM4ToM5Upgrade({ executable, capture });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await standalone();
}
