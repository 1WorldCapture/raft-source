// M3 Computer admission acceptance: the real device-code grant (the exact
// surface `raft-computer login` drives), Computer attach, the sk_computer_*
// internal surface, and key revocation via machine deletion.
// Wire contract pinned from packages/server/src/routes/deviceAuth.ts,
// routes/computerAttach.ts, services/computerCredentialService.ts,
// routes/internalComputer.ts and packages/computer/src/{apiClient,services/login}.ts.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachComputer, createVerifiedAccount, createWorkspace, deviceLogin, expectStatus, expectUUID, httpClient } from './m3-harness.mjs';

export async function verifyM3ComputerAdmission({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 computer ${name}`); };

  const owner = await createVerifiedAccount(request, maildir, 'cowner');
  const other = await createVerifiedAccount(request, maildir, 'cother');
  const workspace = await createWorkspace(request, owner, 'admission');
  const foreign = await createWorkspace(request, other, 'foreign');

  await check('device authorize issues a real grant pointing at the web origin', async () => {
    const grant = await request('/api/auth/device/authorize', { method: 'POST', body: { clientName: 'raft-computer' } });
    expectStatus(grant, 201, 'device authorize');
    for (const field of ['deviceCode', 'userCode', 'verificationUri', 'verificationUriComplete', 'expiresIn', 'interval']) {
      assert.ok(grant.data[field] !== undefined, `authorize response must carry ${field}`);
    }
    assert.equal(typeof grant.data.expiresIn, 'number'); assert.ok(grant.data.expiresIn > 0);
    assert.equal(typeof grant.data.interval, 'number'); assert.ok(grant.data.interval >= 1);
    const uri = new URL(grant.data.verificationUri);
    assert.equal(uri.pathname, '/login/device', 'approval lives on the web /login/device page');
    assert.notEqual(uri.origin, new URL(origin).origin, 'verification URL must not point at the API origin');
    const complete = new URL(grant.data.verificationUriComplete);
    assert.equal(complete.searchParams.get('user_code'), grant.data.userCode, 'verificationUriComplete pre-fills the user_code');
    const invalid = await request('/api/auth/device/authorize', { method: 'POST', body: { clientName: 'x'.repeat(201) } });
    expectStatus(invalid, 400, 'oversized clientName'); assert.equal(invalid.data?.code, 'client_name_invalid');
  });

  await check('device approve/token lifecycle is single-use and honest', async () => {
    const grant = await request('/api/auth/device/authorize', { method: 'POST', body: {} });
    expectStatus(grant, 201, 'authorize for lifecycle');
    const unauthenticated = await request('/api/auth/device/approve', { method: 'POST', body: { userCode: grant.data.userCode } });
    expectStatus(unauthenticated, 401, 'approve without identity');
    const missing = await request('/api/auth/device/approve', { method: 'POST', token: owner.accessToken, body: {} });
    expectStatus(missing, 400, 'approve without userCode'); assert.equal(missing.data?.code, 'user_code_required');
    const unknown = await request('/api/auth/device/approve', { method: 'POST', token: owner.accessToken, body: { userCode: 'ZZZZZZZZZ' } });
    expectStatus(unknown, 404, 'approve with unknown userCode');
    const pending = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    expectStatus(pending, 400, 'token before approval'); assert.equal(pending.data?.code, 'authorization_pending');
    const required = await request('/api/auth/device/token', { method: 'POST', body: {} });
    expectStatus(required, 400, 'token without deviceCode'); assert.equal(required.data?.code, 'device_code_required');
    const approve = await request('/api/auth/device/approve', { method: 'POST', token: owner.accessToken, body: { userCode: grant.data.userCode } });
    expectStatus(approve, 200, 'approve'); assert.deepEqual({ ok: approve.data.ok, action: approve.data.action }, { ok: true, action: 'approved' });
    const resolved = await request('/api/auth/device/approve', { method: 'POST', token: owner.accessToken, body: { userCode: grant.data.userCode } });
    expectStatus(resolved, 409, 'second approve is already_resolved');
    const token = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    expectStatus(token, 200, 'token after approval');
    assert.equal(token.data.userId, owner.user.id, 'session belongs to the approving user');
    const me = await request('/api/auth/me', { token: token.data.accessToken });
    expectStatus(me, 200, 'device-issued token is a real user session'); assert.equal(me.data.id, owner.user.id);
    const replay = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    expectStatus(replay, 410, 'consumed grant'); assert.equal(replay.data?.code, 'device_code_consumed');
    const bogus = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: 'not-a-real-code' } });
    expectStatus(bogus, 400, 'unknown deviceCode'); assert.equal(bogus.data?.code, 'device_code_invalid');
  });

  await check('a denied device grant surfaces access_denied, never a session', async () => {
    const grant = await request('/api/auth/device/authorize', { method: 'POST', body: { clientName: 'denied-flow' } });
    expectStatus(grant, 201, 'authorize for denial');
    const deny = await request('/api/auth/device/approve', { method: 'POST', token: owner.accessToken, body: { userCode: grant.data.userCode, approve: false } });
    expectStatus(deny, 200, 'deny'); assert.equal(deny.data.action, 'denied');
    const poll = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    expectStatus(poll, 403, 'token after denial'); assert.equal(poll.data?.code, 'access_denied');
  });

  let computer;
  await check('attach issues a real sk_computer_ bound to a fresh machine', async () => {
    const login = await deviceLogin(request, { approveToken: owner.accessToken });
    assert.equal(login.session.userId, owner.user.id);
    const servers = await request('/api/servers/', { token: login.session.accessToken });
    expectStatus(servers, 200, 'computer ServersClient list with trailing slash');
    assert.ok(Array.isArray(servers.data), 'ServersClient requires a bare array');
    assert.ok(servers.data.some(row => row.id === workspace.id && row.slug === workspace.slug && row.role === 'owner'));
    const unauthenticated = await request('/api/computer/attach', { method: 'POST', body: { serverSlug: workspace.slug, name: 'acceptance-box' } });
    expectStatus(unauthenticated, 401, 'attach without identity');
    const emptySlug = await request('/api/computer/attach', { method: 'POST', token: login.session.accessToken, body: { serverSlug: '' } });
    expectStatus(emptySlug, 400, 'attach empty slug'); assert.equal(emptySlug.data?.code, 'server_slug_required');
    const badName = await request('/api/computer/attach', { method: 'POST', token: login.session.accessToken, body: { serverSlug: workspace.slug, name: 'x'.repeat(201) } });
    expectStatus(badName, 400, 'attach invalid name'); assert.equal(badName.data?.code, 'name_invalid');
    const unknownSlug = await request('/api/computer/attach', { method: 'POST', token: login.session.accessToken, body: { serverSlug: 'no-such-slug', name: 'box' } });
    expectStatus(unknownSlug, 403, 'attach unknown slug collapses to not_authorized'); assert.equal(unknownSlug.data?.code, 'not_authorized');
    computer = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'acceptance-box' });
    assert.match(computer.apiKey, /^sk_computer_[A-Za-z0-9_-]+$/, 'raw computer key is returned exactly once');
    expectUUID(computer.serverMachineId, 'serverMachineId is the computers row id');
    expectUUID(computer.machineId, 'machineId is the machines row id');
    assert.notEqual(computer.serverMachineId, computer.machineId, 'serverMachineId (computers.id) differs from machineId (machines.id)');
    assert.equal(computer.serverId, workspace.id); assert.equal(computer.serverSlug, workspace.slug);
    assert.equal(computer.resumed, false, 'a fresh attach is not a resume');
    const collision = await request('/api/computer/attach', { method: 'POST', token: login.session.accessToken, body: { serverSlug: workspace.slug, name: 'acceptance-box' } });
    expectStatus(collision, 409, 'same-user same-name reattach'); assert.equal(collision.data?.code, 'COMPUTER_NAME_COLLISION');
    const second = await attachComputer(request, { userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'acceptance-box-2' });
    assert.notEqual(second.machineId, computer.machineId, 'a different name attaches a distinct machine');
  });

  await check('sk_computer_ principal reaches preflight and the runner whitelist', async () => {
    const preflight = await request('/internal/computer/preflight', { method: 'POST', token: computer.apiKey, body: {} });
    expectStatus(preflight, 200, 'preflight');
    assert.equal(preflight.data.ok, true, 'preflight must confirm surface alignment before local state is written');
    assert.equal(preflight.data.serverSlug, workspace.slug);
    assert.equal(preflight.data.principal?.kind, 'computer', 'principal split is enforced for this request');
    assert.equal(preflight.data.principal?.serverId, workspace.id);
    const garbage = await request('/internal/computer/preflight', { method: 'POST', token: 'sk_computer_deadbeef', body: {} });
    expectStatus(garbage, 401, 'preflight with unknown key');
    // This is a required original-Daemon launch identity surface in M3,
    // not an optional future message-delivery capability.
    const runners = await request('/internal/computer/runners', { token: computer.apiKey });
    expectStatus(runners, 200, 'required runners control plane');
    assert.deepEqual(runners.data.whitelist, ['agentId', 'name', 'status', 'model', 'runtime'], 'the control-plane whitelist is server-enforced and echoed');
    assert.deepEqual(runners.data.runners, [], 'no Agent has been created on this newly attached machine');
    const machines = await request(`/api/servers/${workspace.id}/machines`, { token: owner.accessToken, server: workspace.id });
    expectStatus(machines, 200, 'machine directory after attach');
    const row = machines.data.machines.find(m => m.id === computer.machineId);
    assert.ok(row, 'attached machine appears in the workspace directory');
    assert.equal(row.isComputer, true); assert.equal(row.computerAttachedByCurrentUser, true);
    assert.equal(row.agentCount, 0); assert.equal(typeof row.name, 'string');
    assert.ok(machines.data.machines.some(m => m.id !== computer.machineId), 'second attach is listed too');
  });

  await check('deleting the machine revokes the Computer key immediately', async () => {
    const removed = await request(`/api/servers/${workspace.id}/machines/${computer.machineId}`, { method: 'DELETE', token: owner.accessToken, server: workspace.id });
    expectStatus(removed, 200, 'machine delete');
    const preflight = await request('/internal/computer/preflight', { method: 'POST', token: computer.apiKey, body: {} });
    expectStatus(preflight, 401, 'preflight with revoked key');
    const runners = await request('/internal/computer/runners', { token: computer.apiKey });
    expectStatus(runners, 401, 'runners with revoked key');
    const machines = await request(`/api/servers/${workspace.id}/machines`, { token: owner.accessToken, server: workspace.id });
    expectStatus(machines, 200, 'directory after revoke');
    assert.ok(!machines.data.machines.some(m => m.id === computer.machineId), 'revoked machine leaves the directory');
    const foreignDelete = await request(`/api/servers/${workspace.id}/machines/${computer.machineId}`, { method: 'DELETE', token: other.accessToken, server: foreign.id });
    assert.ok([400, 403, 404].includes(foreignDelete.status), 'a non-member or mismatched scope cannot delete machines in this workspace');
  });

  console.log(`M3 computer admission acceptance passed: ${passed.length} groups.`);
  return { owner, other, workspace, computer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL, data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyM3ComputerAdmission({ origin, data });
}
