// M3 agent identity acceptance: real Web agent creation (external + official
// onboarding), sk_agent_* credential mint/list/revoke, the CLI whoami surface
// at GET /internal/agent-api/, and honest lifecycle dispatch over the machine
// WebSocket. Pinned from packages/server/src/routes/agents.ts,
// routes/agentCredentials.ts, routes/agentLogin.ts, routes/internalAgentApi.ts,
// packages/cli/src/{client.ts,commands/agent/login.ts} and the shared name
// validators. No LLM/provider is started: the machine peer is the test's own
// raw WebSocket answering ready with the runtimes it advertises.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachComputer, createVerifiedAccount, createWorkspace, deviceLogin, expectStatus, expectUUID, httpClient, pollUntil } from './m3-harness.mjs';
import { connectMachine } from './m3-wire-ws.mjs';

export async function verifyM3AgentIdentity({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 agent ${name}`); };
  const sockets = [];
  const finallyClose = () => { for (const socket of sockets.splice(0)) try { socket.close(); } catch { /* best-effort teardown */ } };

  const owner = await createVerifiedAccount(request, maildir, 'aowner');
  const stranger = await createVerifiedAccount(request, maildir, 'astranger');
  const workspace = await createWorkspace(request, owner, 'agents');
  const strangerWorkspace = await createWorkspace(request, stranger, 'strangers');
  const scoped = (extras = {}) => ({ token: owner.accessToken, server: workspace.id, ...extras });
  const login = await deviceLogin(request, { approveToken: owner.accessToken });
  const computer = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'agent-peer' });

  let external;
  await check('external agent creation follows the Web contract exactly', async () => {
    const created = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'relay-bot', description: 'external relay', external: true } }) });
    expectStatus(created, 200, 'external create');
    external = created.data;
    expectUUID(external.id, 'agent id');
    assert.equal(external.name, 'relay-bot');
    assert.equal(external.description, 'external relay');
    assert.equal(external.runtime, 'external');
    assert.equal(external.machineId, null, 'external agents are never bound to a Computer');
    assert.equal(external.serverRole, 'member');
    assert.match(external.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T/, 'createdAt is a timestamp');
    const detail = await request(`/api/agents/${external.id}`, scoped());
    expectStatus(detail, 200, 'detail'); assert.equal(detail.data.id, external.id);
    const listed = await request('/api/agents', scoped());
    expectStatus(listed, 200, 'agent list'); assert.ok(Array.isArray(listed.data) && listed.data.some(a => a.id === external.id));
  });

  await check('agent name and shape errors keep the shared validator wording', async () => {
    for (const [body, error] of [
      [{ name: '   ', external: true }, 'Agent name is required'],
      [{ name: 'x'.repeat(33), external: true }, 'Agent name must be at most 32 characters'],
      [{ name: '1starts-with-digit', external: true }, 'Agent name must start with a letter and can only contain letters, numbers, hyphens, and underscores'],
    ]) {
      const bad = await request('/api/agents', { method: 'POST', ...scoped({ body }) });
      expectStatus(bad, 400, 'agent name validation'); assert.equal(bad.data?.error, error);
    }
    const duplicate = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'relay-bot', external: true } }) });
    expectStatus(duplicate, 409, 'duplicate agent name'); assert.match(duplicate.data?.error ?? '', /already taken|conflict/i);
    const both = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'mixed', external: true, onboarding: true } }) });
    expectStatus(both, 400, 'external onboarding'); assert.equal(both.data?.error, 'Onboarding agent cannot be external');
    const machineBound = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'mixed2', external: true, machineId: computer.machineId } }) });
    expectStatus(machineBound, 400, 'external machine binding'); assert.equal(machineBound.data?.error, 'External agents cannot be assigned to a Computer');
  });

  await check('cross-workspace agent reads do not leak existence', async () => {
    const detail = await request(`/api/agents/${external.id}`, { token: stranger.accessToken, server: strangerWorkspace.id });
    expectStatus(detail, 404, 'a valid workspace scope does not expose a foreign Agent');
    const nonmember = await request(`/api/agents/${external.id}`, { token: stranger.accessToken, server: workspace.id });
    expectStatus(nonmember, 403, 'non-member scope is rejected by requireServer semantics');
    assert.equal(nonmember.data?.error, 'Not a member of this server');
    const mint = await request(`/api/agents/${external.id}/credentials`, { method: 'POST', token: stranger.accessToken, body: {} });
    expectStatus(mint, 404, 'anti-enumeration mint'); assert.equal(mint.data?.code, 'agent_missing');
  });

  let minted;
  await check('credential mint and CLI whoami agree on one identity', async () => {
    const mint = await request(`/api/agents/${external.id}/credentials`, { method: 'POST', token: owner.accessToken, body: {} });
    expectStatus(mint, 201, 'mint (no X-Server-Id; the agent row is the subject)');
    minted = mint.data;
    assert.match(minted.apiKey, /^sk_agent_[A-Za-z0-9_-]+$/, 'raw agent key returned exactly once');
    expectUUID(minted.credentialId, 'credentialId');
    assert.equal(minted.agentId, external.id); assert.equal(minted.agentName, external.name);
    assert.equal(minted.serverId, workspace.id);
    assert.ok(Array.isArray(minted.scopes) && minted.scopes.length > 0, 'default scope set is non-empty');
    // Exact CLI surface: GET /internal/agent-api/ (trailing slash) with the bare agent key.
    const whoami = await request('/internal/agent-api/', { token: minted.apiKey });
    expectStatus(whoami, 200, 'agent-api whoami');
    assert.equal(whoami.data.agentId, external.id);
    assert.equal(whoami.data.agentName, external.name);
    assert.equal(whoami.data.serverId, workspace.id);
    assert.equal(whoami.data.credentialId, minted.credentialId);
    assert.deepEqual(whoami.data.scopes, minted.scopes);
    assert.equal(typeof whoami.data.serverRole, 'string');
    const badKey = await request('/internal/agent-api/', { token: 'sk_agent_0000000000000000000000000000' });
    expectStatus(badKey, 401, 'whoami with unknown key');
  });

  await check('credential revocation is durable and idempotent', async () => {
    const revoke = await request(`/api/agents/${external.id}/credentials/${minted.credentialId}`, { method: 'DELETE', token: owner.accessToken });
    expectStatus(revoke, 204, 'revoke');
    const after = await request('/internal/agent-api/', { token: minted.apiKey });
    expectStatus(after, 401, 'whoami with revoked key');
    const repeat = await request(`/api/agents/${external.id}/credentials/${minted.credentialId}`, { method: 'DELETE', token: owner.accessToken });
    // The frozen TS revokeAgentCredential returns true for an already
    // revoked row; repeating DELETE is an idempotent success, not a miss.
    expectStatus(repeat, 204, 'repeat revoke remains idempotent');
    const list = await request(`/api/agents/${external.id}/credentials`, { token: owner.accessToken });
    expectStatus(list, 200, 'credential list'); assert.equal(list.data.agentId, external.id);
    // listAgentCredentials exposes metadata.id; only the mint result
    // calls this value credentialId. No raw key is returned on list.
    const row = (list.data.credentials ?? []).find(c => c.id === minted.credentialId);
    assert.ok(row, 'revoked credential stays auditable'); assert.ok(row.revokedAt, 'revocation is timestamped');
    assert.match(row.maskedToken ?? '', /\*\*\*$/);
    assert.ok(!JSON.stringify(list.data).includes(minted.apiKey), 'credential listing never recovers the raw key');
  });

  await check('explicitly enabled bootstrap issues and consumes a real credential', async () => {
    const issue = await request(`/api/agents/${external.id}/bootstrap-tokens`, { method: 'POST', ...scoped({ body: {} }) });
    {
      expectStatus(issue, 201, 'bootstrap token issue (acceptance starts with explicit bootstrap opt-in)');
      const exchange = await request('/api/agent/login', { method: 'POST', body: { bootstrapToken: issue.data.bootstrapToken } });
      expectStatus(exchange, 200, 'bootstrap exchange');
      assert.match(exchange.data.apiKey, /^sk_agent_/); assert.equal(exchange.data.agentId, external.id);
      assert.equal(typeof exchange.data.serverSlug, 'string');
      const replay = await request('/api/agent/login', { method: 'POST', body: { bootstrapToken: issue.data.bootstrapToken } });
      expectStatus(replay, 410, 'bootstrap single-use'); assert.equal(replay.data?.code, 'token_consumed');
    }
  });

  let peer;
  try {
    await check('managed runtime agent dispatches over the machine wire, not a fake success', async () => {
      peer = await connectMachine({ origin, apiKey: computer.apiKey });
      assert.ok(!('rejected' in peer), `machine peer upgrade failed with HTTP ${peer.rejected?.status}`);
      sockets.push(peer);
      const context = await peer.nextMessage(m => m.type === 'machine:context', 10000);
      assert.equal(context.machineId, computer.machineId);
      peer.send({ type: 'ready', capabilities: ['agent:start', 'agent:stop', 'agent:deliver'], runtimes: ['claude'], runningAgents: [], hostname: 'agent-peer', os: 'darwin arm64', daemonVersion: '0.0.0-m3-agent' });
      await pollUntil('ready runtimes in the machine directory', async () => {
        const machines = await request(`/api/servers/${workspace.id}/machines`, scoped());
        const row = machines.data.machines.find(m => m.id === computer.machineId);
        return row && Array.isArray(row.runtimes) && row.runtimes.includes('claude') ? row : null;
      });
      const created = await request('/api/agents', {
        method: 'POST', ...scoped({ body: { name: 'wire-runner', runtime: 'claude', model: 'sonnet', machineId: computer.machineId } }),
      });
      expectStatus(created, 200, 'managed agent create bound to the attached machine');
      const agent = created.data;
      assert.equal(agent.machineId, computer.machineId);
      const start = await request(`/api/agents/${agent.id}/start`, { method: 'POST', ...scoped({ body: {} }) });
      expectStatus(start, 200, 'start'); assert.deepEqual(start.data, { ok: true });
      const dispatched = await peer.nextMessage(m => m.type === 'agent:start' && m.agentId === agent.id, 15000);
      assert.equal(dispatched.agentId, agent.id, 'the start command reaches the bound machine as agent:start');
      assert.ok(dispatched.config && typeof dispatched.config === 'object', 'agent:start carries the launch config');
      const stop = await request(`/api/agents/${agent.id}/stop`, { method: 'POST', ...scoped({ body: {} }) });
      expectStatus(stop, 200, 'stop');
      const stopped = await peer.nextMessage(m => m.type === 'agent:stop' && m.agentId === agent.id, 15000);
      assert.equal(stopped.agentId, agent.id);
      const reset = await request(`/api/agents/${agent.id}/reset`, { method: 'POST', ...scoped({ body: { mode: 'restart' } }) });
      expectStatus(reset, 200, 'reset');
      const detail = await request(`/api/agents/${agent.id}`, scoped());
      expectStatus(detail, 200, 'detail after lifecycle');
      const deleted = await request(`/api/agents/${agent.id}`, { method: 'DELETE', ...scoped() });
      expectStatus(deleted, 200, 'delete'); assert.deepEqual(deleted.data, { ok: true });
      const deletedProfile = await request(`/api/agents/${agent.id}`, scoped());
      expectStatus(deletedProfile, 200, 'soft-deleted profile remains viewable, matching the original client contract');
      assert.ok(deletedProfile.data.deletedAt, 'deleted profile reports its real deletion timestamp');
      const liveAgents = await request('/api/agents', scoped());
      expectStatus(liveAgents, 200, 'live agent directory after deletion');
      assert.ok(!liveAgents.data.some(row => row.id === agent.id), 'deleted Agent is absent from the live directory');
    });

    await check('lifecycle boundaries are reported honestly', async () => {
      const start = await request(`/api/agents/${external.id}/start`, { method: 'POST', ...scoped({ body: {} }) });
      expectStatus(start, 400, 'external start'); assert.equal(start.data?.error, 'External agents do not use Raft-managed runtime lifecycle');
      const stop = await request(`/api/agents/${external.id}/stop`, { method: 'POST', ...scoped({ body: {} }) });
      expectStatus(stop, 400, 'external stop'); assert.equal(stop.data?.error, 'External agents do not use Raft-managed runtime lifecycle');
      // The original service auto-assigns the first workspace machine.
      // Use the other, genuinely machine-less workspace for this refusal.
      const machineLessScope = { token: stranger.accessToken, server: strangerWorkspace.id };
      const unassigned = await request('/api/agents', { method: 'POST', ...machineLessScope, body: { name: 'no-machine', runtime: 'claude', model: 'sonnet' } });
      expectStatus(unassigned, 200, 'identity creation in a machine-less workspace succeeds');
      assert.equal(unassigned.data.machineId, null, 'the fixture is genuinely unassigned');
      const startUnassigned = await request(`/api/agents/${unassigned.data.id}/start`, { method: 'POST', ...machineLessScope, body: {} });
      expectStatus(startUnassigned, 409, 'start without machine'); assert.equal(startUnassigned.data?.code, 'machine_unassigned');
    });

    await check('official onboarding agent completes setup through real facts', async () => {
      const created = await request('/api/agents', {
        method: 'POST', ...scoped({ body: { name: 'whatever-the-form-said', onboarding: true, runtime: 'claude', model: 'sonnet', machineId: computer.machineId } }),
      });
      expectStatus(created, 200, 'onboarding agent create');
      const cindy = created.data;
      assert.equal(cindy.name, 'Cindy', 'the official identity overrides the submitted name');
      assert.equal(cindy.description, 'Onboarding Assistant');
      assert.equal(cindy.avatarUrl, 'pixel:mug');
      assert.equal(cindy.serverRole, 'admin');
      const workspaceAfter = await request(`/api/servers/${workspace.id}`, scoped());
      expectStatus(workspaceAfter, 200, 'workspace detail');
      assert.equal(workspaceAfter.data.onboardingAgentId, cindy.id, 'the workspace points at the official onboarding agent');
      const duplicate = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'again', onboarding: true, runtime: 'claude', model: 'sonnet', machineId: computer.machineId } }) });
      expectStatus(duplicate, 409, 'second onboarding agent');
      const complete = await request(`/api/servers/${workspace.id}/setup-transition`, { method: 'POST', ...scoped({ body: { action: 'complete' } }) });
      expectStatus(complete, 200, 'setup complete with a real online machine and official agent');
      assert.equal(complete.data.phase, 'complete', 'completion is earned, not assumed');
      assert.equal(complete.data.blocksChat, false);
    });
  } finally {
    finallyClose();
  }
  console.log(`M3 agent identity acceptance passed: ${passed.length} groups.`);
  return { owner, workspace, external };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL, data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyM3AgentIdentity({ origin, data });
}
