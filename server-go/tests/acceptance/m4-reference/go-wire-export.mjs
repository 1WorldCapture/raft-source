// Collect REAL Go wire by running the in-process Go export test (no TCP, no
// router, no live data), then verify it against the ORIGINAL TypeScript
// executed right here: the frozen reaction-version rule, the original
// read-state ledger, the generated Activity JSON Schema (ajv), and the
// original Activity reducer folding the REAL Go difference rows.
//
//   node server-go/tests/acceptance/m4-reference/run.mjs --go-wire
//
// Product surface: only public store APIs (see go_wire_export_test.go).
// This is NOT the parent's HTTP parity run; it is store-level executable
// evidence that the Go public APIs emit wire the original consumers accept.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { repoRoot } from './pinned-sources.mjs';
import { loadOriginalModules, loadActivityJsonSchema } from './exec-original.mjs';
import { checkViewerVersionTrace } from './cases-reaction-versions.mjs';

const HOST = (value) => JSON.parse(JSON.stringify(
  value,
  (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner),
));

export async function collectGoWire({ timeoutMs = 300000, env = process.env } = {}) {
  const serverGo = path.join(repoRoot, 'server-go');
  return new Promise((resolve, reject) => {
    const child = spawn('go', ['test', './tests/acceptance/m4-reference/', '-run', 'TestM4ReferenceExportGoWire', '-count=1', '-v'], {
      cwd: serverGo,
      env: { ...env, GOCACHE: env.GOCACHE || path.join(repoRoot, 'server-go/var/tmp/go-build-cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('go test timed out')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`go test exited ${code}: ${stderr.slice(0, 2000)}`));
        return;
      }
      const marker = stdout.match(/M4REF_GO_WIRE_BEGIN(\{.*\})M4REF_GO_WIRE_END/s);
      if (!marker) {
        reject(new Error('M4REF_GO_WIRE marker not found in go test output'));
        return;
      }
      resolve(JSON.parse(marker[1]));
    });
  });
}

export async function verifyGoWire(wire) {
  const mods = await loadOriginalModules();
  const failures = [];
  const checks = [];

  // ---- 1. reaction viewer-version ordering (frozen original rule) ---------
  const byViewer = new Map();
  for (const step of wire.reactionViewerVersionStream ?? []) {
    if (!byViewer.has(step.viewer)) byViewer.set(step.viewer, []);
    byViewer.get(step.viewer).push({ op: step.op, viewerVersion: step.viewerVersion, reactedEmojis: step.reactedEmojis ?? [] });
  }
  for (const [viewer, events] of byViewer) {
    const violations = checkViewerVersionTrace(events);
    if (violations.length) {
      failures.push(`reaction viewer ${viewer}: ${violations.map(v => `${v.kind} at ${v.index} (${v.detail})`).join('; ')}`);
    } else {
      checks.push(`reaction viewer ${viewer}: ${events.length} steps, versions strictly ordered (add/remove/add inclusive)`);
    }
  }
  // Idempotent repeats must not bump the version AND must keep the payload.
  for (const step of wire.reactionViewerVersionStream ?? []) {
    if (step.op === 'add-idempotent' && step.changed) {
      failures.push('idempotent reaction add reported changed=true (version must not bump)');
    }
  }
  // Discussion versions must also be non-decreasing.
  const discussion = wire.reactionDiscussionVersions ?? [];
  for (let i = 1; i < discussion.length; i += 1) {
    if (discussion[i].discussionVersion < discussion[i - 1].discussionVersion) {
      failures.push(`discussion version regressed: ${discussion[i - 1].discussionVersion} -> ${discussion[i].discussionVersion}`);
    }
  }
  if (discussion.length) checks.push(`discussion versions non-decreasing across ${discussion.length} probes`);

  // ---- 2. read stream through the ORIGINAL ledger ---------------------------
  // The Go server's emitted (maxReadSeq, readStateVersion) sequence is exactly
  // the event stream every OTHER device of this user receives; the original
  // web ledger must accept it without stale/conflict (it is authoritative
  // output, not a competing client write).
  const RS = mods.webReadStateSync;
  RS.resetReadStateSyncForTests();
  const readEvents = (wire.readStateStream ?? [])
    .filter((step) => step.changed)
    .map((step) => ({ serverId: 'srv', scopeId: 'go-channel', maxReadSeq: step.maxReadSeq, readStateVersion: step.readStateVersion }));
  const readVerdicts = [];
  for (const event of readEvents) {
    const normalized = RS.normalizeReadStateUpdated(event);
    if (normalized === null) { readVerdicts.push('corrupt'); continue; }
    readVerdicts.push(RS.consumeReadStateUpdate(normalized));
  }
  if (readVerdicts.some((v) => v !== 'accepted')) {
    failures.push(`original ledger rejected the Go read-state stream: ${readVerdicts.join(',')}`);
  } else {
    checks.push(`read-state stream: original ledger accepts all ${readVerdicts.length} changed emits (versions strictly advance)`);
  }
  const lastRead = wire.readStateStream?.[wire.readStateStream.length - 1];
  if (lastRead) {
    const final = RS.getAcceptedReadState('srv', 'go-channel');
    if (final && (final.maxReadSeq !== lastRead.maxReadSeq || final.readStateVersion !== lastRead.readStateVersion)) {
      failures.push(`read-state final mismatch: original=${JSON.stringify(final)} go-last=${JSON.stringify(lastRead)}`);
    }
  }

  // ---- 3. Activity bodies against the REAL generated schema (ajv) ----------
  const requireFromSyncCore = createRequire(path.join(repoRoot, 'packages/sync-core/package.json'));
  const Ajv2020 = requireFromSyncCore('ajv/dist/2020.js');
  const bundle = await loadActivityJsonSchema();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(bundle, 'activity-sync.schema.json');
  const validateIngress = ajv.getSchema('ActivityIngress.json');
  const schemaBodies = [
    ['activitySnapshot', (b) => ({ ...b, type: 'snapshot' })],
    ['activityDifferenceAfterChange', (b) => ({ ...b, type: 'difference' })],
    ['activityNotModified', (b) => ({ ...b, type: 'notModified' })],
    ['activitySnapshotAfterDone', (b) => ({ ...b, type: 'snapshot' })],
    ['activityAfterDoneNotModified', (b) => ({ ...b, type: 'notModified' })],
  ];
  for (const [key, shape] of schemaBodies) {
    const body = wire[key];
    if (!body) { failures.push(`go wire missing ${key}`); continue; }
    const candidate = HOST(body);
    delete candidate.status; // HTTP status is never a body key (sealed schema)
    Object.assign(candidate, {});
    const shaped = shape(candidate);
    if (!validateIngress(shaped)) {
      failures.push(`${key}: REAL Go body rejected by the generated Activity schema: ${validateIngress.errors?.map((e) => `${e.instancePath} ${e.message}`).slice(0, 6).join('; ')}`);
    } else {
      checks.push(`${key}: passes the generated Activity JSON Schema`);
    }
  }

  // ---- 4. REAL Go difference rows through the ORIGINAL Activity reducer ----
  const R = mods.activityRunner;
  const diffBody = wire.activityDifferenceAfterChange;
  if (diffBody?.rows) {
    const scope = diffBody.scope;
    const core = mods.createActivitySyncCore();
    const scopeId = mods.activityDomain.encodeActivityScopeId({ serverId: scope.serverId, principalId: scope.principalId, filter: scope.filter, windowId: scope.windowId });
    // Exactly the ORIGINAL runner's difference mapping (applyStep): one
    // sequenced frame at toSeq through core.ingestDifference.
    const frame = {
      type: 'frame',
      rows: diffBody.rows,
      tombstones: diffBody.tombstones,
      activityVersion: diffBody.activityVersion,
      totalCount: diffBody.totalCount,
      totalUnreadCount: diffBody.totalUnreadCount,
      complete: diffBody.complete,
      hasMore: diffBody.hasMore,
      nextCursor: diffBody.nextCursor,
    };
    const foldOutcome = core.ingestDifference('activity', {
      scopeId,
      epoch: diffBody.epoch,
      fromSeq: BigInt(diffBody.fromSeq) - 1n,
      toSeq: BigInt(diffBody.toSeq),
      events: [{ seq: BigInt(diffBody.toSeq), event: frame }],
    });
    const state = core.state('activity', scopeId);
    const rowsStored = state ? state.rows.length : 0;
    if (String(foldOutcome.kind) !== 'applied' && String(foldOutcome.kind) !== 'max_advanced') {
      failures.push(`original reducer refused the REAL Go difference frame: ${JSON.stringify(HOST(foldOutcome))}`);
    } else if (rowsStored !== diffBody.rows.length) {
      failures.push(`original reducer stored ${rowsStored} rows from ${diffBody.rows.length} REAL Go rows (row guard rejected some)`);
    } else {
      checks.push(`REAL Go difference rows all enter the original reducer state (${rowsStored} rows)`);
      // The stored row must keep the Go rowVersion (monotonic uint64 string).
      const stored = HOST(state.rows[0]);
      const goRow = diffBody.rows[0];
      if (String(stored.rowVersion) !== String(goRow.rowVersion)) {
        failures.push(`rowVersion mutated by the original fold: go=${goRow.rowVersion} stored=${stored.rowVersion}`);
      }
    }
  }

  // ---- 5. tombstone shape after Done ----------------------------------------
  const doneSnap = wire.activitySnapshotAfterDone;
  if (doneSnap) {
    const stones = doneSnap.window.tombstones ?? [];
    const row = stones.find((s) => s.reason === 'done');
    if (!row) failures.push('post-Done snapshot carries no done tombstone');
    else checks.push(`post-Done snapshot carries a done tombstone (rowVersion ${row.rowVersion})`);
  }

  return { ok: failures.length === 0, checks, failures };
}

// CLI: node go-wire-export.mjs [--save path]
if (process.argv[1] && process.argv[1].endsWith('go-wire-export.mjs')) {
  const wire = await collectGoWire();
  const report = await verifyGoWire(wire);
  const saveAt = process.argv.indexOf('--save');
  if (saveAt !== -1 && process.argv[saveAt + 1]) {
    const { writeFile } = await import('node:fs/promises');
    const { stableJson } = await import('./pinned-sources.mjs');
    await writeFile(process.argv[saveAt + 1], stableJson({ collectedFrom: 'go test TestM4ReferenceExportGoWire (in-process, no TCP)', wire, report }), { mode: 0o644 });
  }
  for (const line of report.checks) process.stdout.write(`  ok  ${line}\n`);
  for (const line of report.failures) process.stderr.write(`  FAIL ${line}\n`);
  process.stdout.write(report.ok ? 'PASS M4 go-wire (real public APIs vs original TS)\n' : 'FAIL M4 go-wire\n');
  process.exitCode = report.ok ? 0 : 1;
}
