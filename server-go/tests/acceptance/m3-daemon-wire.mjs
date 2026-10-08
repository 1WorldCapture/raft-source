// M3 daemon wire acceptance: the raw /daemon/connect WebSocket protocol the
// original daemon speaks (packages/daemon/src/connection.ts + core.ts emitReady)
// against the server contract in packages/server/src/routes/daemon.ts and
// services/machineContext.ts. Uses a hand-rolled RFC 6455 client so the
// Authorization bearer handshake and the Slock-Reason rejection header are
// exercised exactly as the daemon sees them.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachComputer, createVerifiedAccount, createWorkspace, deviceLogin, expectStatus, httpClient, pollUntil } from './m3-harness.mjs';
import { connectMachine } from './m3-wire-ws.mjs';

const DAEMON_VERSION = '0.0.0-m3-acceptance';
const CLOSED_SET_REASON = /^[a-z][a-z0-9_]*$/;

export async function verifyM3DaemonWire({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 daemon ${name}`); };
  const sockets = [];
  const finallyClose = () => { for (const socket of sockets.splice(0)) try { socket.close(); } catch { /* best-effort teardown */ } };

  const owner = await createVerifiedAccount(request, maildir, 'downer');
  const workspace = await createWorkspace(request, owner, 'daemonwire');
  const login = await deviceLogin(request, { approveToken: owner.accessToken });
  const computer = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'wire-peer' });
  const machinesRoute = () => request(`/api/servers/${workspace.id}/machines`, { token: owner.accessToken, server: workspace.id });
  const machineRow = async () => (await machinesRoute()).data.machines.find(m => m.id === computer.machineId);

  try {
    await check('handshake accepts the bearer key and sends machine:context first', async () => {
      const opened = await connectMachine({ origin, apiKey: computer.apiKey });
      assert.ok(!('rejected' in opened), `expected the upgrade to succeed, got HTTP ${opened.rejected?.status}`);
      sockets.push(opened);
      const context = await opened.nextMessage(message => message.type === 'machine:context', 10000);
      assert.equal(context.machineId, computer.machineId, 'context carries the linked machines.id');
      assert.equal(context.serverId, workspace.id);
    });

    let live;
    await check('legacy ?key= query form is still accepted', async () => {
      const opened = await connectMachine({ origin, apiKey: computer.apiKey, useQueryKey: true });
      assert.ok(!('rejected' in opened), `legacy query key path was rejected with HTTP ${opened.rejected?.status}`);
      sockets.push(opened);
      const context = await opened.nextMessage(message => message.type === 'machine:context', 10000);
      assert.equal(context.machineId, computer.machineId);
      live = opened;
    });

    await check('ready facts surface in the machine directory and the link answers ping', async () => {
      live.send({
        type: 'ready', capabilities: ['agent:start', 'agent:stop', 'agent:deliver'],
        runtimes: ['claude', 'builtin'], runtimeVersions: { claude: '1.0.0' },
        runningAgents: [], hostname: 'm3-acceptance-host', os: 'darwin arm64', daemonVersion: DAEMON_VERSION,
      });
      await pollUntil('daemonVersion from the ready frame in the machine directory', async () => {
        const row = await machineRow();
        return row?.daemonVersion === DAEMON_VERSION ? row : null;
      });
      const row = await machineRow();
      assert.equal(row.status, 'online', 'a live connection projects online');
      live.send({ type: 'ping' });
      const echoed = await live.nextMessage(message => message.type === 'ping', 10000);
      assert.equal(echoed.type, 'ping', 'the server answers machine liveness pings on the same socket');
    });

    let legacy;
    await check('legacy sk_machine_ registration, wire access and key rotation', async () => {
      const registered = await request(`/api/servers/${workspace.id}/machines`, { method: 'POST', ...{ token: owner.accessToken, server: workspace.id }, body: { name: 'legacy-peer' } });
      expectStatus(registered, 200, 'legacy machine registration');
      assert.match(registered.data.apiKey, /^sk_machine_[A-Za-z0-9_-]+$/, 'raw machine key returned exactly once');
      legacy = { machine: registered.data.machine, apiKey: registered.data.apiKey };
      const opened = await connectMachine({ origin, apiKey: legacy.apiKey });
      assert.ok(!('rejected' in opened), `legacy machine key upgrade failed with HTTP ${opened.rejected?.status}`);
      sockets.push(opened);
      const context = await opened.nextMessage(m => m.type === 'machine:context', 10000);
      assert.equal(context.machineId, legacy.machine.id, 'legacy machines bind their own machines.id');
      assert.equal(context.serverId, workspace.id);
      opened.send({ type: 'ready', capabilities: [], runtimes: [], runningAgents: [], hostname: 'legacy-host', os: 'darwin arm64', daemonVersion: '0.0.0-m3-legacy' });
      opened.close();
      const rotated = await request(`/api/servers/${workspace.id}/machines/${legacy.machine.id}/rotate-key`, { method: 'POST', token: owner.accessToken, server: workspace.id, body: {} });
      expectStatus(rotated, 200, 'rotate key');
      assert.match(rotated.data.apiKey, /^sk_machine_[A-Za-z0-9_-]+/);
      assert.notEqual(rotated.data.apiKey, legacy.apiKey, 'rotation mints a fresh key');
      const oldKey = await connectMachine({ origin, apiKey: legacy.apiKey });
      assert.ok('rejected' in oldKey && oldKey.rejected.status === 401, 'the rotated-out key is dead');
      assert.equal(oldKey.rejected.reason, 'machine_key_invalid');
      const fresh = await connectMachine({ origin, apiKey: rotated.data.apiKey });
      assert.ok(!('rejected' in fresh), 'the rotated key connects');
      sockets.push(fresh);
      await fresh.nextMessage(m => m.type === 'machine:context', 10000);
    });

    await check('a replacement connection closes the previous one', async () => {
      const replacement = await connectMachine({ origin, apiKey: computer.apiKey });
      assert.ok(!('rejected' in replacement));
      sockets.push(replacement);
      await replacement.nextMessage(message => message.type === 'machine:context', 10000);
      await live.waitClosed(15000);
      assert.ok(live.closed, 'the old generation is displaced by the new connection');
      replacement.send({ type: 'ping' });
      await replacement.nextMessage(message => message.type === 'ping', 10000);
      await pollUntil('the machine to stay online via the replacement', async () => {
        const row = await machineRow();
        return row?.status === 'online' ? row : null;
      });
      live = replacement;
    });

    await check('handshake rejections carry closed-set Slock-Reason headers', async () => {
      const missing = await connectMachine({ origin, apiKey: '' });
      assert.ok('rejected' in missing, 'an empty bearer must not complete the upgrade');
      assert.equal(missing.rejected.status, 401); assert.equal(missing.rejected.reason, 'missing_key');
      const malformed = await connectMachine({ origin, apiKey: 'not-an-raft-key' });
      assert.ok('rejected' in malformed);
      assert.equal(malformed.rejected.status, 401); assert.equal(malformed.rejected.reason, 'invalid_key_format');
      const unknown = await connectMachine({ origin, apiKey: 'sk_computer_0000000000000000000000000000000000000000' });
      assert.ok('rejected' in unknown);
      assert.equal(unknown.rejected.status, 401);
      assert.match(unknown.rejected.reason ?? '', CLOSED_SET_REASON, 'deny reasons are a closed set, never raw key material');
      // A browser Origin header must not bypass key authentication.
      const spoofed = await connectMachine({ origin, apiKey: 'sk_computer_0000000000000000000000000000000000000000', headers: { Origin: 'http://127.0.0.1:5175' } });
      assert.ok('rejected' in spoofed); assert.equal(spoofed.rejected.status, 401);
    });

    await check('disconnecting marks the machine offline without losing the row', async () => {
      live.close();
      await live.waitClosed(10000);
      await pollUntil('offline projection after disconnect', async () => {
        const row = await machineRow();
        return row && row.status !== 'online' ? row : null;
      }, { timeoutMs: 30000 });
      const row = await machineRow();
      assert.equal(row.daemonVersion, DAEMON_VERSION, 'observed ready facts persist in the machines row');
    });

    let revoked;
    await check('revoked keys cannot reconnect', async () => {
      revoked = await connectMachine({ origin, apiKey: computer.apiKey });
      // The key is still valid here; revoke it, then prove reconnect is closed.
      if (!('rejected' in revoked)) {
        sockets.push(revoked);
        const removed = await request(`/api/servers/${workspace.id}/machines/${computer.machineId}`, { method: 'DELETE', token: owner.accessToken, server: workspace.id });
        expectStatus(removed, 200, 'machine delete for revoke');
        // pong is an authentication re-verification point: nudge it so the
        // teardown is not bound to the next 30s heartbeat tick.
        try { revoked.send({ type: 'pong' }); } catch { /* already closing */ }
        await revoked.waitClosed(30000); // revocation reaches established connections (bounded delay accepted)
        assert.ok(revoked.closed, 'an established connection is torn down after revocation');
        const again = await connectMachine({ origin, apiKey: computer.apiKey });
        assert.ok('rejected' in again, 'a revoked key must not complete a new upgrade');
        assert.equal(again.rejected.status, 401);
        assert.ok(['computer_revoked', 'computer_machine_unlinked', 'machine_not_found'].includes(again.rejected.reason),
          `revocation deny reason must name the revoked/unlinked state, got ${again.rejected.reason}`);
      } else {
        throw new Error(`expected the pre-revoke connection to be accepted, got HTTP ${revoked.rejected.status}`);
      }
    });
  } finally {
    finallyClose();
  }
  console.log(`M3 daemon wire acceptance passed: ${passed.length} groups.`);
  return { owner, workspace };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL, data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyM3DaemonWire({ origin, data });
}
