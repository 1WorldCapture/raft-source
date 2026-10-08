// Area C — history coverage boundary shapes.
//
// HONEST SCOPE NOTE: `listMessagesWithCoverage` reads PostgreSQL through
// drizzle inside a repeatable-read transaction. It CANNOT be executed here
// without the original TS server and a database, so this area is a
// SOURCE-DERIVED contract, not an executed one: the boundary table below is
// derived strictly from the pinned function's own computation (each expected
// value traces to a specific line), and the function's exact bytes are
// hash-anchored so any drift invalidates the table. Real Go coverage objects
// are compared against this table later through verify-go-wire.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PINNED, readPinned, segmentOf } from './pinned-sources.mjs';

// Derivation mirrors the pinned source EXACTLY (line-anchored below):
//   chronologicalRows = after ? rows : reverse(rows)
//   firstReturnedSeq  = chronologicalRows[0]?.seq
//   remoteHighWaterSeq = max(channel seqs, 0)
//   coveredAfterSeq   = rows empty ? max(channel seqs, 0)
//                       : max(channel seqs where seq < firstReturnedSeq, 0)
//   coveredFromSeq    = enriched[0]?.seq ?? remoteHighWaterSeq + 1
//   coveredThroughSeq = enriched.at(-1)?.seq ?? remoteHighWaterSeq
//   completeThroughLatest = direction === 'latest' && coveredThroughSeq === remoteHighWaterSeq
//   hasGap = hasNewer = direction !== 'latest'
function deriveCoverage({ direction, chronologicalRowSeqs, allChannelSeqs }) {
  const remoteHighWaterSeq = Math.max(0, ...allChannelSeqs);
  const firstReturnedSeq = chronologicalRowSeqs.length > 0 ? chronologicalRowSeqs[0] : null;
  const coveredAfterSeq = firstReturnedSeq === null
    ? remoteHighWaterSeq
    : Math.max(0, ...allChannelSeqs.filter(seq => seq < firstReturnedSeq));
  const coveredFromSeq = chronologicalRowSeqs.length > 0 ? chronologicalRowSeqs[0] : remoteHighWaterSeq + 1;
  const coveredThroughSeq = chronologicalRowSeqs.length > 0
    ? chronologicalRowSeqs[chronologicalRowSeqs.length - 1]
    : remoteHighWaterSeq;
  return {
    coveredAfterSeq,
    coveredFromSeq,
    coveredThroughSeq,
    remoteHighWaterSeq,
    hasGap: direction !== 'latest',
    hasNewer: direction !== 'latest',
    completeThroughLatest: direction === 'latest' && coveredThroughSeq === remoteHighWaterSeq,
  };
}

const RANGE = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export async function runHistoryCases(mods) {
  const source = await readPinned('serverMessageService');
  const functionSegment = segmentOf(
    source,
    'export async function listMessagesWithCoverage(',
    'export async function listMessagesByIds(',
    'messageService.listMessagesWithCoverage',
  );
  const typeSegment = segmentOf(
    source,
    'export type MessageWindowCoverage = {',
    '/**\n * Read one message page',
    'messageService.MessageWindowCoverage',
  );
  const functionSha = createHash('sha256').update(functionSegment).digest('hex');
  const typeSha = createHash('sha256').update(typeSegment).digest('hex');

  // Structural gates on the pinned bytes (cheap, but they pin the shape the
  // boundary table depends on).
  for (const needle of [
    'const direction = afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest"',
    'const coveredFromSeq = enriched[0]?.seq ?? result.remoteHighWaterSeq + 1;',
    'const coveredThroughSeq = enriched.at(-1)?.seq ?? result.remoteHighWaterSeq;',
    'const completeThroughLatest = direction === "latest" && coveredThroughSeq === result.remoteHighWaterSeq;',
    'hasGap: direction !== "latest"',
    'hasNewer: direction !== "latest"',
    'filter (where ${messages.seq} < ${firstReturnedSeq})',
  ]) {
    assert.ok(functionSegment.includes(needle), `pinned coverage function lost invariant: ${needle}`);
  }

  const scenarios = [
    { id: 'latest-full-tail', direction: 'latest', chronologicalRowSeqs: [8, 9, 10], allChannelSeqs: RANGE(1, 10) },
    { id: 'latest-cutoff-narrowed', direction: 'latest', chronologicalRowSeqs: [6, 7], allChannelSeqs: RANGE(1, 10) },
    { id: 'latest-empty-channel', direction: 'latest', chronologicalRowSeqs: [], allChannelSeqs: [] },
    { id: 'latest-empty-page-all-cut-off', direction: 'latest', chronologicalRowSeqs: [], allChannelSeqs: [3, 4, 5] },
    { id: 'before-mid-page', direction: 'before', chronologicalRowSeqs: [4, 5, 6], allChannelSeqs: RANGE(1, 10) },
    { id: 'before-oldest-page', direction: 'before', chronologicalRowSeqs: [1, 2], allChannelSeqs: RANGE(1, 10) },
    { id: 'before-empty-page', direction: 'before', chronologicalRowSeqs: [], allChannelSeqs: RANGE(1, 10) },
    { id: 'after-mid-page', direction: 'after', chronologicalRowSeqs: [4, 5, 6], allChannelSeqs: RANGE(1, 10) },
    { id: 'after-empty-at-top', direction: 'after', chronologicalRowSeqs: [], allChannelSeqs: RANGE(1, 10) },
    { id: 'latest-single-message', direction: 'latest', chronologicalRowSeqs: [1], allChannelSeqs: [1] },
    // Global sequence gaps from OTHER channels must not look like local gaps:
    // this channel only holds seqs 10 and 30 of a server-wide sequence space.
    { id: 'latest-sparse-global-seqs', direction: 'latest', chronologicalRowSeqs: [10, 30], allChannelSeqs: [10, 30] },
  ].map(scenario => ({ ...scenario, expected: deriveCoverage(scenario) }));

  // Cross-check a few load-bearing expectations that must fall out of the
  // source semantics (guards against a transcription error in the table).
  const byId = Object.fromEntries(scenarios.map(s => [s.id, s]));
  assert.equal(byId['latest-full-tail'].expected.completeThroughLatest, true);
  assert.deepEqual(
    [byId['latest-empty-channel'].expected.coveredFromSeq, byId['latest-empty-channel'].expected.coveredThroughSeq],
    [1, 0],
  );
  assert.equal(byId['latest-empty-page-all-cut-off'].expected.completeThroughLatest, true);
  // Empty before-page still reports coveredAfterSeq = channel max (the filter
  // branch only applies when a row was returned).
  assert.equal(byId['before-empty-page'].expected.coveredAfterSeq, 10);
  assert.equal(byId['after-empty-at-top'].expected.coveredFromSeq, 11);
  assert.equal(byId['latest-sparse-global-seqs'].expected.completeThroughLatest, true);
  assert.equal(byId['latest-sparse-global-seqs'].expected.hasGap, false);
  for (const id of ['before-mid-page', 'after-mid-page']) {
    assert.equal(byId[id].expected.hasGap, true);
    assert.equal(byId[id].expected.hasNewer, true);
    assert.equal(byId[id].expected.completeThroughLatest, false);
  }

  // Message-page envelope literals, extracted from the pinned route bytes.
  const routeSource = await readPinned('serverMessagesRoute');
  const pageRoute = segmentOf(
    routeSource,
    'messageRouter.get("/channel/:channelId",',
    '// Send message (user sends)',
    'messages.page.route',
  );
  for (const needle of [
    'receiver_visible_messages_v1',
    'schemaVersion: 1',
    'receiverKind: "user"',
    '...page.coverage',
    'historyLimited',
    'threadSummariesByParentMessageId',
  ]) {
    assert.ok(pageRoute.includes(needle), `page envelope literal missing: ${needle}`);
  }
  const bySenderRoute = segmentOf(
    routeSource,
    '// One sender\'s messages in a channel',
    'messageRouter.get("/channel/:channelId",',
    'messages.bySender.route',
  );
  assert.ok(bySenderRoute.includes('res.json({ messages: page.messages, hasMore: page.hasMore })'));
  assert.ok(bySenderRoute.includes('the response carries no coverage'));

  return {
    area: 'history-coverage',
    sourceDerived: {
      derivation: 'source-derived, NOT executed: listMessagesWithCoverage reads PostgreSQL via drizzle; the table below is transcribed line-by-line from the pinned function and every Go comparison must come from real Go wire',
      sourceAnchor: {
        file: PINNED.serverMessageService.path,
        fileSha256: PINNED.serverMessageService.sha256,
        functionSegmentSha256: functionSha,
        typeSegmentSha256: typeSha,
        functionStartMarker: 'export async function listMessagesWithCoverage(',
      },
      coverageFieldOrder: [
        'coveredAfterSeq', 'coveredFromSeq', 'coveredThroughSeq', 'remoteHighWaterSeq',
        'hasGap', 'hasNewer', 'completeThroughLatest',
      ],
      semantics: {
        direction: 'afterSeq ? "after" : beforeSeq ? "before" : "latest" (mutually exclusive; both present is a 400 invalid_message_page_cursor)',
        coveredAfterSeq: 'max channel seq strictly below the first returned seq; channel max when the page is empty; 0 when none',
        coveredFromSeq: 'first returned seq; remoteHighWaterSeq+1 when the page is empty',
        coveredThroughSeq: 'last returned seq; remoteHighWaterSeq when the page is empty',
        hasGap: 'direction !== "latest" (non-latest pages never claim coverage)',
        hasNewer: 'direction !== "latest"',
        completeThroughLatest: 'direction === "latest" && coveredThroughSeq === remoteHighWaterSeq (an empty latest page on an empty-or-fully-cut-off channel is still complete)',
        seqDomain: 'message seq is a per-channel-ordered global SQLite AUTOINCREMENT integer; cross-channel gaps are NOT local gaps',
      },
      messagePageEnvelope: {
        shape: '{ messages, threadSummariesByParentMessageId, historyLimited, messageWindow }',
        messageWindow: {
          schemaVersion: 1,
          domain: 'receiver_visible_messages_v1',
          receiverKind: 'user',
          spreads: '...coverage (the eight coverage fields inline, not nested)',
        },
        distinctSurfaces: {
          bySender: '{ messages, hasMore } — explicitly NOT a message window; must never feed the channel history cache',
          sync: 'GET /messages/sync returns a bare JSON array of projected messages (no envelope)',
          v2Create: 'POST /api/v2/messages wraps as { message, ... }',
        },
      },
    },
    scenarios,
    assertions: 19,
  };
}
