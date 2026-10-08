// M3 persistence acceptance: real M3 facts (channels, agent identity and
// credentials, the Computer attachment and its machine row) must survive a
// full process restart on the same SQLite data directory, and the daemon wire
// must reconnect afterwards. Requires the parent-provided start/stop pair;
// like workspaces-upgrade.mjs it is not standalone-runnable.
import assert from 'node:assert/strict';
import path from 'node:path';
import { attachComputer, createVerifiedAccount, createWorkspace, deviceLogin, expectStatus, httpClient, pollUntil } from './m3-harness.mjs';
import { connectMachine } from './m3-wire-ws.mjs';

export async function verifyM3Persistence({ origin, data, start, stop }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const sockets = [];
  const finallyClose = () => { for (const socket of sockets.splice(0)) try { socket.close(); } catch { /* best-effort teardown */ } };

  const owner = await createVerifiedAccount(request, maildir, 'powner');
  const workspace = await createWorkspace(request, owner, 'persist');
  const scoped = (extras = {}) => ({ token: owner.accessToken, server: workspace.id, ...extras });
  const created = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'durable', visibility: 'private' } }) });
  expectStatus(created, 200, 'persist fixture channel');
  const agent = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'durable-agent', external: true } }) });
  expectStatus(agent, 200, 'persist fixture agent');
  const minted = await request(`/api/agents/${agent.data.id}/credentials`, { method: 'POST', token: owner.accessToken, body: {} });
  expectStatus(minted, 201, 'persist fixture credential');
  const login = await deviceLogin(request, { approveToken: owner.accessToken });
  const computer = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'durable-box' });

  let peer = await connectMachine({ origin, apiKey: computer.apiKey });
  if ('rejected' in peer) throw new Error(`machine peer rejected before restart with HTTP ${peer.rejected.status}`);
  sockets.push(peer);
  await peer.nextMessage(m => m.type === 'machine:context', 10000);
  peer.send({ type: 'ready', capabilities: ['agent:start'], runtimes: ['claude'], runningAgents: [], hostname: 'persist-host', os: 'darwin arm64', daemonVersion: '0.0.0-m3-persist' });
  await pollUntil('ready facts before restart', async () => {
    const machines = await request(`/api/servers/${workspace.id}/machines`, scoped());
    const row = machines.data.machines.find(m => m.id === computer.machineId);
    return row?.daemonVersion === '0.0.0-m3-persist' ? row : null;
  });

  try {
    await stop();
    await start();

    await check('login still works against the restarted process', async () => {
      const fresh = await request('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } });
      expectStatus(fresh, 200, 'password login after restart'); assert.equal(fresh.data.user.id, owner.user.id);
    });

    await check('channels and agent rows survive with the same ids', async () => {
      const channels = await request('/api/channels', scoped());
      expectStatus(channels, 200, 'channel list after restart');
      const durable = channels.data.find(c => c.id === created.data.id);
      assert.ok(durable, 'the created channel keeps its identity'); assert.equal(durable.type, 'private');
      const agents = await request('/api/agents', scoped());
      expectStatus(agents, 200, 'agent list after restart');
      assert.ok(agents.data.some(a => a.id === agent.data.id), 'the agent keeps its identity');
    });

    await check('agent credentials and computer keys survive restart', async () => {
      const whoami = await request('/internal/agent-api/', { token: minted.data.apiKey });
      expectStatus(whoami, 200, 'agent credential after restart');
      assert.equal(whoami.data.credentialId, minted.data.credentialId);
      assert.equal(whoami.data.agentId, agent.data.id);
      const preflight = await request('/internal/computer/preflight', { method: 'POST', token: computer.apiKey, body: {} });
      expectStatus(preflight, 200, 'computer key after restart'); assert.equal(preflight.data.ok, true);
    });

    await check('the daemon wire reconnects and the machine row is intact', async () => {
      const machines = await request(`/api/servers/${workspace.id}/machines`, scoped());
      expectStatus(machines, 200, 'machine directory after restart');
      const row = machines.data.machines.find(m => m.id === computer.machineId);
      assert.ok(row, 'the machine row persists'); assert.equal(row.isComputer, true);
      assert.equal(row.daemonVersion, '0.0.0-m3-persist', 'ready facts persisted in SQLite, not just memory');
      const reconnected = await connectMachine({ origin, apiKey: computer.apiKey });
      assert.ok(!('rejected' in reconnected), `reconnect after restart was rejected with HTTP ${reconnected.rejected?.status}`);
      sockets.push(reconnected);
      const context = await reconnected.nextMessage(m => m.type === 'machine:context', 10000);
      assert.equal(context.machineId, computer.machineId);
      assert.equal(context.serverId, workspace.id);
      reconnected.send({ type: 'ready', capabilities: ['agent:start'], runtimes: ['claude'], runningAgents: [], hostname: 'persist-host', os: 'darwin arm64', daemonVersion: '0.0.0-m3-persist' });
      await pollUntil('online projection after reconnect', async () => {
        const listed = await request(`/api/servers/${workspace.id}/machines`, scoped());
        const current = listed.data.machines.find(m => m.id === computer.machineId);
        return current?.status === 'online' ? current : null;
      });
    });

    console.log('M3 persistence acceptance passed: restart preserves channels, agent identity and credentials, computer keys and daemon reconnection.');
  } finally {
    finallyClose();
  }

  async function check(name, fn) { await fn(); console.log(`PASS M3 persist ${name}`); }
  return { workspace, owner };
}
