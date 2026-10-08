// M3 -> M4 real-process upgrade acceptance. TWO frozen M3 starting points are
// built from committed source (never the working tree): the unpatched M3
// d275cce and the invitation-fix M3 bc65213. Each old binary creates REAL data
// through its own HTTP APIs (accounts, workspaces, channels, agents,
// computers, invites where the old binary has them), then the current M4
// executable upgrades that data in place. The old binary must refuse the M4
// schema, and restoring the matching cold backup must make the old binary
// work again. No reverse-engineered current-schema fixture substitutes for
// this process-level evidence (phase-4-messaging.md §4.3, coordination doc
// P7, m4-execution-lock.md "Freeze/test BOTH").
//
// Exported: verifyM3ToM4Upgrade({ executable, capture }) — the same harness
// shape as verifyM2ToM3Upgrade. Standalone run:
//   node tests/acceptance/m3-to-m4-upgrade.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createVerifiedAccount, expectStatus, httpClient } from './m3-harness.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const repo = path.resolve(root, '..');

// Frozen M3 starting points (docs/m4-implementation-coordination.md P7 and
// m4-execution-lock.md baseline). d275cce predates the invitation surface;
// bc65213 is the M3 invitations/UI-fix commit the M4 baseline builds on.
const FROZEN_M3 = [
  {
    commit: 'd275cce25c251997ba872add84d6e75d3bef4df8',
    label: 'unpatched-m3',
    invites: false,
  },
  {
    commit: 'bc65213b377a992c381e809c72ba50ca9af367fd',
    label: 'patched-m3',
    invites: true,
  },
];

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function execTool(program, args, options = {}) {
  const { promisify } = await import('node:util');
  const execFile = promisify((await import('node:child_process')).execFile);
  return execFile(program, args, {
    encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options,
  });
}

// Generates the real pre-upgrade dataset through the OLD binary's own APIs.
async function generateOldWorld({ request, maildir, data, invites }) {
  const owner = await createVerifiedAccount(request, maildir, `up-${invites ? 'p' : 'u'}`);
  const auth = { token: owner.accessToken };
  const workspace = await request('/api/servers', {
    ...auth, method: 'POST', body: { name: `M4 upgrade ${invites ? 'patched' : 'unpatched'}`, slug: `m4-up-${invites ? 'p' : 'u'}-${Date.now().toString(36)}` },
  });
  expectStatus(workspace, 200, 'old binary creates the workspace');
  const second = await request('/api/servers', {
    ...auth, method: 'POST', body: { name: 'Upgrade second space', slug: `m4-up-2-${Date.now().toString(36)}` },
  });
  expectStatus(second, 200, 'old binary creates the second workspace');
  const order = await request('/api/servers/order', { ...auth, method: 'PATCH', body: { serverOrder: [second.data.id, workspace.data.id] } });
  expectStatus(order, 200, 'old server order write');
  const scoped = { ...auth, server: workspace.data.id };

  const publicChannel = await request('/api/channels', {
    ...scoped, method: 'POST', body: { name: 'upgrade-general', description: 'preserved by the upgrade', visibility: 'public' },
  });
  expectStatus(publicChannel, 200, 'old binary creates the public channel');
  const privateChannel = await request('/api/channels', {
    ...scoped, method: 'POST', body: { name: 'upgrade-private', visibility: 'private' },
  });
  expectStatus(privateChannel, 200, 'old binary creates the private channel');

  let joiner = null;
  let joinLinkId = null;
  let invitedEmail = null;
  if (invites) {
    // Real invite surface that only bc65213 has: a join link the joiner
    // accepts, plus a pending email invite kept for the post-upgrade check.
    joiner = await createVerifiedAccount(request, maildir, `up-${invites ? 'p' : 'u'}-joiner`);
    const link = await request(`/api/servers/${workspace.data.id}/join-links`, {
      ...scoped, method: 'POST', body: { maxUses: null, expiresAt: null },
    });
    expectStatus(link, 200, 'old binary creates the join link');
    joinLinkId = link.data.link.id;
    const accept = await request('/api/auth/accept-invite', {
      method: 'POST', token: joiner.accessToken, body: { token: link.data.token },
    });
    expectStatus(accept, 200, 'old binary join via the real link');
    invitedEmail = `pending-${Date.now().toString(36)}@example.test`;
    const invite = await request(`/api/servers/${workspace.data.id}/invites`, {
      ...scoped, method: 'POST', body: { email: invitedEmail },
    });
    expectStatus(invite, 200, 'old binary issues the email invite');
  }

  // External Agent + a minted credential (both frozen M3 commits).
  const agent = await request('/api/agents', {
    ...scoped, method: 'POST', body: { name: 'upgrade-relay', description: 'external relay', external: true },
  });
  expectStatus(agent, 200, 'old binary creates the external agent');
  const credential = await request(`/api/agents/${agent.data.id}/credentials`, { ...auth, method: 'POST', body: {} });
  expectStatus(credential, 201, 'old binary mints the agent credential');

  // Real Computer admission: device-code grant + attach.
  const grant = await request('/api/auth/device/authorize', { method: 'POST', body: { clientName: 'upgrade-computer' } });
  expectStatus(grant, 201, 'device authorize');
  expectStatus(await request('/api/auth/device/approve', {
    method: 'POST', token: owner.accessToken, body: { userCode: grant.data.userCode },
  }), 200, 'device approve');
  let deviceSession = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    const poll = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    if (poll.status === 200) { deviceSession = poll.data; break; }
    if (poll.status === 400 && poll.data?.code === 'authorization_pending') { await sleep(100); continue; }
    throw new Error(`old binary device token poll returned ${poll.status}`);
  }
  assert.ok(deviceSession, 'device session issued');
  const attached = await request('/api/computer/attach', {
    method: 'POST', token: deviceSession.accessToken,
    body: { serverSlug: workspace.data.slug, name: 'Upgrade Computer' },
  });
  expectStatus(attached, 201, 'old binary attaches the Computer');

  const meBefore = await request('/api/auth/me', auth);
  expectStatus(meBefore, 200, 'old me snapshot');
  const serversBefore = await request('/api/servers', auth);
  expectStatus(serversBefore, 200, 'old servers snapshot');
  const jwtKey = await readFile(path.join(data, 'keys', 'jwt-secret'));

  return {
    owner, workspace: workspace.data, second: second.data, order: order.data,
    publicChannel: publicChannel.data, privateChannel: privateChannel.data,
    agent: agent.data, agentApiKey: credential.data.apiKey,
    computerApiKey: attached.data.apiKey, meBefore: meBefore.data,
    serversBefore: serversBefore.data, jwtKey,
    joiner, joinLinkId, invitedEmail,
  };
}

export async function verifyM3ToM4Upgrade({ executable, capture }) {
  for (const frozen of FROZEN_M3) {
    await upgradeFromFrozenM3({ ...frozen, executable, capture });
  }
  console.log('PASS both frozen M3 binaries (d275cce unpatched, bc65213 patched) upgrade to the current M4 executable with real data preserved');
  console.log('PASS each old M3 binary refuses the M4 schema and the matching cold backup restores a working old instance');
}

async function upgradeFromFrozenM3({ commit, label, invites, executable, capture }) {
  const dir = await mkdtemp(path.join(tmpdir(), `raft-m3-m4-${label}-`));
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
      assert.ok(!forced && code === 0 && signal === null, `${label}: server must stop gracefully`);
    } finally { clearTimeout(timer); }
  };
  try {
    // 1. Build the frozen old binary from committed source only.
    const snapshot = path.join(dir, 'm3-source');
    await mkdir(snapshot);
    // The archive contains only the path from the frozen local commit. The
    // user's working tree and its index are never touched.
    const archive = await execTool('git', ['archive', '--format=tar', commit, 'server-go'], { cwd: repo });
    const tar = path.join(dir, 'm3.tar');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tar, archive.stdout, { mode: 0o600 });
    await execTool('tar', ['-xf', tar, '-C', snapshot]);
    const oldBinary = path.join(dir, process.platform === 'win32' ? 'm3-server.exe' : 'm3-server');
    const built = await capture('go', ['build', '-buildvcs=false', '-o', oldBinary, './cmd/raft-server'], {
      cwd: path.join(snapshot, 'server-go'),
      env: { ...process.env, CGO_ENABLED: '0' }, timeout: 180000,
    });
    assert.equal(built.code, 0, `${label}: the frozen M3 source at ${commit} must build independently`);

    // 2. The old binary creates real data through its own APIs.
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
      if (child) throw new Error(`${label}: refusing to start a duplicate process`);
      child = spawn(binary, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: process exited before readiness`);
        try {
          const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await ready.arrayBuffer();
          if (ready.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error(`${label}: readiness timed out`);
    };
    const request = httpClient(origin);
    const maildir = path.join(data, 'outbox');

    await start(oldBinary);
    const world = await generateOldWorld({ request, maildir, data, invites });
    // The old binary genuinely predates M4 messaging: the v2 surface is an
    // unknown route there, so this upgrade is a real schema+surface step.
    const oldV2 = await request('/api/v2/messages', {
      method: 'POST', token: world.owner.accessToken, server: world.workspace.id,
      body: { channelId: world.publicChannel.id, content: 'pre-upgrade send' },
    });
    expectStatus(oldV2, 404, `${label}: frozen M3 has no v2 message surface`);
    await stop();

    // 3. Cold backup of the OLD-schema data (SQLite checkpointed by the
    //    graceful shutdown) taken BEFORE the new binary ever touches it.
    const backup = path.join(dir, 'cold-backup');
    await cp(data, backup, { recursive: true });

    // 4. The current M4 executable upgrades the real old data in place.
    await start(executable);
    const auth = { token: world.owner.accessToken };
    const scoped = { ...auth, server: world.workspace.id };
    assert.ok((await readFile(path.join(data, 'keys', 'jwt-secret'))).equals(world.jwtKey),
      `${label}: upgrade must not rotate the signing key`);
    const meAfter = await request('/api/auth/me', auth);
    expectStatus(meAfter, 200, `${label}: old access session survives`);
    assert.deepEqual(meAfter.data, world.meBefore, `${label}: old account profile preserved byte-for-byte`);
    const serversAfter = await request('/api/servers', auth);
    expectStatus(serversAfter, 200, `${label}: old memberships survive`);
    // historyCutoff is intentionally calculated from the request clock.
    const stable = items => items.map(({ historyCutoff, ...item }) => item);
    assert.deepEqual(stable(serversAfter.data), stable(world.serversBefore), `${label}: all old workspace fields and order survive`);
    assert.deepEqual((await request('/api/servers/order', auth)).data, world.order, `${label}: server order preserved`);

    const channels = await request('/api/channels', scoped);
    expectStatus(channels, 200, `${label}: channel list after upgrade`);
    const channelIds = channels.data.map(c => c.id);
    assert.ok(channelIds.includes(world.publicChannel.id), `${label}: the old public channel survives`);
    assert.ok(channelIds.includes(world.privateChannel.id), `${label}: the old private channel survives`);
    const preserved = channels.data.find(c => c.id === world.publicChannel.id);
    assert.equal(preserved.name, 'upgrade-general', `${label}: channel identity preserved`);
    assert.equal(preserved.description, 'preserved by the upgrade', `${label}: channel fields preserved`);

    const agentAfter = await request(`/api/agents/${world.agent.id}`, scoped);
    expectStatus(agentAfter, 200, `${label}: old Agent survives`);
    assert.equal(agentAfter.data.name, 'upgrade-relay', `${label}: Agent identity preserved`);
    // Exact CLI surface: GET /internal/agent-api/ with the bare agent key.
    const whoami = await request('/internal/agent-api/', { token: world.agentApiKey });
    expectStatus(whoami, 200, `${label}: the old Agent credential still authenticates`);
    assert.equal(whoami.data.agentId, world.agent.id, `${label}: whoami still names the old Agent`);
    expectStatus(await request('/internal/computer/preflight', {
      method: 'POST', token: world.computerApiKey, body: {},
    }), 200, `${label}: the old Computer credential still authenticates`);

    if (invites) {
      // Member lists are workspace-scoped even when the path carries the
      // workspace id; preserve the existing X-Server-Id binding contract.
      const members = await request(`/api/servers/${world.workspace.id}/members`, scoped);
      expectStatus(members, 200, `${label}: member list survives`);
      assert.ok(Array.isArray(members.data) && members.data.some(m => m.userId === world.joiner.user.id),
        `${label}: the pre-upgrade joiner is still a member`);
      const invitesList = await request(`/api/servers/${world.workspace.id}/invites`, scoped);
      expectStatus(invitesList, 200, `${label}: invite list survives`);
      const pending = JSON.stringify(invitesList.data).includes(world.invitedEmail);
      assert.ok(pending, `${label}: the pending email invite survives the upgrade`);
      const links = await request(`/api/servers/${world.workspace.id}/join-links`, scoped);
      expectStatus(links, 200, `${label}: join-link list survives`);
      assert.ok(JSON.stringify(links.data).includes(world.joinLinkId), `${label}: the join link survives`);
    }

    const refreshed = await request('/api/auth/refresh', {
      method: 'POST', body: { refreshToken: world.owner.refreshToken },
    });
    expectStatus(refreshed, 200, `${label}: old refresh token survives`);
    expectStatus(await request('/api/auth/login', {
      method: 'POST', body: { email: world.owner.email, password: world.owner.password },
    }), 200, `${label}: old password verifier survives`);

    // 5. M4 messaging works ON the migrated data, not just next to it.
    const sent = await request('/api/v2/messages', {
      method: 'POST', ...scoped,
      body: { channelId: world.publicChannel.id, content: 'first M4 message on migrated data', randomId: `up-${label}-1` },
    });
    expectStatus(sent, 200, `${label}: v2 send on migrated data`);
    const replay = await request('/api/v2/messages', {
      method: 'POST', ...scoped,
      body: { channelId: world.publicChannel.id, content: 'first M4 message on migrated data', randomId: `up-${label}-1` },
    });
    expectStatus(replay, 200, `${label}: randomId replay on migrated data`);
    assert.equal(replay.data.message.id, sent.data.message.id, `${label}: idempotency works on migrated data`);
    const page = await request(`/api/messages/channel/${world.publicChannel.id}?limit=50`, scoped);
    expectStatus(page, 200, `${label}: history on migrated data`);
    assert.equal(page.data.messages.length, 1, `${label}: exactly one message row exists`);
    // Honest empty history: no fake welcome rows were invented by the upgrade.
    const privatePage = await request(`/api/messages/channel/${world.privateChannel.id}?limit=50`, scoped);
    expectStatus(privatePage, 200, `${label}: empty private history answers`);
    assert.deepEqual(privatePage.data.messages, [], `${label}: an empty channel stays honestly empty`);
    await stop();

    // 6. The old binary refuses the newer schema (fail closed, no damage).
    const rejected = await capture(oldBinary, [], { cwd: dir, env, timeout: 20000 });
    assert.notEqual(rejected.code, 0, `${label}: frozen M3 must refuse the M4 schema`);
    assert.match(rejected.stdout + rejected.stderr, /schema version.*newer than this binary/,
      `${label}: refusal must be the migration guard, not an unrelated startup failure`);

    // 7. Restoring the matching cold backup makes the old binary work again.
    await rm(data, { recursive: true, force: true });
    await cp(backup, data, { recursive: true });
    await start(oldBinary);
    const restoredMe = await request('/api/auth/me', auth);
    expectStatus(restoredMe, 200, `${label}: rolled-back old binary serves the old session`);
    assert.deepEqual(restoredMe.data, world.meBefore, `${label}: rolled-back profile is the old one`);
    const restoredChannels = await request('/api/channels', scoped);
    expectStatus(restoredChannels, 200, `${label}: rolled-back channel list`);
    assert.ok(restoredChannels.data.some(c => c.id === world.publicChannel.id),
      `${label}: rolled-back data still has the old channels`);
    const restoredV2 = await request('/api/v2/messages', {
      method: 'POST', ...scoped, body: { channelId: world.publicChannel.id, content: 'should not exist' },
    });
    expectStatus(restoredV2, 404, `${label}: rolled-back instance is genuinely the old surface`);
    await stop();

    for (const secret of [world.owner.password, world.owner.accessToken, world.owner.refreshToken, world.agentApiKey, world.computerApiKey]) {
      assert.ok(!logs.includes(secret), `${label}: process logs must not contain test credentials`);
    }
    console.log(`PASS ${label} (${commit}): real old data upgrades to M4 preserving keys, sessions, accounts, workspaces, channels, Agent and Computer${invites ? ', invites and members' : ''}`);
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

// ---------------------------------------------------------------------------
// Standalone execution: build the current tree once, then run the exported
// verifier. Isolated development runner only; run.mjs stays the shared entry.
// ---------------------------------------------------------------------------

async function standalone() {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-m3-m4-upgrade-'));
  const executable = path.join(dir, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
  const built = await new Promise((resolve, reject) => {
    const worker = spawn('go', ['build', '-buildvcs=false', '-o', executable, './cmd/raft-server'], {
      cwd: root, env: { ...process.env, CGO_ENABLED: '0', GOCACHE: path.join(dir, 'gocache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => worker.kill('SIGKILL'), 300000);
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { process.stderr.write(stdout + stderr); reject(new Error('standalone build failed')); return; }
      resolve();
    });
  });
  assert.ok(built === undefined, 'standalone build completed');
  const capture = (program, args, { timeout = 180000, env = process.env, cwd = root } = {}) => new Promise((resolve, reject) => {
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
    await verifyM3ToM4Upgrade({ executable, capture });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await standalone();
}
