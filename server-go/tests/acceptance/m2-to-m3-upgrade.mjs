// An actual committed M2 executable creates its own data, then the current
// executable upgrades it. No reverse-engineered current-schema fixture can
// substitute for this process-level compatibility evidence.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpClient, expectStatus, verifiedAccount } from './workspaces-contract.mjs';

const exec = promisify(execFile);
const m2Commit = '4acd99066170db863a348f250d452c77b43532c4';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(root, '..');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export async function verifyM2ToM3Upgrade({ executable, capture }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-actual-m2-upgrade-'));
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
      assert.ok(!forced && code === 0 && signal === null, 'upgrade server must stop gracefully');
    } finally { clearTimeout(timer); }
  };
  try {
    const snapshot = path.join(dir, 'm2-source');
    await mkdir(snapshot);
    // The archive contains only the path from the frozen local commit. We
    // never check it out over the user's working tree or alter its index.
    const archive = await exec('git', ['archive', '--format=tar', m2Commit, 'server-go'], {
      cwd: repo, encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    const tar = path.join(dir, 'm2.tar');
    await writeFile(tar, archive.stdout, { mode: 0o600 });
    await exec('tar', ['-xf', tar, '-C', snapshot], { timeout: 30000 });
    const oldBinary = path.join(dir, process.platform === 'win32' ? 'm2-server.exe' : 'm2-server');
    const built = await capture('go', ['build', '-buildvcs=false', '-o', oldBinary, './cmd/raft-server'], {
      cwd: path.join(snapshot, 'server-go'), env: { ...process.env, CGO_ENABLED: '0' }, timeout: 180000,
    });
    assert.equal(built.code, 0, 'the frozen M2 source must build independently');
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
      if (child) throw new Error('Refusing to start a duplicate upgrade process');
      child = spawn(binary, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Upgrade process exited before readiness');
        try {
          const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await ready.arrayBuffer();
          if (ready.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error('Upgrade process readiness timed out');
    };
    await start(oldBinary);
    const request = httpClient(origin);
    const account = await verifiedAccount(request, path.join(data, 'outbox'), 'actual-m2');
    const auth = { token: account.accessToken };
    const created = await request('/api/servers', { ...auth, method: 'POST', body: { name: 'Actual M2 workspace', slug: 'actual-m2-space' } });
    expectStatus(created, 200, 'old binary creates workspace');
    const id = created.data.id;
    const other = await request('/api/servers', { ...auth, method: 'POST', body: { name: 'Second M2 workspace', slug: 'actual-m2-other' } });
    expectStatus(other, 200, 'old binary creates second workspace');
    const scoped = { ...auth, server: id };
    const order = await request('/api/servers/order', { ...auth, method: 'PATCH', body: { serverOrder: [other.data.id, id] } });
    expectStatus(order, 200, 'old order write');
    const prefs = await request(`/api/servers/${id}/onboarding-settings`, { ...scoped, method: 'PATCH', body: { setupModalReminderOptOut: true, dismissedInviteStep: true } });
    expectStatus(prefs, 200, 'old preference write');
    const started = await request(`/api/servers/${id}/setup-transition`, { ...scoped, method: 'POST', body: { action: 'start' } });
    expectStatus(started, 200, 'old setup state write');
    assert.equal(started.data.phase, 'in_progress');
    const userBefore = await request('/api/auth/me', auth);
    const listBefore = await request('/api/servers', auth);
    const key = await readFile(path.join(data, 'keys', 'jwt-secret'));
    const oldChannels = await request('/api/channels', scoped);
    assert.equal(oldChannels.status, 404, 'M2 must really be the old channel-less binary');
    await stop();

    await start(executable);
    assert.ok((await readFile(path.join(data, 'keys', 'jwt-secret'))).equals(key), 'upgrade must not rotate signing key');
    const userAfter = await request('/api/auth/me', auth);
    expectStatus(userAfter, 200, 'old access session after upgrade');
    assert.deepEqual(userAfter.data, userBefore.data, 'old account profile is preserved');
    const listAfter = await request('/api/servers', auth);
    expectStatus(listAfter, 200, 'old memberships after upgrade');
    // historyCutoff is intentionally calculated from the request clock.
    const stable = items => items.map(({ historyCutoff, ...item }) => item);
    assert.deepEqual(stable(listAfter.data), stable(listBefore.data), 'all old workspace fields and order survive');
    assert.deepEqual((await request('/api/servers/order', auth)).data, order.data);
    assert.deepEqual((await request(`/api/servers/${id}/onboarding-settings`, scoped)).data, prefs.data);
    assert.deepEqual((await request(`/api/servers/${id}/setup-projection`, scoped)).data, started.data, 'upgrade must not skip unfinished setup');
    const refreshed = await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: account.refreshToken } });
    expectStatus(refreshed, 200, 'old refresh token survives upgrade');
    expectStatus(await request('/api/auth/login', { method: 'POST', body: { email: account.email, password: account.password } }), 200, 'old password verifier survives upgrade');
    const channels = await request('/api/channels', scoped);
    expectStatus(channels, 200, 'M3 reads real system channels created by M2');
    assert.ok(Array.isArray(channels.data));
    assert.deepEqual(channels.data.map(channel => channel.systemKind).sort(), ['all', 'announcement']);
    const attachment = await request('/api/computer/attach', { ...auth, method: 'POST', body: { serverSlug: 'actual-m2-space', name: 'M3 upgrade Computer' } });
    expectStatus(attachment, 201, 'old account can use new Computer admission');
    assert.equal(attachment.data.serverId, id);
    await stop();

    const rejected = await capture(oldBinary, [], { cwd: dir, env, timeout: 15000 });
    assert.notEqual(rejected.code, 0, 'M2 binary must refuse the newer schema');
    assert.match(rejected.stdout + rejected.stderr, /schema version.*newer than this binary/, 'failure must be schema guard, not an unrelated startup failure');
    await start(executable);
    expectStatus(await request('/api/auth/me', { token: refreshed.data.accessToken }), 200, 'failed downgrade does not damage current account');
    expectStatus(await request('/internal/computer/preflight', { method: 'POST', token: attachment.data.apiKey, body: {} }), 200, 'new Computer credential survives restart and failed downgrade');
    await stop();
    for (const secret of [account.password, account.accessToken, account.refreshToken, attachment.data.apiKey]) {
      assert.ok(!logs.includes(secret), 'process logs must not contain test credentials');
    }
    console.log('PASS frozen committed M2 executable -> M3 upgrade preserves real sessions, keys, accounts, membership, preferences and setup; new channel/Computer APIs work');
    console.log('PASS old M2 executable fails closed on M3 schema without damaging data; M3 restart retains newly issued Computer credential');
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
