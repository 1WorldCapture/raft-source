// M3 creation read models: the assembled Web picker, live catalog RPC, agent
// form admission, avatar bytes, and sk_agent directory. Pinned from
// docs/m3-runtime-catalog-contract.md, docs/m3-agent-contract.md, and the
// original routes in packages/server/src/routes/{servers.ts,agents.ts,
// internalAgentApi.ts,internalComputer.ts}. The machine peer is this test's
// raw socket. No LLM, browser, or database seed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachComputer, createVerifiedAccount, createWorkspace, deviceLogin, exactKeys, expectStatus, expectUUID, httpClient, pollUntil } from './m3-harness.mjs';
import { connectMachine } from './m3-wire-ws.mjs';

const NEW_AGENT_ORDER = ['claude', 'codex', 'builtin', 'kimi-sdk', 'copilot', 'cursor-sdk', 'opencode', 'pi'];
const IN_PROCESS = new Set(['builtin', 'kimi-sdk', 'cursor-sdk']);
const OMITTED = ['grok', 'omp', 'kimi', 'antigravity', 'gemini'];
const BUILTIN_REF = { protocolVersion: 1, runtimeId: 'builtin', schemaVersion: 'builtin-pi.create.v2' };
const KIMI_REF = { protocolVersion: 1, runtimeId: 'kimi-sdk', schemaVersion: 'kimi-sdk.create.v1' };
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function publicFailure(result) {
  const code = result.data?.code ?? result.data?.issues?.[0]?.code;
  const error = typeof result.data?.error === 'string' && result.data.error.length < 180 ? result.data.error : '';
  const text = [result.status, code, error].filter(Boolean).join(' ');
  return /sk_|bearer |apikey|password|token/i.test(text) ? String(result.status) : text;
}

function assertNewAgentOptions(body, machineId, installed) {
  assert.equal(body?.context, 'new_agent');
  assert.equal(body?.machineId, machineId);
  assert.deepEqual((body?.options ?? []).map(option => option.runtimeId), NEW_AGENT_ORDER);
  for (const absent of OMITTED) {
    assert.equal(body.options.some(option => option.runtimeId === absent), false, `${absent} stays out of the new-agent catalog`);
  }
  for (const option of body.options) {
    assert.equal(Object.hasOwn(option, 'admissionReason'), true, `${option.runtimeId} always carries admissionReason`);
    assert.equal(option.admissionReason, null);
    assert.equal(option.admissionStatus, 'available_for_new');
    assert.equal(option.availableForNew, true);
    assert.equal(option.current, false);
    const reported = installed.has(option.runtimeId);
    const capability = reported ? 'available' : (IN_PROCESS.has(option.runtimeId) ? 'update_required' : 'not_installed');
    assert.equal(option.capabilityStatus, capability, option.runtimeId);
    assert.equal(option.canSelectInThisContext, reported, option.runtimeId);
    if (option.runtimeId === 'builtin' || option.runtimeId === 'kimi-sdk') {
      assert.deepEqual(option.formDefinitionRef, option.runtimeId === 'builtin' ? BUILTIN_REF : KIMI_REF);
    } else {
      assert.equal(Object.hasOwn(option, 'formDefinitionRef'), false, option.runtimeId);
    }
  }
}

async function expectDetect(peer, pending, runtime) {
  const winner = await Promise.race([
    peer.nextMessage(message => message?.type === 'machine:runtime_models:detect' && message.runtime === runtime, 8000).then(message => ({ message })),
    pending.then(result => ({ result })),
  ]);
  if (winner.result) {
    throw new Error(`HTTP ${publicFailure(winner.result)} returned before machine:runtime_models:detect for ${runtime}`);
  }
  expectUUID(winner.message.requestId, `${runtime} detect requestId`);
  assert.equal(winner.message.runtime, runtime);
  return winner.message;
}

function liveReply(requestId, modelId, catalog) {
  const value = { models: [{ id: modelId, label: 'Observed' }], default: modelId };
  if (catalog) value.catalog = catalog;
  return { type: 'machine:runtime_models:result', requestId, outcome: { kind: 'live', value } };
}

export async function verifyM3CreationReadModels({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 creation ${name}`); };
  const sockets = [];
  const finallyClose = () => { for (const socket of sockets.splice(0)) try { socket.close(); } catch { /* teardown */ } };

  const owner = await createVerifiedAccount(request, maildir, 'cowner');
  const stranger = await createVerifiedAccount(request, maildir, 'cstranger');
  const profile = await request('/api/auth/me', { token: owner.accessToken });
  expectStatus(profile, 200, 'owner profile');
  const ownerName = profile.data?.name;
  assert.equal(typeof ownerName, 'string');
  assert.ok(ownerName.length > 0, 'profile name is the human handle');
  const workspace = await createWorkspace(request, owner, 'creation');
  const foreign = await createWorkspace(request, stranger, 'foreign');
  const scoped = (extras = {}) => ({ token: owner.accessToken, server: workspace.id, ...extras });
  const login = await deviceLogin(request, { approveToken: owner.accessToken });
  const computer = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'creation-peer' });
  const machinePath = `/api/servers/${workspace.id}/machines/${computer.machineId}`;

  try {
    await check('runtime options before ready omit flag-off runtimes and do not pretend installed', async () => {
      const options = await request(`${machinePath}/runtime-options`, scoped());
      expectStatus(options, 200, 'runtime options before ready');
      assertNewAgentOptions(options.data, computer.machineId, new Set());
    });

    await check('builtin catalog offline is an honest retry, not a fabricated model list', async () => {
      const source = await request(`${machinePath}/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2`, scoped());
      expectStatus(source, 409, 'builtin option source while the Computer is offline');
      exactKeys(source.data, ['error', 'code', 'recovery']);
      assert.equal(source.data.code, 'builtin_catalog_unavailable');
      assert.equal(source.data.recovery, 'retry');
      const models = await request(`${machinePath}/runtime-models/builtin`, scoped());
      expectStatus(models, 200, 'runtime models while the Computer is offline');
      exactKeys(models.data, ['kind', 'retryable']);
      assert.equal(models.data.kind, 'error');
      assert.equal(models.data.retryable, true);
    });

    const peer = await connectMachine({ origin, apiKey: computer.apiKey });
    assert.ok(!('rejected' in peer), `machine peer upgrade failed with HTTP ${peer.rejected?.status}`);
    sockets.push(peer);
    const context = await peer.nextMessage(message => message.type === 'machine:context', 8000);
    assert.equal(context.machineId, computer.machineId);
    peer.send({
      type: 'ready', capabilities: ['agent:start'], runtimes: ['builtin', 'kimi-sdk', 'claude'],
      runningAgents: [], hostname: 'creation-peer', os: 'darwin arm64', daemonVersion: '0.0.0-m3-read',
    });
    await pollUntil('ready builtin, kimi-sdk, and claude inventory', async () => {
      const machines = await request(`/api/servers/${workspace.id}/machines`, scoped());
      const row = machines.data?.machines?.find(machine => machine.id === computer.machineId);
      return row?.runtimes?.includes('builtin') && row.runtimes.includes('kimi-sdk') && row.runtimes.includes('claude') ? row : null;
    }, { timeoutMs: 8000, intervalMs: 100 });

    await check('runtime options after ready admit only the reported builtin, kimi-sdk, and claude rows', async () => {
      const options = await request(`${machinePath}/runtime-options`, scoped());
      expectStatus(options, 200, 'runtime options after ready');
      assertNewAgentOptions(options.data, computer.machineId, new Set(['builtin', 'kimi-sdk', 'claude']));
    });

    await check('runtime form definitions publish the current builtin and kimi-sdk refs', async () => {
      const builtin = await request(`${machinePath}/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2`, scoped());
      expectStatus(builtin, 200, 'builtin form definition');
      assert.equal(builtin.data.protocolVersion, BUILTIN_REF.protocolVersion);
      assert.equal(builtin.data.runtimeId, BUILTIN_REF.runtimeId);
      assert.equal(builtin.data.schemaVersion, BUILTIN_REF.schemaVersion);
      assert.deepEqual(builtin.data.dataSchema?.required, ['providerId', 'apiKey', 'model']);
      assert.equal(builtin.data.optionSources?.provider?.schemaVersion, BUILTIN_REF.schemaVersion);
      assert.equal(builtin.data.optionSources?.provider?.sourceId, 'provider');
      assert.equal(builtin.data.optionSources?.model?.schemaVersion, BUILTIN_REF.schemaVersion);
      assert.equal(builtin.data.optionSources?.model?.kind, 'dependent_select');
      const kimi = await request(`${machinePath}/runtime-form-definitions/kimi-sdk?schemaVersion=kimi-sdk.create.v1`, scoped());
      expectStatus(kimi, 200, 'kimi-sdk form definition');
      assert.equal(kimi.data.schemaVersion, KIMI_REF.schemaVersion);
      assert.equal(kimi.data.runtimeId, KIMI_REF.runtimeId);
      assert.deepEqual(kimi.data.dataSchema?.required, ['model']);
      assert.equal(kimi.data.optionSources?.model?.sourceId, 'model');
      assert.equal(kimi.data.optionSources?.model?.kind, 'select');
      assert.equal(kimi.data.optionSources?.provider, undefined);
      const stale = await request(`${machinePath}/runtime-form-definitions/builtin?schemaVersion=stale`, scoped());
      expectStatus(stale, 409, 'stale form schema');
      assert.equal(stale.data?.issues?.[0]?.code, 'stale_form_schema');
      assert.equal(stale.data?.issues?.[0]?.pointer, '/schemaVersion');
      const claude = await request(`${machinePath}/runtime-form-definitions/claude?schemaVersion=builtin-pi.create.v2`, scoped());
      expectStatus(claude, 404, 'claude has no form definition');
      assert.equal(claude.data?.issues?.[0]?.code, 'unknown_form_runtime');
    });

    await check('model detect uses the correlated reply and rescan only sends the command', async () => {
      const pending = request(`${machinePath}/runtime-models/claude`, scoped());
      const command = await expectDetect(peer, pending, 'claude');
      peer.send(liveReply('00000000-0000-4000-8000-000000000099', 'decoy-not-this'));
      peer.send(liveReply(command.requestId, 'm3-observed-model'));
      const models = await pending;
      expectStatus(models, 200, 'correlated runtime models');
      exactKeys(models.data, ['kind', 'value', 'models', 'default']);
      assert.equal(models.data.kind, 'live');
      assert.deepEqual(models.data.models?.map(model => model.id), ['m3-observed-model']);
      assert.deepEqual(models.data.value?.models?.map(model => model.id), ['m3-observed-model']);
      assert.equal(models.data.default, 'm3-observed-model');
      assert.equal(JSON.stringify(models.data).includes('decoy-not-this'), false);
      const rescanPending = request(`${machinePath}/runtimes/rescan`, { method: 'POST', ...scoped({ body: {} }) });
      const rescan = await peer.nextMessage(message => message?.type === 'machine:runtimes:rescan', 8000);
      assert.deepEqual(rescan, { type: 'machine:runtimes:rescan' });
      const requested = await rescanPending;
      expectStatus(requested, 200, 'runtime rescan');
      assert.deepEqual(requested.data, { requested: true });
    });

    let agent;
    await check('a current builtin form ref is admitted only after the live broker replies', async () => {
      const pending = request('/api/agents', {
        method: 'POST', ...scoped({ body: {
          name: 'form-reader', runtime: 'builtin', model: 'm3-form-model', machineId: computer.machineId,
          formDefinitionRef: BUILTIN_REF,
          runtimeConfig: { runtime: 'builtin', model: 'm3-form-model' },
        } }),
      });
      const command = await expectDetect(peer, pending, 'builtin');
      peer.send(liveReply(command.requestId, 'm3-form-model', { protocolVersion: 1, runtime: 'builtin', runtimeVersion: '0.85.1' }));
      const created = await pending;
      expectStatus(created, 200, 'builtin agent create');
      agent = created.data;
      assert.equal(agent.runtime, 'builtin');
      assert.equal(agent.model, 'm3-form-model');
      assert.equal(agent.machineId, computer.machineId);
      assert.equal(agent.name, 'form-reader');
    });

    await check('agent avatar upload is the PNG later served at the returned URL', async () => {
      const form = new FormData();
      form.append('avatar', new Blob([PNG_1X1], { type: 'image/png' }), 'avatar.png');
      const uploaded = await fetch(new URL(`/api/agents/${agent.id}/avatar`, origin), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), body: form,
        headers: { Authorization: `Bearer ${owner.accessToken}`, 'X-Server-Id': workspace.id },
      });
      const uploadedText = await uploaded.text();
      let uploadedBody = null;
      try { uploadedBody = JSON.parse(uploadedText); } catch { uploadedBody = null; }
      const avatarResult = { status: uploaded.status, data: uploadedBody };
      expectStatus(avatarResult, 200, 'agent avatar upload');
      const avatarUrl = uploadedBody?.avatarUrl;
      assert.match(avatarUrl ?? '', /^\/api\/avatars\/servers\/[0-9a-f]{32}\.png$/, 'avatar URL is a content-addressed server PNG');
      const served = await fetch(new URL(avatarUrl, origin), { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const bytes = Buffer.from(await served.arrayBuffer());
      assert.equal(served.status, 200, 'served avatar');
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    });

    await check('sk_agent server and channel-members use handles, scopes, and private or foreign isolation', async () => {
      const eng = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'eng', visibility: 'public' } }) });
      expectStatus(eng, 200, 'public channel');
      const vault = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'vault', visibility: 'private' } }) });
      expectStatus(vault, 200, 'private channel');
      const abroad = await request('/api/channels', { method: 'POST', token: stranger.accessToken, server: foreign.id, body: { name: 'abroad', visibility: 'public' } });
      expectStatus(abroad, 200, 'foreign channel');
      const joined = await request(`/api/channels/${eng.data.id}/members`, { method: 'POST', ...scoped({ body: { agentId: agent.id } }) });
      expectStatus(joined, 200, 'add agent to #eng');
      const directoryMint = await request(`/api/agents/${agent.id}/credentials`, { method: 'POST', token: owner.accessToken, body: { scopes: ['server', 'channels'] } });
      expectStatus(directoryMint, 201, 'directory credential');
      assert.deepEqual(directoryMint.data?.scopes, ['channels', 'server']);
      const narrowMint = await request(`/api/agents/${agent.id}/credentials`, { method: 'POST', token: owner.accessToken, body: { scopes: ['read'] } });
      expectStatus(narrowMint, 201, 'narrow credential');
      const directoryKey = directoryMint.data.apiKey;
      const narrowKey = narrowMint.data.apiKey;
      const server = await request('/internal/agent-api/server', { token: directoryKey });
      expectStatus(server, 200, 'agent server directory');
      assert.equal(server.data?.runtimeContext?.agentId, agent.id);
      assert.equal(server.data?.runtimeContext?.runtime, 'builtin');
      assert.equal(server.data?.runtimeContext?.machineId, computer.machineId);
      assert.equal(server.data?.runtimeContext?.machineName, 'creation-peer');
      assert.equal(server.data?.serverRole, 'member');
      const channelNames = (server.data?.channels ?? []).map(channel => channel.name);
      assert.ok(channelNames.includes('all') && channelNames.includes('eng'), 'visible channels keep their names');
      assert.equal(channelNames.includes('vault'), false, 'a private channel the agent has not joined is omitted');
      assert.equal(channelNames.includes('abroad'), false, 'a foreign workspace channel is omitted');
      const listedAgent = (server.data?.agents ?? []).find(row => row.name === 'form-reader');
      assert.ok(listedAgent, 'the agent directory is addressed by name');
      assert.equal(Object.hasOwn(listedAgent, 'id'), false);
      assert.equal(listedAgent.role, 'member');
      const listedHuman = (server.data?.humans ?? []).find(row => row.name === ownerName);
      assert.ok(listedHuman, 'the human directory uses the profile name');
      assert.equal(Object.hasOwn(listedHuman, 'id'), false);
      assert.equal(listedHuman.role, 'owner');
      const members = await request(`/internal/agent-api/channel-members?channel=${encodeURIComponent('#eng')}`, { token: directoryKey });
      expectStatus(members, 200, '#eng members');
      assert.deepEqual(members.data?.channel, { ref: '#eng', type: 'channel' });
      assert.ok((members.data?.agents ?? []).some(row => row.name === 'form-reader' && !Object.hasOwn(row, 'id')));
      assert.ok((members.data?.humans ?? []).some(row => row.name === ownerName && row.role === 'owner' && !Object.hasOwn(row, 'id')));
      for (const [ref, label] of [['#vault', 'private'], ['#abroad', 'foreign'], ['#eng:ab12cd34', 'thread suffix']]) {
        const hidden = await request(`/internal/agent-api/channel-members?channel=${encodeURIComponent(ref)}`, { token: directoryKey });
        expectStatus(hidden, 404, label);
        assert.equal(hidden.data?.error, `Channel not found: ${ref}`);
      }
      const missing = await request('/internal/agent-api/channel-members', { token: directoryKey });
      expectStatus(missing, 400, 'missing channel handle');
      const serverDenied = await request('/internal/agent-api/server', { token: narrowKey });
      expectStatus(serverDenied, 403, 'server scope');
      assert.equal(serverDenied.data?.code, 'capability_not_authorized');
      assert.equal(serverDenied.data?.requiredCapability, 'server');
      const membersDenied = await request(`/internal/agent-api/channel-members?channel=${encodeURIComponent('#eng')}`, { token: narrowKey });
      expectStatus(membersDenied, 403, 'channels scope');
      assert.equal(membersDenied.data?.code, 'capability_not_authorized');
      assert.equal(membersDenied.data?.requiredCapability, 'channels');
      const inactive = await request('/internal/agent-api/server', { token: directoryKey, headers: { 'X-Slock-Agent-Active-Capabilities': 'channels' } });
      expectStatus(inactive, 501, 'inactive server capability');
      assert.equal(inactive.data?.code, 'unsupported_capability');
      assert.equal(inactive.data?.requiredCapability, 'server');
    });

    await check('computer preflight lists the sk_agent identity routes', async () => {
      const preflight = await request('/internal/computer/preflight', { method: 'POST', token: computer.apiKey, body: {} });
      expectStatus(preflight, 200, 'preflight');
      assert.equal(preflight.data?.ok, true);
      assert.ok((preflight.data?.registeredPrincipals ?? []).includes('sk_agent'), 'registeredPrincipals includes sk_agent');
      assert.ok((preflight.data?.claimedPrefixes ?? []).includes('/internal/agent-api/'));
      const surface = preflight.data?.computerSurface ?? [];
      for (const routePath of ['/internal/agent-api', '/internal/agent-api/', '/internal/agent-api/server', '/internal/agent-api/channel-members']) {
        assert.ok(surface.some(row => row.method === 'GET' && row.path === routePath && row.principal === 'sk_agent'), routePath);
      }
    });
  } finally {
    finallyClose();
  }
  console.log(`M3 creation read models acceptance passed: ${passed.length} groups.`);
  return { passed: passed.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL;
  const data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyM3CreationReadModels({ origin, data });
}
