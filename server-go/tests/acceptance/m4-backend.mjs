// M4 backend real-process acceptance: human messaging, threads, DMs,
// reactions, readstate, Inbox/Done and Activity snapshot/difference against a
// real Go server process with disposable data. Pinned to the frozen contracts
// (docs/phase-4-messaging.md, docs/m4-compatibility-contract.md,
// docs/m4-activity-readstate-contract.md) and to the pinned original TS/Web
// sources executed through tests/acceptance/m4-reference/exec-original.mjs.
//
// Every fixture comes from real flows: accounts from register + private
// outbox verification, workspace from POST /api/servers, the second/third
// members from a real join link, channels from POST /api/channels. No SQL
// seeding, no seeded credentials, no secrets logged. Message send volume per
// user stays far below the frozen 60-writes/60s shared v1/v2/reaction bucket
// on purpose (the dedicated rate-limit suite owns that behavior).
//
// Standalone run (isolated, disposable):  node tests/acceptance/m4-backend.mjs
// Parent integration: import { verifyM4Backend } from './m4-backend.mjs' and
// call it from run.mjs with the same { origin, data, start, stop, capture,
// executable, env } shape the other verify* suites receive. This file never
// edits shared runners and never starts the Web UI or the TS server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createVerifiedAccount, createWorkspace, expectStatus, expectUUID, httpClient,
} from './m3-harness.mjs';
import { loadOriginalModules } from './m4-reference/exec-original.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const UINT64_RE = /^(0|[1-9][0-9]*)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Populated from the pinned original manifest inside verifyM4Backend so the
// canonical required-field gate is single-sourced from the frozen baseline.
let CANONICAL_REQUIRED = ['channelId', 'content', 'createdAt', 'id', 'messageType',
  'randomId', 'senderId', 'senderType', 'seq', 'threadId'];

// ---------------------------------------------------------------------------
// Frozen-wire helpers (expectations derived from pinned original sources).
// ---------------------------------------------------------------------------

function assertCanonicalRequiredFields(message, context) {
  // canonicalRequired (canonicalMessageManifest.ts:97-109): present on every
  // producer surface; absence is schema-invalid and must fail closed.
  for (const field of CANONICAL_REQUIRED) {
    assert.ok(field in message, `${context}: canonical required field "${field}" must be present`);
  }
  for (const field of ['channelId', 'content', 'createdAt', 'id', 'messageType', 'senderId', 'senderType']) {
    assert.equal(typeof message[field], 'string', `${context}: ${field} must be a string`);
  }
  assert.ok(Number.isSafeInteger(message.seq) && message.seq > 0,
    `${context}: seq must be a positive safe integer (wire is a JS number)`);
  assert.ok(message.randomId === null || typeof message.randomId === 'string', `${context}: randomId is string|null`);
  assert.ok(message.threadId === null || typeof message.threadId === 'string', `${context}: threadId is string|null`);
  assert.ok(!Number.isNaN(Date.parse(message.createdAt)), `${context}: createdAt must parse as a timestamp`);
}

function assertMessageWindowShape(window, scope, context) {
  // Frozen MessagePage.messageWindow (compat contract §3.3; messages.ts
  // 1145-1153; messageService.ts listMessagesWithCoverage).
  assert.equal(window.schemaVersion, 1, `${context}: messageWindow.schemaVersion`);
  assert.equal(window.domain, 'receiver_visible_messages_v1', `${context}: messageWindow.domain`);
  assert.equal(window.serverId, scope.server, `${context}: messageWindow.serverId`);
  assert.equal(window.receiverKind, 'user', `${context}: messageWindow.receiverKind`);
  assert.equal(window.receiverId, scope.user, `${context}: messageWindow.receiverId`);
  assert.equal(window.scopeId, scope.channel, `${context}: messageWindow.scopeId`);
  for (const field of ['coveredAfterSeq', 'coveredFromSeq', 'coveredThroughSeq', 'remoteHighWaterSeq']) {
    assert.ok(Number.isSafeInteger(window[field]) && window[field] >= 0,
      `${context}: messageWindow.${field} must be a non-negative safe integer`);
  }
  assert.equal(typeof window.hasGap, 'boolean', `${context}: messageWindow.hasGap`);
  assert.equal(typeof window.hasNewer, 'boolean', `${context}: messageWindow.hasNewer`);
  assert.equal(typeof window.completeThroughLatest, 'boolean', `${context}: messageWindow.completeThroughLatest`);
}

function assertActivityScope(scope, expected, context) {
  assert.deepEqual(Object.keys(scope).sort(), ['filter', 'principalId', 'serverId', 'windowId'], `${context}: scope keys`);
  assert.equal(scope.serverId, expected.server, `${context}: scope.serverId`);
  assert.equal(scope.principalId, expected.user, `${context}: scope.principalId`);
  assert.equal(scope.filter, expected.filter, `${context}: scope.filter`);
  assert.equal(scope.windowId, 'main', `${context}: scope.windowId`);
}

function assertActivityEnvelopeCommon(body, expected, context) {
  assert.equal(body.requestId, expected.requestId, `${context}: requestId echoed`);
  assertActivityScope(body.scope, expected, context);
  // The generated Activity v1 contract is discriminated: snapshot and
  // notModified carry watermark; difference carries fromSeq/toSeq instead.
  const frontierField = body.type === 'difference' ? 'toSeq' : 'watermark';
  const fields = ['epoch', frontierField, 'activityVersion'];
  if (body.type === 'difference') {
    fields.push('fromSeq');
    assert.ok(!('watermark' in body), `${context}: difference does not invent a snapshot watermark field`);
  }
  for (const field of fields) {
    assert.match(body[field] ?? '', UINT64_RE, `${context}: ${field} must be a canonical uint64 decimal string`);
  }
  assert.equal(body.activityVersion, body[frontierField], `${context}: activityVersion tracks the scope frontier`);
}

// ActivityRowCommon + row kinds (activity-v1/activity-sync.tsp): every
// seq-ish field is a canonical UInt64 decimal string, never a JS number.
function assertActivityRow(row, context) {
  assert.ok(['channel', 'dm', 'thread'].includes(row.type), `${context}: row type discriminator`);
  assert.equal(typeof row.rowId, 'string', `${context}: rowId`);
  for (const field of ['rowVersion', 'latestActivitySeq', 'maxReadSeq', 'readStateVersion']) {
    assert.match(row[field] ?? '', UINT64_RE, `${context}: ${field} must be a canonical uint64 string`);
  }
  assert.equal(typeof row.lastActivityAt, 'string', `${context}: lastActivityAt`);
  assert.ok(Number.isInteger(row.unreadCount) && row.unreadCount >= 0, `${context}: unreadCount`);
  assert.equal(typeof row.hasMention, 'boolean', `${context}: hasMention`);
  if (row.type === 'thread') {
    assert.equal(typeof row.threadChannelId, 'string', `${context}: thread row threadChannelId`);
    assert.equal(typeof row.parentMessageId, 'string', `${context}: thread row parentMessageId`);
    assert.equal(typeof row.parentChannelId, 'string', `${context}: thread row parentChannelId`);
  } else {
    assert.equal(typeof row.channelId, 'string', `${context}: channel/dm row channelId`);
  }
}

function assertThreadSummary(summary, context) {
  // ThreadSummaryResult (channelService.ts:6877-6885).
  for (const field of ['threadChannelId', 'replyCount', 'lastReplyAt', 'participantIds', 'unreadCount', 'firstUnreadMessageId', 'latestReplies']) {
    assert.ok(field in summary, `${context}: thread summary field "${field}"`);
  }
  assert.ok(Number.isInteger(summary.replyCount) && summary.replyCount >= 0, `${context}: replyCount`);
  assert.ok(Array.isArray(summary.participantIds), `${context}: participantIds`);
}

// ---------------------------------------------------------------------------
// The acceptance suite.
// ---------------------------------------------------------------------------

export async function verifyM4Backend({ origin, data, start, stop, capture, executable, env }) {
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M4 backend ${name}`); };

  // Pinned original consumers, loaded once. A failure here means the frozen
  // baseline drifted, which must block the suite rather than fake a pass.
  const originals = await loadOriginalModules();
  CANONICAL_REQUIRED = originals.canonicalManifest.CANONICAL_REQUIRED_MESSAGE_FIELDS;

  // ---- real-flow fixture --------------------------------------------------
  const alice = await createVerifiedAccount(request, maildir, 'm4alice');
  const bob = await createVerifiedAccount(request, maildir, 'm4bob');
  const carol = await createVerifiedAccount(request, maildir, 'm4carol');
  const stranger = await createVerifiedAccount(request, maildir, 'm4stranger');
  // The M3 harness intentionally returns the original signup response. Its
  // user.name is the pre-profile placeholder, not the newly chosen handle.
  // M4 structured mentions require the current directory binding.
  for (const account of [alice, bob, carol, stranger]) {
    const me = await request('/api/auth/me', { token: account.accessToken });
    expectStatus(me, 200, 'M4 fixture reads the completed real profile');
    account.user = me.data;
  }
  const workspace = await createWorkspace(request, alice, 'm4main');
  const strangerWorkspace = await createWorkspace(request, stranger, 'm4other');
  const ws = workspace.id;

  // Real second/third members: a join link created by the owner and accepted
  // through /api/auth/accept-invite (the exact UI invite flow).
  const joinLink = await request(`/api/servers/${ws}/join-links`, {
    method: 'POST', token: alice.accessToken, server: ws, body: { maxUses: null, expiresAt: null },
  });
  expectStatus(joinLink, 200, 'M4 fixture join link creation');
  for (const member of [bob, carol]) {
    expectStatus(await request('/api/auth/accept-invite', {
      method: 'POST', token: member.accessToken, body: { token: joinLink.data.token },
    }), 200, 'M4 fixture member joins via the real invite link');
  }

  const publicChannel = await request('/api/channels', {
    method: 'POST', token: alice.accessToken, server: ws,
    body: { name: 'm4-general', description: 'M4 acceptance channel', visibility: 'public' },
  });
  expectStatus(publicChannel, 200, 'M4 fixture public channel');
  const pub = publicChannel.data;
  const privateChannel = await request('/api/channels', {
    method: 'POST', token: alice.accessToken, server: ws,
    body: { name: 'm4-private', visibility: 'private' },
  });
  expectStatus(privateChannel, 200, 'M4 fixture private channel');
  const priv = privateChannel.data;
  assert.equal(pub.type, 'channel', 'fixture created a real public channel');
  assert.equal(priv.type, 'private', 'fixture created a real private channel');
  expectStatus(await request(`/api/channels/${pub.id}/join`, {
    method: 'POST', token: bob.accessToken, server: ws, body: {},
  }), 200, 'bob joins the public channel before posting');
  expectStatus(await request(`/api/channels/${priv.id}/members`, {
    method: 'POST', token: alice.accessToken, server: ws, body: { userId: bob.user.id },
  }), 200, 'bob is added to the private channel');
  const agent = await request('/api/agents', {
    method: 'POST', token: alice.accessToken, server: ws,
    body: { name: 'm4-relay', description: 'external relay', external: true },
  });
  expectStatus(agent, 200, 'M4 fixture external agent');

  const asAlice = { token: alice.accessToken, server: ws };
  const asBob = { token: bob.accessToken, server: ws };
  const asCarol = { token: carol.accessToken, server: ws };
  const asStranger = { token: stranger.accessToken, server: strangerWorkspace.id };

  const send = (actor, body, version = 'v2') => request(version === 'v2' ? '/api/v2/messages' : '/api/messages', {
    method: 'POST', ...actor, body,
  });
  const history = (actor, channelId, query = '') => request(`/api/messages/channel/${channelId}${query}`, actor);
  let randomCounter = 0;
  const randomId = () => `m4-rid-${Date.now().toString(36)}-${(randomCounter++).toString(36)}`;

  // Shared fixtures produced by the ordered checks below.
  let pubRows = [];
  let channelHighWater = 0;
  let parentMessage = null;
  let threadChannelId = null;
  let dmAliceBob = null;
  let lastCommittedPubId = null;

  // ---- 1. v2 write envelope, canonical DTO, original Web fold -------------
  await check('v2 send returns the canonical envelope the original Web fold accepts', async () => {
    const rid = randomId();
    const sent = await send(asAlice, { channelId: pub.id, content: 'm4 first human message', randomId: rid });
    expectStatus(sent, 200, 'v2 send');
    // messages.ts:1749-1754: for plain human text the optional
    // pendingMentionActions/unresolvedMentionHandles members are OMITTED.
    assert.deepEqual(Object.keys(sent.data).sort(), ['message'], 'v2 envelope keys for plain text');
    const firstMessage = sent.data.message;
    assertCanonicalRequiredFields(firstMessage, 'v2 message');
    assert.equal(firstMessage.channelId, pub.id, 'channelId');
    assert.equal(firstMessage.content, 'm4 first human message', 'content round-trips verbatim');
    assert.equal(firstMessage.randomId, rid, 'randomId round-trips');
    assert.equal(firstMessage.senderType, 'user', 'senderType');
    assert.equal(firstMessage.senderId, alice.user.id, 'senderId comes from the verified principal, not the body');
    assert.equal(firstMessage.messageType, 'chat', 'messageType');
    assert.equal(firstMessage.threadId, null, 'a channel message has no thread');
    assert.equal(typeof firstMessage.senderName, 'string', 'senderName present on the enriched HTTP surface');

    // The original Web sync-core must accept this exact frame
    // (messageSyncDomain messageNewFrame shape; seq widened to bigint).
    const core = originals.core.createSyncCore({ domains: [originals.webMessageFold.createMessagesSyncDomain()] });
    const outcome = core.ingestFrame(originals.webMessageFold.MESSAGES_SYNC_DOMAIN, {
      scopeId: firstMessage.channelId, seq: BigInt(firstMessage.seq), epoch: null,
      event: { kind: 'message:new', message: firstMessage },
    });
    assert.ok(['applied', 'max_advanced'].includes(outcome.kind),
      'original message sync core accepts the real wire frame');
    const state = core.state(originals.webMessageFold.MESSAGES_SYNC_DOMAIN, firstMessage.channelId);
    const folded = state.channelMessages[firstMessage.channelId].find(row => row.id === firstMessage.id);
    assert.ok(folded, 'the folded state contains the HTTP message');
    assert.equal(folded.seq, firstMessage.seq, 'fold preserves seq');
  });

  // ---- 2. v1 alias + frozen input validation ------------------------------
  await check('v1 alias shares the use case and input validation is the frozen parser contract', async () => {
    const v1 = await send(asBob, { channelId: pub.id, content: 'm4 v1 reply', randomId: randomId() }, 'v1');
    expectStatus(v1, 200, 'v1 send');
    // messages.ts:1757-1762: v1 returns the bare Message unless pending
    // mention actions exist — never the v2 envelope.
    assert.ok(UUID_RE.test(v1.data.id), 'v1 returns a bare message DTO');
    assert.ok(!('message' in v1.data), 'v1 must not wrap in the v2 envelope');
    assertCanonicalRequiredFields(v1.data, 'v1 message');

    // Body validation pinned from parseHumanMessageCreateBody / content checks
    // (messages.ts:1663-1691) and parseRandomId (messages.ts:89-94).
    for (const [body, matcher] of [
      [{ channelId: pub.id, content: '   ' }, /Message content cannot be empty/],
      [{ channelId: pub.id, content: 'x'.repeat(32001) }, /exceeds maximum length of 32000/],
      [{ channelId: pub.id, content: 'ok', randomId: 'x'.repeat(129) }, /randomId must be a non-empty string/],
      [{ channelId: pub.id, content: 'ok', randomId: '' }, /randomId must be a non-empty string/],
      [{ channelId: 'not-a-uuid', content: 'ok' }, /Invalid message request body/],
      [{ channelId: pub.id, content: 'ok', mentions: 'nope' }, /Invalid mentions payload/],
    ]) {
      const bad = await send(asAlice, body);
      expectStatus(bad, 400, 'frozen message body validation');
      assert.match(bad.data?.error ?? '', matcher, 'frozen validation error text');
    }
    // Unsupported side effects are rejected before commit with the only code
    // the original frontend recognizes as not-enabled (compat contract §5).
    const asTask = await send(asAlice, { channelId: pub.id, content: 'taskish', asTask: true });
    expectStatus(asTask, 501, 'asTask is rejected as not implemented');
    assert.equal(asTask.data?.code, 'feature_not_implemented', 'asTask 501 code');
    const attachments = await send(asAlice, { channelId: pub.id, content: 'with file', attachmentIds: ['00000000-0000-0000-0000-000000000001'] });
    expectStatus(attachments, 501, 'attachment send is rejected as not implemented');
    assert.equal(attachments.data?.code, 'feature_not_implemented', 'attachment 501 code');
    const before = await history(asAlice, pub.id, '?limit=200');
    assert.equal(before.data.messages.filter(m => m.content === 'taskish' || m.content === 'with file').length, 0,
      'rejected side effects must leave zero rows behind');
    // Page cursor parsing (messages.ts:478-484): non-numeric cursor and
    // before+after together are 400 invalid_message_page_cursor.
    for (const query of ['?before=abc', '?after=abc', '?before=2&after=1']) {
      const bad = await history(asAlice, pub.id, query);
      expectStatus(bad, 400, `cursor validation ${query}`);
      assert.equal(bad.data?.code, 'invalid_message_page_cursor', 'cursor error code');
    }
  });

  // ---- 3. randomId idempotency across v1/v2 and conflict semantics --------
  await check('randomId replay is idempotent across v1/v2 and conflicts never leak the original row', async () => {
    const rid = randomId();
    const first = await send(asAlice, { channelId: pub.id, content: 'idempotent payload', randomId: rid });
    expectStatus(first, 200, 'original keyed send');
    const replayV1 = await send(asAlice, { channelId: pub.id, content: 'idempotent payload', randomId: rid }, 'v1');
    expectStatus(replayV1, 200, 'v1 replay of a v2 send');
    assert.equal(replayV1.data.id, first.data.message.id, 'replay returns the SAME message id');
    assert.equal(replayV1.data.seq, first.data.message.seq, 'replay returns the SAME seq');
    assert.equal(replayV1.data.randomId, rid, 'replay preserves the key');

    // Same key, different content -> 409 random_id_conflict
    // (messageService.ts:1202-1210, 2408-2413).
    const otherContent = await send(asAlice, { channelId: pub.id, content: 'different payload', randomId: rid });
    expectStatus(otherContent, 409, 'same key different content conflicts');
    assert.equal(otherContent.data?.code, 'random_id_conflict', 'conflict code');
    // Same key, different channel -> 409.
    const otherChannel = await send(asAlice, { channelId: priv.id, content: 'idempotent payload', randomId: rid });
    expectStatus(otherChannel, 409, 'same key different channel conflicts');
    assert.equal(otherChannel.data?.code, 'random_id_conflict', 'channel conflict code');

    // The idempotency scope is (sender_type, sender_id, random_id) and is NOT
    // reset per workspace (compat contract §3.1). The same sender reusing the
    // key in another workspace gets 409 and no content read-back.
    const secondSpace = await createWorkspace(request, alice, 'm4second');
    const secondChannel = await request('/api/channels', {
      method: 'POST', token: alice.accessToken, server: secondSpace.id,
      body: { name: 'm4-second', visibility: 'public' },
    });
    expectStatus(secondChannel, 200, 'second workspace channel');
    const cross = await send({ token: alice.accessToken, server: secondSpace.id }, {
      channelId: secondChannel.data.id, content: 'idempotent payload', randomId: rid,
    });
    expectStatus(cross, 409, 'cross-workspace replay with the same sender key conflicts');
    assert.equal(cross.data?.code, 'random_id_conflict', 'cross-workspace conflict code');
    assert.ok(!JSON.stringify(cross.data).includes(first.data.message.id),
      'cross-workspace conflict must not leak the original message id');

    // A different sender may use the same key: the scope is per sender.
    const bobSameKey = await send(asBob, { channelId: pub.id, content: 'bob own keyed send', randomId: rid });
    expectStatus(bobSameKey, 200, 'another sender may reuse the key');
    assert.notEqual(bobSameKey.data.message.id, first.data.message.id, 'different sender creates a distinct row');

    // Two concurrent sends with one fresh key resolve to one row.
    const concurrentKey = randomId();
    const [a, b] = await Promise.all([
      send(asAlice, { channelId: pub.id, content: 'concurrent keyed', randomId: concurrentKey }),
      send(asAlice, { channelId: pub.id, content: 'concurrent keyed', randomId: concurrentKey }),
    ]);
    expectStatus(a, 200, 'concurrent keyed send A');
    expectStatus(b, 200, 'concurrent keyed send B');
    assert.equal(a.data.message.id, b.data.message.id, 'concurrent same-key sends return the same message');
    const all = await history(asAlice, pub.id, '?limit=200');
    expectStatus(all, 200, 'history for idempotency count');
    assert.equal(all.data.messages.filter(m => m.randomId === concurrentKey).length, 1,
      'exactly one persisted row for the concurrent key');
  });

  // ---- 4. authorization and workspace/private isolation -------------------
  await check('workspace, membership and private-channel isolation hold on every M4 read path', async () => {
    // A non-member scope: the channel never exists in that scope
    // (messages.ts:1695-1698 create; 1010-1012 history).
    const strangerSend = await send(asStranger, { channelId: pub.id, content: 'intrusion' });
    expectStatus(strangerSend, 404, 'non-member scope send collapses to not-found');
    assert.equal(strangerSend.data?.error, 'Channel not found', 'create-path not-found text');
    const strangerHistory = await history(asStranger, pub.id);
    expectStatus(strangerHistory, 404, 'non-member scope history collapses to not-found');
    assert.equal(strangerHistory.data?.error, 'Channel not found or not visible', 'history path not-found text');
    const strangerSync = await request('/api/messages/sync?since_seq=0', asStranger);
    expectStatus(strangerSync, 200, 'global sync answers for the stranger own workspace');
    assert.deepEqual(strangerSync.data, [], 'a foreign workspace sync never returns workspace rows');

    // Unauthenticated and unscoped calls fail before any channel logic.
    expectStatus(await request('/api/v2/messages', { method: 'POST', body: { channelId: pub.id, content: 'x' } }), 401, 'unauthenticated send');
    expectStatus(await request(`/api/messages/channel/${pub.id}`, { token: alice.accessToken }), 400, 'history without X-Server-Id');

    // Private channel: a member reads; a never-member gets 404. GET history
    // does not persist a receiver witness. Original channelService.ts:4670+
    // deliberately excludes deleted membership rows from historical proof.
    expectStatus(await history(asBob, priv.id), 200, 'private member reads history');
    const carolPrivate = await history(asCarol, priv.id);
    expectStatus(carolPrivate, 404, 'never-member private read collapses to not-found');
    assert.equal(carolPrivate.data?.error, 'Channel not found or not visible', 'never-member not-found body');
    // The send route does not use the history route's 403/404 witness split:
    // original messages.ts:1694-1705 checks same-workspace existence, then
    // canUserPostToChannel => 403 with the exact join-before-post sentence.
    const neverMemberSend = await send(asCarol, { channelId: priv.id, content: 'sneak' });
    expectStatus(neverMemberSend, 403, 'never-member private send');
    assert.equal(neverMemberSend.data?.error, 'You must join this channel to send messages');
    expectStatus(await request(`/api/channels/${priv.id}/members/user/${bob.user.id}`, {
      method: 'DELETE', ...asAlice, body: {},
    }), 200, 'owner removes bob from the private channel');
    const removedHistory = await history(asBob, priv.id);
    expectStatus(removedHistory, 404, 'removed member without receiver-owned residue stays undisclosed');
    assert.equal(removedHistory.data?.error, 'Channel not found or not visible', 'no-residue denial text');
    const removedSend = await send(asBob, { channelId: priv.id, content: 'after removal' });
    expectStatus(removedSend, 403, 'removed member cannot send');
    assert.match(removedSend.data?.error ?? '', /join this channel|do not have access/i, 'removal denial text');

    // A member who has not joined the public channel cannot post
    // (messages.ts:1701-1705) but still reads the public history.
    expectStatus(await history(asCarol, pub.id), 200, 'public channel history is workspace-readable');
    const carolSend = await send(asCarol, { channelId: pub.id, content: 'not joined' });
    expectStatus(carolSend, 403, 'posting requires real channel membership');
    assert.equal(carolSend.data?.error, 'You must join this channel to send messages', 'join-before-post text');
  });

  // ---- 5. real human mention ----------------------------------------------
  await check('structured human mention persists the directory identity and drives mention projections', async () => {
    const bobBefore = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(bobBefore, 200, 'bob unread summary before mention');
    const unreadBefore = bobBefore.data.channels[pub.id]?.unreadCount ?? 0;

    const beforeForged = (await history(asAlice, pub.id, '?limit=200')).data.messages.length;
    const forgedMention = await send(asAlice, {
      channelId: pub.id, content: 'forged mention binding',
      mentions: [{ type: 'user', id: bob.user.id, name: 'impersonated-handle' }],
    });
    // A mismatched structured id/handle binding is rejected, not silently
    // rewritten into a successful send. A legitimate UI selection supplies
    // the canonical directory handle. Both paths must prevent impersonation.
    expectStatus(forgedMention, 400, 'forged structured mention binding');
    assert.equal((await history(asAlice, pub.id, '?limit=200')).data.messages.length, beforeForged,
      'rejected mention binding has no message side effect');
    const mentioned = await send(asAlice, {
      channelId: pub.id,
      content: `heads up @${bob.user.name} please review`,
      mentions: [{ type: 'user', id: bob.user.id, name: bob.user.name }],
    });
    expectStatus(mentioned, 200, 'mention send');
    assert.equal(mentioned.data.message.mentions.length, 1, 'exactly one persisted mention');
    const mention = mentioned.data.message.mentions[0];
    assert.equal(mention.type, 'user', 'mention type');
    assert.equal(mention.id, bob.user.id, 'mention target id is the directory identity');
    assert.equal(mention.name, bob.user.name, 'mention name is projected from the directory, not the client payload');

    const bobAfter = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(bobAfter, 200, 'bob unread summary after mention');
    const entry = bobAfter.data.channels[pub.id];
    assert.ok(entry, 'the mentioned channel appears in the unread summary');
    assert.equal(entry.unreadCount, unreadBefore + 1, 'the mention message adds exactly one unread');
    assert.equal(entry.hasMention, true, 'unread summary entry reports hasMention');
    assert.equal(entry.hasAnyMention, true, 'unread summary entry reports hasAnyMention');

    // M5 implements Agent mentions. This Agent has not joined the ordinary
    // public channel, so its lack of reply authority still rejects the
    // entire write. Preserve the M4 atomic-rejection assertion, not its
    // obsolete feature-not-implemented status.
    const pubRowsBefore = (await history(asAlice, pub.id, '?limit=200')).data.messages.length;
    const agentMention = await send(asAlice, {
      channelId: pub.id, content: 'hey relay',
      mentions: [{ type: 'agent', id: agent.data.id, name: 'm4-relay' }],
    });
    expectStatus(agentMention, 400, 'agent mention without reply authority is rejected');
    assert.equal(agentMention.data?.error, 'Mention target cannot receive messages in this conversation',
      'Agent mention rejection reflects current conversation authority');
    const mixed = await send(asAlice, {
      channelId: pub.id, content: 'mixed mention',
      mentions: [
        { type: 'user', id: bob.user.id, name: bob.user.name },
        { type: 'agent', id: agent.data.id, name: 'm4-relay' },
      ],
    });
    expectStatus(mixed, 400, 'mixed user+unauthorized-agent mention is rejected whole');
    assert.equal(mixed.data?.error, 'Mention target cannot receive messages in this conversation',
      'mixed mentions preserve the same invalid-recipient refusal');
    assert.equal((await history(asAlice, pub.id, '?limit=200')).data.messages.length, pubRowsBefore,
      'no partial row survived the rejected agent mentions');

    // A structured mention targeting a user outside the workspace is an
    // explicit error, not receive-then-ignore (compat contract §3.1 forbids
    // the implementer from choosing silent acceptance).
    const invalid = await send(asAlice, {
      channelId: pub.id, content: 'foreign target',
      mentions: [{ type: 'user', id: stranger.user.id, name: 'stranger' }],
    });
    expectStatus(invalid, 400, 'non-member mention target is rejected');
    assert.equal((await history(asAlice, pub.id, '?limit=200')).data.messages.length, pubRowsBefore,
      'no row persisted for the invalid mention');
  });

  // ---- 6. self-DM and two human DMs ---------------------------------------
  await check('self-DM and two human DMs are unique, participant-only and shape-exact', async () => {
    const bothInputs = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: bob.user.id, agentId: agent.data.id } });
    expectStatus(bothInputs, 400, 'userId and agentId are mutually exclusive');
    assert.equal(bothInputs.data?.error, 'Cannot provide both agentId and userId', 'both-inputs text');
    const noInput = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: {} });
    expectStatus(noInput, 400, 'one of userId/agentId is required');
    assert.equal(noInput.data?.error, 'Either agentId or userId is required', 'missing-input text');

    const selfDm = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: alice.user.id } });
    expectStatus(selfDm, 200, 'self-DM creation');
    assert.equal(selfDm.data.type, 'dm', 'self-DM type');
    assert.equal(selfDm.data.peerType, 'user', 'self-DM peerType');
    assert.equal(selfDm.data.peerId, alice.user.id, 'self-DM peer is the caller');
    assert.deepEqual(selfDm.data.readState, { kind: 'absent' },
      'fresh self-DM frontier is the exact absent union, not null or zero-filled');

    dmAliceBob = (await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: bob.user.id } })).data;
    assert.ok(dmAliceBob && dmAliceBob.id, 'alice->bob DM creation');
    assert.equal(dmAliceBob.type, 'dm', 'DM type');
    assert.equal(dmAliceBob.peerType, 'user', 'DM peerType');
    assert.equal(dmAliceBob.peerId, bob.user.id, 'DM peer is the other user');
    const dmAliceCarol = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: carol.user.id } });
    expectStatus(dmAliceCarol, 200, 'alice->carol DM creation');

    // Pair uniqueness from both sides and on re-open.
    const againFromAlice = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: bob.user.id } });
    expectStatus(againFromAlice, 200, 'DM re-ensure by alice');
    assert.equal(againFromAlice.data.id, dmAliceBob.id, 're-open returns the same DM channel');
    const fromBob = await request('/api/channels/dm', { method: 'POST', ...asBob, body: { userId: alice.user.id } });
    expectStatus(fromBob, 200, 'DM ensure from bob side');
    assert.equal(fromBob.data.id, dmAliceBob.id, 'pair identity is direction independent');
    assert.deepEqual(dmAliceBob.readState, { kind: 'absent' }, 'fresh DM creator frontier');
    assert.deepEqual(fromBob.data.readState, { kind: 'absent' }, 'fresh peer frontier');

    // M5 replaces the former Agent-DM 501 with a participant-scoped,
    // canonical Agent conversation. Human-pair contracts above stay intact.
    const dmListBefore = await request('/api/channels/dm', asAlice);
    expectStatus(dmListBefore, 200, 'DM list before agent branch');
    const agentDm = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { agentId: agent.data.id } });
    expectStatus(agentDm, 200, 'Agent DM is implemented');
    assert.equal(agentDm.data.peerType, 'agent', 'Agent DM uses the Agent peer union');
    assert.equal(agentDm.data.peerId, agent.data.id, 'Agent DM keeps the real peer identity');
    const agentDmAgain = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { agentId: agent.data.id } });
    expectStatus(agentDmAgain, 200, 'Agent DM re-open');
    assert.equal(agentDmAgain.data.id, agentDm.data.id, 'Agent DM pair is canonical');
    const dmListAfter = await request('/api/channels/dm', asAlice);
    expectStatus(dmListAfter, 200, 'DM list after agent branch');
    assert.equal(dmListAfter.data.length, dmListBefore.data.length + 1, 'one Agent conversation is created');
    assert.equal(dmListAfter.data.find(dm => dm.id === agentDm.data.id)?.peerType, 'agent',
      'Agent peer shape survives DM listing');
    expectStatus(await history(asBob, agentDm.data.id), 404, 'unrelated human cannot read the Agent DM');
    const invalidAgentDm = await request('/api/channels/dm', {
      method: 'POST', ...asAlice, body: { agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });
    expectStatus(invalidAgentDm, 404, 'unknown Agent target is rejected');
    assert.equal((await request('/api/channels/dm', asAlice)).data.length, dmListAfter.data.length,
      'an invalid Agent target never creates a conversation');

    // A workspace outsider cannot become a DM target (channels.ts:724-729).
    const outsider = await request('/api/channels/dm', { method: 'POST', ...asAlice, body: { userId: stranger.user.id } });
    expectStatus(outsider, 400, 'non-member DM target');
    assert.equal(outsider.data?.error, 'User is not a member of this server', 'non-member target text');

    // Real content in the DMs; participant-only visibility.
    const selfNote = await send(asAlice, { channelId: selfDm.data.id, content: 'note to self', randomId: randomId() });
    expectStatus(selfNote, 200, 'self-DM message');
    expectStatus(await history(asAlice, selfDm.data.id), 200, 'self-DM history for the owner');
    expectStatus(await history(asBob, selfDm.data.id), 404, 'self-DM is invisible to others');
    const dmMessage = await send(asAlice, { channelId: dmAliceBob.id, content: 'dm hello bob', randomId: randomId() });
    expectStatus(dmMessage, 200, 'human DM message');
    expectStatus(await history(asBob, dmAliceBob.id), 200, 'DM participant history');
    expectStatus(await history(asCarol, dmAliceBob.id), 404, 'DM is participant-only');

    // Own messages never create unread for the sender.
    const aliceUnread = await request('/api/channels/unread?summary=1', asAlice);
    expectStatus(aliceUnread, 200, 'alice unread summary');
    assert.ok(!aliceUnread.data.channels[selfDm.data.id]
      || aliceUnread.data.channels[selfDm.data.id].unreadCount === 0,
      'own self-DM messages never count as unread');
    const bobUnread = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(bobUnread, 200, 'bob unread summary for the DM');
    assert.equal(bobUnread.data.channels[dmAliceBob.id]?.unreadCount ?? 0, 1, 'the DM message is unread for bob');

    // DM lists are per viewer.
    const bobDms = await request('/api/channels/dm', asBob);
    expectStatus(bobDms, 200, 'bob DM list');
    const bobDmIds = bobDms.data.map(dm => dm.id);
    assert.ok(bobDmIds.includes(dmAliceBob.id), 'bob sees the alice DM');
    assert.ok(!bobDmIds.includes(dmAliceCarol.data.id) && !bobDmIds.includes(selfDm.data.id),
      'bob does not see conversations he is not part of');
    const strangerDms = await request('/api/channels/dm', asStranger);
    expectStatus(strangerDms, 200, 'stranger DM list');
    assert.equal(strangerDms.data.some(dm => dm.id === dmAliceBob.id), false,
      'a foreign workspace sees none of these DMs');

    // Independent #632 union contract: expected fields/types come from the
    // protocol, never from calling the production presenter. Real HTTP reads
    // create the row, and create/re-open + list must agree for each viewer.
    assert.deepEqual(bobDms.data.find(dm => dm.id === dmAliceBob.id).readState,
      { kind: 'absent' }, 'a message alone does not create the receiver read row');
    const bobRead = await request(`/api/channels/${dmAliceBob.id}/read`, {
      method: 'POST', ...asBob, body: { seq: dmMessage.data.message.seq },
    });
    expectStatus(bobRead, 200, 'DM first read');
    assert.equal(bobRead.data.readStateVersion, 1, 'first read creates version one');
    const expectedReadFrontier = {
      kind: 'present', readStateVersion: 1,
      maxReadSeq: String(dmMessage.data.message.seq),
      latestActivity: { messageId: dmMessage.data.message.id, seq: String(dmMessage.data.message.seq) },
    };
    const bobReopened = await request('/api/channels/dm', {
      method: 'POST', ...asBob, body: { userId: alice.user.id },
    });
    expectStatus(bobReopened, 200, 'read DM re-open');
    assert.deepEqual(bobReopened.data.readState, expectedReadFrontier,
      'create/re-open preserves present union with decimal-string seqs');
    const bobReadList = await request('/api/channels/dm', asBob);
    expectStatus(bobReadList, 200, 'read DM list');
    assert.deepEqual(bobReadList.data.find(dm => dm.id === dmAliceBob.id).readState,
      expectedReadFrontier, 'list preserves the same independently checked present union');
    const aliceReadList = await request('/api/channels/dm', asAlice);
    expectStatus(aliceReadList, 200, 'other viewer DM list');
    assert.deepEqual(aliceReadList.data.find(dm => dm.id === dmAliceBob.id).readState,
      { kind: 'absent' }, 'bob read state never leaks into alice frontier');

    // Restore an unread message for the downstream Inbox tests, and prove a
    // present row remains present when its frontier rewinds; it is not absent.
    const bobUnreadAgain = await request(`/api/channels/${dmAliceBob.id}/unread`, {
      method: 'POST', ...asBob, body: {},
    });
    expectStatus(bobUnreadAgain, 200, 'DM mark unread after read');
    assert.equal(bobUnreadAgain.data.readStateVersion, 2, 'unread advances version');
    assert.equal(bobUnreadAgain.data.unreadCount, 1, 'the sole incoming DM is unread again');
    const bobRewoundList = await request('/api/channels/dm', asBob);
    expectStatus(bobRewoundList, 200, 'rewound DM list');
    assert.deepEqual(bobRewoundList.data.find(dm => dm.id === dmAliceBob.id).readState, {
      ...expectedReadFrontier, readStateVersion: 2,
      maxReadSeq: String(bobUnreadAgain.data.maxReadSeq),
    }, 'rewound row keeps present union and newest activity pair');
  });

  // ---- 7. threads: replies, follow distinction ----------------------------
  await check('thread ensure/reply/follow distinction matches the frozen thread contract', async () => {
    const parent = await send(asAlice, { channelId: pub.id, content: 'thread root message', randomId: randomId() });
    expectStatus(parent, 200, 'thread parent send');
    parentMessage = parent.data.message;

    const created = await request(`/api/channels/${pub.id}/threads`, {
      method: 'POST', ...asAlice, body: { parentMessageId: parentMessage.id, content: 'first reply from alice' },
    });
    expectStatus(created, 200, 'thread ensure with first reply');
    // channels.ts:4042-4043: {threadChannelId, ...info}.
    expectUUID(created.data.threadChannelId, 'thread channel id');
    assert.notEqual(created.data.threadChannelId, parentMessage.id, 'thread channel is distinct from the parent message');
    assert.equal(created.data.replyCount, 1, 'first reply counted');
    assert.ok(created.data.lastReplyAt, 'lastReplyAt set');
    assert.deepEqual(created.data.participantIds, [alice.user.id], 'participants after first reply');
    threadChannelId = created.data.threadChannelId;

    // The parent message projection points at the thread channel
    // (canonical threadId semantics, compat contract §3.2).
    const page = await history(asAlice, pub.id);
    expectStatus(page, 200, 'parent channel history');
    const projected = page.data.messages.find(m => m.id === parentMessage.id);
    assert.ok(projected, 'parent present in channel history');
    assert.equal(projected.threadId, threadChannelId, 'parent.threadId is the thread channel id');
    assert.ok(page.data.threadSummariesByParentMessageId[parentMessage.id], 'page rides the thread summary');

    // Bob replies: reply.channelId is the thread channel, reply.threadId null.
    const reply = await send(asBob, { channelId: threadChannelId, content: 'second reply from bob', randomId: randomId() });
    expectStatus(reply, 200, 'thread reply send');
    assert.equal(reply.data.message.channelId, threadChannelId, 'reply lives in the thread channel');
    assert.equal(reply.data.message.threadId, null, 'a reply has no nested threadId');

    // Thread info and summaries reflect real counts, never a constant {}.
    const info = await request(`/api/channels/${pub.id}/threads/${parentMessage.id}`, asBob);
    expectStatus(info, 200, 'thread info by parent message');
    assert.equal(info.data.replyCount, 2, 'reply count is the real row count');
    assert.deepEqual(info.data.participantIds.sort(), [alice.user.id, bob.user.id].sort(), 'both repliers are participants');
    const summaries = await request(`/api/channels/${pub.id}/threads`, asBob);
    expectStatus(summaries, 200, 'channel thread summaries');
    assert.ok(summaries.data[parentMessage.id], 'summary map has the parent entry');
    assertThreadSummary(summaries.data[parentMessage.id], 'thread summary');
    assert.equal(summaries.data[parentMessage.id].replyCount, 2, 'summary reply count');

    // Nested threads are rejected — but only reported to callers who can
    // already see the channel (channels.ts:4008-4013).
    const nested = await request(`/api/channels/${threadChannelId}/threads`, {
      method: 'POST', ...asBob, body: { parentMessageId: reply.data.message.id },
    });
    expectStatus(nested, 400, 'nested thread rejected');
    assert.equal(nested.data?.error, 'Cannot create a thread inside a thread', 'nested-thread text');

    // Author/replier auto-follow: both see the thread in followed lists.
    for (const [actor, label] of [[asAlice, 'alice'], [asBob, 'bob']]) {
      const followed = await request('/api/channels/threads/followed', actor);
      expectStatus(followed, 200, `followed threads for ${label}`);
      const row = followed.data.threads.find(t => t.threadChannelId === threadChannelId);
      assert.ok(row, `replier ${label} auto-follows the thread`);
      assert.equal(row.replyCount, 2, 'followed row carries the real reply count');
      assert.equal(row.parentMessageId, parentMessage.id, 'followed row parent');
    }

    // Unfollow keeps history readable (read access != subscription interest).
    expectStatus(await request('/api/channels/threads/unfollow', {
      method: 'POST', ...asBob, body: { threadChannelId },
    }), 200, 'bob unfollows');
    const followedAfter = await request('/api/channels/threads/followed', asBob);
    expectStatus(followedAfter, 200, 'followed after unfollow');
    assert.ok(!followedAfter.data.threads.some(t => t.threadChannelId === threadChannelId),
      'unfollowed thread leaves the followed list');
    const threadHistory = await history(asBob, threadChannelId);
    expectStatus(threadHistory, 200, 'unfollowed but readable thread history still works');
    assert.equal(threadHistory.data.messages.length, 2, 'thread history still returns the replies');

    // Explicit follow: parent message is checked, thread identity is stable.
    expectStatus(await request('/api/channels/threads/follow', {
      method: 'POST', ...asBob, body: { parentMessageId: parentMessage.id },
    }), 200, 'explicit refollow');
    const refollowed = await request('/api/channels/threads/followed', asBob);
    expectStatus(refollowed, 200, 'followed after refollow');
    assert.ok(refollowed.data.threads.some(t => t.threadChannelId === threadChannelId), 'thread followed again');
    expectStatus(await request('/api/channels/threads/follow', {
      method: 'POST', ...asBob, body: { parentMessageId: '00000000-0000-0000-0000-000000000002' },
    }), 404, 'follow of a missing parent message');
    expectStatus(await request('/api/channels/threads/unfollow', {
      method: 'POST', ...asBob, body: { threadChannelId },
    }), 200, 'unfollow again for the sync-interest check');
  });

  // ---- 8. reactions and viewer state --------------------------------------
  await check('reactions are idempotent, aggregated and viewer state is private', async () => {
    const target = parentMessage.id;
    const add = await request(`/api/messages/${target}/reactions`, {
      method: 'POST', ...asAlice, body: { emoji: '👍' },
    });
    expectStatus(add, 200, 'alice adds a reaction');
    // Response: updated message projection + private reactionViewer snapshot
    // (messages.ts:2036-2045; messageReactionService.ts:224-235).
    assert.equal(add.data.reactionViewer.serverId, ws, 'viewer snapshot serverId');
    assert.equal(add.data.reactionViewer.messageId, target, 'viewer snapshot messageId');
    assert.ok(add.data.reactionViewer.viewerVersion >= 1, 'viewer version bumped');
    assert.deepEqual(add.data.reactionViewer.reactedEmojis, ['👍'], 'viewer reacted emojis');
    const mine = add.data.reactions.find(r => r.emoji === '👍');
    assert.ok(mine, 'aggregate reaction present on the message');
    assert.equal(mine.count, 1, 'aggregate count after one reactor');
    assert.deepEqual(mine.reactorIds, [alice.user.id], 'reactor ids');

    expectStatus(await request(`/api/messages/${target}/reactions`, {
      method: 'POST', ...asBob, body: { emoji: '👍' },
    }), 200, 'bob adds the same emoji');
    const afterTwo = await request(`/api/messages/${target}/reactions`, {
      method: 'POST', ...asAlice, body: { emoji: '👍' },
    });
    expectStatus(afterTwo, 200, 'idempotent re-add');
    const both = afterTwo.data.reactions.find(r => r.emoji === '👍');
    assert.equal(both.count, 2, 'idempotent add does not double count');
    assert.deepEqual(both.reactorIds.sort(), [alice.user.id, bob.user.id].sort(), 'both reactors listed');

    const viewer = await request(`/api/messages/${target}/reactions/viewer`, asBob);
    expectStatus(viewer, 200, 'bob viewer snapshot');
    assert.deepEqual(viewer.data.reactedEmojis, ['👍'], 'viewer snapshot emojis for bob');

    const actors = await request(`/api/messages/${target}/reactions/actors?emoji=${encodeURIComponent('👍')}`, asBob);
    expectStatus(actors, 200, 'reaction actors page');
    // messages.ts:1917-1930 frozen envelope.
    for (const key of ['discussion', 'discussionVersion', 'actors', 'nextCursor']) {
      assert.ok(key in actors.data, `actors envelope key ${key}`);
    }
    assert.equal(actors.data.actors.length, 2, 'both actors listed');
    assert.ok(actors.data.actors.every(a => a.actorRef?.kind === 'user' && UUID_RE.test(a.actorRef?.id ?? '')),
      'actor refs are typed and identifiable');

    expectStatus(await request(`/api/messages/${target}/reactions`, {
      method: 'DELETE', ...asBob, body: { emoji: '👍' },
    }), 200, 'bob removes his reaction');
    const afterRemove = await request(`/api/messages/${target}/reactions/viewer`, asBob);
    expectStatus(afterRemove, 200, 'viewer snapshot after remove');
    assert.deepEqual(afterRemove.data.reactedEmojis, [], 'removal clears the private viewer state');
    const finalPage = await history(asAlice, pub.id, '?limit=200');
    const finalTarget = finalPage.data.messages.find(m => m.id === target);
    assert.equal(finalTarget.reactions.find(r => r.emoji === '👍').count, 1, 'aggregate reflects the removal');

    expectStatus(await request(`/api/messages/${target}/reactions`, {
      method: 'POST', ...asAlice, body: { emoji: 'has space' },
    }), 400, 'invalid emoji rejected');
    assert.equal((await request(`/api/messages/${target}/reactions`, {
      method: 'POST', ...asStranger, body: { emoji: '👍' },
    })).status, 404, 'stranger reaction collapses to not-found');
  });

  // ---- 9. pagination, coverage windows, sync ------------------------------
  await check('history paging, messageWindow coverage and sync recovery are exact', async () => {
    // Deterministic bulk: 12 more messages alternating senders.
    for (let i = 1; i <= 12; i++) {
      const actor = i % 2 === 1 ? asBob : asAlice;
      const sent = await send(actor, { channelId: pub.id, content: `pagination ${String(i).padStart(2, '0')}`, randomId: randomId() });
      expectStatus(sent, 200, `pagination send ${i}`);
    }
    const full = await history(asBob, pub.id, '?limit=200');
    expectStatus(full, 200, 'full channel history');
    pubRows = full.data.messages;
    assert.ok(pubRows.length > 17, 'channel accumulated enough rows to page');
    const seqs = pubRows.map(m => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'history rows are seq ascending regardless of direction');
    channelHighWater = seqs[seqs.length - 1];
    assert.equal(full.data.messageWindow.remoteHighWaterSeq, channelHighWater, 'remoteHighWaterSeq is the channel frontier');
    assert.equal(full.data.messageWindow.completeThroughLatest, true, 'latest tail page may claim completeThroughLatest');
    assert.equal(full.data.messageWindow.hasNewer, false, 'no newer rows exist');
    assertMessageWindowShape(full.data.messageWindow, { server: ws, user: bob.user.id, channel: pub.id }, 'full page');

    // Latest partial tail.
    const tail = await history(asBob, pub.id, '?limit=5');
    expectStatus(tail, 200, 'latest tail page');
    assert.equal(tail.data.messages.length, 5, 'limit respected');
    const tailFirstIndex = pubRows.findIndex(m => m.seq === tail.data.messages[0].seq);
    assert.ok(tailFirstIndex > 0, 'the tail is a partial page');
    assert.equal(tail.data.messageWindow.coveredAfterSeq, pubRows[tailFirstIndex - 1].seq,
      'coveredAfterSeq is the real in-channel predecessor, not firstSeq-1');
    assert.equal(tail.data.messageWindow.coveredFromSeq, tail.data.messages[0].seq, 'coveredFromSeq');
    assert.equal(tail.data.messageWindow.coveredThroughSeq, channelHighWater, 'tail coveredThroughSeq');
    assert.equal(tail.data.messageWindow.completeThroughLatest, true, 'tail completeness');

    // Real global-seq holes exist (DM/thread writes interleaved) and the
    // window still reports the in-channel predecessor.
    const dmRows = (await history(asAlice, dmAliceBob.id, '?limit=200')).data.messages;
    const holed = pubRows.some((row, index) => index > 0
      && dmRows.some(dm => dm.seq > pubRows[index - 1].seq && dm.seq < row.seq));
    assert.ok(holed, 'fixture guarantees global seq holes inside the channel window');

    // before page: strictly older, conservative coverage flags
    // (compat contract §3.3: before/after pages conservatively mark
    // hasGap/hasNewer and never claim completeThroughLatest).
    const before = await history(asBob, pub.id, `?before=${tail.data.messages[0].seq}&limit=5`);
    expectStatus(before, 200, 'before page');
    assert.equal(before.data.messages.length, 5, 'before page size');
    assert.ok(before.data.messages.every(m => m.seq < tail.data.messages[0].seq), 'before rows strictly older');
    assert.equal(before.data.messageWindow.completeThroughLatest, false, 'before page never claims completeness');
    assert.equal(before.data.messageWindow.hasNewer, true, 'before page knows newer rows exist');
    const beforeFirstIndex = pubRows.findIndex(m => m.seq === before.data.messages[0].seq);
    assert.equal(before.data.messageWindow.coveredAfterSeq, pubRows[beforeFirstIndex - 1].seq,
      'before page coveredAfterSeq is the real predecessor');

    // after page (overlay shape).
    const anchor = pubRows[pubRows.length - 8];
    const after = await history(asBob, pub.id, `?after=${anchor.seq}&limit=3`);
    expectStatus(after, 200, 'after page');
    assert.equal(after.data.messages.length, 3, 'after page size');
    assert.ok(after.data.messages.every(m => m.seq > anchor.seq), 'after rows strictly newer');
    assert.equal(after.data.messages[0].seq, pubRows[pubRows.indexOf(anchor) + 1].seq, 'after page starts at the successor');
    assert.equal(after.data.messageWindow.completeThroughLatest, false, 'after page never claims completeness');
    assert.equal(after.data.messageWindow.hasNewer, true, 'after page knows newer rows exist');

    // Empty after page: coveredFromSeq=H+1, coveredThroughSeq=H
    // (compat contract §3.3 original empty-page semantics).
    const empty = await history(asBob, pub.id, `?after=${channelHighWater}&limit=50`);
    expectStatus(empty, 200, 'empty after page');
    assert.deepEqual(empty.data.messages, [], 'empty page has no rows');
    assert.equal(empty.data.messageWindow.coveredFromSeq, channelHighWater + 1, 'empty coveredFromSeq');
    assert.equal(empty.data.messageWindow.coveredThroughSeq, channelHighWater, 'empty coveredThroughSeq');

    // HTTP sync: bare Message[], channel-scoped and global, paged by seq.
    const syncChannel = await request(`/api/messages/sync?since_seq=0&channel_id=${pub.id}&limit=500`, asBob);
    expectStatus(syncChannel, 200, 'channel sync');
    assert.ok(Array.isArray(syncChannel.data), 'sync returns the bare array, never an envelope');
    assert.equal(syncChannel.data.length, pubRows.length, 'channel sync returns every visible row');
    const firstPage = await request(`/api/messages/sync?since_seq=0&channel_id=${pub.id}&limit=2`, asBob);
    expectStatus(firstPage, 200, 'sync first page');
    assert.equal(firstPage.data.length, 2, 'sync page limit');
    const secondPage = await request(`/api/messages/sync?since_seq=${firstPage.data[1].seq}&channel_id=${pub.id}&limit=500`, asBob);
    expectStatus(secondPage, 200, 'sync remainder');
    assert.equal(secondPage.data.length, pubRows.length - 2, 'sync paging is lossless');
    assert.deepEqual([...firstPage.data, ...secondPage.data].map(m => m.id), pubRows.map(m => m.id),
      'sync paging produces no duplicates or gaps');

    // Global sync: interest filtering, not just content authorization.
    // Bob: public + DM rows yes; the unfollowed thread and foreign-private
    // channels must not flow through the delivery stream.
    const global = await request('/api/messages/sync?since_seq=0&limit=500', asBob);
    expectStatus(global, 200, 'bob global sync');
    assert.ok(Array.isArray(global.data), 'global sync bare array');
    const allowed = new Set([pub.id, dmAliceBob.id]);
    for (const row of global.data) {
      assert.ok(allowed.has(row.channelId),
        `global sync row ${row.id} came from an unauthorized or uninterested channel ${row.channelId}`);
    }
    assert.ok(!global.data.some(m => m.channelId === threadChannelId),
      'a readable but unfollowed thread never enters sync (interest filter)');
    const threadScoped = await request(`/api/messages/sync?since_seq=0&channel_id=${threadChannelId}`, asBob);
    // The frozen contract requires the follow gate; whether the gate answers
    // 200-empty or 403/404 is an implementation surface, but no thread row may
    // ever be delivered without an active follow.
    if (threadScoped.status === 200) {
      assert.ok(Array.isArray(threadScoped.data) && threadScoped.data.length === 0,
        'unfollowed thread channel sync delivers zero rows');
    } else {
      assert.ok([403, 404].includes(threadScoped.status), 'unfollowed thread channel sync is explicitly denied');
    }
    // Carol (member, never joined) still sees public-channel rows in global
    // sync but no DM rows.
    const carolGlobal = await request('/api/messages/sync?since_seq=0&limit=500', asCarol);
    expectStatus(carolGlobal, 200, 'carol global sync');
    assert.ok(carolGlobal.data.every(m => m.channelId === pub.id),
      'carol global sync only contains server-wide public rows');
  });

  // ---- 10. read / unread / read-all ---------------------------------------
  await check('read, mark-unread and read-all are versioned, effective and bounded', async () => {
    const unreadBefore = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(unreadBefore, 200, 'unread summary before reads');
    const beforeEntry = unreadBefore.data.channels[pub.id];
    assert.ok(beforeEntry && beforeEntry.unreadCount > 0, 'bob starts with unread rows in the public channel');

    const midSeq = pubRows[Math.floor(pubRows.length / 2)].seq;
    const read = await request(`/api/channels/${pub.id}/read`, { method: 'POST', ...asBob, body: { seq: midSeq } });
    expectStatus(read, 200, 'partial read');
    // channels.ts:3819: {ok, maxReadSeq, readStateVersion}.
    assert.deepEqual(Object.keys(read.data).sort(), ['maxReadSeq', 'ok', 'readStateVersion'], 'read response keys');
    assert.equal(read.data.ok, true, 'read ok');
    assert.ok(Number.isSafeInteger(read.data.readStateVersion) && read.data.readStateVersion >= 1, 'read state version');
    assert.equal(read.data.maxReadSeq, midSeq, 'read advances to the requested real in-channel message seq');

    // A fabricated future seq must not become a permanent read-all voucher
    // (readstate contract §4.1: read only advances to the real frontier).
    const fabricated = await request(`/api/channels/${pub.id}/read`, { method: 'POST', ...asBob, body: { seq: channelHighWater + 5000 } });
    expectStatus(fabricated, 200, 'fabricated read answered');
    assert.ok(fabricated.data.maxReadSeq <= channelHighWater,
      'read never advances beyond the channel frontier');

    const unreadMid = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(unreadMid, 200, 'unread after partial read');
    assert.ok(unreadMid.data.channels[pub.id].unreadCount < beforeEntry.unreadCount,
      'partial read reduces the real count');

    // Mark unread is a NEW decision with a new version; the wire maxReadSeq
    // must project the effective (rewound) state, not the internal max.
    const markUnread = await request(`/api/channels/${pub.id}/unread`, { method: 'POST', ...asBob, body: {} });
    expectStatus(markUnread, 200, 'mark unread');
    assert.deepEqual(Object.keys(markUnread.data).sort(), ['maxReadSeq', 'ok', 'readStateVersion', 'unreadCount'], 'unread response keys');
    assert.ok(markUnread.data.unreadCount > 0, 'mark unread restores a positive count');
    assert.ok(markUnread.data.readStateVersion > fabricated.data.readStateVersion, 'mark unread bumps the version');
    assert.ok(markUnread.data.maxReadSeq < fabricated.data.maxReadSeq,
      'wire maxReadSeq projects the effective rewound state, not the internal monotonic max');

    const readAll = await request(`/api/channels/${pub.id}/read-all`, { method: 'POST', ...asBob, body: {} });
    expectStatus(readAll, 200, 'channel read-all');
    // channels.ts:3931: {ok, seq, readStateVersion} — seq, not maxReadSeq.
    assert.deepEqual(Object.keys(readAll.data).sort(), ['ok', 'readStateVersion', 'seq'], 'read-all response keys');
    assert.equal(readAll.data.seq, channelHighWater, 'read-all reaches the channel frontier');
    const unreadAfterAll = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(unreadAfterAll, 200, 'unread after read-all');
    const entry = unreadAfterAll.data.channels[pub.id];
    assert.ok(!entry || entry.unreadCount === 0, 'read-all clears the channel');

    // Inbox-level read-all marks every authorized scope once.
    const inboxReadAll = await request('/api/channels/inbox/read-all', { method: 'POST', ...asBob, body: {} });
    expectStatus(inboxReadAll, 200, 'inbox read-all');
    // channels.ts:1347-1351.
    assert.equal(inboxReadAll.data.ok, true, 'inbox read-all ok');
    assert.ok(Number.isInteger(inboxReadAll.data.markedCount) && inboxReadAll.data.markedCount >= 1, 'markedCount reflects real scopes');
    assert.ok(Array.isArray(inboxReadAll.data.scopes) && inboxReadAll.data.scopes.length >= 1, 'scopes receipt');
    for (const scope of inboxReadAll.data.scopes) {
      assert.ok('scopeId' in scope && 'maxReadSeq' in scope && 'readStateVersion' in scope, 'scope receipt shape');
    }
    const cleared = await request('/api/channels/unread?summary=1', asBob);
    expectStatus(cleared, 200, 'unread fully cleared');
    assert.deepEqual(Object.values(cleared.data.channels).filter(e => e.unreadCount > 0), [],
      'no workspace scope keeps unread after the inbox read-all');
  });

  // ---- 11. mute and display preferences -----------------------------------
  await check('notification mute and display prefs persist with frozen shapes and the mention exception', async () => {
    // GET before any write: channels.ts:2344-2362 defaults.
    const initial = await request(`/api/channels/${pub.id}/notification-settings`, asBob);
    expectStatus(initial, 200, 'notification settings initial');
    assert.deepEqual(Object.keys(initial.data).sort(),
      ['activityMuteSupported', 'activityMuted', 'muteFromSeq', 'prefsVersion'], 'notification settings keys');
    assert.equal(initial.data.activityMuted, false, 'initial muted');
    assert.equal(initial.data.muteFromSeq, null, 'initial muteFromSeq');
    assert.equal(initial.data.prefsVersion, 0, 'initial prefsVersion');
    assert.equal(initial.data.activityMuteSupported, true, 'public channel supports activity mute');

    // activityMuted=true records muteFromSeq = channel latest + 1
    // (channelService.ts:14798).
    const muted = await request(`/api/channels/${pub.id}/notification-settings`, {
      method: 'PATCH', ...asBob, body: { activityMuted: true },
    });
    expectStatus(muted, 200, 'mute on');
    assert.equal(muted.data.activityMuted, true, 'muted flag');
    assert.equal(muted.data.muteFromSeq, channelHighWater + 1, 'muteFromSeq is channel frontier + 1');
    assert.ok(muted.data.prefsVersion >= 1, 'mute bumps prefsVersion');
    const mutedRead = await request(`/api/channels/${pub.id}/notification-settings`, asBob);
    expectStatus(mutedRead, 200, 'mute persisted read');
    assert.deepEqual(mutedRead.data, muted.data, 'mute state persists across reads');

    expectStatus(await request(`/api/channels/${pub.id}/notification-settings`, {
      method: 'PATCH', ...asBob, body: { activityMuted: 'yes' },
    }), 400, 'non-boolean mute rejected');

    // Threads refuse the endpoint; DMs answer unsupported
    // (channels.ts:2282-2285; shared/activityMute.ts:36).
    const threadSettings = await request(`/api/channels/${threadChannelId}/notification-settings`, asBob);
    expectStatus(threadSettings, 400, 'thread notification settings rejected');
    assert.equal(threadSettings.data?.error, 'Thread notification settings are managed via follow/unfollow', 'thread text');
    const dmSettings = await request(`/api/channels/${dmAliceBob.id}/notification-settings`, asBob);
    expectStatus(dmSettings, 200, 'dm notification settings');
    assert.equal(dmSettings.data.activityMuteSupported, false, 'dm mute is not a reachable feature');

    // While muted: plain activity is suppressed from the unread Inbox filter,
    // but a human mention still surfaces (readstate contract §4.1 exception).
    const plain = await send(asAlice, { channelId: pub.id, content: 'muted plain message', randomId: randomId() });
    expectStatus(plain, 200, 'plain message while muted');
    const unreadFilter = await request('/api/channels/inbox?filter=unread', asBob);
    expectStatus(unreadFilter, 200, 'inbox unread while muted');
    assert.equal(unreadFilter.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id), false,
      'muted plain activity is suppressed from the unread filter');
    const mentionMessage = await send(asAlice, {
      channelId: pub.id, content: `urgent @${bob.user.name} while muted`,
      mentions: [{ type: 'user', id: bob.user.id, name: bob.user.name }],
    });
    expectStatus(mentionMessage, 200, 'mention while muted');
    const mentionsFilter = await request('/api/channels/inbox?filter=mentions', asBob);
    expectStatus(mentionsFilter, 200, 'inbox mentions while muted');
    assert.ok(mentionsFilter.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id),
      'the mute exception keeps human mentions visible');

    // Unmute keeps the version moving and clears the frontier
    // (channelService.ts:14756-14795).
    const unmuted = await request(`/api/channels/${pub.id}/notification-settings`, {
      method: 'PATCH', ...asBob, body: { activityMuted: false },
    });
    expectStatus(unmuted, 200, 'mute off');
    assert.equal(unmuted.data.activityMuted, false, 'unmuted flag');
    assert.equal(unmuted.data.muteFromSeq, null, 'unmute clears muteFromSeq');
    assert.ok(unmuted.data.prefsVersion > muted.data.prefsVersion, 'unmute bumps the version again');

    // Display prefs are a separate domain with their own version
    // (channels.ts:2409-2444).
    const displayInitial = await request(`/api/channels/${pub.id}/message-display-settings`, asBob);
    expectStatus(displayInitial, 200, 'display settings initial');
    assert.deepEqual(Object.keys(displayInitial.data).sort(), ['collapseLongMessages', 'prefsVersion'], 'display keys');
    assert.equal(typeof displayInitial.data.collapseLongMessages, 'boolean', 'collapse is boolean');
    const displaySet = await request(`/api/channels/${pub.id}/message-display-settings`, {
      method: 'PATCH', ...asBob, body: { collapseLongMessages: false },
    });
    expectStatus(displaySet, 200, 'display settings write');
    assert.equal(displaySet.data.collapseLongMessages, false, 'collapse persisted');
    assert.ok(displaySet.data.prefsVersion >= 1, 'display version bumps');
    expectStatus(await request(`/api/channels/${pub.id}/message-display-settings`, {
      method: 'PATCH', ...asBob, body: { collapseLongMessages: 'no' },
    }), 400, 'non-boolean display pref rejected');
  });

  // ---- 12. Inbox projection ------------------------------------------------
  await check('Inbox items, counts, filters and query scoping are real', async () => {
    const inbox = await request('/api/channels/inbox', asBob);
    expectStatus(inbox, 200, 'inbox default');
    for (const key of ['items', 'groups', 'hasMore', 'totalCount', 'totalUnreadCount', 'activeUnreadCount']) {
      assert.ok(key in inbox.data, `inbox envelope key ${key}`);
    }
    assert.ok(Array.isArray(inbox.data.items) && inbox.data.items.length > 0, 'inbox is not a constant-empty shell');
    const channelItem = inbox.data.items.find(i => i.kind !== 'thread' && i.channelId === pub.id);
    assert.ok(channelItem, 'public channel item present');
    assert.equal(channelItem.channelName, 'm4-general', 'item channel name');
    assert.equal(channelItem.channelType, 'channel', 'item channel type');
    assert.ok(Number.isInteger(channelItem.unreadCount) && channelItem.unreadCount >= 0, 'item unread count');
    assert.equal(typeof channelItem.hasMention, 'boolean', 'item hasMention');
    assert.ok(channelItem.lastMessageId && channelItem.lastMessageAt && typeof channelItem.lastMessagePreview === 'string',
      'item last-message projection');
    const dmItem = inbox.data.items.find(i => i.kind === 'dm' && i.channelId === dmAliceBob.id);
    assert.ok(dmItem, 'human DM item present');
    // filter=all keeps not-Done unfollowed thread rows (readstate contract §2).
    const unfollowedThreadItem = inbox.data.items.find(i => i.kind === 'thread' && i.threadChannelId === threadChannelId);
    assert.ok(unfollowedThreadItem, 'unfollowed not-Done thread still listed under filter=all');

    const unreadInbox = await request('/api/channels/inbox?filter=unread', asBob);
    expectStatus(unreadInbox, 200, 'inbox unread filter');
    assert.ok(unreadInbox.data.items.every(i => (i.unreadCount ?? 0) > 0), 'unread filter only lists unread rows');
    const unreadMentions = await request('/api/channels/inbox?filter=unread_mentions', asBob);
    expectStatus(unreadMentions, 200, 'inbox unread_mentions filter');
    assert.ok(unreadMentions.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id),
      'the unread mention is listed under unread_mentions');

    const byQuery = await request('/api/channels/inbox?q=m4-general', asBob);
    expectStatus(byQuery, 200, 'inbox q filter');
    assert.ok(byQuery.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id), 'q matches the channel item');
    const byNothing = await request('/api/channels/inbox?q=zzz-no-such-thing', asBob);
    expectStatus(byNothing, 200, 'inbox q without match');
    assert.equal(byNothing.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id), false,
      'q only filters the authorized list');
    const byChannel = await request(`/api/channels/inbox?channelId=${pub.id}`, asBob);
    expectStatus(byChannel, 200, 'inbox channelId filter');
    assert.ok(byChannel.data.items.length >= 1 && byChannel.data.items.every(i => i.kind === 'thread' || i.channelId === pub.id),
      'channelId scopes the listing');

    const limited = await request('/api/channels/inbox?limit=1', asBob);
    expectStatus(limited, 200, 'inbox limit');
    assert.ok(limited.data.items.length <= 1, 'limit respected');
    assert.equal(limited.data.hasMore, true, 'hasMore is computed from the real authorized set');
    const ascending = await request('/api/channels/inbox?sort=asc', asBob);
    expectStatus(ascending, 200, 'inbox sort asc');
    const times = ascending.data.items.map(i => i.kind === 'thread' ? i.lastActivityAt : i.lastMessageAt);
    assert.deepEqual(times, [...times].sort((a, b) => new Date(a) - new Date(b)), 'sort=asc orders by activity');

    // Another workspace member never sees foreign items.
    const carolInbox = await request('/api/channels/inbox', asCarol);
    expectStatus(carolInbox, 200, 'carol inbox');
    assert.ok(!carolInbox.data.items.some(i => i.kind === 'dm' && i.channelId === dmAliceBob.id),
      'carol inbox has no foreign DM items');
  });

  // ---- 13. Done frontiers ---------------------------------------------------
  await check('Done frontier matrix, Done history and reactivation are exact', async () => {
    // The adjudicated four-way matrix (channels.ts:1240-1265, 1681-1705 and
    // readstate contract §4.2).
    const withoutSpace = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: '5' },
    });
    expectStatus(withoutSpace, 412, 'seq without frontierSpace');
    assert.equal(withoutSpace.data?.code, 'DONE_FRONTIER_SPACE_REQUIRED', '412 code');
    const badSpace = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: '5', frontierSpace: 'display' },
    });
    expectStatus(badSpace, 400, 'unsupported frontierSpace');
    assert.equal(badSpace.data?.code, 'DONE_FRONTIER_UNMAPPABLE', '400 code');
    // Canonical decimal STRING only (inboxSuppressionWriters.ts:99-103).
    const numericSeq = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: 5, frontierSpace: 'storage' },
    });
    expectStatus(numericSeq, 400, 'numeric frontier is not canonical');
    assert.equal(numericSeq.data?.code, 'DONE_FRONTIER_REQUIRED', 'numeric frontier code');
    const zeroSeq = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: '0', frontierSpace: 'storage' },
    });
    expectStatus(zeroSeq, 400, 'zero frontier rejected');
    assert.equal(zeroSeq.data?.code, 'DONE_FRONTIER_REQUIRED', 'zero frontier code');
    const dmHighWater = (await history(asBob, dmAliceBob.id, '?limit=200')).data.messages.map(m => m.seq).pop();
    const beyondLatest = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: String(dmHighWater + 10), frontierSpace: 'storage' },
    });
    expectStatus(beyondLatest, 409, 'frontier beyond latest');
    assert.equal(beyondLatest.data?.code, 'DONE_FRONTIER_BEYOND_LATEST', 'beyond-latest code');
    // The original validateDoneFrontier (inboxSuppressionWriters.ts) checks
    // currentLatest BEFORE the int4 ceiling. This HTTP-created conversation
    // has no message at 3e9, so BEYOND_LATEST must win over ABOVE_INT4.
    // TestDoneChannelFrontierMatrix separately seeds a real high-seq fact in
    // an isolated Go fixture and requires ABOVE_INT4 without any write.
    const aboveInt4 = await request('/api/channels/inbox/done', {
      method: 'POST', ...asBob, body: { channelId: dmAliceBob.id, throughActivitySeq: '3000000000', frontierSpace: 'storage' },
    });
    expectStatus(aboveInt4, 409, 'frontier above both latest and int4 authority');
    assert.equal(aboveInt4.data?.code, 'DONE_FRONTIER_BEYOND_LATEST', 'latest guard takes precedence over int4 ceiling');

    // Omitted frontier uses the canonical snapshot (200 {ok:true}).
    const doneOk = await request('/api/channels/inbox/done', { method: 'POST', ...asBob, body: { channelId: pub.id } });
    expectStatus(doneOk, 200, 'channel done with snapshot frontier');
    assert.deepEqual(doneOk.data, { ok: true }, 'done response is the frozen {ok:true}');
    const activeAfterDone = await request('/api/channels/inbox?filter=all', asBob);
    expectStatus(activeAfterDone, 200, 'inbox after done');
    assert.ok(!activeAfterDone.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id),
      'done channel leaves the active inbox');
    const doneList = await request('/api/channels/inbox/done', asBob);
    expectStatus(doneList, 200, 'done history');
    assert.ok(doneList.data.items.some(i => i.channelId === pub.id), 'done history lists the channel');
    const unfollowedList = await request('/api/channels/inbox/unfollowed', asBob);
    expectStatus(unfollowedList, 200, 'unfollowed history');
    assert.ok(unfollowedList.data.items.some(i => i.threadChannelId === threadChannelId),
      'unfollowed history lists the explicitly unfollowed thread');

    // New activity past the frontier reactivates the row.
    const reactivation = await send(asAlice, { channelId: pub.id, content: 'reactivation after done', randomId: randomId() });
    expectStatus(reactivation, 200, 'new message after done');
    const activeAgain = await request('/api/channels/inbox?filter=all', asBob);
    expectStatus(activeAgain, 200, 'inbox after new activity');
    assert.ok(activeAgain.data.items.some(i => i.kind !== 'thread' && i.channelId === pub.id),
      'activity past the Done frontier restores the row');

    // undone restores the caller's own active state.
    expectStatus(await request('/api/channels/inbox/undone', {
      method: 'POST', ...asBob, body: { channelId: pub.id },
    }), 200, 'undone');

    // Thread Done: input must be a thread for someone who can see it.
    const notAThread = await request('/api/channels/threads/done', {
      method: 'POST', ...asBob, body: { threadChannelId: pub.id },
    });
    expectStatus(notAThread, 400, 'non-thread input to threads/done');
    assert.equal(notAThread.data?.code, 'NOT_A_THREAD', 'NOT_A_THREAD code');
    expectStatus(await request('/api/channels/threads/done', {
      method: 'POST', ...asBob, body: { threadChannelId },
    }), 200, 'thread done');
    expectStatus(await request('/api/channels/threads/undone', {
      method: 'POST', ...asBob, body: { threadChannelId },
    }), 200, 'thread undone');

    // Stranger anti-enumeration: merged 404, no existence oracle.
    const strangerDone = await request('/api/channels/inbox/done', {
      method: 'POST', ...asStranger, body: { channelId: pub.id },
    });
    expectStatus(strangerDone, 404, 'stranger done collapses to not-found');
    assert.equal(strangerDone.data?.error, 'Chat not found', 'stranger done text');
  });

  // ---- 14. Activity snapshot / difference / notModified ---------------------
  await check('Activity snapshot, difference and notModified follow the frozen wire contract', async () => {
    const missingId = await request('/api/channels/activity/snapshot', asBob);
    expectStatus(missingId, 400, 'snapshot without requestId');
    assert.equal(missingId.data?.error, 'requestId is required and windowId must be main', 'requestId error text');
    expectStatus(await request('/api/channels/activity/snapshot?requestId=r1&windowId=side', asBob), 400, 'non-main window rejected');
    expectStatus(await request('/api/channels/activity/snapshot?requestId=r1&filter=hot', asBob), 400, 'unknown filter rejected');

    const snapshot = await request('/api/channels/activity/snapshot?requestId=rq-snap-1', asBob);
    expectStatus(snapshot, 200, 'activity snapshot');
    assert.equal(snapshot.data.type, 'snapshot', 'snapshot type');
    assertActivityEnvelopeCommon(snapshot.data, { requestId: 'rq-snap-1', server: ws, user: bob.user.id, filter: 'all' }, 'snapshot');
    const window = snapshot.data.window;
    for (const key of ['rows', 'tombstones', 'nextCursor', 'hasMore', 'complete', 'totalCount', 'totalUnreadCount']) {
      assert.ok(key in window, `window key ${key}`);
    }
    assert.ok(Array.isArray(window.rows) && window.rows.length > 0, 'the snapshot carries real human rows');
    for (const row of window.rows) assertActivityRow(row, 'snapshot row');
    const channelRow = window.rows.find(r => r.type !== 'thread' && r.channelId === pub.id);
    assert.ok(channelRow, 'public channel activity row present');
    assert.ok(window.rows.some(r => r.type === 'dm' && r.channelId === dmAliceBob.id), 'human DM activity row present');
    const activityEpoch = snapshot.data.epoch;
    const activityWatermark = snapshot.data.watermark;

    // Every row must be accepted by the ORIGINAL Activity fold: fold the real
    // window as a frame; any row the original isRow() gate rejects would
    // silently vanish from the folded state.
    const state0 = originals.activityDomain.initialActivityState();
    const folded = originals.activityDomain.foldActivityEvent(state0, {
      type: 'frame', rows: window.rows, tombstones: window.tombstones, activityVersion: snapshot.data.activityVersion,
    });
    assert.equal(folded.rows.length, window.rows.length,
      'the original Activity reducer accepts every real wire row');
    assert.equal(folded.activityVersion, snapshot.data.activityVersion, 'fold tracks activityVersion');

    // Same-row stability: a second snapshot keeps rowId/rowVersion stable
    // while nothing changed.
    const snapshot2 = await request('/api/channels/activity/snapshot?requestId=rq-snap-2', asBob);
    expectStatus(snapshot2, 200, 'second snapshot');
    assert.equal(snapshot2.data.epoch, activityEpoch, 'epoch stable without scope rebuild');
    assert.equal(snapshot2.data.watermark, activityWatermark, 'watermark stable without changes');
    const rowAgain = snapshot2.data.window.rows.find(r => r.type !== 'thread' && r.channelId === pub.id);
    assert.deepEqual([rowAgain.rowId, rowAgain.rowVersion], [channelRow.rowId, channelRow.rowVersion],
      'unchanged rows keep their identity and version');

    // notModified: replay the current watermark.
    const notModified = await request(`/api/channels/activity/difference?requestId=rq-nm&epoch=${activityEpoch}&afterWatermark=${activityWatermark}`, asBob);
    expectStatus(notModified, 200, 'difference at the watermark');
    assert.equal(notModified.data.type, 'notModified', 'notModified type');
    assertActivityEnvelopeCommon(notModified.data, { requestId: 'rq-nm', server: ws, user: bob.user.id, filter: 'all' }, 'notModified');
    assert.ok(!('window' in notModified.data) && !('rows' in notModified.data), 'notModified carries no window');

    // A real change: difference covers (after, current] continuously.
    const changed = await send(asAlice, { channelId: pub.id, content: 'activity difference trigger', randomId: randomId() });
    expectStatus(changed, 200, 'change trigger');
    const difference = await request(`/api/channels/activity/difference?requestId=rq-diff&epoch=${activityEpoch}&afterWatermark=${activityWatermark}`, asBob);
    expectStatus(difference, 200, 'difference after change');
    assert.equal(difference.data.type, 'difference', 'difference type');
    assertActivityEnvelopeCommon(difference.data, { requestId: 'rq-diff', server: ws, user: bob.user.id, filter: 'all' }, 'difference');
    for (const key of ['rows', 'tombstones', 'nextCursor', 'hasMore', 'complete', 'totalCount', 'totalUnreadCount', 'nextFromSeq']) {
      assert.ok(key in difference.data, `difference key ${key}`);
    }
    assert.equal(difference.data.fromSeq, String(BigInt(activityWatermark) + 1n), 'fromSeq is after+1');
    assert.ok(BigInt(difference.data.toSeq) > BigInt(activityWatermark), 'toSeq advanced past the old watermark');
    assert.equal(difference.data.nextFromSeq, null, 'single-page difference has null nextFromSeq');
    const advancedRow = difference.data.rows.find(r => r.type !== 'thread' && r.channelId === pub.id);
    assert.ok(advancedRow, 'the changed conversation appears in the difference');
    assert.ok(BigInt(advancedRow.rowVersion) > BigInt(channelRow.rowVersion), 'row version advanced for real change');
    // The original fold applies the difference on top of the snapshot.
    const foldedDiff = originals.activityDomain.foldActivityEvent(folded, {
      type: 'frame', rows: difference.data.rows, tombstones: difference.data.tombstones,
      activityVersion: difference.data.activityVersion,
    });
    const foldedRow = foldedDiff.rows.find(r => r.rowId === advancedRow.rowId);
    assert.ok(foldedRow, 'the original fold accepted the difference frame');
    assert.equal(foldedRow.rowVersion, advancedRow.rowVersion, 'folded row version matches the wire');
    const currentWatermark = difference.data.toSeq;

    // Epoch mismatch and a watermark ahead of the authority -> 409
    // snapshotRequired with the server's CURRENT values and no type member.
    const staleEpoch = await request(`/api/channels/activity/difference?requestId=rq-stale&epoch=999999999999&afterWatermark=${currentWatermark}`, asBob);
    expectStatus(staleEpoch, 409, 'stale epoch');
    assert.equal(staleEpoch.data.snapshotRequired, true, 'snapshotRequired flag');
    assert.ok(!('type' in staleEpoch.data), '409 has no ingress type member');
    assert.equal(staleEpoch.data.epoch, activityEpoch, '409 carries the current epoch');
    const ahead = await request(`/api/channels/activity/difference?requestId=rq-ahead&epoch=${activityEpoch}&afterWatermark=${String(BigInt(currentWatermark) + 5n)}`, asBob);
    expectStatus(ahead, 409, 'afterWatermark ahead of authority');
    assert.equal(ahead.data.snapshotRequired, true, 'ahead -> snapshotRequired');

    // Canonical uint64 parsing rejections (readstate contract §5).
    for (const bad of ['0x10', '1.5', '007', '%2012', '-3']) {
      const malformed = await request(`/api/channels/activity/difference?requestId=rq-bad&epoch=${bad}&afterWatermark=0`, asBob);
      expectStatus(malformed, 400, `malformed epoch ${bad}`);
    }

    // Cross-principal watermark misuse never returns foreign rows: whatever
    // bob's watermark does inside alice's scope, the answer is alice's own
    // scope (200 difference of her data or 409 snapshotRequired).
    const aliceSnap = await request('/api/channels/activity/snapshot?requestId=rq-alice', asAlice);
    expectStatus(aliceSnap, 200, 'alice snapshot');
    const crossScope = await request(`/api/channels/activity/difference?requestId=rq-cross&epoch=${aliceSnap.data.epoch}&afterWatermark=${currentWatermark}`, asAlice);
    assert.ok([200, 409].includes(crossScope.status), 'cross-scope request resolves within the caller scope');
    assert.equal(crossScope.data.scope.principalId, alice.user.id, 'cross-scope answer is scoped to the caller');

    // Compare filters at the SAME content frontier. snapshot2 predates the
    // message deliberately written above and must not be used as the current
    // row-version authority after the difference has already advanced it.
    const currentAllSnap = await request('/api/channels/activity/snapshot?requestId=rq-current-all', asBob);
    expectStatus(currentAllSnap, 200, 'current all-filter snapshot');
    const unreadSnap = await request('/api/channels/activity/snapshot?requestId=rq-unread&filter=unread', asBob);
    expectStatus(unreadSnap, 200, 'unread filter snapshot');
    for (const row of unreadSnap.data.window.rows) {
      assert.ok(row.unreadCount > 0, 'unread filter lists only unread rows');
      const sameRow = currentAllSnap.data.window.rows.find(r => r.rowId === row.rowId);
      assert.ok(sameRow, 'each unread row exists in the current all-filter fixture window');
      assert.equal(row.rowVersion, sameRow.rowVersion, 'same content version across filters');
    }
    const mentionsSnap = await request('/api/channels/activity/snapshot?requestId=rq-mentions&filter=mentions', asBob);
    expectStatus(mentionsSnap, 200, 'mentions filter snapshot');
    assert.equal(mentionsSnap.data.scope.filter, 'mentions', 'mentions scope filter');
    // Original channelService uses has_any_mention for this filter, not
    // unread_mention_count: read mentions remain visible. hasMention on the
    // row still describes unread mentions and must not be forced to true.
    assert.ok(mentionsSnap.data.window.rows.length >= 1, 'the historical mention row is present');
    assert.ok(mentionsSnap.data.window.rows.every(r => r.type === 'channel' && r.channelId === pub.id),
      'only the fixture channel with valid persisted human mentions is listed');
    for (const row of mentionsSnap.data.window.rows) {
      const sameRow = currentAllSnap.data.window.rows.find(r => r.rowId === row.rowId);
      assert.ok(sameRow, 'mention row exists in the current all-filter fixture window');
      assert.equal(row.hasMention, sameRow.hasMention, 'mention filter preserves the current unread-mention flag');
      assert.equal(row.rowVersion, sameRow.rowVersion, 'mention filter preserves the content version');
    }

    // The new read-mutation sequencer surface stays explicitly closed this
    // phase: authorized callers get 501 feature_not_implemented, not a fake
    // success and not a bare unknown-route 404 (readstate contract §2).
    for (const [route, method] of [['/api/read-mutations', 'POST'], ['/api/read-mutations/frontier', 'GET']]) {
      const closed = await request(route, { method, ...asBob, body: method === 'POST' ? {} : undefined });
      expectStatus(closed, 501, `${route} is not open this phase`);
      assert.equal(closed.data?.code, 'feature_not_implemented', `${route} 501 code`);
    }
  });

  // ---- 15. account-level unread summary -------------------------------------
  await check('servers/unread-summary is the user-scoped literal route with real counts', async () => {
    // A fresh unread message so the count is deterministic.
    const trigger = await send(asAlice, { channelId: pub.id, content: 'summary trigger', randomId: randomId() });
    expectStatus(trigger, 200, 'unread-summary trigger send');
    lastCommittedPubId = trigger.data.message.id;
    const summary = await request('/api/servers/unread-summary', { token: bob.accessToken });
    expectStatus(summary, 200, 'unread-summary without X-Server-Id');
    assert.ok(Array.isArray(summary.data), 'summary is an array');
    const own = summary.data.find(entry => entry.serverId === ws);
    assert.ok(own, 'the workspace appears in the account summary');
    assert.ok(Number.isInteger(own.unreadCount) && own.unreadCount >= 1, 'unread count is a real number');
    assert.equal(typeof own.serverPushMuted, 'boolean', 'serverPushMuted flag');
    const strangerSummary = await request('/api/servers/unread-summary', { token: stranger.accessToken });
    expectStatus(strangerSummary, 200, 'stranger summary');
    assert.ok(!strangerSummary.data.some(entry => entry.serverId === ws),
      'a foreign workspace never appears in another account summary');
  });

  // ---- 16. restart persistence ------------------------------------------------
  if (start && stop) {
    await check('readstate, prefs, Activity epoch/watermark and history survive a process restart', async () => {
      const prefsBefore = await request(`/api/channels/${pub.id}/notification-settings`, asBob);
      const displayBefore = await request(`/api/channels/${pub.id}/message-display-settings`, asBob);
      const snapBefore = await request('/api/channels/activity/snapshot?requestId=rq-restart-before', asBob);
      expectStatus(snapBefore, 200, 'snapshot before restart');
      await stop();
      await start();
      const historyAfter = await history(asBob, pub.id, '?limit=200');
      expectStatus(historyAfter, 200, 'history after restart');
      assert.ok(historyAfter.data.messages.some(m => m.id === lastCommittedPubId),
        'the last committed message survives the restart');
      const prefsAfter = await request(`/api/channels/${pub.id}/notification-settings`, asBob);
      expectStatus(prefsAfter, 200, 'prefs after restart');
      assert.deepEqual(prefsAfter.data, prefsBefore.data, 'mute prefs survive');
      const displayAfter = await request(`/api/channels/${pub.id}/message-display-settings`, asBob);
      expectStatus(displayAfter, 200, 'display after restart');
      assert.deepEqual(displayAfter.data, displayBefore.data, 'display prefs survive');
      const snapAfter = await request('/api/channels/activity/snapshot?requestId=rq-restart-after', asBob);
      expectStatus(snapAfter, 200, 'snapshot after restart');
      assert.equal(snapAfter.data.epoch, snapBefore.data.epoch, 'epoch survives restart');
      assert.equal(snapAfter.data.watermark, snapBefore.data.watermark, 'watermark survives restart');
      const notModified = await request(`/api/channels/activity/difference?requestId=rq-restart-nm&epoch=${snapAfter.data.epoch}&afterWatermark=${snapAfter.data.watermark}`, asBob);
      expectStatus(notModified, 200, 'difference after restart');
      assert.equal(notModified.data.type, 'notModified', 'restart preserves the no-change verdict');
    });
  } else {
    console.log('SKIP M4 backend restart persistence (no start/stop provided by the runner)');
  }

  console.log(`M4 backend acceptance complete: ${passed.length} check groups passed; no Web UI was started or tested.`);
}

// ---------------------------------------------------------------------------
// Standalone execution: build the current tree into a disposable dir, start
// one server on a free loopback port, run the suite, tear everything down.
// This is an isolated runner for development verification only — the shared
// tests/acceptance/run.mjs stays the integration entry point.
// ---------------------------------------------------------------------------

async function standalone() {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-m4-backend-'));
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
      assert.ok(!forced && code === 0 && signal === null, 'standalone server must stop gracefully');
    } finally { clearTimeout(timer); }
  };
  const capture = (program, args, { timeout = 300000, env = process.env, cwd = root } = {}) => new Promise((resolve, reject) => {
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
  const freePort = async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
  };
  try {
    const executable = path.join(dir, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
    const build = await capture('go', ['build', '-buildvcs=false', '-o', executable, './cmd/raft-server'], {
      // Disposable build cache: the standalone runner never touches the
      // user's persistent cache directory.
      env: { ...process.env, CGO_ENABLED: '0', GOCACHE: path.join(dir, 'gocache') },
    });
    if (build.code !== 0) {
      process.stderr.write(build.stdout + build.stderr);
      throw new Error('standalone build failed; see compiler output above');
    }
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const data = path.join(dir, 'data');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      RAFT_GO_LISTEN: `127.0.0.1:${port}`, RAFT_GO_DATA_DIR: data,
      RAFT_GO_WEB_ORIGIN: 'http://127.0.0.1:5175', RAFT_GO_MAIL_MODE: 'outbox',
    };
    const start = async () => {
      if (child) throw new Error('Refusing to start a duplicate standalone process');
      child = spawn(executable, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Standalone server exited before readiness');
        try {
          const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          if (response.status === 200) return;
        } catch {}
        await sleep(100);
      }
      throw new Error('Standalone server readiness timed out');
    };
    await start();
    await verifyM4Backend({ origin, data, start, stop, capture, executable, env });
    if (/[?&](verify|reset)=|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(logs)) {
      throw new Error('Server emitted credential-like material to logs');
    }
    await stop();
    console.log('PASS standalone M4 backend run shut down cleanly with credential-safe output');
  } finally {
    try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await standalone();
}
