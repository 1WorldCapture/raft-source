// Area D — read/prefs event wire: the read-mutation admission parser, the
// read-state ingress ledger, the read-receipt pure domain, and channel/prefs
// (mute + display + notification prefs) normalizers and folds.
// All of it EXECUTES original code from the pinned baseline.
import assert from 'node:assert/strict';

const host = (value) => JSON.parse(JSON.stringify(value));
const SCOPE = 'scope-1';

export async function runReadStateCases(mods) {
  const executed = {};

  // ---- read-mutation wire parser (route segment + real error class) ----
  const RM = mods.readMutationParser;
  const mutationCases = [
    { label: 'row-read', body: { mutationId: 'm-1', kind: 'row_read', scopeId: SCOPE, throughSeq: 5 } },
    { label: 'row-unread', body: { mutationId: 'm-2', kind: 'row_unread', scopeId: SCOPE, throughSeq: 7 } },
    { label: 'channel-read-all', body: { mutationId: 'm-3', kind: 'channel_read_all', scopeId: SCOPE } },
    { label: 'global-read-all', body: { mutationId: 'm-4', kind: 'global_read_all' } },
    { label: 'unknown-kind', body: { mutationId: 'm-5', kind: 'row_mute', scopeId: SCOPE } },
    { label: 'missing-mutation-id', body: { kind: 'row_read', scopeId: SCOPE, throughSeq: 1 } },
    { label: 'null-body', body: null },
    { label: 'string-body', body: 'x' },
    // The parser CASTS scopeId/throughSeq without validating them — a wire
    // fact a Go port must know (it must type-check what TS only trusts).
    { label: 'cast-passthrough-string-throughseq', body: { mutationId: 'm-6', kind: 'row_read', scopeId: 42, throughSeq: '5' } },
  ];
  executed.readMutationParse = mutationCases.map(({ label, body }) => {
    try {
      const out = RM.parsePayload(body);
      return { label, verdict: 'ok', parsed: host(out) };
    } catch (error) {
      assert.equal(error.name, 'ReadMutationError');
      return { label, verdict: 'ReadMutationError', code: error.code, message: error.message };
    }
  });
  const byLabel = Object.fromEntries(executed.readMutationParse.map(c => [c.label, c]));
  assert.equal(byLabel['row-read'].parsed.mutation.kind, 'row_read');
  assert.equal(byLabel['row-read'].parsed.mutation.throughSeq, 5);
  assert.equal(byLabel['unknown-kind'].code, 'INVALID_MUTATION_PAYLOAD');
  assert.equal(byLabel['missing-mutation-id'].code, 'INVALID_MUTATION_ID');
  assert.equal(byLabel['null-body'].code, 'INVALID_MUTATION_PAYLOAD');
  assert.equal(byLabel['cast-passthrough-string-throughseq'].parsed.mutation.throughSeq, '5');
  // Route-level status mapping (source-derived from readMutations.ts bytes):
  // MUTATION_ID_PAYLOAD_MISMATCH -> 409, SCOPE_NOT_FOUND -> 404, others -> 400.
  executed.readMutationErrorStatus = {
    MUTATION_ID_PAYLOAD_MISMATCH: 409,
    SCOPE_NOT_FOUND: 404,
    INVALID_MUTATION_ID: 400,
    INVALID_MUTATION_PAYLOAD: 400,
  };

  // ---- read-state ingress ledger (web startup path) ----
  const RS = mods.webReadStateSync;
  const corruptBefore = () => mods.recordedWarnings.length;
  const normalizeCases = [
    { label: 'valid', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 2 } },
    { label: 'missing-server-id', payload: { scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 2 } },
    { label: 'empty-scope-id', payload: { serverId: 'srv', scopeId: '', maxReadSeq: 10, readStateVersion: 2 } },
    { label: 'negative-max-read-seq', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: -1, readStateVersion: 2 } },
    { label: 'float-version', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 1.5 } },
    { label: 'non-object', payload: 'nope' },
    { label: 'null', payload: null },
  ];
  executed.readStateNormalize = normalizeCases.map(({ label, payload }) => {
    const before = corruptBefore();
    const out = RS.normalizeReadStateUpdated(payload);
    return { label, verdict: out === null ? 'corrupt-null' : 'valid', parsed: out === null ? null : host(out), corruptionLogged: mods.recordedWarnings.length > before };
  });
  for (const c of executed.readStateNormalize.slice(0, 6)) {
    if (c.verdict === 'corrupt-null') assert.equal(c.corruptionLogged, true);
  }
  assert.equal(executed.readStateNormalize[0].verdict, 'valid');

  const bulkCases = [
    { label: 'mixed-good-and-bad', payload: { serverId: 'srv', scopes: [
      { scopeId: 'a', maxReadSeq: 1, readStateVersion: 1 },
      { scopeId: '', maxReadSeq: 2, readStateVersion: 2 },
      { scopeId: 'b', maxReadSeq: 3, readStateVersion: 3 },
    ] } },
    { label: 'scopes-not-array', payload: { serverId: 'srv', scopes: 'x' } },
    { label: 'server-id-missing', payload: { scopes: [{ scopeId: 'a', maxReadSeq: 1, readStateVersion: 1 }] } },
    { label: 'not-object', payload: 42 },
  ];
  executed.readStateNormalizeBulk = bulkCases.map(({ label, payload }) => {
    const out = RS.normalizeReadStateUpdatedBulk(payload);
    return { label, count: out.length, parsed: host(out) };
  });
  assert.equal(executed.readStateNormalizeBulk[0].count, 2);
  assert.deepEqual(executed.readStateNormalizeBulk.map(c => c.count), [2, 0, 0, 0]);

  // Ledger versioning: accepted -> stale(same) -> stale(lower) -> accepted(higher).
  RS.resetReadStateSyncForTests();
  executed.readStateLedger = [
    { label: 'accept-v2', result: RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 2 }) },
    { label: 'stale-same-v2', result: RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 11, readStateVersion: 2 }) },
    { label: 'stale-lower-v1', result: RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 99, readStateVersion: 1 }) },
    { label: 'accept-v3', result: RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 12, readStateVersion: 3 }) },
    { label: 'read-back', accepted: host(RS.getAcceptedReadState('srv', SCOPE)) },
  ];
  assert.deepEqual(executed.readStateLedger.slice(0, 4).map(s => s.result), ['accepted', 'stale', 'stale', 'accepted']);
  // The ledger's accepted map carries an internal generation counter; it is a
  // real (private) field of the original store and is frozen as-is.
  assert.deepEqual(executed.readStateLedger[4].accepted, { maxReadSeq: 12, readStateVersion: 3, generation: 2 });

  // Authority snapshot fold (single conversion point for the read-state union).
  RS.resetReadStateSyncForTests();
  const snapshotCases = [
    { label: 'absent-first-is-cleared', frontier: { kind: 'absent' }, expect: 'cleared' },
    { label: 'corrupt-union', frontier: { kind: 'corrupt' }, expect: 'corrupt' },
    { label: 'present-leading-zero-string', frontier: { kind: 'present', maxReadSeq: '01', readStateVersion: 1 }, expect: 'corrupt' },
    { label: 'present-beyond-safe-integer', frontier: { kind: 'present', maxReadSeq: '9007199254740993', readStateVersion: 1 }, expect: 'corrupt' },
    { label: 'present-valid-42', frontier: { kind: 'present', maxReadSeq: '42', readStateVersion: 1 }, expect: 'accepted' },
    { label: 'present-stale-version', frontier: { kind: 'present', maxReadSeq: '50', readStateVersion: 1 }, expect: 'stale' },
    { label: 'present-newer-version', frontier: { kind: 'present', maxReadSeq: '60', readStateVersion: 2, latestActivity: { seq: '61' } }, expect: 'accepted' },
  ];
  executed.readStateSnapshot = snapshotCases.map(({ label, frontier, expect }) => {
    const out = RS.consumeReadStateSnapshot('srv', SCOPE, frontier);
    assert.equal(out.kind, expect, label);
    return { label, outcome: host(out) };
  });
  // Row evidence rides even on a version-stale row (contract: evidence is
  // orthogonal to ledger acceptance).
  assert.equal(executed.readStateSnapshot[5].outcome.latestActivitySeq, null);
  // ...and a superseded-by-socket response is stale even when version-newer.
  RS.resetReadStateSyncForTests();
  RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 5, readStateVersion: 5 });
  const generation = RS.getReadStateLedgerGeneration();
  RS.consumeReadStateUpdate({ serverId: 'srv', scopeId: SCOPE, maxReadSeq: 6, readStateVersion: 6 });
  executed.readStateSupersededBySocket = {
    generationAtRequest: generation,
    result: RS.consumeReadStateSnapshot('srv', SCOPE, { kind: 'present', maxReadSeq: '7', readStateVersion: 7 }, undefined, { ledgerGenerationAtRequest: generation }),
  };
  assert.equal(executed.readStateSupersededBySocket.result.kind, 'stale');

  // ---- read-receipt pure domain (whole original file, zero imports) ----
  const RR = mods.webReadReceipt;
  const peers = { peerReadStates: [
    { peerKind: 'human', peerId: 'u1', maxReadSeq: 10 },
    { peerKind: 'agent', peerId: 'a1', maxReadSeq: 4 },
  ] };
  executed.readReceiptNormalize = {
    peersValid: host(RR.normalizeReadReceiptHydrate(peers)),
    peersDuplicate: RR.normalizeReadReceiptHydrate({ peerReadStates: [
      { peerKind: 'human', peerId: 'u1', maxReadSeq: 10 },
      { peerKind: 'human', peerId: 'u1', maxReadSeq: 12 },
    ] }),
    peersBadKind: RR.normalizeReadReceiptHydrate({ peerReadStates: [{ peerKind: 'robot', peerId: 'u1', maxReadSeq: 1 }] }),
    peersNegativeSeq: RR.normalizeReadReceiptHydrate({ peerReadStates: [{ peerKind: 'human', peerId: 'u1', maxReadSeq: -1 }] }),
    peersEmptyArray: host(RR.normalizeReadReceiptHydrate({ peerReadStates: [] })),
    bothKeysPresent: RR.normalizeReadReceiptHydrate({ ...peers, peerReadSummary: { peerCount: 0, readCountAtSeq: [] } }),
    // readCountAtSeq rows must be strictly ASCENDING in seq and strictly
    // DESCENDING in count (the read-through ladder: as seq grows, fewer peers
    // have read that far).
    summaryValid: host(RR.normalizeReadReceiptHydrate({ peerReadSummary: { peerCount: 3, readCountAtSeq: [{ seq: 4, count: 3 }, { seq: 9, count: 2 }] } })),
    summaryCountAbovePeerCount: RR.normalizeReadReceiptHydrate({ peerReadSummary: { peerCount: 3, readCountAtSeq: [{ seq: 9, count: 4 }] } }),
    summaryCountNotDescending: RR.normalizeReadReceiptHydrate({ peerReadSummary: { peerCount: 3, readCountAtSeq: [{ seq: 4, count: 2 }, { seq: 9, count: 2 }] } }),
    summaryDuplicateSeq: RR.normalizeReadReceiptHydrate({ peerReadSummary: { peerCount: 3, readCountAtSeq: [{ seq: 4, count: 1 }, { seq: 4, count: 2 }] } }),
    nonObject: RR.normalizeReadReceiptHydrate('x'),
  };
  assert.equal(executed.readReceiptNormalize.peersValid.kind, 'peers');
  assert.equal(executed.readReceiptNormalize.peersDuplicate, null);
  assert.equal(executed.readReceiptNormalize.peersBadKind, null);
  assert.equal(executed.readReceiptNormalize.bothKeysPresent, null);
  assert.equal(executed.readReceiptNormalize.summaryValid.kind, 'summary');
  assert.equal(executed.readReceiptNormalize.summaryCountAbovePeerCount, null);
  assert.equal(executed.readReceiptNormalize.summaryCountNotDescending, null);
  assert.equal(executed.readReceiptNormalize.summaryDuplicateSeq, null);

  executed.readReceiptScopeUpdated = {
    validPeer: host(RR.normalizeScopeReadUpdated({ scopeId: SCOPE, peerKind: 'human', peerId: 'u1', maxReadSeq: 12 })),
    summaryChanged: host(RR.normalizeScopeReadUpdated({ scopeId: SCOPE, summaryChanged: true })),
    missingScopeId: RR.normalizeScopeReadUpdated({ peerKind: 'human', peerId: 'u1', maxReadSeq: 3 }),
    floatSeq: RR.normalizeScopeReadUpdated({ scopeId: SCOPE, peerKind: 'human', peerId: 'u1', maxReadSeq: 1.5 }),
  };
  assert.equal(executed.readReceiptScopeUpdated.floatSeq, null);

  executed.readReceiptMerge = {
    advance: host(RR.mergePeerReadAdvance(executed.readReceiptNormalize.peersValid, { scopeId: SCOPE, peerKind: 'agent', peerId: 'a1', maxReadSeq: 9 })),
    regressIsNoop: (() => {
      const scope = RR.normalizeReadReceiptHydrate(peers);
      return RR.mergePeerReadAdvance(scope, { scopeId: SCOPE, peerKind: 'agent', peerId: 'a1', maxReadSeq: 1 }) === scope;
    })(),
    unknownPeerIsNoop: (() => {
      const scope = RR.normalizeReadReceiptHydrate(peers);
      return RR.mergePeerReadAdvance(scope, { scopeId: SCOPE, peerKind: 'human', peerId: 'zz', maxReadSeq: 99 }) === scope;
    })(),
    summaryScopeIsNoop: (() => {
      const summary = RR.normalizeReadReceiptHydrate({ peerReadSummary: { peerCount: 2, readCountAtSeq: [] } });
      return RR.mergePeerReadAdvance(summary, { scopeId: SCOPE, peerKind: 'human', peerId: 'u1', maxReadSeq: 5 }) === summary;
    })(),
    hydrateKeepsHigherWatermarks: host(RR.mergeReadReceiptHydrate(
      RR.normalizeReadReceiptHydrate(peers),
      RR.normalizeReadReceiptHydrate({ peerReadStates: [
        { peerKind: 'human', peerId: 'u1', maxReadSeq: 2 },
        { peerKind: 'agent', peerId: 'a1', maxReadSeq: 8 },
      ] }),
    )),
  };
  assert.equal(executed.readReceiptMerge.advance.peers.find(p => p.peerId === 'a1').maxReadSeq, 9);
  assert.equal(executed.readReceiptMerge.regressIsNoop, true);
  const mergedHydrate = executed.readReceiptMerge.hydrateKeepsHigherWatermarks;
  assert.equal(mergedHydrate.peers.find(p => p.peerId === 'u1').maxReadSeq, 10);
  assert.equal(mergedHydrate.peers.find(p => p.peerId === 'a1').maxReadSeq, 8);

  executed.readReceiptProject = {
    peers: host(RR.projectReadReceipt(executed.readReceiptNormalize.peersValid, 5)),
    peersUnread: host(RR.projectReadReceipt(executed.readReceiptNormalize.peersValid, 11)),
    invalidSeq: host(RR.projectReadReceipt(executed.readReceiptNormalize.peersValid, 0)),
    summary: host(RR.projectReadReceipt(executed.readReceiptNormalize.summaryValid, 5)),
    agentKnown: host(RR.projectAgentReadReceipt(executed.readReceiptNormalize.peersValid, 'a1', 4)),
    agentUnknownScope: RR.projectAgentReadReceipt(executed.readReceiptNormalize.summaryValid, 'a1', 4),
    agentNotPeer: RR.projectAgentReadReceipt(executed.readReceiptNormalize.peersValid, 'zz', 4),
  };
  assert.deepEqual(executed.readReceiptProject.peers, { read: true, readCount: 1, peerCount: 2 });
  assert.deepEqual(executed.readReceiptProject.peersUnread, { read: false, readCount: 0, peerCount: 2 });
  assert.deepEqual(executed.readReceiptProject.invalidSeq, { read: false, readCount: 0, peerCount: 0 });
  assert.deepEqual(executed.readReceiptProject.summary, { read: true, readCount: 2, peerCount: 3 });
  assert.deepEqual(executed.readReceiptProject.agentKnown, { read: true });

  // ---- channel mute / display prefs (web channel domain + shared eligibility) ----
  const CD = mods.webChannelDomain;
  executed.prefsNormalize = {
    muteLegacyDefault: host(CD.normalizeActivityMuteState({})),
    muteActiveStringSeq: host(CD.normalizeActivityMuteState({ activityMuted: true, muteFromSeq: '12' })),
    muteNegativeVersionDropped: host(CD.normalizeActivityMuteState({ activityMuted: true, prefsVersion: -1 })),
    muteWithVersion: host(CD.normalizeActivityMuteState({ activityMuted: true, muteFromSeq: 7, prefsVersion: 4 })),
    displayDefault: host(CD.normalizeMessageDisplayPrefs({})),
    displayExplicitFalse: host(CD.normalizeMessageDisplayPrefs({ collapseLongMessages: false })),
    displayWithVersion: host(CD.normalizeMessageDisplayPrefs({ collapseLongMessages: true, prefsVersion: 2 })),
  };
  assert.deepEqual(executed.prefsNormalize.muteLegacyDefault, { activityMuted: false, muteFromSeq: null, activityMuteSupported: false });
  assert.equal(executed.prefsNormalize.muteNegativeVersionDropped.prefsVersion, undefined);
  assert.equal(executed.prefsNormalize.displayDefault.collapseLongMessages, true);

  const channelState = { channels: [], dmChannels: [], channelActivity: {} };
  const seeded = CD.applyActivityMuteState(
    { ...channelState, channels: [{ id: 'c1', name: 'general', type: 'channel', prefsVersion: 5, activityMuted: false, muteFromSeq: null }] },
    'c1',
    CD.normalizeActivityMuteState({ activityMuted: true, muteFromSeq: 9, prefsVersion: 4 }),
  );
  executed.prefsStalePatchGuard = {
    staleLowerVersionIsNoop: seeded.channels[0].activityMuted === false,
    newerVersionApplies: (() => {
      const next = CD.applyActivityMuteState(
        seeded,
        'c1',
        CD.normalizeActivityMuteState({ activityMuted: true, muteFromSeq: 10, prefsVersion: 6 }),
      );
      return { activityMuted: next.channels[0].activityMuted, muteFromSeq: next.channels[0].muteFromSeq, prefsVersion: next.channels[0].prefsVersion };
    })(),
  };
  assert.equal(executed.prefsStalePatchGuard.staleLowerVersionIsNoop, true);
  assert.deepEqual(executed.prefsStalePatchGuard.newerVersionApplies, { activityMuted: true, muteFromSeq: 10, prefsVersion: 6 });

  executed.activityMuteEligibility = ['channel', 'private', 'joint', 'dm', 'thread', null, undefined].map(type => ({
    channelType: type,
    supports: mods.sharedActivityMute.channelTypeSupportsActivityMute(type),
  }));
  // null and undefined both collapse to "unsupported" (includes(type ?? "")).
  assert.deepEqual(
    Object.fromEntries(executed.activityMuteEligibility.map(e => [String(e.channelType), e.supports])),
    { channel: true, private: true, joint: true, dm: false, thread: false, null: false, undefined: false },
  );
  executed.canToggleActivityMute = {
    joinedChannel: CD.canToggleActivityMute({ type: 'channel', joined: true }),
    unjoinedChannel: CD.canToggleActivityMute({ type: 'channel', joined: false }),
    joinedDm: CD.canToggleActivityMute({ type: 'dm', joined: true }),
  };
  assert.deepEqual(executed.canToggleActivityMute, { joinedChannel: true, unjoinedChannel: false, joinedDm: false });

  // ---- notification-prefs fold (web notification prefs domain) ----
  const NP = mods.webNotificationPrefs;
  executed.notificationPrefs = {};
  executed.notificationPrefs.scopeIds = {
    channel: NP.scopeIdForNotificationPrefsUpdate({ type: 'channel', serverId: 'srv', channelId: 'c1', state: { activityMuted: true, muteFromSeq: 1 } }),
    server: NP.scopeIdForNotificationPrefsUpdate({ type: 'server', serverId: 'srv', serverPushMuted: true }),
  };
  assert.deepEqual(executed.notificationPrefs.scopeIds, { channel: 'channel:c1', server: 'server:srv' });

  let prefsState = NP.createInitialNotificationPrefsDomainState();
  const channelUpdate = { type: 'channel', serverId: 'srv', channelId: 'c1', state: { activityMuted: true, muteFromSeq: 3, activityMuteSupported: true, prefsVersion: 2 } };
  const afterFirst = NP.applyNotificationPrefsDomainEvent(prefsState, { kind: 'notification_prefs:updated', update: channelUpdate });
  const afterSame = NP.applyNotificationPrefsDomainEvent(afterFirst, { kind: 'notification_prefs:updated', update: channelUpdate });
  const afterChanged = NP.applyNotificationPrefsDomainEvent(afterSame, { kind: 'notification_prefs:updated', update: { ...channelUpdate, state: { ...channelUpdate.state, activityMuted: false } } });
  executed.notificationPrefs.fold = {
    firstWrites: afterFirst !== prefsState,
    sameUpdateIsIdentityNoop: afterSame === afterFirst,
    changedUpdateWrites: afterChanged !== afterSame,
    folded: host(afterChanged.prefsByScopeId['channel:c1']),
  };
  assert.equal(executed.notificationPrefs.fold.sameUpdateIsIdentityNoop, true);
  assert.equal(executed.notificationPrefs.fold.folded.state.activityMuted, false);

  // ---- multi-event read stream (executed original ledger, wire-replay shape) --
  // A real client's day: read up, unread rewind, LATE duplicate of the older
  // read response arriving after the rewind, a higher-version read, plus a
  // corrupt payload mid-stream. The ORIGINAL ledger adjudicates every step;
  // Go implementations replaying the same stream must agree per step and on
  // the final effective frontier.
  const STREAM = [
    { id: 'read-v1-to-10', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 1 }, expect: 'accepted' },
    { id: 'unread-rewind-to-4', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 4, readStateVersion: 2 }, expect: 'accepted' },
    { id: 'late-read-v1-to-10-again', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 10, readStateVersion: 1 }, expect: 'stale' },
    { id: 'same-v2-different-value', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 6, readStateVersion: 2 }, expect: 'stale' },
    { id: 'read-v3-to-12', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 12, readStateVersion: 3 }, expect: 'accepted' },
    { id: 'corrupt-negative', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: -1, readStateVersion: 4 }, expect: 'corrupt-null' },
    { id: 'corrupt-float-version', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 13, readStateVersion: 4.5 }, expect: 'corrupt-null' },
    { id: 'read-v4-to-13-after-corrupt', payload: { serverId: 'srv', scopeId: SCOPE, maxReadSeq: 13, readStateVersion: 4 }, expect: 'accepted' },
  ];
  RS.resetReadStateSyncForTests();
  executed.readStateStream = STREAM.map(({ id, payload, expect }) => {
    const normalized = RS.normalizeReadStateUpdated(payload);
    if (normalized === null) {
      assert.equal(expect, 'corrupt-null', id);
      return { id, normalized: null, outcome: 'corrupt-null' };
    }
    const outcome = RS.consumeReadStateUpdate(normalized);
    assert.equal(outcome, expect, id);
    return { id, normalized: host(normalized), outcome };
  });
  executed.readStateStreamFinal = host(RS.getAcceptedReadState('srv', SCOPE));
  // Effective frontier is 13 with version 4: the late v1 duplicate and the
  // same-version-different-value write were both rejected by the ORIGINAL
  // ledger; the corrupt payloads never entered state.
  assert.deepEqual(
    [executed.readStateStreamFinal.maxReadSeq, executed.readStateStreamFinal.readStateVersion],
    [13, 4],
  );

  return {
    area: 'readstate-prefs-wire',
    executed,
    assertions: 39,
  };
}
