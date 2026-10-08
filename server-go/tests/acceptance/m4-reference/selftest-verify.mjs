// Self-test for the Go-wire integration API itself.
//
// These samples are SYNTHETIC (clearly labelled selftest-*): their only job is
// to prove the verifier pipeline discriminates — correct wire passes, drifted
// wire fails. They are NOT evidence about the real Go server; that evidence
// only exists once the parent feeds recorded Go wire through the same API.
import assert from 'node:assert/strict';
import { verifyGoWireSamples } from './verify-go-wire.mjs';

const UUID = '0b2a6f3e-9c1d-4e7b-8f2a-1c3b5d7e9a01';
const SCOPE = { serverId: 'srv-1', principalId: 'p-1', filter: 'all', windowId: 'w-1' };

function canonicalMessage() {
  return {
    channelId: 'ch-1', content: 'hello', createdAt: '2026-10-01T00:00:00.000Z',
    id: UUID, messageType: 'chat', randomId: null, senderId: 'u-1', senderType: 'user',
    seq: 7, threadId: null,
    attachments: [], commentRef: null, externalAuthor: null, mentions: [], reactions: [],
    senderDescription: null, senderMembershipStatus: null, senderName: 'Ada',
    conversationContext: { channelType: 'channel' },
    actionMetadata: null,
  };
}

export async function runVerifySelfTest() {
  const { createHash } = await import('node:crypto');
  const { loadOriginalModules } = await import('./exec-original.mjs');
  const mods = await loadOriginalModules();
  const R = mods.activityRunner;

  // Build the reducer digest the same way a Go port would have to: fold the
  // steps with the ORIGINAL runner, canonicalJson, sha256.
  const steps = [
    { type: 'snapshot', requestId: 'r1', scope: SCOPE, epoch: '1', watermark: '2', activityVersion: '2',
      window: { rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true, totalCount: 0, totalUnreadCount: 0 } },
    { type: 'notModified', requestId: 'r2', scope: SCOPE, epoch: '1', watermark: '2', activityVersion: '2' },
  ];
  const core = mods.createActivitySyncCore();
  const outcomes = steps.map(step => R.applyStep(core, step));
  const scopeIds = new Set(steps.map(step => R.scopeIdOf(step)));
  const finalState = {};
  for (const id of [...scopeIds].sort()) finalState[id] = core.state('activity', id) ?? null;
  const digest = R.sha256Hex(R.canonicalJson({
    steps: outcomes.map(o => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))),
    finalState: JSON.parse(JSON.stringify(finalState, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    violations: core.violations().records.map(({ index, ...rest }) => rest),
  }));

  const samples = [
    { id: 'selftest-message-create-v1-ok', area: 'message.create.body',
      input: { version: 'v1', body: { channelId: UUID, content: 'hi' } },
      goStatus: 200, goOutput: { ...canonicalMessage() } },
    { id: 'selftest-message-create-v2-wrapped', area: 'message.create.body',
      input: { version: 'v2', body: { channelId: UUID, content: 'hi' } },
      goStatus: 200, goOutput: { message: canonicalMessage() } },
    { id: 'selftest-message-create-randomid-too-long', area: 'message.create.body',
      input: { version: 'v1', body: { channelId: UUID, content: 'hi', randomId: 'x'.repeat(129) } },
      goStatus: 400, goErrorBody: { error: 'randomId must be a non-empty string with at most 128 characters' } },
    { id: 'selftest-message-create-bad-mentions', area: 'message.create.body',
      input: { version: 'v2', body: { channelId: UUID, content: 'hi', mentions: [{ type: 'team', id: UUID, name: 'X' }] } },
      goStatus: 400, goErrorBody: { error: 'Invalid mentions payload' } },
    // Drifted wire (must FAIL): v1 returning a wrapped envelope.
    { id: 'selftest-message-create-v1-wrongly-wrapped', area: 'message.create.body',
      input: { version: 'v1', body: { channelId: UUID, content: 'hi' } },
      goStatus: 200, goOutput: { message: canonicalMessage() }, expectFail: true },
    { id: 'selftest-message-dto-messagenew-ok', area: 'message.dto',
      input: { surface: 'messageNew' }, goOutput: canonicalMessage() },
    // Drifted (must FAIL): enrichedUpdated carrying conversationContext.
    { id: 'selftest-message-dto-updated-with-context', area: 'message.dto',
      input: { surface: 'enrichedUpdated' }, goOutput: canonicalMessage(), expectFail: true },
    // Drifted (must FAIL): storage-only key leaking onto the wire.
    { id: 'selftest-message-dto-sealed-key', area: 'message.dto',
      input: { surface: 'messageNew' }, goOutput: { ...canonicalMessage(), searchText: 'leak' }, expectFail: true },
    { id: 'selftest-history-coverage-ok', area: 'history.coverage',
      input: { scenarioId: 'latest-full-tail' },
      goOutput: { coveredAfterSeq: 7, coveredFromSeq: 8, coveredThroughSeq: 10, remoteHighWaterSeq: 10, hasGap: false, hasNewer: false, completeThroughLatest: true } },
    { id: 'selftest-history-coverage-drifted', area: 'history.coverage',
      input: { scenarioId: 'latest-empty-page-all-cut-off' },
      goOutput: { coveredAfterSeq: 0, coveredFromSeq: 6, coveredThroughSeq: 5, remoteHighWaterSeq: 5, hasGap: false, hasNewer: false, completeThroughLatest: false },
      expectFail: true },
    { id: 'selftest-read-mutation-ok', area: 'read.mutation',
      input: { body: { mutationId: 'm-1', kind: 'row_read', scopeId: 's1', throughSeq: 5 } },
      goStatus: 201, goOutput: { mutation: { kind: 'row_read', scopeId: 's1', throughSeq: 5 } } },
    { id: 'selftest-read-mutation-unknown-kind', area: 'read.mutation',
      input: { body: { mutationId: 'm-2', kind: 'row_mute', scopeId: 's1' } },
      goStatus: 400, goErrorBody: { error: 'unsupported read mutation kind', code: 'INVALID_MUTATION_PAYLOAD' } },
    { id: 'selftest-read-state-accepted', area: 'read.state.event',
      input: { payload: { serverId: 'srv', scopeId: 's1', maxReadSeq: 3, readStateVersion: 1 } },
      goAccepted: true, goOutcome: 'accepted' },
    { id: 'selftest-read-state-corrupt-dropped', area: 'read.state.event',
      input: { payload: { serverId: 'srv', scopeId: 's1', maxReadSeq: -1, readStateVersion: 1 } },
      goAccepted: false },
    { id: 'selftest-read-receipt-hydrate-ok', area: 'read.receipt.hydrate',
      input: { payload: { peerReadStates: [{ peerKind: 'human', peerId: 'u1', maxReadSeq: 2 }] } },
      goOutput: { kind: 'peers', peers: [{ peerKind: 'human', peerId: 'u1', maxReadSeq: 2 }] } },
    { id: 'selftest-prefs-mute-ok', area: 'prefs.activityMute',
      input: { payload: { activityMuted: true, muteFromSeq: '4', prefsVersion: 2 } },
      goOutput: { activityMuted: true, muteFromSeq: '4', activityMuteSupported: false, prefsVersion: 2 } },
    { id: 'selftest-prefs-mute-dm-unsupported', area: 'prefs.activityMute.supported',
      input: { channelType: 'dm' }, goOutput: false },
    { id: 'selftest-activity-ingress-accept', area: 'activity.ingress',
      input: { candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '1', watermark: '5', activityVersion: '5' } },
      goVerdict: 'accept' },
    { id: 'selftest-activity-ingress-reject', area: 'activity.ingress',
      input: { candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '01', watermark: '5', activityVersion: '5' } },
      goVerdict: 'reject' },
    { id: 'selftest-activity-ingress-drifted', area: 'activity.ingress',
      input: { candidate: { type: 'notModified', requestId: 'r', scope: SCOPE, epoch: '01', watermark: '5', activityVersion: '5' } },
      goVerdict: 'accept', expectFail: true },
    { id: 'selftest-activity-uint64', area: 'activity.uint64',
      input: { value: '01' }, goVerdict: 'invalid' },
    { id: 'selftest-activity-reducer-match', area: 'activity.reducer.run',
      input: { steps }, goOutput: { digest } },
    { id: 'selftest-activity-reducer-drifted', area: 'activity.reducer.run',
      input: { steps }, goOutput: { digest: createHash('sha256').update('drifted').digest('hex') }, expectFail: true },
    // Reaction viewer-version ordering (pinned original rule).
    { id: 'selftest-reaction-versions-counter-ok', area: 'reaction.viewerVersion.stream',
      input: { events: [
        { op: 'add', viewerVersion: 1, reactedEmojis: ['👍'] },
        { op: 'remove', viewerVersion: 2, reactedEmojis: [] },
        { op: 'add', viewerVersion: 3, reactedEmojis: ['🎉'] },
        { op: 'idempotent', viewerVersion: 3, reactedEmojis: ['🎉'] },
      ] } },
    { id: 'selftest-reaction-versions-hash-regression', area: 'reaction.viewerVersion.stream',
      input: { events: [
        { op: 'add', viewerVersion: 7, reactedEmojis: ['👍'] },
        { op: 'remove', viewerVersion: 3, reactedEmojis: [] },
        { op: 'add', viewerVersion: 7, reactedEmojis: ['🎉'] },
      ] }, expectFail: true },
    // Real read stream replayed against the ORIGINAL ledger.
    { id: 'selftest-read-stream-ok', area: 'read.state.stream',
      input: { events: [
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 10, readStateVersion: 1 },
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 4, readStateVersion: 2 },
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 10, readStateVersion: 1 },
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 12, readStateVersion: 3 },
      ] },
      goOutcomes: ['accepted', 'accepted', 'stale', 'accepted'],
      goFinal: { maxReadSeq: 12, readStateVersion: 3 } },
    // Frozen actual Activity stream digest (contract-driven; needs the
    // regenerated contract, which run.mjs writes before the self-test runs).
    { id: 'selftest-activity-stream-digest-ok', area: 'activity.stream.digest',
      goOutput: { digest: await (async () => {
        const { readFile } = await import('node:fs/promises');
        const path = await import('node:path');
        const contract = JSON.parse(await readFile(
          path.join(process.cwd(), 'server-go/contracts/m4/activity-v1.contract.json'), 'utf8'));
        return contract.executed.actualStream.digest;
      })() } },
    { id: 'selftest-activity-stream-digest-drifted', area: 'activity.stream.digest',
      goOutput: { digest: createHash('sha256').update('stream-drifted').digest('hex') }, expectFail: true },
    { id: 'selftest-read-stream-late-write-wins', area: 'read.state.stream',
      input: { events: [
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 10, readStateVersion: 1 },
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 4, readStateVersion: 2 },
        { serverId: 'srv', scopeId: 's1', maxReadSeq: 10, readStateVersion: 1 },
      ] },
      goOutcomes: ['accepted', 'accepted', 'accepted', 'stale'], // Go accepted the late v1 replay
      expectFail: true },
  ];

  const report = await verifyGoWireSamples(samples);
  const byId = Object.fromEntries(report.results.map(r => [r.id, r]));
  for (const sample of samples) {
    const verdict = byId[sample.id]?.verdict;
    if (sample.expectFail) {
      assert.equal(verdict, 'fail', `${sample.id}: drifted wire MUST fail (got ${verdict})`);
    } else {
      assert.equal(verdict, 'pass', `${sample.id}: correct wire MUST pass (got ${verdict}: ${byId[sample.id]?.reason ?? ''})`);
    }
  }
  const expectedFailCount = samples.filter(s => s.expectFail).length;
  assert.equal(report.failed.length, expectedFailCount);
  return { total: report.total, passed: report.passed, failed: report.failed.length };
}
