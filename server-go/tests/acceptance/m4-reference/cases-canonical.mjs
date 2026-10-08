// Area B — canonical message wire: the shared manifest, the shared/private
// omission ledger, the socket allowlist projection, and the canonical merge
// fold (commentRef shared-null-preserve). Everything here EXECUTES original
// code: the shared manifest module, the server socket projector, and the web
// message-domain fold (wired to the real manifest + real display sort).
import assert from 'node:assert/strict';

const UUID = '0b2a6f3e-9c1d-4e7b-8f2a-1c3b5d7e9a01';

// Values produced inside the vm are cross-realm (different Array/Object
// prototypes), which node's strict deepEqual treats as unequal. Round-trip
// them into this realm before comparing or freezing them.
const host = (value) => JSON.parse(JSON.stringify(value));

function baseMessage(overrides = {}) {
  return {
    id: UUID,
    channelId: 'ch-1',
    seq: 10,
    senderType: 'user',
    senderId: 'u-1',
    randomId: 'rnd-1',
    messageType: 'chat',
    content: 'hello',
    createdAt: '2026-10-01T00:00:00.000Z',
    threadId: null,
    senderName: 'Ada',
    ...overrides,
  };
}

export async function runCanonicalCases(mods) {
  const executed = {};

  // ---- manifest (executed original module) ----
  const M = mods.canonicalManifest;
  executed.manifestVersion = M.CANONICAL_MESSAGE_MANIFEST_VERSION;
  executed.manifestJson = M.canonicalMessageManifestJson();
  executed.requiredFields = [...M.CANONICAL_REQUIRED_MESSAGE_FIELDS];
  executed.optionalAggregateFields = [...M.OPTIONAL_AGGREGATE_MESSAGE_FIELDS];
  assert.equal(executed.manifestVersion, 5);
  assert.equal(executed.requiredFields.length, 10);
  assert.equal(executed.optionalAggregateFields.length, 10);

  const byName = Object.fromEntries(M.CANONICAL_MESSAGE_FIELD_DESCRIPTORS.map(f => [f.name, f]));
  executed.mergePolicies = Object.fromEntries(
    M.CANONICAL_MESSAGE_FIELD_DESCRIPTORS.map(f => [f.name, { mergePolicy: f.mergePolicy, nullable: f.nullable, wireType: f.wireType }]),
  );
  assert.equal(byName.commentRef.mergePolicy, 'shared-null-preserve');
  assert.equal(byName.commentRef.presence.messageNew, 'present');
  assert.equal(byName.commentRef.presence.taskStatusUpdated, 'absent');
  assert.equal(byName.conversationContext.presence.enrichedUpdated, 'absent');
  assert.equal(byName.conversationContext.presence.messageNew, 'present');
  executed.presenceMatrix = Object.fromEntries(
    M.CANONICAL_MESSAGE_FIELD_DESCRIPTORS.map(f => [f.name, f.presence]),
  );

  // ---- omission ledger (executed original constants) ----
  const E = M.CANONICAL_MESSAGE_EXCLUSIONS;
  executed.omissionLedger = {
    viewerScopedFields: [...E.viewerScopedFields.fields],
    storageOnlySealed: [...E.storageOnlySealed.fields],
    clientOnly: [...E.clientOnly.fields],
    emittedUnconsumed: [...E.emittedUnconsumed.fields],
    taskDomainProjection: [...E.taskDomainProjection.fields],
  };
  assert.deepEqual(executed.omissionLedger.viewerScopedFields, ['attachment.commentCount']);
  assert.deepEqual(executed.omissionLedger.storageOnlySealed, ['agentSendKey', 'searchText', 'searchVector']);
  assert.deepEqual(executed.omissionLedger.clientOnly, ['optimisticDisplaySeq']);

  // ---- socket allowlist projection (executed original projector) ----
  const S = mods.messageSocketProjection;
  const row = {
    id: UUID, seq: 7, channelId: 'ch-1', senderType: 'user', senderId: 'u-1',
    randomId: 'rnd-1', messageType: 'chat', content: 'hi',
    actionMetadata: null, threadId: null,
    taskStatus: null, taskNumber: null, taskAssigneeType: null, taskAssigneeId: null,
    taskClaimedAt: null, taskCompletedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:01.000Z',
  };
  const projectedPlain = S.projectMessageSocketPayload({ ...row }, 'Ada');
  const projectedWithAssignee = S.projectMessageSocketPayload(
    { ...row, taskAssigneeId: 'u-2', taskAssigneeName: 'Bob' }, 'Ada',
  );
  executed.socketProjection = host({
    plain: { input: row, output: projectedPlain },
    withTaskAssignee: { output: projectedWithAssignee },
  });
  // 19 wire keys, alphabetically: the exact allowlist of the shared socket frame.
  assert.deepEqual(Object.keys(projectedPlain).sort(), [
    'actionMetadata', 'channelId', 'content', 'createdAt', 'id', 'messageType',
    'randomId', 'senderId', 'senderName', 'senderType', 'seq',
    'taskAssigneeId', 'taskAssigneeType', 'taskClaimedAt', 'taskCompletedAt',
    'taskNumber', 'taskStatus', 'threadId', 'updatedAt',
  ]);
  assert.equal('taskAssigneeName' in projectedPlain, false);
  assert.equal(projectedWithAssignee.taskAssigneeName, 'Bob');

  // projectRichMessageSocketPayload: the storage-only seal at the socket
  // boundary — those keys must disappear from any shared frame.
  const sealed = S.projectRichMessageSocketPayload({
    id: UUID, seq: 1, agentSendKey: 'k', searchText: 't', searchVector: 'v',
    senderHandle: 'h', content: 'x',
  });
  executed.storageSeal = host({ output: sealed });
  assert.deepEqual(Object.keys(sealed).sort(), ['content', 'id', 'seq']);
  const sealedProjection = S.projectRichMessageSocketPayload({ ...projectedPlain, senderHandle: 'h' });
  assert.equal('senderHandle' in sealedProjection, false);
  assert.equal(sealedProjection.content, 'hi');

  // ---- canonical merge fold (executed original web fold) ----
  const F = mods.webMessageFold;
  const commentRef = { attachmentId: 'a-1', filename: 'f.png', anchorLabel: null, anchorQuote: null, hostMessageId: null, hostSource: null };

  // 1. message:new into an empty channel buckets by channelId and sorts by seq.
  let state = F.createInitialMessageDomainState();
  state = F.applyMessageDomainEvent(state, { kind: 'message:new', message: baseMessage({ seq: 10 }) });
  state = F.applyMessageDomainEvent(state, { kind: 'message:new', message: baseMessage({ id: 'm-2', seq: 5, content: 'earlier' }) });
  executed.foldNewBucket = host(state.channelMessages['ch-1'].map(m => m.seq));
  assert.deepEqual(executed.foldNewBucket, [5, 10]);

  // 2. message:new for an existing id merges (canonical overwrite), not dupes.
  state = F.applyMessageDomainEvent(state, { kind: 'message:new', message: baseMessage({ seq: 10, content: 'updated content' }) });
  assert.equal(state.channelMessages['ch-1'].length, 2);
  assert.equal(state.channelMessages['ch-1'].find(m => m.id === UUID).content, 'updated content');

  // 3. shared-null-preserve: a shared frame's commentRef:null must NOT clear an
  //    existing receiver-resolved commentRef.
  state = F.applyMessageDomainEvent(state, { kind: 'message:new', message: baseMessage({ seq: 10, commentRef }) });
  assert.ok(state.channelMessages['ch-1'].find(m => m.id === UUID).commentRef);
  state = F.applyMessageDomainEvent(state, { kind: 'message:updated', message: { id: UUID, channelId: 'ch-1', commentRef: null } });
  executed.commentRefSharedNullPreserved = host(state.channelMessages['ch-1'].find(m => m.id === UUID).commentRef);
  assert.deepEqual(executed.commentRefSharedNullPreserved, commentRef);

  // 4. present-overwrite: an ABSENT optional key preserves, a PRESENT empty
  //    array clears.
  state = F.applyMessageDomainEvent(state, { kind: 'message:new', message: baseMessage({ seq: 10, mentions: [{ id: 'u-2', name: 'Bob', type: 'user' }], reactions: [{ count: 1, emoji: '👍', reactorIds: ['u-2'], reactorNames: ['Bob'] }] }) });
  state = F.applyMessageDomainEvent(state, { kind: 'message:updated', message: { id: UUID, channelId: 'ch-1' } });
  executed.absentOptionalPreserved = host({
    mentions: state.channelMessages['ch-1'].find(m => m.id === UUID).mentions,
    reactions: state.channelMessages['ch-1'].find(m => m.id === UUID).reactions,
  });
  assert.equal(executed.absentOptionalPreserved.mentions.length, 1);
  state = F.applyMessageDomainEvent(state, { kind: 'message:updated', message: { id: UUID, channelId: 'ch-1', mentions: [] } });
  executed.presentEmptyClears = host(state.channelMessages['ch-1'].find(m => m.id === UUID).mentions);
  assert.deepEqual(executed.presentEmptyClears, []);

  // 5. a no-op update returns the SAME state object (identity-stable no-op).
  const before = state;
  state = F.applyMessageDomainEvent(state, { kind: 'message:updated', message: { id: UUID, channelId: 'ch-1', content: state.channelMessages['ch-1'].find(m => m.id === UUID).content } });
  executed.noopUpdateIdentityStable = state === before;
  assert.equal(executed.noopUpdateIdentityStable, true);

  // 6. message:updated for an unknown channel is a no-op.
  const untouched = state;
  state = F.applyMessageDomainEvent(state, { kind: 'message:updated', message: { id: UUID, channelId: 'not-a-bucket', content: 'x' } });
  assert.equal(state, untouched);

  // 7. canonical display order: seq wins; missing seq falls to createdAt, then
  //    id; no-seq rows sort AFTER seq rows when only one has a usable seq.
  const sort = mods.webSort;
  const sorted = sort.sortBySeq([
    baseMessage({ id: 'm-b', seq: 2, createdAt: '2026-10-01T00:00:03.000Z' }),
    baseMessage({ id: 'm-a', seq: undefined, optimisticDisplaySeq: 99, createdAt: '2026-10-01T00:00:01.000Z' }),
    baseMessage({ id: 'm-c', seq: 1, createdAt: '2026-10-01T00:00:02.000Z' }),
  ]);
  executed.displayOrderSeqPreferred = host(sorted.map(m => m.id));
  assert.deepEqual(executed.displayOrderSeqPreferred, ['m-c', 'm-b', 'm-a']);

  // ---- shared/private omission rules, machine-readable for Go comparison ----
  const omissionRules = {
    sharedFramesMustNotCarry: {
      receiverPrivate: ['reaction viewer snapshot', 'read state (viewer)', 'mute state (viewer prefs)'],
      viewerScopedNested: executed.omissionLedger.viewerScopedFields,
      storageOnly: executed.omissionLedger.storageOnlySealed,
      clientOnly: executed.omissionLedger.clientOnly,
    },
    commentRefSharedNull: 'a null commentRef on a shared (room-broadcast) surface is privacy-scrub, NOT a clear; only a receiver-private surface may clear it',
    wireOnlyDroppedByWebAdapter: ['readState', 'lastMessageAt'],
    sealedAtSocketBoundary: executed.omissionLedger.storageOnlySealed.concat(['senderHandle']),
  };

  return {
    area: 'canonical-message',
    executed,
    omissionRules,
    assertions: 20,
  };
}
