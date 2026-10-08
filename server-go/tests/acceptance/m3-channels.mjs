// M3 channel acceptance: public/private channel list/create/detail, join/leave,
// roster, archive lifecycle and workspace isolation on /api/channels with the
// X-Server-Id scope. Pinned from packages/server/src/routes/channels.ts,
// middleware/auth.ts requireServer and the shared name validators consumed by
// packages/web/src/store/channelStore.ts. Threads, DMs with unread state and
// messages are M4; only the M3A surface is asserted here.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedAccount, createWorkspace, expectStatus, expectUUID, httpClient } from './m3-harness.mjs';

export async function verifyM3Channels({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 channel ${name}`); };

  const owner = await createVerifiedAccount(request, maildir, 'chowner');
  const stranger = await createVerifiedAccount(request, maildir, 'chstranger');
  const workspace = await createWorkspace(request, owner, 'channels');
  const strangerWorkspace = await createWorkspace(request, stranger, 'strangerch');
  const scoped = (extras = {}) => ({ token: owner.accessToken, server: workspace.id, ...extras });

  await check('scope middleware rejects unauthenticated and unscoped channel reads', async () => {
    expectStatus(await request('/api/channels'), 401, 'channel list without identity');
    expectStatus(await request('/api/channels', { token: owner.accessToken }), 400, 'channel list without X-Server-Id');
    const strangerScope = await request('/api/channels', { token: stranger.accessToken, server: workspace.id });
    expectStatus(strangerScope, 403, 'channel list for a non-member scope');
    const strangerChannel = await request('/api/channels/00000000-0000-0000-0000-000000000000', { token: stranger.accessToken, server: strangerWorkspace.id });
    expectStatus(strangerChannel, 404, 'cross-workspace channel lookup collapses to not-found');
  });

  await check('system channels are present with truthful systemKind', async () => {
    const list = await request('/api/channels', scoped());
    expectStatus(list, 200, 'channel list'); assert.ok(Array.isArray(list.data));
    const all = list.data.find(c => c.systemKind === 'all');
    const announcement = list.data.find(c => c.systemKind === 'announcement');
    assert.ok(all, 'the #all system channel exists'); assert.equal(all.name, 'all');
    assert.ok(['channel', 'private'].includes(all.type)); assert.equal(all.joined, true, 'members implicitly join an enabled #all');
    assert.equal(all.archivedAt, null);
    assert.ok(announcement, 'the #announcement system channel exists'); assert.equal(announcement.archivedAt, null);
  });

  let channel;
  await check('public channel creation returns the creator-joined DTO', async () => {
    const invalidVisibility = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'x', visibility: 'secret' } }) });
    expectStatus(invalidVisibility, 400, 'invalid visibility');
    assert.equal(invalidVisibility.data?.error, 'visibility must be one of: public, private, joint');
    const reserved = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'all', visibility: 'public' } }) });
    expectStatus(reserved, 400, 'reserved name'); assert.equal(reserved.data?.code, 'channel_name_reserved');
    for (const [badName, error] of [['   ', 'Channel name is required'], ['x'.repeat(33), 'Channel name must be at most 32 characters'], ['9start', 'Channel name must start with a letter and can only contain letters, numbers, hyphens, and underscores']]) {
      const bad = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: badName, visibility: 'public' } }) });
      expectStatus(bad, 400, 'channel name validation'); assert.equal(bad.data?.error, error);
    }
    const tooLongDescription = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'desc', visibility: 'public', description: 'x'.repeat(501) } }) });
    expectStatus(tooLongDescription, 400, 'description length');
    const created = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'eng', description: 'engineering', visibility: 'public' } }) });
    expectStatus(created, 200, 'create returns 200 like the TS route, not 201');
    channel = created.data;
    expectUUID(channel.id, 'channel id'); assert.equal(channel.name, 'eng');
    assert.equal(channel.type, 'channel'); assert.equal(channel.description, 'engineering');
    assert.equal(channel.joined, true, 'the creator is a member'); assert.equal(channel.archivedAt, null);
    assert.match(channel.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T/, 'createdAt is a timestamp');
    const duplicate = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'eng', visibility: 'public' } }) });
    expectStatus(duplicate, 409, 'duplicate name'); assert.match(duplicate.data?.error ?? '', /already taken/i);
    const detail = await request(`/api/channels/${channel.id}`, scoped());
    expectStatus(detail, 200, 'detail'); assert.equal(detail.data.id, channel.id); assert.equal(detail.data.joined, true);
  });

  await check('join/leave cycle and private visibility behave per contract', async () => {
    const leave = await request(`/api/channels/${channel.id}/leave`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(leave, 200, 'leave'); assert.deepEqual(leave.data, { ok: true });
    const afterLeave = await request(`/api/channels/${channel.id}`, scoped());
    expectStatus(afterLeave, 200, 'public detail after leave'); assert.equal(afterLeave.data.joined, false, 'the leave is observable');
    const join = await request(`/api/channels/${channel.id}/join`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(join, 200, 'join'); assert.deepEqual(join.data, { ok: true });
    const afterJoin = await request(`/api/channels/${channel.id}`, scoped());
    expectStatus(afterJoin, 200, 'detail after rejoin'); assert.equal(afterJoin.data.joined, true);
    const created = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'secret-ops', visibility: 'private' } }) });
    expectStatus(created, 200, 'private create'); assert.equal(created.data.type, 'private');
    // The join handler rejects private channels before any visibility check.
    const privateJoin = await request(`/api/channels/${created.data.id}/join`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(privateJoin, 403, 'private join'); assert.equal(privateJoin.data?.error, 'Private channels require an invitation');
    const strangerDetail = await request(`/api/channels/${created.data.id}`, { token: stranger.accessToken, server: strangerWorkspace.id });
    expectStatus(strangerDetail, 404, 'private channel is invisible across workspaces');
    const announcementReserved = await request('/api/channels', { method: 'POST', ...scoped({ body: { name: 'announcement', visibility: 'public' } }) });
    expectStatus(announcementReserved, 400, 'announcement is reserved'); assert.equal(announcementReserved.data?.code, 'channel_name_reserved');
    const system = await request('/api/channels', scoped());
    const allChannel = system.data.find(c => c.systemKind === 'all');
    const leaveAll = await request(`/api/channels/${allChannel.id}/leave`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(leaveAll, 403, 'leaving #all is refused');
    const joinAll = await request(`/api/channels/${allChannel.id}/join`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(joinAll, 200, 'implicit #all membership makes join idempotent'); assert.deepEqual(joinAll.data, { ok: true });
  });

  let agentForRoster;
  await check('roster lists humans and accepts agent members', async () => {
    const members = await request(`/api/channels/${channel.id}/members`, scoped());
    expectStatus(members, 200, 'members');
    assert.ok(Array.isArray(members.data.agents) && Array.isArray(members.data.humans) && Array.isArray(members.data.externalMembers));
    const human = members.data.humans.find(h => h.id === owner.user.id);
    assert.ok(human, 'the owner is on the roster');
    assert.equal(human.role, 'owner');
    assert.equal(human.effectiveChannelRole, 'owner', 'server owners keep owner authority in channels');
    assert.equal(human.canChangeChannelRole, false, 'owner rows are not editable');
    const created = await request('/api/agents', { method: 'POST', ...scoped({ body: { name: 'roster-agent', external: true } }) });
    expectStatus(created, 200, 'agent fixture for roster'); agentForRoster = created.data;
    const invalidMember = await request(`/api/channels/${channel.id}/members`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(invalidMember, 400, 'member add without target');
    const foreignAgent = await request(`/api/channels/${channel.id}/members`, { method: 'POST', ...scoped({ body: { agentId: '00000000-0000-0000-0000-000000000000' } }) });
    expectStatus(foreignAgent, 400, 'member add with unknown agent'); assert.equal(foreignAgent.data?.error, 'Agent not found in this server');
    const added = await request(`/api/channels/${channel.id}/members`, { method: 'POST', ...scoped({ body: { agentId: agentForRoster.id } }) });
    expectStatus(added, 200, 'member add'); assert.deepEqual(added.data, { ok: true });
    const roster = await request(`/api/channels/${channel.id}/members`, scoped());
    expectStatus(roster, 200, 'roster after add');
    assert.ok(roster.data.agents.some(a => a.id === agentForRoster.id), 'the agent appears on the channel roster');
  });

  await check('archive lifecycle is enforced and reversible', async () => {
    const system = await request('/api/channels', scoped());
    const allChannel = system.data.find(c => c.systemKind === 'all');
    const protectedArchive = await request(`/api/channels/${allChannel.id}/archive`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(protectedArchive, 400, 'system channels cannot be archived');
    const archived = await request(`/api/channels/${channel.id}/archive`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(archived, 200, 'archive');
    assert.match(archived.data.archivedAt ?? '', /^\d{4}-\d{2}-\d{2}T/, 'archivedAt is set');
    const joinArchived = await request(`/api/channels/${channel.id}/join`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(joinArchived, 409, 'join archived'); assert.equal(joinArchived.data?.code, 'channel_archived');
    const archivedOnly = await request(`/api/channels?archived=only`, scoped());
    expectStatus(archivedOnly, 200, 'archived filter'); assert.ok(archivedOnly.data.some(c => c.id === channel.id));
    const invalidFilter = await request('/api/channels?archived=sometimes', scoped());
    expectStatus(invalidFilter, 400, 'archived filter validation');
    assert.equal(invalidFilter.data?.error, 'archived must be one of: exclude, include, only');
    const unarchived = await request(`/api/channels/${channel.id}/unarchive`, { method: 'POST', ...scoped({ body: {} }) });
    expectStatus(unarchived, 200, 'unarchive'); assert.equal(unarchived.data.archivedAt, null);
    const defaultList = await request('/api/channels', scoped());
    assert.ok(defaultList.data.some(c => c.id === channel.id && c.archivedAt === null), 'unarchived channel returns to the default list');
  });

  await check('channel profile updates apply owner-visible fields only', async () => {
    const renamed = await request(`/api/channels/${channel.id}`, { method: 'PATCH', ...scoped({ body: { name: 'eng-renamed', description: 'updated' } }) });
    expectStatus(renamed, 200, 'rename');
    assert.equal(renamed.data.name, 'eng-renamed'); assert.equal(renamed.data.description, 'updated');
    const detail = await request(`/api/channels/${channel.id}`, scoped());
    expectStatus(detail, 200, 'detail after rename'); assert.equal(detail.data.name, 'eng-renamed');
    const strangerPatch = await request(`/api/channels/${channel.id}`, { method: 'PATCH', token: stranger.accessToken, server: strangerWorkspace.id, body: { name: 'hijack' } });
    expectStatus(strangerPatch, 404, 'cross-workspace patch cannot leak');
  });

  console.log(`M3 channel acceptance passed: ${passed.length} groups.`);
  return { owner, workspace, channel };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL, data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyM3Channels({ origin, data });
}
