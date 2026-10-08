// Area F+G — Activity v1: uint64 primitives, generated JSON Schema runtime
// validation, and the pure reducer driven through the real sync core for
// snapshot / difference / notModified / frame / readStateUpdated.
//
// Everything executes ORIGINAL code: the uint64 module, the reducer + core,
// the contract's own behavior-runner functions, and the frozen contract
// vectors are replayed through the REAL generated JSON Schema with the same
// ajv the contract packet itself uses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PINNED, repoRoot } from './pinned-sources.mjs';
import { loadActivityJsonSchema } from './exec-original.mjs';

// Sync-core sequences are BigInt; freeze them as canonical decimal strings
// (the same policy the contract's own canonicalJson applies).
const host = (value) => JSON.parse(JSON.stringify(
  value,
  (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner),
));

const SCOPE = { serverId: 'srv-1', principalId: 'p-1', filter: 'all', windowId: 'w-1' };
const scopeId = JSON.stringify([SCOPE.serverId, SCOPE.principalId, SCOPE.filter, SCOPE.windowId]);

function row(rowId, rowVersion, overrides = {}) {
  return {
    type: 'channel', rowId, rowVersion,
    channelId: 'ch-1', channelName: 'general', channelKind: 'channel',
    lastMessageId: 'm-1', lastMessagePreview: 'p', lastMessageSenderKind: 'user',
    lastMessageSenderId: 'u-1', lastMessageSenderName: 'Ada',
    latestActivitySeq: rowVersion, lastActivityAt: '2026-10-01T00:00:00.000Z',
    unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null,
    maxReadSeq: '0', readStateVersion: '0',
    ...overrides,
  };
}

function snapshotIngress(overrides = {}) {
  return {
    type: 'snapshot', requestId: 'req-1', scope: SCOPE, epoch: '1',
    watermark: '3', activityVersion: '3',
    window: { rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 0, totalUnreadCount: 0 },
    ...overrides,
  };
}

export async function runActivityCases(mods) {
  const executed = {};

  // ===================== uint64 primitives (executed) =====================
  const U = mods.uint64;
  const uint64Inputs = ['0', '1', '00', '01', '9', '10', '9007199254740992', '9007199254740993',
    '18446744073709551615', '18446744073709551616', '-1', '+1', '', ' 1', '1 ', '0x1', 1, null];
  executed.uint64 = {
    isUInt64String: uint64Inputs.map(value => ({
      input: typeof value === 'string' ? value : { typeof: typeof value },
      verdict: U.isUInt64String(value) ? 'valid' : 'invalid',
    })),
    compare: [
      ['0', '0', 0], ['1', '0', 1], ['0', '1', -1],
      ['9', '10', -1], ['10', '9', 1], ['2', '10', -1],
      ['9007199254740992', '9007199254740993', -1],
      ['18446744073709551615', '18446744073709551616', -1],
      ['123456789012345678901', '123456789012345678902', -1],
    ].map(([left, right, expect]) => {
      const actual = U.compareUInt64String(left, right);
      assert.equal(actual, expect, `compare(${left},${right})`);
      return { left, right, result: actual };
    }),
  };
  assert.deepEqual(
    Object.fromEntries(executed.uint64.isUInt64String.slice(0, 17).map(c => [typeof c.input === 'string' ? c.input : c.input.typeof, c.verdict])),
    { '0': 'valid', '1': 'valid', '00': 'invalid', '01': 'invalid', '9': 'valid', '10': 'valid',
      '9007199254740992': 'valid', '9007199254740993': 'valid', '18446744073709551615': 'valid',
      '18446744073709551616': 'valid', '-1': 'invalid', '+1': 'invalid', '': 'invalid',
      ' 1': 'invalid', '1 ': 'invalid', '0x1': 'invalid', number: 'invalid' },
  );

  // ===================== JSON Schema leg (real ajv + real schema) ==========
  const requireFromSyncCore = createRequire(path.join(repoRoot, 'packages/sync-core/package.json'));
  const Ajv2020 = requireFromSyncCore('ajv/dist/2020.js');
  const bundle = await loadActivityJsonSchema();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(bundle, 'activity-sync.schema.json');
  const validateIngress = ajv.getSchema('ActivityIngress.json');
  const validateIntent = ajv.getSchema('ActivityIntent.json');
  assert.ok(validateIngress && validateIntent);
  executed.schemaStructural = {
    ingressBranchCount: bundle.$defs ? (() => {
      const defs = Object.values(bundle.$defs).filter(d => d && typeof d === 'object' && typeof d.$id === 'string');
      const ingress = defs.find(d => d.$id === 'ActivityIngress.json');
      return ingress.oneOf.length;
    })() : null,
    uint64Pattern: bundle.$defs.UInt64String.pattern,
  };
  assert.equal(executed.schemaStructural.ingressBranchCount, 7);
  assert.equal(executed.schemaStructural.uint64Pattern, '^(0|[1-9][0-9]*)$');

  // Replay the packet's OWN frozen contract vectors through the real schema;
  // the ajv verdict must equal the frozen expectation for every vector.
  const vectorsBytes = await readFile(path.join(repoRoot, PINNED.activityContractVectors.path), 'utf8');
  const vectors = vectorsBytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  executed.contractVectorReplay = vectors.map(vector => {
    const candidate = vector.candidate;
    const validate = candidate && (candidate.type === 'ensureWindow' || candidate.type === 'refresh'
      || candidate.type === 'loadMore' || candidate.type === 'markChannelReadAll'
      || candidate.type === 'markInboxReadAll' || candidate.type === 'markThreadDone'
      || candidate.type === 'markInboxDone') ? validateIntent : validateIngress;
    const ajvVerdict = validate(candidate) ? 'accept' : 'reject';
    assert.equal(ajvVerdict, vector.expectation.validator,
      `vector ${vector.vectorId}: ajv ${ajvVerdict} != frozen expectation ${vector.expectation.validator}`);
    return { vectorId: vector.vectorId, constraintClass: vector.constraintClass, validatorVerdict: ajvVerdict };
  });
  assert.equal(executed.contractVectorReplay.length >= 13, true);

  // Authored boundary candidates against the same real schema.
  const boundaryCandidates = [
    { id: 'notModified-happy', candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '5', activityVersion: '5' }, expect: 'accept' },
    { id: 'epoch-leading-zero', candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '01', watermark: '5', activityVersion: '5' }, expect: 'reject' },
    { id: 'epoch-as-number', candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: 1, watermark: '5', activityVersion: '5' }, expect: 'reject' },
    { id: 'watermark-empty-string', candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '', activityVersion: '5' }, expect: 'reject' },
    { id: 'notModified-sealed-extra-key', candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '5', activityVersion: '5', extra: 1 }, expect: 'reject' },
    { id: 'wrong-discriminator', candidate: { type: 'notmodified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '5', activityVersion: '5' }, expect: 'reject' },
    { id: 'uint64-beyond-js-safe-accepted', candidate: snapshotIngress({ watermark: '9007199254740993', activityVersion: '9007199254740993' }), expect: 'accept' },
    { id: 'rowVersion-leading-zero-rejected', candidate: snapshotIngress({ window: { rows: [row('r1', '01')], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 1, totalUnreadCount: 0 } }), expect: 'reject' },
    { id: 'rowVersion-as-number-rejected', candidate: snapshotIngress({ window: { rows: [row('r1', 5)], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 1, totalUnreadCount: 0 } }), expect: 'reject' },
    { id: 'rowVersion-negative-rejected', candidate: snapshotIngress({ window: { rows: [row('r1', '-1')], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 1, totalUnreadCount: 0 } }), expect: 'reject' },
    { id: 'difference-nextFromSeq-null-accepted', candidate: { type: 'difference', requestId: 'r', scope: SCOPE, epoch: '1', fromSeq: '1', toSeq: '2', activityVersion: '2', rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 0, totalUnreadCount: 0, nextFromSeq: null }, expect: 'accept' },
    { id: 'difference-nextFromSeq-zero-accepted', candidate: { type: 'difference', requestId: 'r', scope: SCOPE, epoch: '1', fromSeq: '0', toSeq: '2', activityVersion: '2', rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 0, totalUnreadCount: 0, nextFromSeq: '0' }, expect: 'accept' },
    { id: 'markThreadDone-zero-throughSeq-rejected', candidate: { type: 'markThreadDone', scope: SCOPE, commandId: 'c1', threadChannelId: 't1', throughActivitySeq: '0', frontierSpace: 'storage' }, expect: 'reject' },
    { id: 'filter-wrong-case-rejected', candidate: { type: 'notModified', requestId: 'r', scope: { ...SCOPE, filter: 'ALL' }, epoch: '1', watermark: '5', activityVersion: '5' }, expect: 'reject' },
  ];
  executed.schemaBoundary = boundaryCandidates.map(({ id, candidate, expect }) => {
    const validate = candidate.type === 'markThreadDone' ? validateIntent : validateIngress;
    const verdict = validate(candidate) ? 'accept' : 'reject';
    assert.equal(verdict, expect, `boundary candidate ${id}`);
    return { id, verdict };
  });
  // 10 rejects / 4 accepts among the 14 boundary candidates.
  assert.equal(executed.schemaBoundary.filter(c => c.verdict === 'reject').length, 10);

  // ============ reducer: replay frozen behavior vectors (executed) =========
  const R = mods.activityRunner;
  const behaviorBytes = await readFile(path.join(repoRoot, PINNED.activityBehaviorVectors.path), 'utf8');
  const envelopes = behaviorBytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const behaviorResults = envelopes.map(envelope => {
    const result = R.runCase(envelope);
    return { caseId: envelope.caseId, digest: R.sha256Hex(R.canonicalJson(result)) };
  });
  const behaviorAggregate = R.sha256Hex(
    R.canonicalJson(envelopes.map(envelope => R.runCase(envelope))),
  );
  executed.behaviorVectors = {
    vectorsSha256: R.sha256Hex(behaviorBytes),
    caseCount: envelopes.length,
    cases: behaviorResults,
    aggregateDigest: behaviorAggregate,
    branches: [...R.SEQUENCED_INGRESS_BRANCHES],
  };
  // manifest.json has canonicalBehaviorResultSha256: null — this freeze is the
  // first recorded digest, produced by the ORIGINAL runner on ORIGINAL vectors.
  assert.equal(executed.behaviorVectors.vectorsSha256, PINNED.activityBehaviorVectors.sha256);
  assert.equal(new Set(envelopes.map(e => e.contractVersion !== undefined ? e.contractVersion : 1)).size, 1);
  const manifest = JSON.parse(await readFile(path.join(repoRoot, PINNED.activityManifest.path), 'utf8'));
  assert.equal(manifest.behaviorVectorsSha256, PINNED.activityBehaviorVectors.sha256);
  assert.equal(manifest.canonicalBehaviorResultSha256, null);

  // ============ reducer: authored sequences through the real core ==========
  const core = mods.createActivitySyncCore();
  const step = (ingress) => host(R.applyStep(core, ingress));
  const state = () => host(core.state('activity', scopeId));
  const violations = () => host(core.violations().records.map(({ index, ...rest }) => rest));
  const pending = () => host(core.pendingRequests());

  const authored = [];
  // All assertions address steps BY ID, never by array index.
  const byId = () => Object.fromEntries(authored.map(a => [a.id, a]));

  // 1. Snapshot baseline, then a STALE same-epoch snapshot is a no-op that
  //    records a version_regression violation and never rolls back.
  let core1 = mods.createActivitySyncCore();
  authored.push({ id: 'snapshot-baseline', outcome: host(R.applyStep(core1, snapshotIngress())) })
  authored.push({ id: 'snapshot-stale-same-epoch', outcome: host(R.applyStep(core1, snapshotIngress({ watermark: '1', activityVersion: '1' }))) });
  authored.push({ id: 'snapshot-stale-violations', violations: host(core1.violations().records.map(({ index, ...rest }) => rest)) });
  assert.equal(byId()['snapshot-stale-same-epoch'].outcome.kind, 'duplicate_dropped');
  assert.equal(byId()['snapshot-stale-violations'].violations[0].kind, 'version_regression');

  // 2. notModified is a recorded no-op observable (runnerProtocol 1).
  const core2 = mods.createActivitySyncCore();
  const notModified = { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '0', activityVersion: '0' };
  authored.push({ id: 'notModified-observable', outcome: host(R.applyStep(core2, notModified)) });
  assert.deepEqual(byId()['notModified-observable'].outcome, { kind: 'not_modified', scopeId });

  // 3. Difference pages apply through the real runner adapter. NOTE an honest
  //    runnerProtocol-1 fact: applyStep's difference branch does NOT map
  //    ingress.hasMore onto the core's `partial` flag, so a hasMore page is
  //    still folded as a COMPLETE difference (requests cleared, applied).
  //    Frozen as observed original behavior — a Go port fed the same ingress
  //    must agree with THIS, not with the OpenAPI prose.
  const core3 = mods.createActivitySyncCore();
  const difference = { type: 'difference', requestId: 'r', scope: SCOPE, epoch: '1', fromSeq: '0', toSeq: '2', activityVersion: '2',
    rows: [row('r1', '5'), row('r2', '7')], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 2, totalUnreadCount: 0, nextFromSeq: null };
  authored.push({ id: 'difference-applies', outcome: host(R.applyStep(core3, difference)) });
  assert.equal(byId()['difference-applies'].outcome.kind, 'applied');
  authored.push({ id: 'difference-state', state: host(core3.state('activity', scopeId)) });
  assert.equal(byId()['difference-state'].state.rows.length, 2);
  const hasMoreDifference = { ...difference, requestId: 'r2', toSeq: '4', fromSeq: '2', hasMore: true, nextFromSeq: '4' };
  authored.push({ id: 'difference-hasmore-folded-complete', outcome: host(R.applyStep(core3, hasMoreDifference)), pending: host(core3.pendingRequests()) });
  assert.equal(byId()['difference-hasmore-folded-complete'].outcome.kind, 'applied');
  assert.equal(byId()['difference-hasmore-folded-complete'].pending.length, 0);
  // The core DOES honor partial when a host maps it (the raw API stays
  // available); pin that half with a direct core call so the distinction is
  // explicit rather than implied.
  const partialOutcome = core3.ingestDifference('activity', {
    scopeId, epoch: '1', fromSeq: 4n, toSeq: 6n,
    events: [{ seq: 6n, event: { type: 'frame', rows: [], tombstones: [], activityVersion: '6' } }],
    partial: true,
  });
  authored.push({ id: 'core-partial-difference-regenerates-request', outcome: host(partialOutcome), pending: host(core3.pendingRequests()) });
  assert.equal(byId()['core-partial-difference-regenerates-request'].outcome.kind, 'gap_repair_requested');
  assert.ok(byId()['core-partial-difference-regenerates-request'].pending.some(p => p.kind === 'difference'));

  // 4. Contiguous density needs a snapshot baseline: a LONE frame before any
  //    baseline is stop-gated with a snapshot request (it cannot be ordered);
  //    after a baseline, a contiguous frame applies and a gapped frame is
  //    stop-gated with a difference request.
  const core4 = mods.createActivitySyncCore();
  authored.push({ id: 'frame-without-baseline', outcome: host(R.applyStep(core4, { type: 'frame', scope: SCOPE, epoch: '1', seq: '1', activityVersion: '1', rows: [row('r1', '1')], tombstones: [] })), pending: host(core4.pendingRequests()) });
  assert.equal(byId()['frame-without-baseline'].outcome.kind, 'gap_repair_requested');
  assert.equal(byId()['frame-without-baseline'].outcome.fromSeq, '0');
  assert.ok(byId()['frame-without-baseline'].pending.some(p => p.kind === 'snapshot'));
  authored.push({ id: 'frame-baseline-snapshot', outcome: host(R.applyStep(core4, snapshotIngress({ watermark: '2', activityVersion: '2', window: { rows: [row('r1', '1')], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 1, totalUnreadCount: 0 } }))) });
  assert.equal(byId()['frame-baseline-snapshot'].outcome.kind, 'applied');
  authored.push({ id: 'frame-3-applies', outcome: host(R.applyStep(core4, { type: 'frame', scope: SCOPE, epoch: '1', seq: '3', activityVersion: '3', rows: [row('r3', '3')], tombstones: [] })) });
  assert.equal(byId()['frame-3-applies'].outcome.kind, 'applied');
  authored.push({ id: 'frame-gap-5', outcome: host(R.applyStep(core4, { type: 'frame', scope: SCOPE, epoch: '1', seq: '5', activityVersion: '5', rows: [row('r5', '5')], tombstones: [] })), pending: host(core4.pendingRequests()) });
  assert.equal(byId()['frame-gap-5'].outcome.kind, 'gap_repair_requested');
  assert.equal(byId()['frame-gap-5'].outcome.fromSeq, '4');
  assert.equal(byId()['frame-gap-5'].outcome.toSeq, '4');
  authored.push({ id: 'frame-gap-state-unchanged', state: host(core4.state('activity', scopeId)) });
  assert.equal(byId()['frame-gap-state-unchanged'].state.rows.length, 2);

  // 5. Same seq, same fingerprint -> duplicate_dropped, no violation; same seq,
  //    different fact -> producer_version_conflict + snapshot request.
  const core5 = mods.createActivitySyncCore();
  authored.push({ id: 'frame-seq-baseline', outcome: host(R.applyStep(core5, snapshotIngress({ watermark: '0', activityVersion: '0' }))) });
  assert.equal(byId()['frame-seq-baseline'].outcome.kind, 'applied');
  const frameA = { type: 'frame', scope: SCOPE, epoch: '1', seq: '1', activityVersion: '1', rows: [row('r1', '1', { unreadCount: 0 })], tombstones: [] };
  authored.push({ id: 'frame-first-apply', outcome: host(R.applyStep(core5, frameA)) });
  authored.push({ id: 'frame-identical-replay', outcome: host(R.applyStep(core5, { ...frameA })) });
  assert.equal(byId()['frame-identical-replay'].outcome.kind, 'duplicate_dropped');
  const frameB = { type: 'frame', scope: SCOPE, epoch: '1', seq: '1', activityVersion: '1', rows: [row('r1', '1', { unreadCount: 9 })], tombstones: [] };
  authored.push({ id: 'frame-same-seq-different-fact', outcome: host(R.applyStep(core5, frameB)), violations: host(core5.violations().records.map(({ index, ...rest }) => rest)), pending: host(core5.pendingRequests()) });
  assert.equal(byId()['frame-same-seq-different-fact'].outcome.kind, 'violation');
  assert.equal(byId()['frame-same-seq-different-fact'].violations[0].kind, 'producer_version_conflict');
  authored.push({ id: 'conflict-state-kept-first-fact', state: host(core5.state('activity', scopeId)) });
  assert.equal(byId()['conflict-state-kept-first-fact'].state.rows[0].unreadCount, 0);

  // 6. Tombstone monotonicity: buried row stays buried for <= versions and
  //    resurrects only for strictly newer row versions.
  const core6 = mods.createActivitySyncCore();
  authored.push({ id: 'tombstone-baseline', outcome: host(R.applyStep(core6, snapshotIngress({ watermark: '0', activityVersion: '0' }))) });
  authored.push({ id: 'tombstone-buries-row', outcome: host(R.applyStep(core6, { type: 'frame', scope: SCOPE, epoch: '1', seq: '1', activityVersion: '1', rows: [row('r1', '2')], tombstones: [] })) });
  authored.push({ id: 'tombstone-v5', outcome: host(R.applyStep(core6, { type: 'frame', scope: SCOPE, epoch: '1', seq: '2', activityVersion: '2', rows: [], tombstones: [{ rowId: 'r1', rowVersion: '5', reason: 'done' }] })) });
  authored.push({ id: 'older-row-cannot-resurrect', outcome: host(R.applyStep(core6, { type: 'frame', scope: SCOPE, epoch: '1', seq: '3', activityVersion: '3', rows: [row('r1', '5')], tombstones: [] })), state: host(core6.state('activity', scopeId)) });
  assert.equal(byId()['older-row-cannot-resurrect'].state.rows.length, 0);
  authored.push({ id: 'newer-row-resurrects', outcome: host(R.applyStep(core6, { type: 'frame', scope: SCOPE, epoch: '1', seq: '4', activityVersion: '4', rows: [row('r1', '6')], tombstones: [] })), state: host(core6.state('activity', scopeId)) });
  assert.equal(byId()['newer-row-resurrects'].state.rows.length, 1);

  // 7. readStateUpdated: versioned register — stale echoes ignored, newer
  //    versions advance the row's maxReadSeq/readStateVersion.
  const core7 = mods.createActivitySyncCore();
  authored.push({ id: 'readstate-seed', outcome: host(R.applyStep(core7, snapshotIngress({ watermark: '1', activityVersion: '1', window: { rows: [row('r1', '2', { maxReadSeq: '0', readStateVersion: '1' })], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 1, totalUnreadCount: 0 } }))) });
  authored.push({ id: 'readstate-stale-echo', outcome: host(R.applyStep(core7, { type: 'readStateUpdated', scope: SCOPE, epoch: '1', seq: '2', activityVersion: '2', updates: [{ scopeId: 'r1', channelId: 'ch-1', maxReadSeq: '9', readStateVersion: '1' }] })), state: host(core7.state('activity', scopeId)) });
  assert.equal(byId()['readstate-stale-echo'].state.rows[0].maxReadSeq, '0');
  authored.push({ id: 'readstate-newer-applies', outcome: host(R.applyStep(core7, { type: 'readStateUpdated', scope: SCOPE, epoch: '1', seq: '3', activityVersion: '3', updates: [{ scopeId: 'r1', channelId: 'ch-1', maxReadSeq: '12', readStateVersion: '4' }] })), state: host(core7.state('activity', scopeId)) });
  assert.equal(byId()['readstate-newer-applies'].state.rows[0].maxReadSeq, '12');
  assert.equal(byId()['readstate-newer-applies'].state.rows[0].readStateVersion, '4');

  // 8. uint64 exactness at 2^53: adjacent positions stay distinct through the
  //    core (BigInt seqs), and a genuine gap between them is still detected.
  const core8 = mods.createActivitySyncCore();
  authored.push({ id: 'exact-2p53', outcome: host(R.applyStep(core8, snapshotIngress({ watermark: '9007199254740992', activityVersion: '9007199254740992' }))) });
  authored.push({ id: 'exact-2p53-plus-one-applies', outcome: host(R.applyStep(core8, { type: 'frame', scope: SCOPE, epoch: '1', seq: '9007199254740993', activityVersion: '9007199254740993', rows: [], tombstones: [] })) });
  assert.equal(byId()['exact-2p53-plus-one-applies'].outcome.kind, 'applied');
  authored.push({ id: 'exact-gap-detected', outcome: host(R.applyStep(core8, { type: 'frame', scope: SCOPE, epoch: '1', seq: '9007199254740995', activityVersion: '9007199254740995', rows: [], tombstones: [] })) });
  assert.equal(byId()['exact-gap-detected'].outcome.kind, 'gap_repair_requested');

  // 9. Cross-epoch arrival: rebaseline requested + violation recorded.
  const core9 = mods.createActivitySyncCore();
  authored.push({ id: 'epoch-1-baseline', outcome: host(R.applyStep(core9, snapshotIngress())) });
  authored.push({ id: 'epoch-2-frame-rebaselines', outcome: host(R.applyStep(core9, { type: 'frame', scope: SCOPE, epoch: '2', seq: '4', activityVersion: '4', rows: [], tombstones: [] })), violations: host(core9.violations().records.map(({ index, ...rest }) => rest)), pending: host(core9.pendingRequests()) });
  assert.equal(byId()['epoch-2-frame-rebaselines'].outcome.kind, 'epoch_rebaseline_requested');
  assert.equal(byId()['epoch-2-frame-rebaselines'].violations[0].kind, 'cross_epoch_arrival');

  // 10. The fold is TOTAL: unknown event types leave state untouched; a row
  //     missing required uint64 fields is skipped (not stored, not thrown).
  const F = mods.activityDomain;
  const initial = F.initialActivityState();
  const untouched = F.foldActivityEvent(initial, { type: 'mystery' });
  authored.push({ id: 'fold-unknown-event-total', identityPreserved: untouched === initial });
  assert.equal(byId()['fold-unknown-event-total'].identityPreserved, true);
  const partialRowFold = F.foldActivityEvent(initial, { type: 'frame', rows: [{ rowId: 'x', rowVersion: '1' }], tombstones: [] });
  authored.push({ id: 'fold-partial-row-skipped', rowsStored: host(partialRowFold.rows), note: 'isRow guards maxReadSeq/readStateVersion/lastActivityAt/type — a partial row never enters state' });
  assert.equal(byId()['fold-partial-row-skipped'].rowsStored.length, 0);
  const missingFieldRow = row('r9', '1');
  delete missingFieldRow.maxReadSeq;
  const droppedRow = F.foldActivityEvent(initial, { type: 'frame', rows: [missingFieldRow], tombstones: [] });
  assert.equal(droppedRow.rows.length, 0);

  executed.authoredSequences = authored;

  // Freeze runner-protocol facts the Go side must reproduce.
  executed.runnerProtocol = {
    sequencedBranches: [...R.SEQUENCED_INGRESS_BRANCHES],
    unsequencedBranches: ['commandReceipt', 'commandRejected — the frozen contract gives them no seq; runnerProtocol 1 refuses to sequence them'],
    notModified: 'recorded no-op observable { kind: "not_modified", scopeId }',
  };

  // ============ actual stream: message -> read -> done -> difference ========
  // A frozen, realistic end-to-end ingress sequence a Go port must be able to
  // replay byte-identically: baseline snapshot, a new message frame, the
  // reader's read-state advance, a Done tombstone, then the difference page
  // that redelivers the whole (afterWatermark, currentWatermark] range.
  const actualStreamSteps = [
    snapshotIngress({ watermark: '2', activityVersion: '2', window: { rows: [row('row-ch-1', '1', { maxReadSeq: '0', readStateVersion: '0' }), row('row-th-1', '1', { type: 'thread', maxReadSeq: '0', readStateVersion: '0' })], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 2, totalUnreadCount: 0 } }),
    { type: 'frame', scope: SCOPE, epoch: '1', seq: '3', activityVersion: '3',
      rows: [row('row-ch-1', '2', { unreadCount: 1, latestActivitySeq: '2', lastMessageId: 'm-2', lastMessagePreview: 'new message' })], tombstones: [] },
    { type: 'readStateUpdated', scope: SCOPE, epoch: '1', seq: '4', activityVersion: '4',
      updates: [{ scopeId: 'row-ch-1', channelId: 'ch-1', maxReadSeq: '2', readStateVersion: '5' }] },
    { type: 'frame', scope: SCOPE, epoch: '1', seq: '5', activityVersion: '5',
      rows: [], tombstones: [{ rowId: 'row-th-1', rowVersion: '3', reason: 'done' }] },
  ];
  const streamCore = mods.createActivitySyncCore();
  const streamOutcomes = actualStreamSteps.map(step => host(R.applyStep(streamCore, step)));
  const streamFinal = host(streamCore.state('activity', scopeId));
  executed.actualStream = {
    description: 'snapshot(baseline 2 rows) -> new-message frame -> readStateUpdated advance -> done tombstone; then a difference replay of (2,5]',
    steps: actualStreamSteps,
    perStepOutcomes: streamOutcomes,
    finalState: streamFinal,
    // The original reducer's terminal state for this exact input, canonical
    // digest included: a Go fold of the SAME steps must produce the same
    // canonical bytes (verify-go-wire area activity.stream.digest). The digest
    // object uses the SAME shape as activity.reducer.run / the README recipe:
    // { steps, finalState: { [scopeId]: state }, violations }.
    digest: R.sha256Hex(R.canonicalJson({
      steps: streamOutcomes,
      finalState: { [scopeId]: streamFinal },
      violations: streamCore.violations().records.map(({ index, ...rest }) => rest),
    })),
    replayDifference: (() => {
      // After the stream, a difference over (2,5] must re-apply in order and
      // converge to the same state (the contiguous repair path).
      const repair = mods.createActivitySyncCore();
      const out = R.applyStep(repair, {
        type: 'difference', requestId: 'repair', scope: SCOPE, epoch: '1',
        fromSeq: '2', toSeq: '5', activityVersion: '5',
        rows: [row('row-ch-1', '2', { unreadCount: 0, maxReadSeq: '2', readStateVersion: '5', latestActivitySeq: '2', lastMessageId: 'm-2', lastMessagePreview: 'new message' })],
        tombstones: [{ rowId: 'row-th-1', rowVersion: '3', reason: 'done' }],
        nextCursor: null, hasMore: false, complete: true, totalCount: 2, totalUnreadCount: 0, nextFromSeq: null,
      });
      return { outcome: host(out), finalRows: host(repair.state('activity', scopeId)).rows.length };
    })(),
  };
  assert.equal(executed.actualStream.digest.length, 64);
  assert.equal(executed.actualStream.replayDifference.finalRows, 1);

  return {
    area: 'activity-v1',
    executed,
    assertions: 42,
  };
}
