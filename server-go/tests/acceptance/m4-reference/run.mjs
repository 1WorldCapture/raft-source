// M4 backend-compatibility reference suite — entrypoint.
//
//   node server-go/tests/acceptance/m4-reference/run.mjs            # run + (re)generate contract fixtures
//   node server-go/tests/acceptance/m4-reference/run.mjs --check    # run + assert fixtures are byte-identical (no rewrite)
//   node server-go/tests/acceptance/m4-reference/run.mjs --verify samples.json   # compare real Go wire samples against frozen contracts
//   node server-go/tests/acceptance/m4-reference/run.mjs --go-wire --check      # verify fresh Go wire without rewriting evidence
//
// What a green run proves: the ORIGINAL TS parsers/normalizers/reducers/schema
// at the pinned baseline (bc65213) accept/reject the frozen inputs exactly as
// recorded, and the frozen JSON in server-go/contracts/m4/** is a faithful
// transcript of those executions. It deliberately proves nothing about the Go
// server until real Go wire samples are fed through --verify.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { M4_BASELINE_COMMIT, PINNED, contractsDir, stableJson } from './pinned-sources.mjs';
import { loadOriginalModules } from './exec-original.mjs';
import { runMessagesCases } from './cases-messages.mjs';
import { runCanonicalCases } from './cases-canonical.mjs';
import { runHistoryCases } from './cases-history.mjs';
import { runReadStateCases } from './cases-readstate.mjs';
import { runThreadDmCases } from './cases-thread-dm.mjs';
import { runActivityCases } from './cases-activity.mjs';
import { runReactionVersionCases } from './cases-reaction-versions.mjs';
import { verifyGoWireSamples } from './verify-go-wire.mjs';
import { collectGoWire, verifyGoWire } from './go-wire-export.mjs';
import { runVerifySelfTest } from './selftest-verify.mjs';

function metaFor(area, generatedBy, notes) {
  const pins = {};
  for (const [key, pin] of Object.entries(PINNED)) pins[key] = { path: pin.path, sha256: pin.sha256 };
  return {
    contract: 'raft.m4-reference',
    area,
    baseline: M4_BASELINE_COMMIT,
    generatedBy,
    sourcePins: pins,
    notes,
  };
}

const CHECK = process.argv.includes('--check');
const VERIFY_AT = process.argv.indexOf('--verify');
const GO_WIRE = process.argv.includes('--go-wire');

if (GO_WIRE) {
  // Collect REAL Go wire from the in-process export test (public store APIs,
  // isolated temp DB, no TCP/router/live data) and verify it against the
  // original TS executed here. --check keeps the test gate read-only:
  // generated message IDs are intentionally fresh, so compare semantics
  // against the original reducers/schema, not bytes against a prior run.
  const wire = await collectGoWire();
  const report = await verifyGoWire(wire);
  if (!CHECK) {
    await mkdir(contractsDir, { recursive: true });
    await writeFile(path.join(contractsDir, 'go-wire-samples.json'), stableJson({
      collectedFrom: 'go test ./tests/acceptance/m4-reference/ -run TestM4ReferenceExportGoWire (in-process public APIs; parent runs true HTTP separately)',
      baseline: M4_BASELINE_COMMIT,
      wire,
      report,
    }), { mode: 0o644 });
  }
  for (const line of report.checks) process.stdout.write(`  ok  ${line}\n`);
  for (const line of report.failures) process.stderr.write(`  FAIL ${line}\n`);
  process.stdout.write(report.ok
    ? `PASS M4 go-wire: real Go public-API wire accepted by original TS reducers/schema (${CHECK ? 'read-only check; evidence unchanged' : 'evidence: server-go/contracts/m4/go-wire-samples.json'})\n`
    : 'FAIL M4 go-wire\n');
  process.exitCode = report.ok ? 0 : 1;
} else if (VERIFY_AT !== -1) {
  const samplesPath = process.argv[VERIFY_AT + 1];
  if (!samplesPath) throw new Error('--verify requires a path to a Go wire samples JSON file');
  const samples = JSON.parse(await readFile(samplesPath, 'utf8'));
  const report = await verifyGoWireSamples(samples);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.failed.length === 0 ? 0 : 1;
} else {
  const mods = await loadOriginalModules();
  const reactionVersionCases = await runReactionVersionCases();
  const suites = [
    await runMessagesCases(mods),
    await runCanonicalCases(mods),
    await runHistoryCases(mods),
    await runReadStateCases(mods),
    await runThreadDmCases(mods),
    await runActivityCases(mods),
    reactionVersionCases,
  ];

  const files = {
    'messages-wire.contract.json': {
      ...metaFor('messages-wire', 'original-execution (parsers/constants) + source-derived literals (route envelope)',
        ['v1/v2 body-limit, mentions and randomId verdicts are EXECUTED from pinned messages.ts',
         'response error literals and envelope shapes are extracted from the same pinned bytes (handlers are express/DB-bound and not executable)']),
      executed: suites[0].executed,
      sourceDerived: suites[0].sourceDerived,
    },
    'canonical-message.contract.json': {
      ...metaFor('canonical-message', 'original-execution (shared manifest, socket projector, web canonical fold)',
        ['commentRef shared-null-preserve, present-overwrite and viewer/storage omission rules all run original code']),
      executed: suites[1].executed,
      omissionRules: suites[1].omissionRules,
    },
    'history-coverage.contract.json': {
      ...metaFor('history-coverage', 'source-derived (NOT executed: requires PostgreSQL + drizzle)',
        ['boundary table transcribed line-anchored from pinned listMessagesWithCoverage; Go side must be compared through real wire']),
      sourceDerived: suites[2].sourceDerived,
      scenarios: suites[2].scenarios,
    },
    'readstate-prefs-wire.contract.json': {
      ...metaFor('readstate-prefs-wire', 'original-execution (route parser segment, web read-state ledger, read-receipt domain, channel/prefs folds)',
        ['read-mutation parsePayload + real ReadMutationError class executed (official TS transform for the parameter property)']),
      executed: suites[3].executed,
    },
    'thread-dm-wire.contract.json': {
      ...metaFor('thread-dm-wire', 'original-execution (channel parsers, shared name validator, web DM fold) + source-derived route literals',
        ['DM/thread route error bodies and validation order are extracted from pinned channels.ts bytes']),
      executed: suites[4].executed,
    },
    'activity-v1.contract.json': {
      ...metaFor('activity-v1', 'original-execution (uint64, reducer + core, contract behavior runner, ajv over generated JSON Schema)',
        ['frozen behavior vectors replayed through the ORIGINAL runner; aggregate digest recorded here for the first time (packet manifest has canonicalBehaviorResultSha256: null)',
         'runnerProtocol-1 fact: applyStep does not map difference.hasMore onto core partial — frozen as observed',
         'actualStream: a frozen message->read->done->difference ingress sequence with the original reducer digest; Go ports replay it via verify area activity.stream.digest']),
      executed: suites[5].executed,
    },
    'reaction-versions.contract.json': {
      ...metaFor('reaction-versions', 'source-derived rule invariants (the rule sits inside a zustand store; the two mathematically checkable invariants are enforced on Go wire samples)',
        ['viewerVersion/discussionVersion must be persistent monotonic counters (0010 message_reaction_*_versions), never state hashes — derived from the pinned web reducer reactionReadModels.ts:387-401',
         'readstate-prefs-wire.contract.json now also freezes an executed multi-event read stream (readStateStream) including the late-duplicate rejection']),
      sourceDerived: reactionVersionCases.sourceDerived,
      executed: reactionVersionCases.executed,
    },
  };

  await mkdir(contractsDir, { recursive: true });
  let totalAssertions = 0;
  for (const suite of suites) totalAssertions += suite.assertions;
  const written = [];
  for (const [name, body] of Object.entries(files)) {
    const serialized = stableJson(body);
    const target = path.join(contractsDir, name);
    if (CHECK) {
      const existing = await readFile(target, 'utf8').catch(() => null);
      if (existing !== serialized) {
        throw new Error(`--check: ${target} does not match regenerated content (rerun without --check after re-reviewing the baseline)`);
      }
    } else {
      await writeFile(target, serialized, { mode: 0o644 });
    }
    written.push(name);
  }

  const executedSuites = suites.filter(s => s.area !== 'history-coverage').length;
  // Discrimination self-test for the Go-wire integration API: correct wire
  // passes, drifted wire fails. Synthetic samples, labelled selftest-*.
  const selftest = await runVerifySelfTest();
  process.stdout.write(
    `PASS M4 reference: ${suites.length} suites (${executedSuites} executing original code), `
    + `${totalAssertions} assertions, ${written.length} contract fixtures in server-go/contracts/m4 `
    + `(baseline ${M4_BASELINE_COMMIT.slice(0, 7)}); `
    + `verify API self-test ${selftest.passed}/${selftest.total} pass + ${selftest.failed} drifted-sample rejects\n`,
  );
}
