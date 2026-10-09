// Historical architecture-refactor contract, retained across the additive M5
// schema: a FROZEN M4 binary creates real data, the current binary preserves
// and extends its cold copy. The old binary must now REFUSE the upgraded
// schema; its matching original cold backup restores a writable old instance.
// --baseline-only still checks the original same-schema roundtrip against
// the frozen binary itself. No UI, SQL fixture seeding or live data access.
//
// Standalone: node tests/acceptance/stabilization-rollback.mjs
// Harness self-check ONLY: append --baseline-only (old vs old; not new-code
// evidence). This checks that the eleven observed HTTP views are stable
// across restarts before using their equality as a refactor assertion.
// Parent integration can call verifyStabilizationRollback with
// the already built current executable and capture helper.
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.dirname(root);
const BASELINE = '6ffc168dd7025a2d5f61416347ecc9937853c3ad';

async function captureTool(program, args, { cwd = root, env = process.env, timeout = 180000 } = {}) {
  try {
    const result = await execFile(program, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function seedWorld(request, data) {
  const maildir = path.join(data, 'outbox');
  const owner = await createVerifiedAccount(request, maildir, 'rollback-owner');
  const member = await createVerifiedAccount(request, maildir, 'rollback-member');
  const stranger = await createVerifiedAccount(request, maildir, 'rollback-stranger');
  // A real authenticated but unverified/unconfigured account distinguishes
  // Require from the stronger verified/profile gate during HTTP repartition.
  const pendingID = randomUUID();
  const pending = await request('/api/auth/register', {
    method: 'POST', body: {
      email: `pending-${pendingID}@example.test`, password: `Pending-${pendingID}-Password!`,
      acceptTerms: true, termsVersion: '2026-05-12', privacyVersion: '2026-05-12', legalAcceptanceSource: 'signup',
    },
  });
  expectStatus(pending, 200, 'baseline creates a genuine unfinished account');
  const workspace = await createWorkspace(request, owner, 'rollback');
  const ws = workspace.id;
  const asOwner = { token: owner.accessToken, server: ws };
  const asMember = { token: member.accessToken, server: ws };
  const link = await request(`/api/servers/${ws}/join-links`, {
    ...asOwner, method: 'POST', body: { maxUses: null, expiresAt: null },
  });
  expectStatus(link, 200, 'baseline creates a real join link');
  expectStatus(await request('/api/auth/accept-invite', {
    token: member.accessToken, method: 'POST', body: { token: link.data.token },
  }), 200, 'baseline joins a member using the invitation protocol');

  const channel = await request('/api/channels', {
    ...asOwner, method: 'POST', body: { name: 'rollback-chat', visibility: 'public' },
  });
  expectStatus(channel, 200, 'baseline creates a channel');
  const channelId = channel.data.id;
  expectStatus(await request(`/api/channels/${channelId}/join`, {
    ...asMember, method: 'POST', body: {},
  }), 200, 'baseline member joins channel');
  const privateChannel = await request('/api/channels', {
    ...asOwner, method: 'POST', body: { name: 'rollback-private', visibility: 'private' },
  });
  expectStatus(privateChannel, 200, 'baseline creates an owner-private channel');

  const originalBody = { channelId, content: 'message created by the frozen baseline', randomId: 'architecture-rollback-original' };
  const sent = await request('/api/v2/messages', { ...asOwner, method: 'POST', body: originalBody });
  expectStatus(sent, 200, 'baseline sends original message');
  const original = sent.data.message;
  for (const actor of [asOwner, asMember]) {
    expectStatus(await request(`/api/messages/${original.id}/reactions`, {
      ...actor, method: 'POST', body: { emoji: '👍' },
    }), 200, 'baseline persists two reaction actors');
  }
  const actorPagePath = `/api/messages/${original.id}/reactions/actors?emoji=${encodeURIComponent('👍')}&limit=1`;
  const actors = await request(actorPagePath, asMember);
  expectStatus(actors, 200, 'baseline issues signed reaction pagination cursor');
  assert.equal(typeof actors.data.nextCursor, 'string', 'baseline pagination requires a nonempty signed cursor');
  assert.ok(actors.data.nextCursor.length > 0, 'signed cursor exists');
  const cursorPath = `${actorPagePath}&cursor=${encodeURIComponent(actors.data.nextCursor)}`;
  const cursorPage = await request(cursorPath, asMember);
  expectStatus(cursorPage, 200, 'baseline accepts its signed cursor');

  const thread = await request(`/api/channels/${channelId}/threads`, {
    ...asMember, method: 'POST', body: { parentMessageId: original.id, content: 'baseline thread reply' },
  });
  expectStatus(thread, 200, 'baseline atomically creates thread and reply');
  const threadId = thread.data.threadChannelId;
  const dm = await request('/api/channels/dm', {
    ...asOwner, method: 'POST', body: { userId: member.user.id },
  });
  expectStatus(dm, 200, 'baseline creates a human DM');
  expectStatus(await request('/api/v2/messages', {
    ...asOwner, method: 'POST', body: { channelId: dm.data.id, content: 'baseline DM', randomId: 'rollback-dm' },
  }), 200, 'baseline persists a DM message');
  expectStatus(await request(`/api/channels/${channelId}/read`, {
    ...asMember, method: 'POST', body: { seq: original.seq },
  }), 200, 'baseline persists a real read frontier');
  expectStatus(await request(`/api/channels/${channelId}/notification-settings`, {
    ...asMember, method: 'PATCH', body: { activityMuted: true },
  }), 200, 'baseline persists notification preferences');
  expectStatus(await request(`/api/channels/${channelId}/message-display-settings`, {
    ...asMember, method: 'PATCH', body: { collapseLongMessages: false },
  }), 200, 'baseline persists display preferences');

  const agent = await request('/api/agents', {
    ...asOwner, method: 'POST', body: { name: 'rollback-agent', external: true },
  });
  expectStatus(agent, 200, 'baseline creates an external agent');
  const credential = await request(`/api/agents/${agent.data.id}/credentials`, {
    token: owner.accessToken, method: 'POST', body: {},
  });
  expectStatus(credential, 201, 'baseline mints a real Agent credential');
  const device = await deviceLogin(request, { approveToken: owner.accessToken, clientName: 'rollback-computer' });
  const computer = await attachComputer(request, {
    userToken: device.session.accessToken, serverSlug: workspace.slug, name: 'Rollback computer',
  });
  const pendingInvite = await request(`/api/servers/${ws}/invites`, {
    ...asOwner, method: 'POST', body: { email: 'rollback-pending@example.test' },
  });
  expectStatus(pendingInvite, 200, 'baseline persists an unconsumed invitation');

  return {
    owner, member, stranger, pendingToken: pending.data.accessToken, workspace, asOwner, asMember, channelId,
    privateId: privateChannel.data.id, threadId, dmId: dm.data.id,
    original, originalBody, cursorPath, cursorPage: cursorPage.data,
    agentKey: credential.data.apiKey, computerKey: computer.apiKey,
    jwtKey: await readFile(path.join(data, 'keys', 'jwt-secret')),
  };
}

async function observableState(request, world) {
  const { asOwner, asMember, channelId, threadId, dmId, workspace, original } = world;
  const queries = [
    ['profile', '/api/auth/me', { token: world.owner.accessToken }],
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
    const response = await request(route, actor);
    expectStatus(response, 200, `read persisted ${name}`);
    state[name] = response.data;
  }
  return state;
}

// Representative high-risk routing contracts, captured from the real frozen
// process rather than accepting a newly generated golden. All mutations here
// are invalid/unsupported and must not change the seeded business state.
async function routeObservations(request, world) {
  const { asOwner, asMember, workspace, channelId, pendingToken, agentKey, computerKey } = world;
  const cases = [
    ['human rejects Agent key', '/api/channels', { token: agentKey, server: workspace.id }],
    ['human rejects Computer key', '/api/channels', { token: computerKey, server: workspace.id }],
    ['agent rejects human token', '/internal/agent-api', { token: world.owner.accessToken }],
    ['agent rejects Computer key', '/internal/agent-api', { token: computerKey }],
    ['computer rejects Agent key', '/internal/computer/preflight', { token: agentKey, method: 'POST', body: {} }],
    ['computer rejects human token', '/internal/computer/preflight', { token: world.owner.accessToken, method: 'POST', body: {} }],
    ['agent unknown unauthenticated', '/internal/agent-api/not-registered', {}],
    ['agent unknown authenticated', '/internal/agent-api/not-registered', { token: agentKey }],
    ['agent wrong method', '/internal/agent-api', { token: agentKey, method: 'POST', body: {} }],
    ['agent known deferred family', '/internal/agent-api/tasks', { token: agentKey }],
    ['computer unknown unauthenticated', '/internal/computer/not-registered', { method: 'POST', body: {} }],
    ['computer unknown authenticated', '/internal/computer/not-registered', { token: computerKey, method: 'POST', body: {} }],
    ['workspace auth before method', `/api/servers/${workspace.id}/settings`, { method: 'DELETE' }],
    ['workspace method after auth', `/api/servers/${workspace.id}/settings`, { ...asOwner, method: 'DELETE' }],
    ['workspace scope before method', `/api/servers/${workspace.id}/settings`, { token: world.owner.accessToken, method: 'DELETE' }],
    ['workspace mismatched scope', `/api/servers/${workspace.id}/settings`, { token: world.owner.accessToken, server: 'wrong-workspace', method: 'DELETE' }],
    ['unread summary method literal', '/api/servers/unread-summary', { ...asOwner, method: 'POST', body: {} }],
    ['server order method literal', '/api/servers/order', { ...asOwner, method: 'POST', body: {} }],
    ['servers trailing alias', '/api/servers/', { token: world.owner.accessToken }],
    ['channels trailing alias', '/api/channels/', asMember],
    ['channel subtree trailing slash', `/api/channels/${channelId}/`, asMember],
    ['channel method requires auth', '/api/channels', { method: 'DELETE' }],
    ['channel method Allow', '/api/channels', { ...asMember, method: 'DELETE' }],
    ['agent trailing whoami', '/internal/agent-api/', { token: agentKey }],
    ['v2 bare-path bad body', '/api/v2/messages', { ...asMember, method: 'POST', body: {} }],
    ['v1 bare-path bad body', '/api/messages', { ...asMember, method: 'POST', body: {} }],
    ['known unsupported read mutation', '/api/read-mutations', { ...asMember, method: 'POST', body: {} }],
    ['unfinished account me', '/api/auth/me', { token: pendingToken }],
    ['unfinished account device approve', '/api/auth/device/approve', { token: pendingToken, method: 'POST', body: {} }],
    ['unfinished account attach', '/api/computer/attach', { token: pendingToken, method: 'POST', body: {} }],
    ['unfinished account legacy roster', '/api/computer/legacy-machines', { token: pendingToken }],
    ['device exchange is public', '/api/auth/device/token', { method: 'POST', body: { deviceCode: 'not-issued' } }],
    ['bootstrap exchange is public', '/api/agent/login', { method: 'POST', body: { bootstrapToken: 'not-issued' } }],
  ];
  const observations = {};
  for (const [label, route, input] of cases) {
    const startedAt = Date.now();
    const response = await request(route, input);
    const endedAt = Date.now();
    let data = response.data;
    if (label === 'servers trailing alias' && response.status === 200) {
      assert.ok(Array.isArray(data), 'servers trailing alias returns an array');
      data = data.map(server => {
        // This one field is a rolling policy value, not persisted state:
        // baseline historyCutoff uses now.UTC().AddDate(0,0,-days). Validate
        // its exact day-window meaning against the request clock, then
        // normalize ONLY that verified timestamp for cross-process equality.
        assert.ok(Number.isInteger(server.messageHistoryDays), 'server history day-window is integral');
        assert.ok(Object.hasOwn(server, 'historyCutoff'), 'historyCutoff key remains present');
        if (server.messageHistoryDays < 0) {
          assert.equal(server.historyCutoff, null, 'unlimited history has an explicit null cutoff');
          return server;
        }
        assert.match(server.historyCutoff ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'history cutoff retains millisecond UTC wire shape');
        const cutoff = Date.parse(server.historyCutoff);
        const offset = server.messageHistoryDays * 24 * 60 * 60 * 1000;
        assert.ok(cutoff >= startedAt - offset && cutoff <= endedAt - offset,
          'history cutoff is exactly the current UTC day-window, not a stale or arbitrary timestamp');
        return { ...server, historyCutoff: '<validated-current-history-window>' };
      });
    }
    observations[label] = {
      status: response.status, data,
      allow: response.headers.get('allow'), location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
    };
  }
  return observations;
}

async function assertIdentityAndCursor(request, world) {
  expectStatus(await request('/internal/agent-api', { token: world.agentKey }), 200, 'persisted Agent credential remains usable');
  // Preflight embeds build revision metadata, which intentionally differs
  // across binaries. Its protocol shape is checked by the original-client
  // suite; this assertion specifically checks the persisted credential.
  expectStatus(await request('/internal/computer/preflight', {
    method: 'POST', token: world.computerKey, body: {},
  }), 200, 'persisted Computer credential remains usable');
  expectStatus(await request('/internal/agent-api', { token: world.owner.accessToken }), 401, 'human token never becomes an Agent credential');
  const page = await request(world.cursorPath, world.asMember);
  expectStatus(page, 200, 'persisted signed cursor remains valid across binary replacement');
  assert.deepEqual(page.data, world.cursorPage, 'signed cursor continues the same actor page');
}

export async function verifyStabilizationRollback({ executable, capture = captureTool, baselineOnly = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-stabilization-rollback-'));
  let child;
  let logs = '';
  let leakedCredential = false;
  let interrupted;
  let primaryFailure;
  const leakPattern = /[?&](verify|reset)=|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;
  // A signal sent to this harness alone does not reach its child. Stop only
  // our owned server and let request/start checkpoints unwind through finally.
  // SIGKILL cannot be handled by any process.
  const onInterrupt = signal => {
    interrupted ??= new Error(`Rollback harness interrupted by ${signal}`);
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  const onSIGINT = () => onInterrupt('SIGINT');
  const onSIGTERM = () => onInterrupt('SIGTERM');
  process.on('SIGINT', onSIGINT);
  process.on('SIGTERM', onSIGTERM);
  const checkInterrupted = () => { if (interrupted) throw interrupted; };
  async function stop() {
    if (!child) return;
    const current = child;
    child = undefined;
    if (!current.pid) return; // spawn failure: no process exists to reap
    if (current.exitCode !== null || current.signalCode !== null) {
      throw new Error('Rollback test server exited before explicit shutdown');
    }
    const exited = once(current, 'exit');
    let forced = false;
    const timer = setTimeout(() => { forced = true; current.kill('SIGKILL'); }, 12000);
    current.kill('SIGTERM');
    try {
      const [code, signal] = await exited;
      assert.ok(!forced && code === 0 && signal === null, 'owned test server shuts down gracefully');
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const snapshot = path.join(dir, 'baseline-source');
    await mkdir(snapshot);
    const archive = await execFile('git', ['archive', '--format=tar', BASELINE, 'server-go'], {
      cwd: repo, encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    const tar = path.join(dir, 'baseline.tar');
    await writeFile(tar, archive.stdout, { mode: 0o600 });
    await execFile('tar', ['-xf', tar, '-C', snapshot], { timeout: 30000 });
    const oldBinary = path.join(dir, process.platform === 'win32' ? 'baseline.exe' : 'baseline');
    const built = await capture('go', ['build', '-buildvcs=false', '-o', oldBinary, './cmd/raft-server'], {
      cwd: path.join(snapshot, 'server-go'), env: { ...process.env, CGO_ENABLED: '0' }, timeout: 180000,
    });
    assert.equal(built.code, 0, 'frozen M4 source must build independently');
    if (baselineOnly) {
      executable = oldBinary;
    } else if (!executable) {
      executable = path.join(dir, process.platform === 'win32' ? 'current.exe' : 'current');
      const currentBuild = await capture('go', ['build', '-o', executable, './cmd/raft-server'], {
        cwd: root, env: { ...process.env, CGO_ENABLED: '0' }, timeout: 180000,
      });
      assert.equal(currentBuild.code, 0, 'current source must build before compatibility verification');
    }
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const data = path.join(dir, 'baseline-data');
    const workingData = path.join(dir, 'refactored-data');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      RAFT_GO_LISTEN: `127.0.0.1:${port}`, RAFT_GO_MAIL_MODE: 'outbox',
      RAFT_GO_WEB_ORIGIN: origin, RAFT_GO_AGENT_BOOTSTRAP_ENABLED: 'true',
    };
    async function start(binary, dataDir) {
      checkInterrupted();
      assert.equal(child, undefined, 'never start a second owned server concurrently');
      child = spawn(binary, [], { cwd: dir, env: { ...env, RAFT_GO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => {
          const combined = logs + chunk;
          leakedCredential ||= leakPattern.test(combined);
          logs = combined.slice(-1024 * 1024);
        });
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        checkInterrupted();
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned rollback server exited before readiness');
        try {
          const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await ready.arrayBuffer();
          if (ready.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error('Owned rollback server readiness timed out');
    }
    // The variable is intentionally cleared before every subsequent start;
    // copies are taken ONLY with no server process accessing either directory.
    const sendRequest = httpClient(origin);
    const request = async (...args) => {
      checkInterrupted();
      const result = await sendRequest(...args);
      checkInterrupted();
      return result;
    };
    await start(oldBinary, data);
    const world = await seedWorld(request, data);
    await assertIdentityAndCursor(request, world);
    const before = await observableState(request, world);
    const routesBefore = await routeObservations(request, world);
    assert.deepEqual(await observableState(request, world), before, 'routing probes have no business mutations');
    const forbiddenBefore = await request(`/api/channels/${world.privateId}`, world.asMember);
    assert.ok(forbiddenBefore.status >= 400, 'nonmember cannot read owner-private channel');
    const strangerBefore = await request('/api/channels', { token: world.stranger.accessToken, server: world.workspace.id });
    assert.ok(strangerBefore.status >= 400, 'outsider cannot read the workspace');
    await stop(); child = undefined;
    const backup = path.join(dir, 'cold-backup');
    await cp(data, backup, { recursive: true });
    await cp(data, workingData, { recursive: true });

    await start(executable, workingData);
    assert.ok((await readFile(path.join(workingData, 'keys', 'jwt-secret'))).equals(world.jwtKey), 'binary replacement preserves signing material');
    await assertIdentityAndCursor(request, world);
    assert.deepEqual(await observableState(request, world), before, 'new binary preserves all eleven persisted HTTP views');
    const replay = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: world.originalBody });
    expectStatus(replay, 200, 'new binary recognizes old idempotency key/digest');
    assert.equal(replay.data.message.id, world.original.id, 'replay returns original stable ID');
    assert.equal(replay.data.message.seq, world.original.seq, 'replay does not allocate another seq');
    assert.deepEqual(await observableState(request, world), before, 'replaying a stored message has no new observable effects');
    assert.deepEqual(await routeObservations(request, world), routesBefore, 'new route ownership preserves status, body, Allow, redirects and identity gates');
    const forbiddenAfter = await request(`/api/channels/${world.privateId}`, world.asMember);
    assert.deepEqual({ status: forbiddenAfter.status, data: forbiddenAfter.data }, { status: forbiddenBefore.status, data: forbiddenBefore.data }, 'private denial status/body is unchanged');
    const strangerAfter = await request('/api/channels', { token: world.stranger.accessToken, server: world.workspace.id });
    assert.deepEqual({ status: strangerAfter.status, data: strangerAfter.data }, { status: strangerBefore.status, data: strangerBefore.data }, 'workspace denial status/body is unchanged');

    const newBody = { channelId: world.threadId, content: 'reply written by refactored binary', randomId: 'architecture-rollback-new' };
    const added = await request('/api/v2/messages', { ...world.asMember, method: 'POST', body: newBody });
    expectStatus(added, 200, 'new binary extends old data through complete messaging workflow');
    expectStatus(await request(`/api/channels/${world.channelId}/message-display-settings`, {
      ...world.asMember, method: 'PATCH', body: { collapseLongMessages: true },
    }), 200, 'new binary updates persisted display preference');
    const after = await observableState(request, world);
    const routesAfter = await routeObservations(request, world);
    await stop(); child = undefined;

    if (baselineOnly) {
      // Preserve the original zero-schema-change harness self-check. It is
      // deliberately NOT evidence that an old program can read M5 tables.
      await start(oldBinary, workingData);
      await assertIdentityAndCursor(request, world);
      assert.deepEqual(await observableState(request, world), after, 'same-schema baseline roundtrip preserves all writes');
      assert.deepEqual(await routeObservations(request, world), routesAfter, 'baseline route/auth roundtrip');
      const replayNew = await request('/api/v2/messages', { ...world.asMember, method: 'POST', body: newBody });
      expectStatus(replayNew, 200, 'baseline recognizes its persisted idempotency digest');
      assert.equal(replayNew.data.message.id, added.data.message.id, 'baseline replay does not duplicate the reply');
      assert.deepEqual(await observableState(request, world), after, 'baseline replay preserves read/follow/message state');
      await stop(); child = undefined;
    } else {
      const refused = await capture(oldBinary, [], {
        cwd: dir, env: { ...env, RAFT_GO_DATA_DIR: workingData }, timeout: 15000,
      });
      assert.notEqual(refused.code, 0, 'frozen M4 must refuse the additive M5 schema');
      assert.match(refused.stdout + refused.stderr, /schema version.*newer than this binary/,
        'old binary refuses for the explicit schema guard, not an unrelated failure');
      assert.ok(!leakPattern.test(refused.stdout + refused.stderr), 'schema refusal does not log credentials');
      // A failed downgrade attempt must not damage the current schema or data.
      await start(executable, workingData);
      await assertIdentityAndCursor(request, world);
      assert.deepEqual(await observableState(request, world), after, 'M5 remains intact after old-binary refusal');
      assert.deepEqual(await routeObservations(request, world), routesAfter, 'M5 routes remain intact after refusal');
      await stop(); child = undefined;
    }
    // Only the original cold backup can restore the old program after an
    // additive migration; prove both original views and continued writes.
    await start(oldBinary, backup);
    await assertIdentityAndCursor(request, world);
    assert.deepEqual(await observableState(request, world), before, 'the original cold backup restores the original eleven HTTP views');
    assert.deepEqual(await routeObservations(request, world), routesBefore, 'cold backup preserves route/auth contracts');
    const oldWriteBody = { channelId: world.dmId, content: 'old binary continues writing after cold-backup restore', randomId: 'architecture-rollback-final' };
    const oldWrite = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: oldWriteBody });
    expectStatus(oldWrite, 200, 'restored old binary can continue writing, not merely open the backup');
    const oldReplay = await request('/api/v2/messages', { ...world.asOwner, method: 'POST', body: oldWriteBody });
    expectStatus(oldReplay, 200, 'restored old binary preserves send idempotency');
    assert.equal(oldReplay.data.message.id, oldWrite.data.message.id, 'restored retry does not duplicate a message');
    await stop(); child = undefined;
    assert.ok(!leakedCredential, 'owned processes did not log credentials');
    console.log(baselineOnly
      ? 'PASS stabilization rollback HARNESS SELF-CHECK (frozen baseline vs itself; not evidence for refactored code)'
      : 'PASS frozen M4 -> current M5: eleven persisted HTTP views, signed cursor/credentials, 33 route/auth probes, old-schema refusal and writable cold-backup restore');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { if (child) await stop(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(dir, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    process.removeListener('SIGINT', onSIGINT);
    process.removeListener('SIGTERM', onSIGTERM);
    if (cleanupErrors.length > 0) {
      // Preserve the actual test failure rather than replacing it with a
      // filesystem/cleanup exception. Never silently report successful cleanup.
      throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
        'Rollback acceptance or owned-resource cleanup failed');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyStabilizationRollback({ baselineOnly: process.argv.includes('--baseline-only') });
}
