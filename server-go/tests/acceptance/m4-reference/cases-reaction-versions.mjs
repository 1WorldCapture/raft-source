// Reaction viewer/discussion version ordering — frozen from the ORIGINAL web
// reducer (packages/web/src/store/reactionReadModels.ts:387-401, pinned).
//
// The original consumer's rule is NUMERIC and per-(principal,server,message):
//   viewerVersion < current          -> stale (dropped, state untouched)
//   viewerVersion == current
//     && same canonical emojis       -> duplicate (no-op)
//     && different emojis            -> CONFLICT (recorded, state untouched)
//   viewerVersion > current          -> applied
// A server that derives the version from a state HASH (Go reaction.go today)
// can repeat or decrease it across add/remove/add — both directions are wire
// drift the original client detects as stale/conflict storms.
//
// The rule lives inside a zustand store (not extractable like the pure folds),
// so the CONTRACT here is the pinned source segment plus its two mathematically
// checkable invariants; the verifier enforces exactly those invariants on Go
// wire samples. Nothing is claimed as "executed" — derivation is explicit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PINNED, readPinned, segmentOf } from './pinned-sources.mjs';

// The invariants, exactly as the pinned reducer (lines 387-401 of the pinned
// file) enforces them. Exported for the Go-wire verifier — same file, same
// rule, no second implementation anywhere.
function checkTrace(events) {
  const violations = [];
  let current; // {version, emojis}
  for (const [index, event] of events.entries()) {
    const canonical = [...event.reactedEmojis].sort().join('\u0000');
    if (current !== undefined) {
      if (event.viewerVersion < current.version) {
        violations.push({ index, op: event.op, kind: 'stale', detail: `version ${event.viewerVersion} < current ${current.version}` });
        continue; // original drops it; state untouched
      }
      if (event.viewerVersion === current.version && canonical !== current.emojis) {
        violations.push({ index, op: event.op, kind: 'equal-version-different-payload', detail: `version ${event.viewerVersion} repeated with different payload` });
        continue; // original records a conflict; state untouched
      }
    }
    current = { version: event.viewerVersion, emojis: canonical };
  }
  return violations;
}


export async function runReactionVersionCases() {
  const source = await readPinned('webReactionReadModels');
  const ruleSegment = segmentOf(
    source,
    'const currentVersion = state.viewerVersions.get(messageKey);',
    'set((current) => {',
    'reactionReadModels.viewerVersionRule',
  );
  for (const needle of [
    'snapshot.viewerVersion < currentVersion',
    'return { kind: "stale" };',
    'currentVersion === snapshot.viewerVersion',
    'return { kind: "duplicate" };',
    'reason: "equal-version-different-payload"',
  ]) {
    assert.ok(ruleSegment.includes(needle), `pinned viewer-version rule lost: ${needle}`);
  }

  // Executable check over the frozen rule: the canonical add/remove/add trace
  // a Go server MUST be able to emit, versus what a hash-derived version
  // cannot guarantee. We verify the invariants directly on sample traces.
  const canonicalTrace = (startVersion) => [
    { op: 'add', viewerVersion: startVersion + 1, reactedEmojis: ['👍'] },
    { op: 'remove', viewerVersion: startVersion + 2, reactedEmojis: [] },
    { op: 'add', viewerVersion: startVersion + 3, reactedEmojis: ['🎉'] },
    { op: 'add-idempotent', viewerVersion: startVersion + 3, reactedEmojis: ['🎉'] },
    { op: 'two-users', viewerVersion: startVersion + 4, reactedEmojis: ['👍', '🎉'] },
  ];
  const hashLikeTrace = [
    { op: 'add', viewerVersion: 7, reactedEmojis: ['👍'] },
    { op: 'remove', viewerVersion: 3, reactedEmojis: [] },      // hash went DOWN
    { op: 'add', viewerVersion: 7, reactedEmojis: ['🎉'] },      // hash repeated, payload differs
  ];

  // checkTrace is the module-scope frozen rule above (also exported for the
  // verifier); the traces below are checked against THAT definition.
  const canonicalViolations = checkTrace(canonicalTrace(0));
  const hashViolations = checkTrace(hashLikeTrace);
  assert.equal(canonicalViolations.length, 0, 'a persistent-counter trace must be clean');
  assert.equal(hashViolations.length, 2, 'a hash-derived trace must trip stale + conflict');
  assert.equal(hashViolations[0].kind, 'stale');
  assert.equal(hashViolations[1].kind, 'equal-version-different-payload');

  return {
    area: 'reaction-versions',
    sourceDerived: {
      derivation: 'source-derived rule check (the rule sits inside a zustand store; the verifier enforces its two invariants on Go wire samples — no execution of the store is claimed)',
      sourceAnchor: {
        file: PINNED.webReactionReadModels.path,
        fileSha256: PINNED.webReactionReadModels.sha256,
        ruleSegmentSha256: createHash('sha256').update(ruleSegment).digest('hex'),
        ruleStartMarker: 'const currentVersion = state.viewerVersions.get(messageKey);',
      },
      rule: {
        lowerVersion: 'stale — dropped, viewer state untouched',
        equalVersionSamePayload: 'duplicate — no-op',
        equalVersionDifferentPayload: 'conflict "equal-version-different-payload" — recorded, state untouched',
        higherVersion: 'applied',
        scope: 'per (principalId, serverId, messageId); reactedEmojis compare canonically (sorted)',
      },
      serverObligation: 'viewerVersion (and discussionVersion, same numeric contract per message:emoji) must come from PERSISTENT MONOTONIC COUNTERS (0010 message_reaction_viewer_versions / message_reaction_discussion_versions), incremented only on actual mutation, never from a state hash',
    },
    executed: {
      // Worked examples frozen for the Go side: the clean counter trace and
      // the two hash-drift shapes the verifier rejects.
      canonicalCounterTrace: canonicalTrace(0),
      canonicalTraceViolations: canonicalViolations,
      hashLikeTrace,
      hashLikeTraceViolations: hashViolations,
    },
    assertions: 7,
  };
}

export { checkTrace as checkViewerVersionTrace };
