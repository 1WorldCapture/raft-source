// M3 invitations acceptance: the exact UI-blocking surface from the M3
// report finding #1 — join-link creation/list/revoke
// (InviteHumanDialog/SettingsPanel), email invites + pending list
// (SettingsPanel administration), the public accept preview and the
// logged-in join (InviteAcceptPage), pinned to the frozen TS routes
// (servers.ts join-links/invites, auth.ts invite-info/accept-invite).
// Real flows only: accounts from register + private outbox verification,
// workspaces from POST /api/servers, invite tokens from the outbox mail.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createVerifiedAccount, createWorkspace, expectStatus, expectUUID, httpClient, isoMillis } from './m3-harness.mjs';

async function inviteMailToken(maildir, to) {
  for (let attempt = 0; attempt < 60; attempt++) {
    let entries;
    try { entries = await readdir(maildir); } catch { entries = []; }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const text = await readFile(path.join(maildir, name), 'utf8');
      try {
        const parsed = JSON.parse(text);
        if (parsed.kind === 'invite' && parsed.to === to && parsed.token) return parsed.token;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Invite mail to ${to} never arrived in the private outbox.`);
}

export async function verifyM3Invitations({ origin, data }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M3 invitations ${name}`); };

  const owner = await createVerifiedAccount(request, maildir, 'invowner');
  const owner2 = await createVerifiedAccount(request, maildir, 'invowner2');
  const joiner = await createVerifiedAccount(request, maildir, 'invjoiner');
  const joiner2 = await createVerifiedAccount(request, maildir, 'invjoiner2');
  const outsider = await createVerifiedAccount(request, maildir, 'invout');
  const workspace = await createWorkspace(request, owner, 'invitations');
  const otherWorkspace = await createWorkspace(request, owner2, 'otherinv');
  const scoped = (token, server = workspace.id, extras = {}) => ({ token, server, ...extras });

  let joinToken;
  let linkId;
  await check('join-link management matches the invite dialog contract', async () => {
    // This account has not joined yet: scope denial must precede the
    // owner/admin capability check. The real member case is asserted below.
    expectStatus(await request('/api/servers', { token: joiner.accessToken }), 200, 'joiner lists own servers only');
    const asNonmember = await request(`/api/servers/${workspace.id}/join-links`, scoped(joiner.accessToken));
    expectStatus(asNonmember, 403, 'nonmember cannot view join links');
    assert.equal(asNonmember.data?.error, 'Not a member of this server');
    const unauthenticated = await request(`/api/servers/${workspace.id}/join-links`);
    expectStatus(unauthenticated, 401, 'join links require identity');
    const missingHeader = await request(`/api/servers/${workspace.id}/join-links`, { token: owner.accessToken });
    expectStatus(missingHeader, 400, 'join links require X-Server-Id');

    // The dialog's open flow: GET returns the bare active list, then POST
    // {maxUses:null, expiresAt:null} creates the reusable link.
    const empty = await request(`/api/servers/${workspace.id}/join-links`, scoped(owner.accessToken));
    expectStatus(empty, 200, 'empty join-link list');
    assert.ok(Array.isArray(empty.data) && empty.data.length === 0, 'empty list is a bare []');
    for (const [body, error] of [
      [{ maxUses: 0 }, 'maxUses must be a positive integer'],
      [{ maxUses: 2.5 }, 'maxUses must be a positive integer'],
      [{ expiresAt: 'whenever' }, 'expiresAt must be a valid date'],
    ]) {
      const invalid = await request(`/api/servers/${workspace.id}/join-links`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body }) });
      expectStatus(invalid, 400, 'join-link validation');
      assert.equal(invalid.data?.error, error);
    }
    const created = await request(`/api/servers/${workspace.id}/join-links`, {
      method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { maxUses: null, expiresAt: null } }),
    });
    expectStatus(created, 200, 'create join link');
    assert.ok(created.data.token, 'response carries the raw token');
    expectUUID(created.data.link?.id, 'link id');
    assert.equal(created.data.link.token, created.data.token, 'link record carries the token (URL rebuild)');
    assert.equal(created.data.link.useCount, 0);
    assert.equal(created.data.link.maxUses, null);
    assert.match(created.data.link.createdAt ?? '', isoMillis, 'createdAt is ISO milliseconds');
    joinToken = created.data.token;
    linkId = created.data.link.id;

    const listed = await request(`/api/servers/${workspace.id}/join-links`, scoped(owner.accessToken));
    expectStatus(listed, 200, 'list join links');
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].id, linkId);
    // Cross-workspace isolation: another owner's scope never sees this list.
    const foreign = await request(`/api/servers/${workspace.id}/join-links`, scoped(owner2.accessToken));
    expectStatus(foreign, 403, 'foreign owner cannot list');
  });

  await check('public invite preview serves the accept page', async () => {
    const missing = await request('/api/auth/invite-info');
    expectStatus(missing, 400, 'token param required');
    const info = await request(`/api/auth/invite-info?token=${encodeURIComponent(joinToken)}`);
    expectStatus(info, 200, 'public preview without identity');
    assert.equal(info.data.kind, 'join_link');
    assert.equal(info.data.serverName, workspace.name);
    assert.equal(info.data.insideCountsHidden, false);
    assert.equal(info.data.agreement, null);
    assert.equal(info.data.humanSeatLimitReached, false);
    assert.equal(typeof info.data.memberCount, 'number');
    const garbage = await request('/api/auth/invite-info?token=definitely-not-a-token');
    expectStatus(garbage, 404, 'invalid token collapses to the legacy 404');
    assert.equal(garbage.data?.error, 'Invalid or expired invite');
  });

  await check('logged-in join via link lands the member and stays idempotent', async () => {
    const accept = await request('/api/auth/accept-invite', { method: 'POST', token: joiner.accessToken, body: { token: joinToken } });
    expectStatus(accept, 200, 'accept join link');
    assert.equal(accept.data.serverId, workspace.id);
    assert.equal(accept.data.serverName, workspace.name);

    // The exact follow-up reads the web performs after accepting: the
    // joined workspace appears in the joiner's server list with the role.
    const servers = await request('/api/servers', { token: joiner.accessToken });
    expectStatus(servers, 200, 'joiner server list');
    const joined = servers.data.find(s => s.id === workspace.id);
    assert.ok(joined, 'joined workspace is in the list');
    assert.equal(joined.role, 'member');

    // Members directory reflects the new human (owner view).
    const members = await request(`/api/servers/${workspace.id}/members`, scoped(owner.accessToken));
    expectStatus(members, 200, 'members list');
    const joinerRow = members.data.find(m => m.email === joiner.email);
    assert.ok(joinerRow, 'joiner visible in the member directory');

    // Re-accepting is idempotent and does not consume another use.
    const again = await request('/api/auth/accept-invite', { method: 'POST', token: joiner.accessToken, body: { token: joinToken } });
    expectStatus(again, 200, 'idempotent re-accept');
    const links = await request(`/api/servers/${workspace.id}/join-links`, scoped(owner.accessToken));
    expectStatus(links, 200, 'use count after idempotent accept');
    assert.equal(links.data.find(l => l.id === linkId).useCount, 1);

    // The scope gate now admits the joiner as a real member, while
    // management stays owner/admin-only for them.
    expectStatus(await request(`/api/servers/${workspace.id}`, scoped(joiner.accessToken)), 200, 'joiner can read workspace');
    const memberManage = await request(`/api/servers/${workspace.id}/join-links`, scoped(joiner.accessToken));
    expectStatus(memberManage, 403, 'joiner still cannot manage invitations');
    assert.equal(memberManage.data?.error, 'Only server owners and admins can view join links');

    // The joined member is usable end-to-end on the real API: settings, the
    // honest no-setup projection for a non-owner, sidebar order (which
    // requires the per-member preferences companion row) and the channel
    // list with the implicit #all membership.
    expectStatus(await request(`/api/servers/${workspace.id}/settings`, scoped(joiner.accessToken)), 200, 'member reads settings');
    const projection = await request(`/api/servers/${workspace.id}/setup-projection`, scoped(joiner.accessToken));
    expectStatus(projection, 200, 'member setup projection');
    assert.equal(projection.data.surface, 'none');
    assert.equal(projection.data.gateReason, 'insufficient_permission');
    expectStatus(await request(`/api/servers/${workspace.id}/sidebar-order`, scoped(joiner.accessToken)), 200, 'member sidebar order');
    const channels = await request('/api/channels', scoped(joiner.accessToken));
    expectStatus(channels, 200, 'member channel list');
    const allChannel = channels.data.find(c => c.systemKind === 'all');
    assert.ok(allChannel, 'the #all channel is visible');
    assert.equal(allChannel.joined, true, 'the joined member implicitly belongs to #all');
  });

  await check('email invites honor the frozen guest gate, bind to the invited address and honor roles', async () => {
    const invitedEmail = joiner2.email;
    const badRole = await request(`/api/servers/${workspace.id}/invites`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { email: outsider.email, role: 'owner' } }) });
    expectStatus(badRole, 400, 'role must be member|guest');
    assert.equal(badRole.data?.error, 'role must be one of: member, guest');

    // Frozen M3 guest gate: the TS route refuses guest invites while the
    // feature flag is disabled, and M3 freezes it disabled. Exact sentence,
    // 400, no silent member downgrade, nothing persisted.
    const guestInvite = await request(`/api/servers/${workspace.id}/invites`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { email: invitedEmail, role: 'guest' } }) });
    expectStatus(guestInvite, 400, 'guest invites refused under the frozen disabled gate');
    assert.equal(guestInvite.data?.error, 'Guest access is not enabled for this server');
    const notPersisted = await request(`/api/servers/${workspace.id}/invites`, scoped(owner.accessToken));
    expectStatus(notPersisted, 200, 'pending list after guest refusal');
    assert.equal(notPersisted.data.length, 0, 'no guest invite was persisted');

    const invited = await request(`/api/servers/${workspace.id}/invites`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { email: `  ${invitedEmail.toUpperCase()}  ` } }) });
    expectStatus(invited, 200, 'create email invite');
    expectUUID(invited.data.id, 'invite id');
    assert.equal(invited.data.invitedEmail, invitedEmail, 'address normalized like the account store');
    assert.equal(invited.data.role, 'member');
    assert.match(invited.data.expiresAt ?? '', isoMillis, 'expiresAt is ISO milliseconds');
    assert.equal(invited.data.token, undefined, 'the raw invite token never rides the response');

    const duplicate = await request(`/api/servers/${workspace.id}/invites`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { email: invitedEmail } }) });
    expectStatus(duplicate, 409, 'duplicate pending invite');
    assert.equal(duplicate.data?.error, 'An invite has already been sent to this email');

    const pending = await request(`/api/servers/${workspace.id}/invites`, scoped(owner.accessToken));
    expectStatus(pending, 200, 'pending list');
    assert.equal(pending.data.length, 1);
    assert.equal(pending.data[0].invitedEmail, invitedEmail);
    assert.equal(pending.data[0].status, 'pending');

    const mailToken = await inviteMailToken(maildir, invitedEmail);
    // Email binding: a different account cannot consume the invite.
    const wrongAccount = await request('/api/auth/accept-invite', { method: 'POST', token: outsider.accessToken, body: { token: mailToken } });
    expectStatus(wrongAccount, 400, 'email-bound invite');
    assert.equal(wrongAccount.data?.error, 'This invite was sent to a different email address');

    // The invited account previews the email invite and accepts as member.
    const info = await request(`/api/auth/invite-info?token=${encodeURIComponent(mailToken)}`);
    expectStatus(info, 200, 'email invite preview');
    assert.equal(info.data.kind, 'email');
    assert.ok(info.data.inviterName, 'inviter is named for email invites');
    const accept = await request('/api/auth/accept-invite', { method: 'POST', token: joiner2.accessToken, body: { token: mailToken } });
    expectStatus(accept, 200, 'accept email invite');
    assert.equal(accept.data.serverId, workspace.id);

    const servers = await request('/api/servers', { token: joiner2.accessToken });
    const joined = servers.data.find(s => s.id === workspace.id);
    assert.ok(joined, 'the invited account joined the workspace');
    assert.equal(joined.role, 'member', 'the invited role is what lands');

    // Single use, and the pending list drained.
    const reuse = await request('/api/auth/accept-invite', { method: 'POST', token: joiner2.accessToken, body: { token: mailToken } });
    expectStatus(reuse, 400, 'used invite');
    assert.equal(reuse.data?.error, 'This invite has already been used');
    const afterAccept = await request(`/api/servers/${workspace.id}/invites`, scoped(owner.accessToken));
    expectStatus(afterAccept, 200, 'pending list after accept');
    assert.equal(afterAccept.data.length, 0);
  });

  await check('revoke, limits and cross-workspace scoping close the loop', async () => {
    // Revoking another workspace's link id against this workspace is a no-op.
    const foreignLink = await request(`/api/servers/${otherWorkspace.id}/join-links`, { method: 'POST', ...scoped(owner2.accessToken, otherWorkspace.id, { body: { maxUses: null, expiresAt: null } }) });
    expectStatus(foreignLink, 200, 'foreign link create');
    const crossRevoke = await request(`/api/servers/${workspace.id}/join-links/${foreignLink.data.link.id}`, { method: 'DELETE', ...scoped(owner.accessToken, workspace.id) });
    expectStatus(crossRevoke, 200, 'cross-workspace revoke stays ok');
    assert.deepEqual(crossRevoke.data, { ok: true });
    expectStatus(await request(`/api/auth/invite-info?token=${encodeURIComponent(foreignLink.data.token)}`), 200, 'foreign link survived the cross revoke');

    // A limited link joins exactly maxUses members, then refuses honestly.
    const limited = await request(`/api/servers/${workspace.id}/join-links`, { method: 'POST', ...scoped(owner.accessToken, workspace.id, { body: { maxUses: 1 } }) });
    expectStatus(limited, 200, 'limited link create');
    expectStatus(await request('/api/auth/accept-invite', { method: 'POST', token: outsider.accessToken, body: { token: limited.data.token } }), 200, 'first use joins');
    const exhausted = await request('/api/auth/accept-invite', { method: 'POST', token: joiner2.accessToken, body: { token: limited.data.token } });
    expectStatus(exhausted, 400, 'exhausted link refuses');
    assert.equal(exhausted.data?.error, 'This invite has already reached its usage limit');
    expectStatus(await request(`/api/auth/invite-info?token=${encodeURIComponent(limited.data.token)}`), 404, 'exhausted link stops previewing');

    // Owner revocation kills the link and removes it from management.
    const revoked = await request(`/api/servers/${workspace.id}/join-links/${linkId}`, { method: 'DELETE', ...scoped(owner.accessToken, workspace.id) });
    expectStatus(revoked, 200, 'revoke join link');
    assert.deepEqual(revoked.data, { ok: true });
    const listed = await request(`/api/servers/${workspace.id}/join-links`, scoped(owner.accessToken));
    expectStatus(listed, 200, 'list after revoke');
    assert.equal(listed.data.filter(l => l.id === linkId).length, 0, 'revoked link is unlisted');
    expectStatus(await request(`/api/auth/invite-info?token=${encodeURIComponent(joinToken)}`), 404, 'revoked link stops previewing');
    const revokedAccept = await request('/api/auth/accept-invite', { method: 'POST', token: joiner2.accessToken, body: { token: joinToken } });
    expectStatus(revokedAccept, 400, 'revoked link refuses');
    assert.equal(revokedAccept.data?.error, 'This invite has been revoked');

    // Unsupported methods answer 405 after the gates, with Allow.
    const method = await request(`/api/servers/${workspace.id}/join-links`, { method: 'PUT', ...scoped(owner.accessToken, workspace.id) });
    expectStatus(method, 405, '405 with Allow');
    const allow = method.headers?.get?.('Allow') ?? '';
    assert.match(allow, /GET/, 'Allow advertises GET');
    assert.match(allow, /POST/, 'Allow advertises POST');
  });

  return passed;
}
