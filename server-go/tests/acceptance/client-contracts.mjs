// Client-contracts capability-index checker (make test-client-contracts).
//
// Verifies contracts/client/manifest.json — the capability index of the frozen
// client-facing artifacts — against reality:
//   * every frozen fixture under contracts/m4, contracts/legacyweb and
//     contracts/m4-readstate-schema.sql is indexed exactly once (no missing,
//     no unindexed, no duplicate, no path escaping out of contracts/);
//   * sha256 (and byte size) of each fixture match the manifest;
//   * each fixture parses as its declared schema (unknown schema ids and
//     shape drift both fail); m4 contracts additionally cross-check their
//     internal sourcePins against tests/acceptance/m4-reference/pinned-sources.mjs;
//   * every entry lists real consumers: direct consumers are files whose code
//     loads the artifact bytes (they must exist and actually reference it);
//     reference consumers only cite it (existence + citation checked);
//   * migration hash invariants 0001-0013: exactly the manifest's files in
//     internal/platform/db/migrations, hashes matching manifest AND the git
//     baseline commit (design §10: zero schema changes this refactor);
//   * explicit additive migration index: contracts/client/migration-additions.json
//     lists the exact files allowed BEYOND the frozen set (bare filename +
//     sha256 + bytes + contract-doc provenance each). The frozen set UNION the
//     additions must equal the on-disk inventory exactly - no wildcard, no
//     auto-accept of future migrations, nothing may sort at or before the
//     frozen tail without belonging to it. Additions are NOT git-baseline
//     checked: they postdate the frozen baseline commit by design, so the
//     additions manifest itself is their authority (M5 worker F).
//   * every immutable fixture hash is also compared against its blob at the
//     manifest's baselineCommit.
//
// The checker is READ-ONLY: it never writes to contracts/, migrations,
// consumers or git. The built-in self-test exercises malformed manifests and
// tampered fixtures only inside throwaway OS-temp directories, with executable
// assertions (no source-grep tests). Exit 0 only when both the self-test and
// the real verification pass.
//
// Usage:
//   node tests/acceptance/client-contracts.mjs [--manifest PATH]
//        [--additions PATH] [--no-self-test | --self-test-only]
//        [RAFT_CLIENT_CONTRACTS_MANIFEST=<path> env override]
//        [RAFT_CLIENT_MIGRATION_ADDITIONS=<path> env override]
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const M4_FROZEN_BASELINE = 'bc65213b377a992c381e809c72ba50ca9af367fd';
// Migration filenames are bare NNNN_lower_snake.sql entries of the single
// migrations directory; anything else in the additions index is a path hazard.
const MIGRATION_NAME_RE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

const here = path.dirname(fileURLToPath(import.meta.url));
const serverGoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------- schemas --
// Executable schemas require >=1 direct consumer (code that loads the bytes).
// Doc schemas are allowed to be reference-only.
const DOC_SCHEMAS = new Set(['m4-contracts-readme', 'legacyweb-account-entry', 'legacyweb-workspaces-route-matrix']);

function isSafeRelPath(p) {
  return typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !p.includes('\\') && !p.includes('\0')
    && p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function validatePins(pins, label, err) {
  if (typeof pins !== 'object' || pins === null || Array.isArray(pins) || Object.keys(pins).length === 0) {
    err('schema-shape', `${label}: sourcePins must be a non-empty object`);
    return;
  }
  for (const [key, pin] of Object.entries(pins)) {
    if (typeof pin !== 'object' || pin === null || !isSafeRelPath(pin.path) || !HEX64.test(String(pin.sha256))) {
      err('schema-shape', `${label}: malformed sourcePin ${key}`);
    }
  }
}

function schemaCheck(entry, text, err) {
  const label = entry.path;
  let doc = null;
  if (entry.schema.endsWith('.json') || ['m4-reference-contract', 'm4-go-wire-samples', 'legacyweb-workspaces-route-matrix'].includes(entry.schema)) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      err('schema-shape', `${label}: not valid JSON (${e.message})`);
      return;
    }
  }
  switch (entry.schema) {
    case 'm4-reference-contract': {
      if (doc.contract !== 'raft.m4-reference') err('schema-shape', `${label}: contract=${JSON.stringify(doc.contract)} !== "raft.m4-reference"`);
      if (doc.area !== entry.area) err('schema-shape', `${label}: area=${JSON.stringify(doc.area)} !== manifest area ${JSON.stringify(entry.area)}`);
      if (doc.baseline !== M4_FROZEN_BASELINE || entry.upstream.producerBaseline !== M4_FROZEN_BASELINE) err('schema-shape', `${label}: baseline/producerBaseline must stay the frozen ${M4_FROZEN_BASELINE}`);
      if (typeof doc.generatedBy !== 'string' || doc.generatedBy === '') err('schema-shape', `${label}: missing generatedBy`);
      validatePins(doc.sourcePins, label, err);
      if (doc.sourcePins && Object.keys(doc.sourcePins).length !== entry.upstream.sourcePinsInside) {
        err('schema-shape', `${label}: ${Object.keys(doc.sourcePins).length} sourcePins != manifest sourcePinsInside ${entry.upstream.sourcePinsInside}`);
      }
      return;
    }
    case 'm4-go-wire-samples': {
      if (typeof doc.collectedFrom !== 'string' || !doc.collectedFrom.includes('TestM4ReferenceExportGoWire')) err('schema-shape', `${label}: collectedFrom must name the in-process Go export test`);
      if (doc.baseline !== M4_FROZEN_BASELINE) err('schema-shape', `${label}: baseline must stay ${M4_FROZEN_BASELINE}`);
      if (typeof doc.wire !== 'object' || doc.wire === null || Array.isArray(doc.wire) || Object.keys(doc.wire).length === 0) err('schema-shape', `${label}: wire must be a non-empty object`);
      if (doc.report?.ok !== true || !Array.isArray(doc.report?.checks) || doc.report.checks.length === 0 || !Array.isArray(doc.report?.failures) || doc.report.failures.length !== 0) err('schema-shape', `${label}: report must be ok:true with checks and zero failures`);
      return;
    }
    case 'legacyweb-workspaces-route-matrix': {
      if (doc.schemaVersion !== 1) err('schema-shape', `${label}: schemaVersion !== 1`);
      if (doc.status !== 'design-not-implementation-evidence') err('schema-shape', `${label}: status must stay "${doc.status}"`);
      if (doc.sourceBaseline !== 'c4a5015deb7dcc8b800df96675d899f384f76e36' || entry.upstream.producerBaseline !== 'c4a5015deb7dcc8b800df96675d899f384f76e36') err('schema-shape', `${label}: sourceBaseline/producerBaseline must stay the frozen c4a5015`);
      if (!Array.isArray(doc.routes) || doc.routes.length === 0) err('schema-shape', `${label}: routes must be a non-empty array`);
      if (!Array.isArray(doc.unchangedClients)) err('schema-shape', `${label}: unchangedClients must be an array`);
      return;
    }
    case 'm4-contracts-readme': {
      if (!text.startsWith('# M4 backend-compatibility reference contracts (frozen at bc65213)')) err('schema-shape', `${label}: heading/frozen-baseline line changed`);
      if (!text.includes('run.mjs')) err('schema-shape', `${label}: regeneration command reference lost`);
      return;
    }
    case 'legacyweb-account-entry': {
      if (!text.startsWith('# Legacy Web account entry')) err('schema-shape', `${label}: heading changed`);
      if (!text.includes('docs/backend-handoff.md')) err('schema-shape', `${label}: backend closeout-note reference lost`);
      return;
    }
    case 'readstate-schema-ddl': {
      if (!text.startsWith('-- M4 P5 human READSTATE / ACTIVITY schema DRAFT for migration 0011.')) err('schema-shape', `${label}: draft header line changed`);
      if (!text.includes('IF NOT EXISTS')) err('schema-shape', `${label}: replayable idempotent DDL marker lost`);
      if (!text.includes('0011_readstate_activity.sql')) err('schema-shape', `${label}: install-target reference lost`);
      return;
    }
    default:
      err('unknown-schema', `${label}: schema ${JSON.stringify(entry.schema)} is not a known frozen-artifact schema`);
  }
}

// ------------------------------------------------------------- verification --
async function gitBlobSha(repoRoot, commit, relPath) {
  const out = await execFileP('git', ['-C', repoRoot, 'cat-file', 'blob', `${commit}:${relPath}`], { maxBuffer: 64 * 1024 * 1024 });
  return sha256(out.stdout === '' ? Buffer.from([]) : Buffer.from(out.stdout, 'utf8'));
}

async function walkFiles(rootDir, relDir, out, err, code) {
  const abs = path.join(rootDir, relDir);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    err(code, `${relDir}: cannot list (${e.message})`);
    return;
  }
  for (const de of entries) {
    const rel = `${relDir}/${de.name}`;
    if (de.isDirectory()) await walkFiles(rootDir, rel, out, err, code);
    else if (de.isFile()) out.push(rel);
  }
}

export async function verifyIndex(manifest, opts) {
  const errors = [];
  const err = (code, detail) => errors.push({ code, detail });
  const { rootDir, useGitBaseline = false, crossCheckPins = false, additions = null } = opts;

  // -- manifest shape
  if (manifest?.manifestVersion !== 1) err('manifest-shape', `manifestVersion=${JSON.stringify(manifest?.manifestVersion)} !== 1`);
  if (manifest?.kind !== 'raft.client-contracts-index') err('manifest-shape', `kind=${JSON.stringify(manifest?.kind)}`);
  if (!HEX40.test(String(manifest?.baselineCommit))) err('manifest-shape', `baselineCommit ${JSON.stringify(manifest?.baselineCommit)} is not a 40-hex commit`);
  if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) err('manifest-shape', 'entries must be a non-empty array');
  if (!Array.isArray(manifest?.frozenRoots) || manifest.frozenRoots.some((p) => !isSafeRelPath(p))) err('manifest-shape', 'frozenRoots must be safe relative paths');
  if (!Array.isArray(manifest?.frozenFiles) || manifest.frozenFiles.some((p) => !isSafeRelPath(p))) err('manifest-shape', 'frozenFiles must be safe relative paths');
  const mig = manifest?.migrations;
  if (typeof mig?.dir !== 'string' || !Number.isInteger(mig?.expectedCount) || !Array.isArray(mig?.files)) err('manifest-shape', 'migrations section malformed');

  if (errors.length) return { ok: false, errors };

  // -- entry-level checks
  const byId = new Map();
  const byPath = new Map();
  const entryTexts = new Map();
  for (const entry of manifest.entries) {
    const label = entry?.id ?? '(no id)';
    if (typeof entry?.id !== 'string' || entry.id === '') { err('manifest-shape', 'entry without id'); continue; }
    if (byId.has(entry.id)) err('duplicate-entry-id', `${entry.id} listed twice (also at ${byId.get(entry.id)})`);
    else byId.set(entry.id, entry.path ?? '(no path)');
    if (typeof entry?.path !== 'string' || !isSafeRelPath(entry.path)) { err('path-escape', `${label}: path ${JSON.stringify(entry?.path)} is not a safe relative path`); continue; }
    if (!entry.path.startsWith('contracts/')) { err('path-outside-frozen', `${label}: ${entry.path} is not under contracts/`); continue; }
    if (byPath.has(entry.path)) err('duplicate-entry-path', `${entry.path} listed twice (${byPath.get(entry.path)} and ${label})`);
    else byPath.set(entry.path, entry.id);
    if (typeof entry?.sha256 !== 'string' || !HEX64.test(entry.sha256)) { err('manifest-shape', `${label}: sha256 malformed`); continue; }
    if (!Number.isInteger(entry?.bytes) || entry.bytes <= 0) err('manifest-shape', `${label}: bytes malformed`);
    if (typeof entry?.capability !== 'string' || entry.capability === '') err('manifest-shape', `${label}: capability missing`);
    if (typeof entry?.upstream?.generatedBy !== 'string' || typeof entry?.upstream?.regeneration !== 'string' || !(entry.upstream.producerBaseline === null || HEX40.test(entry.upstream.producerBaseline))) err('manifest-shape', `${label}: upstream provenance malformed`);
    if (!Array.isArray(entry?.consumers?.direct) || !Array.isArray(entry?.consumers?.reference)) { err('manifest-shape', `${label}: consumers.direct/reference must be arrays`); continue; }

    const abs = path.resolve(rootDir, entry.path);
    // path-escape: lexical path must stay inside contracts/, and the REAL path
    // (symlinks resolved) must too.
    const contractsReal = await realpath(path.resolve(rootDir, 'contracts')).catch(() => null);
    const fileReal = await realpath(abs).catch(() => null);
    if (contractsReal && fileReal && !(fileReal === contractsReal || fileReal.startsWith(contractsReal + path.sep))) {
      err('path-escape', `${label}: ${entry.path} resolves to ${fileReal}, outside ${contractsReal}`);
      continue;
    }
    let buf;
    try {
      buf = await readFile(abs);
    } catch {
      err('missing-artifact', `${label}: ${entry.path} does not exist`);
      continue;
    }
    const actualSha = sha256(buf);
    if (actualSha !== entry.sha256) err('hash-drift', `${label}: ${entry.path} sha256 ${actualSha} != manifest ${entry.sha256}`);
    if (entry.bytes !== buf.length) err('hash-drift', `${label}: ${entry.path} size ${buf.length} != manifest bytes ${entry.bytes}`);
    const text = buf.toString('utf8');
    entryTexts.set(entry.path, text);
    schemaCheck(entry, text, err);

    // consumers: real files that exist and actually cite the artifact.
    const basename = path.basename(entry.path);
    const all = [...entry.consumers.direct.map((p) => ['direct', p]), ...entry.consumers.reference.map((p) => ['reference', p])];
    if (all.length === 0) err('missing-consumers', `${label}: no consumers recorded at all`);
    if (!DOC_SCHEMAS.has(entry.schema) && entry.consumers.direct.length === 0) err('missing-direct-consumer', `${label}: executable schema ${entry.schema} has zero direct consumers`);
    for (const [kind, cpath] of all) {
      if (!isSafeRelPath(cpath)) { err('manifest-shape', `${label}: consumer path ${JSON.stringify(cpath)} unsafe`); continue; }
      let st;
      try {
        st = await lstat(path.resolve(rootDir, cpath));
      } catch {
        err('consumer-missing', `${label}: ${kind} consumer ${cpath} does not exist`);
        continue;
      }
      if (!st.isFile()) { err('consumer-missing', `${label}: ${kind} consumer ${cpath} is not a regular file`); continue; }
      const ctext = await readFile(path.resolve(rootDir, cpath), 'utf8').catch(() => null);
      if (ctext === null || !ctext.includes(basename)) err('consumer-no-reference', `${label}: ${kind} consumer ${cpath} never cites ${basename}`);
    }
  }

  // -- full inventory of the frozen roots (both directions)
  const onDisk = [];
  for (const root of manifest.frozenRoots) await walkFiles(rootDir, root, onDisk, err, 'missing-artifact');
  for (const f of manifest.frozenFiles) {
    const st = await lstat(path.resolve(rootDir, f)).catch(() => null);
    if (st?.isFile()) onDisk.push(f);
  }
  for (const f of [...manifest.frozenRoots, ...manifest.frozenFiles]) {
    const st = await lstat(path.resolve(rootDir, f)).catch(() => null);
    if (!st) err('missing-artifact', `frozen root/file ${f} does not exist`);
  }
  const indexed = new Set(manifest.entries.map((e) => e.path));
  for (const f of onDisk) if (!indexed.has(f)) err('unindexed-artifact', `${f} exists under a frozen root but is not indexed (index and disk must match 1:1)`);
  for (const p of indexed) if (!onDisk.includes(p)) err('missing-artifact', `indexed path ${p} not found under the frozen roots`);

  // -- migration hash invariants + the explicit additive migration index.
  // The frozen set (0001-0013) is compared against the manifest AND the git
  // baseline; a NEWER migration may exist on disk only as an exact,
  // hash-pinned entry of migration-additions.json. There is deliberately no
  // wildcard: a file named by neither index is an error, never an accepted
  // silently-tolerated extra (m5-execution-lock.md worker F).
  if (!errors.some((e) => e.code === 'manifest-shape')) {
    const migAbs = path.resolve(rootDir, mig.dir);
    const frozenNames = new Set(mig.files.map((f) => f.file));
    const lastFrozen = mig.files.at(-1)?.file;

    // Validate the additions document first: shape, provenance, ordering and
    // overlap with the frozen set are judged before any disk comparison.
    const additionSet = new Set();
    if (additions === null) {
      err('additions-shape', 'migration-additions.json was not supplied to verifyIndex; the additive migration index is mandatory (pass the parsed document, or {missing:true} to assert its presence)');
    } else if (additions?.missing === true) {
      err('additions-shape', 'contracts/client/migration-additions.json is missing; the additive migration index is part of the frozen contract, not an optional file');
    } else {
      if (additions?.manifestVersion !== 1) err('additions-shape', `manifestVersion=${JSON.stringify(additions?.manifestVersion)} !== 1`);
      if (additions?.kind !== 'raft.client-migration-additions') err('additions-shape', `kind=${JSON.stringify(additions?.kind)} !== "raft.client-migration-additions"`);
      if (additions?.frozenThrough !== lastFrozen) err('additions-shape', `frozenThrough=${JSON.stringify(additions?.frozenThrough)} must equal the frozen manifest's last migration ${JSON.stringify(lastFrozen)}`);
      if (!Array.isArray(additions?.files) || !Number.isInteger(additions?.expectedCount)) {
        err('additions-shape', 'migration-additions files/expectedCount malformed');
      } else if (additions.files.length !== additions.expectedCount) {
        err('additions-shape', `expectedCount=${additions.expectedCount} but ${additions.files.length} addition files listed`);
      }
      let prevAddition = null;
      for (const f of Array.isArray(additions?.files) ? additions.files : []) {
        const name = f?.file;
        if (typeof name !== 'string' || name === '' || path.isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes('\0') || !MIGRATION_NAME_RE.test(name)) {
          err('additions-path-escape', `addition ${JSON.stringify(name)}: must be a bare migration filename (NNNN_lower_snake.sql) resolved inside ${mig.dir}`);
          continue;
        }
        if (additionSet.has(name)) err('additions-duplicate', `${name} listed twice in migration-additions.json`);
        else additionSet.add(name);
        if (frozenNames.has(name)) err('additions-frozen-overlap', `${name} already belongs to the frozen manifest; additions must be strictly newer files`);
        if (lastFrozen !== undefined && !(name > lastFrozen)) err('additions-shape', `addition ${name} must sort strictly after the frozen tail ${lastFrozen}`);
        if (prevAddition !== null && !(name > prevAddition)) err('additions-shape', `additions must be listed in strictly increasing filename order (${name} after ${prevAddition})`);
        prevAddition = name;
        if (typeof f?.sha256 !== 'string' || !HEX64.test(f.sha256) || !Number.isInteger(f?.bytes) || f.bytes <= 0) { err('additions-shape', `addition ${name}: sha256/bytes malformed`); continue; }
        if (typeof f?.introducedBy !== 'string' || f.introducedBy === '') err('additions-shape', `addition ${name}: introducedBy (the owning delivery contract doc) is required`);
      }
    }

    const diskEntries = await readdir(migAbs, { withFileTypes: true }).catch(() => null);
    // db.go embeds migrations/*.sql, not every tooling directory beside the
    // migrations. Non-matching real directories (for example .claude) cannot
    // affect that embedded set. Retain ALL top-level files/symlinks and any
    // directory matching *.sql in the strict inventory; a symlink or a .sql
    // directory is never an acceptable replacement for a registered file.
    const inventoryEntries = diskEntries?.filter((entry) => !entry.isDirectory() || entry.name.endsWith('.sql')) ?? null;
    const diskFiles = inventoryEntries?.map((entry) => entry.name) ?? null;
    if (diskFiles === null) err('migration-inventory', `${mig.dir}: cannot list`);
    else {
      const allowed = new Set([...frozenNames, ...additionSet]);
      for (const entry of inventoryEntries) if (!entry.isFile()) err('migration-inventory', `${mig.dir}/${entry.name} must be a regular migration file, not a symlink or directory`);
      for (const name of diskFiles) if (!allowed.has(name)) err('migration-inventory', `${mig.dir}/${name} on disk but named by neither the frozen manifest (0001-0013) nor migration-additions.json; register the exact addition or remove the file`);
      for (const f of mig.files) if (!diskFiles.includes(f.file)) err('migration-inventory', `${mig.dir}/${f.file} in manifest but missing on disk`);
      for (const name of additionSet) if (!diskFiles.includes(name)) err('migration-inventory', `${mig.dir}/${name} registered in migration-additions.json but missing on disk`);
      if (mig.files.length !== mig.expectedCount) err('migration-inventory', `expectedCount=${mig.expectedCount} but ${mig.files.length} frozen files listed`);
      if (diskFiles.length !== mig.expectedCount + additionSet.size) err('migration-inventory', `${diskFiles.length} files on disk, expected exactly ${mig.expectedCount} frozen + ${additionSet.size} registered additions (no wildcard)`);
      for (const f of mig.files) {
        if (!HEX64.test(String(f.sha256))) { err('manifest-shape', `migration ${f.file}: sha256 malformed`); continue; }
        const buf = await readFile(path.join(migAbs, f.file)).catch(() => null);
        if (buf === null) { err('migration-inventory', `${mig.dir}/${f.file} unreadable`); continue; }
        const actual = sha256(buf);
        if (actual !== f.sha256) err('migration-hash-drift', `${mig.dir}/${f.file} sha256 ${actual} != manifest ${f.sha256}`);
        if (f.file === '0011_readstate_activity.sql' && !buf.toString('utf8').includes('contracts/m4-readstate-schema.sql')) {
          err('migration-provenance', '0011 no longer cites its reviewed draft source contracts/m4-readstate-schema.sql');
        }
      }
      const additionsByName = new Map((Array.isArray(additions?.files) ? additions.files : []).map((f) => [f?.file, f]));
      for (const name of additionSet) {
        const entry = additionsByName.get(name);
        if (!entry) continue;
        const buf = await readFile(path.join(migAbs, name)).catch(() => null);
        if (buf === null) continue; // absence already reported as inventory drift
        const actual = sha256(buf);
        if (actual !== entry.sha256) err('migration-hash-drift', `${mig.dir}/${name} sha256 ${actual} != migration-additions ${entry.sha256}`);
        if (entry.bytes !== buf.length) err('migration-hash-drift', `${mig.dir}/${name} size ${buf.length} != migration-additions bytes ${entry.bytes}`);
      }
    }
  }

  // -- git baseline comparison (immutable fixtures + migrations vs commit blobs)
  if (useGitBaseline) {
    let repoRoot = null;
    try {
      // TMPDIR-style roots can be symlinked (/var/folders -> /private/var/...);
      // git reports the real toplevel, so resolve the root first or the
      // relative object path computation crosses a symlink divergence.
      const rootReal = await realpath(rootDir);
      repoRoot = (await execFileP('git', ['-C', rootReal, 'rev-parse', '--show-toplevel'])).stdout.trim();
      await execFileP('git', ['-C', rootReal, 'cat-file', '-e', `${manifest.baselineCommit}^{commit}`]);
    } catch (e) {
      err('baseline-unavailable', `git baseline ${manifest.baselineCommit} not usable from ${rootDir} (${e.message.split('\n')[0]})`);
    }
    if (repoRoot) {
      // Frozen-only by design: additions postdate the baseline commit, so no
      // blob can exist for them there; their authority is the additions
      // manifest compared above, never this git comparison.
      const targets = [
        ...manifest.entries.map((e) => e.path),
        ...mig.files.map((f) => `${mig.dir}/${f.file}`),
      ];
      for (const rel of targets) {
        const gitRel = path.relative(repoRoot, path.resolve(await realpath(rootDir), rel)).split(path.sep).join('/');
        let blobSha;
        try {
          blobSha = await gitBlobSha(repoRoot, manifest.baselineCommit, gitRel);
        } catch {
          err('baseline-missing', `${rel}: no blob at baseline ${manifest.baselineCommit}`);
          continue;
        }
        const workSha = sha256(await readFile(path.resolve(rootDir, rel)));
        if (blobSha !== workSha) err('baseline-drift', `${rel}: worktree sha256 ${workSha} != baseline-${manifest.baselineCommit.slice(0, 7)} blob ${blobSha}`);
      }
    }
  }

  // -- cross-check m4 sourcePins against the pinned registry actually executed
  if (crossCheckPins) {
    const pinsPath = path.resolve(rootDir, 'tests/acceptance/m4-reference/pinned-sources.mjs');
    try {
      const mod = await import(pathToFileURL(pinsPath).href);
      if (mod.M4_BASELINE_COMMIT !== M4_FROZEN_BASELINE) err('pins-mismatch', `pinned-sources.mjs baseline ${mod.M4_BASELINE_COMMIT} != frozen ${M4_FROZEN_BASELINE}`);
      const registry = {};
      for (const [k, v] of Object.entries(mod.PINNED ?? {})) registry[k] = { path: v.path, sha256: v.sha256 };
      for (const entry of manifest.entries) {
        if (entry.schema !== 'm4-reference-contract') continue;
        const doc = JSON.parse(entryTexts.get(entry.path));
        const a = JSON.stringify(doc.sourcePins, Object.keys(doc.sourcePins).sort());
        const keys = Object.keys(registry).sort();
        const b = JSON.stringify(Object.fromEntries(keys.map((k) => [k, registry[k]])), keys);
        if (a !== b) err('pins-mismatch', `${entry.id}: sourcePins inside the artifact diverge from the executed registry pinned-sources.mjs`);
      }
    } catch (e) {
      err('pins-mismatch', `cannot cross-check pins (${e.message})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- selftest --
// Builds a mini workspace (frozen contracts + migrations + every referenced
// consumer) in the OS temp dir, then asserts that specific corruptions of the
// manifest/tree produce specific failure codes. All writes stay in tmpdir.
async function buildTemplate(serverRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'client-contracts-selftest-'));
  await cp(path.join(serverRoot, 'contracts'), path.join(tmp, 'contracts'), { recursive: true });
  await mkdir(path.dirname(path.join(tmp, manifest.migrations.dir)), { recursive: true });
  await cp(path.join(serverRoot, manifest.migrations.dir), path.join(tmp, manifest.migrations.dir), { recursive: true });
  const consumerPaths = new Set();
  for (const e of manifest.entries) for (const p of [...e.consumers.direct, ...e.consumers.reference]) consumerPaths.add(p);
  for (const c of consumerPaths) {
    await mkdir(path.dirname(path.join(tmp, c)), { recursive: true });
    await cp(path.join(serverRoot, c), path.join(tmp, c));
  }
  return { tmp, manifest };
}

async function runSelfTest(serverRoot, manifestPath) {
  const { tmp: templateDir } = await buildTemplate(serverRoot, manifestPath);
  const templateManifest = JSON.parse(await readFile(path.join(templateDir, 'contracts/client/manifest.json'), 'utf8'));
  const templateAdditions = JSON.parse(await readFile(path.join(templateDir, 'contracts/client/migration-additions.json'), 'utf8'));
  const cases = [];

  const makeCase = (name, expectedCode, mutate) => cases.push({ name, expectedCode, mutate });
  const writeManifest = async (root, m) => writeFile(path.join(root, 'contracts/client/manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  const writeAdditions = async (root, doc) => writeFile(path.join(root, 'contracts/client/migration-additions.json'), `${JSON.stringify(doc, null, 2)}\n`);
  const migrationDir = (root) => path.join(root, 'internal/platform/db/migrations');
  const ADDITION_SQL = '-- selftest synthetic addition (throwaway workspace only)\nCREATE TABLE m5_selftest_addition_marker(i INTEGER PRIMARY KEY);\n';
  // Only the synthetic throwaway fixture follows the latest registered
  // migration number. The production inventory remains explicitly pinned;
  // no real unregistered migration is admitted by this selftest helper.
  const lastMigration = templateAdditions.files.at(-1)?.file ?? templateAdditions.frozenThrough;
  const ADDITION_FILE = `${String(Number(lastMigration.split('_')[0]) + 1).padStart(4, '0')}_selftest_addition.sql`;
  const registeredAdditionsDoc = (body = ADDITION_SQL, name = ADDITION_FILE) => {
    const doc = structuredClone(templateAdditions);
    doc.files.push({ file: name, sha256: sha256(Buffer.from(body)), bytes: body.length, introducedBy: 'docs/m5-upgrade-worker-selftest-provenance.md' });
    doc.expectedCount = doc.files.length;
    return doc;
  };

  makeCase('pristine-copy-passes', null, async (root) => writeManifest(root, templateManifest));
  makeCase('artifact-byte-drift', 'hash-drift', async (root) => {
    const p = path.join(root, 'contracts/m4/messages-wire.contract.json');
    await writeFile(p, `${await readFile(p, 'utf8')}\n`);
  });
  makeCase('artifact-deleted', 'missing-artifact', async (root) => rm(path.join(root, 'contracts/m4/reaction-versions.contract.json')));
  makeCase('unindexed-artifact', 'unindexed-artifact', async (root) => writeFile(path.join(root, 'contracts/m4/extra-unindexed.contract.json'), '{}\n'));
  makeCase('duplicate-entry-id', 'duplicate-entry-id', async (root) => {
    const m = structuredClone(templateManifest);
    m.entries.push(structuredClone(m.entries[0]));
    await writeManifest(root, m);
  });
  makeCase('duplicate-entry-path', 'duplicate-entry-path', async (root) => {
    const m = structuredClone(templateManifest);
    const dup = structuredClone(m.entries[1]);
    dup.id = 'x.duplicate-path';
    m.entries.push(dup);
    await writeManifest(root, m);
  });
  makeCase('path-escape-dotdot', 'path-escape', async (root) => {
    const m = structuredClone(templateManifest);
    m.entries[0].path = 'contracts/../go.mod';
    await writeManifest(root, m);
  });
  makeCase('path-escape-symlink', 'path-escape', async (root) => {
    await writeFile(path.join(root, 'outside-target.txt'), 'x');
    await symlink('../../outside-target.txt', path.join(root, 'contracts/m4/escape.json'));
    const m = structuredClone(templateManifest);
    m.entries[0].path = 'contracts/m4/escape.json';
    m.entries[0].sha256 = sha256(Buffer.from('x'));
    m.entries[0].bytes = 1;
    m.entries[0].schema = 'legacyweb-account-entry';
    await writeManifest(root, m);
  });
  makeCase('path-outside-frozen', 'path-outside-frozen', async (root) => {
    const m = structuredClone(templateManifest);
    m.entries[0].path = 'go.mod';
    await writeManifest(root, m);
  });
  makeCase('unknown-schema', 'unknown-schema', async (root) => {
    const m = structuredClone(templateManifest);
    m.entries[0].schema = 'invented-schema-id';
    await writeManifest(root, m);
  });
  makeCase('schema-shape-drift', 'schema-shape', async (root) => {
    const p = path.join(root, 'contracts/m4/activity-v1.contract.json');
    const doc = JSON.parse(await readFile(p, 'utf8'));
    doc.contract = 'someone-retyped-this';
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    await writeFile(p, text);
    const m = structuredClone(templateManifest);
    for (const e of m.entries) if (e.path === 'contracts/m4/activity-v1.contract.json') { e.sha256 = sha256(Buffer.from(text)); e.bytes = text.length; }
    await writeManifest(root, m);
  });
  makeCase('pins-tampered', 'schema-shape', async (root) => {
    const p = path.join(root, 'contracts/m4/thread-dm-wire.contract.json');
    const doc = JSON.parse(await readFile(p, 'utf8'));
    doc.sourcePins = { onlyOne: { path: 'packages/x.ts', sha256: '0'.repeat(64) } };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    await writeFile(p, text);
    const m = structuredClone(templateManifest);
    for (const e of m.entries) if (e.path === 'contracts/m4/thread-dm-wire.contract.json') { e.sha256 = sha256(Buffer.from(text)); e.bytes = text.length; }
    await writeManifest(root, m);
  });
  makeCase('go-wire-report-not-ok', 'schema-shape', async (root) => {
    const p = path.join(root, 'contracts/m4/go-wire-samples.json');
    const doc = JSON.parse(await readFile(p, 'utf8'));
    doc.report = { ok: false, checks: [], failures: ['x'] };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    await writeFile(p, text);
    const m = structuredClone(templateManifest);
    for (const e of m.entries) if (e.path === 'contracts/m4/go-wire-samples.json') { e.sha256 = sha256(Buffer.from(text)); e.bytes = text.length; }
    await writeManifest(root, m);
  });
  makeCase('missing-consumers', 'missing-consumers', async (root) => {
    const m = structuredClone(templateManifest);
    for (const e of m.entries) if (e.id === 'legacyweb.account-entry') { e.consumers.direct = []; e.consumers.reference = []; }
    await writeManifest(root, m);
  });
  makeCase('missing-direct-consumer', 'missing-direct-consumer', async (root) => {
    const m = structuredClone(templateManifest);
    for (const e of m.entries) if (e.id === 'm4.messages-wire') e.consumers.direct = [];
    await writeManifest(root, m);
  });
  makeCase('consumer-file-missing', 'consumer-missing', async (root) => {
    await rm(path.join(root, 'tests/acceptance/m4-reference/selftest-verify.mjs'));
  });
  makeCase('consumer-no-citation', 'consumer-no-reference', async (root) => {
    const p = path.join(root, 'internal/readstate/doc.go');
    await writeFile(p, (await readFile(p, 'utf8')).replaceAll('m4-readstate-schema.sql', 'redacted.sql'));
  });
  makeCase('migration-hash-drift', 'migration-hash-drift', async (root) => {
    const p = path.join(root, 'internal/platform/db/migrations/0007_computer_admission.sql');
    await writeFile(p, `${await readFile(p, 'utf8')}-- tampered\n`);
  });
  makeCase('migration-extra-file', 'migration-inventory', async (root) => {
    await writeFile(path.join(root, 'internal/platform/db/migrations/0014_sneaky.sql'), 'CREATE TABLE x(i);\n');
  });
  makeCase('migration-tool-directory-not-embedded', null, async (root) => {
    const metadata = path.join(migrationDir(root), 'tool-state');
    await mkdir(metadata);
    await writeFile(path.join(metadata, 'metadata.json'), '{}\n');
    await writeFile(path.join(metadata, '0015_not_embedded.sql'), 'CREATE TABLE not_embedded(i);\n');
  });
  makeCase('migration-unindexed-non-sql-file', 'migration-inventory', async (root) => {
    await writeFile(path.join(migrationDir(root), 'unindexed-notes.txt'), 'not a registered migration\n');
  });
  makeCase('migration-sql-directory', 'migration-inventory', async (root) => {
    const nested = path.join(migrationDir(root), '0015_nested.sql');
    await mkdir(nested);
    await writeFile(path.join(nested, 'payload.sql'), 'CREATE TABLE nested(i);\n');
  });
  makeCase('migration-symlink-same-bytes', 'migration-inventory', async (root) => {
    const original = path.join(migrationDir(root), templateManifest.migrations.files[0].file);
    const outside = path.join(root, 'outside-migration.sql');
    await writeFile(outside, await readFile(original));
    await rm(original);
    await symlink(outside, original);
  });
  makeCase('migration-removed', 'migration-inventory', async (root) => {
    await rm(path.join(root, 'internal/platform/db/migrations/0013_activity_mute_epochs.sql'));
  });

  // ---- explicit additive migration index (migration-additions.json) ------
  // Every case synthesizes its addition inside the throwaway workspace; none
  // of these filenames may ever exist in the real tree.
  makeCase('additions-registered-passes', null, async (root) => {
    await writeFile(path.join(migrationDir(root), ADDITION_FILE), ADDITION_SQL);
    await writeAdditions(root, registeredAdditionsDoc());
  });
  makeCase('additions-tampered', 'migration-hash-drift', async (root) => {
    await writeFile(path.join(migrationDir(root), ADDITION_FILE), ADDITION_SQL);
    await writeAdditions(root, registeredAdditionsDoc());
    await writeFile(path.join(migrationDir(root), ADDITION_FILE), `${ADDITION_SQL}-- tampered after registration\n`);
  });
  makeCase('additions-unregistered-extra', 'migration-inventory', async (root) => {
    await writeFile(path.join(migrationDir(root), '0015_sneaky.sql'), 'CREATE TABLE sneaky(i);\n');
  });
  makeCase('additions-registered-removed', 'migration-inventory', async (root) => {
    await writeAdditions(root, registeredAdditionsDoc());
  });
  makeCase('additions-path-escape', 'additions-path-escape', async (root) => {
    await writeAdditions(root, registeredAdditionsDoc('CREATE TABLE outside(i);\n', '../outside-migrations.sql'));
  });
  makeCase('additions-path-subdir', 'additions-path-escape', async (root) => {
    await writeAdditions(root, registeredAdditionsDoc('CREATE TABLE nested(i);\n', 'nested/0014_x.sql'));
  });
  makeCase('additions-duplicate', 'additions-duplicate', async (root) => {
    await writeFile(path.join(migrationDir(root), ADDITION_FILE), ADDITION_SQL);
    const doc = registeredAdditionsDoc();
    doc.files.push(structuredClone(doc.files[doc.files.length - 1]));
    doc.expectedCount = doc.files.length;
    await writeAdditions(root, doc);
  });
  makeCase('additions-frozen-overlap', 'additions-frozen-overlap', async (root) => {
    const doc = structuredClone(templateAdditions);
    doc.expectedCount = 1;
    doc.files.push({ ...templateManifest.migrations.files[0], introducedBy: 'docs/overlap-attempt.md' });
    await writeAdditions(root, doc);
  });
  makeCase('additions-shape-bad-hash', 'additions-shape', async (root) => {
    await writeFile(path.join(migrationDir(root), ADDITION_FILE), ADDITION_SQL);
    const doc = registeredAdditionsDoc();
    doc.files[0].sha256 = 'not-hex';
    await writeAdditions(root, doc);
  });
  makeCase('additions-shape-misordered', 'additions-shape', async (root) => {
    await writeFile(path.join(migrationDir(root), '0009_early_addition.sql'), 'CREATE TABLE early(i);\n');
    await writeAdditions(root, registeredAdditionsDoc('CREATE TABLE early(i);\n', '0009_early_addition.sql'));
  });
  makeCase('additions-manifest-deleted', 'additions-shape', async (root) => {
    await rm(path.join(root, 'contracts/client/migration-additions.json'));
  });

  let pass = 0;
  const failures = [];
  for (const c of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'client-contracts-case-'));
    try {
      await cp(templateDir, root, { recursive: true });
      await c.mutate(root);
      const manifest = JSON.parse(await readFile(path.join(root, 'contracts/client/manifest.json'), 'utf8'));
      let additionsDoc;
      try {
        additionsDoc = JSON.parse(await readFile(path.join(root, 'contracts/client/migration-additions.json'), 'utf8'));
      } catch {
        additionsDoc = { missing: true };
      }
      const result = await verifyIndex(manifest, { rootDir: root, useGitBaseline: false, crossCheckPins: false, additions: additionsDoc });
      if (c.expectedCode === null) {
        if (result.ok) { pass += 1; process.stdout.write(`  ok  selftest ${c.name} -> pass as expected\n`); } else { failures.push(`${c.name}: expected clean pass, got ${JSON.stringify(result.errors)}`); }
      } else if (!result.ok && result.errors.some((e) => e.code === c.expectedCode)) {
        pass += 1;
        process.stdout.write(`  ok  selftest ${c.name} -> ${c.expectedCode}\n`);
      } else {
        failures.push(`${c.name}: expected ${c.expectedCode}, got ${result.ok ? 'PASS' : JSON.stringify(result.errors.map((e) => e.code))}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // baseline-drift needs a real throwaway git repository in tmpdir.
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), 'client-contracts-git-'));
    await cp(templateDir, root, { recursive: true });
    const g = (...args) => execFileP('git', ['-C', root, ...args]);
    await g('init', '--quiet');
    await g('-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'add', '-A');
    await g('-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest', 'commit', '--quiet', '-m', 'frozen baseline');
    const commit = (await g('rev-parse', 'HEAD')).stdout.trim();
    const m = JSON.parse(await readFile(path.join(root, 'contracts/client/manifest.json'), 'utf8'));
    m.baselineCommit = commit;
    await writeManifest(root, m);
    let result = await verifyIndex(m, { rootDir: root, useGitBaseline: true, additions: templateAdditions });
    if (!result.ok) {
      failures.push(`git-baseline-pristine: expected pass, got ${JSON.stringify(result.errors)}`);
    } else {
      const p = path.join(root, 'contracts/legacyweb/workspaces-route-matrix.json');
      await writeFile(p, `${await readFile(p, 'utf8')} \n`);
      result = await verifyIndex(m, { rootDir: root, useGitBaseline: true });
      if (!result.ok && result.errors.some((e) => e.code === 'baseline-drift')) {
        pass += 1;
        process.stdout.write('  ok  selftest git-baseline-drift -> baseline-drift\n');
      } else {
        failures.push(`git-baseline-drift: expected baseline-drift, got ${result.ok ? 'PASS' : JSON.stringify(result.errors.map((e) => e.code))}`);
      }
    }
    await rm(root, { recursive: true, force: true });
  } catch (e) {
    failures.push(`git-baseline case errored: ${e.message}`);
  }

  await rm(templateDir, { recursive: true, force: true });
  return { pass, total: cases.length + 1, failures };
}

// -------------------------------------------------------------------- main --
async function main() {
  const args = process.argv.slice(2);
  const manifestIdx = args.indexOf('--manifest');
  const manifestPath = manifestIdx !== -1
    ? path.resolve(args[manifestIdx + 1])
    : process.env.RAFT_CLIENT_CONTRACTS_MANIFEST
      ? path.resolve(process.env.RAFT_CLIENT_CONTRACTS_MANIFEST)
      : path.join(serverGoRoot, 'contracts/client/manifest.json');
  const additionsIdx = args.indexOf('--additions');
  const additionsPath = additionsIdx !== -1
    ? path.resolve(args[additionsIdx + 1])
    : process.env.RAFT_CLIENT_MIGRATION_ADDITIONS
      ? path.resolve(process.env.RAFT_CLIENT_MIGRATION_ADDITIONS)
      : path.join(serverGoRoot, 'contracts/client/migration-additions.json');
  const wantSelfTest = !args.includes('--no-self-test');
  const selfTestOnly = args.includes('--self-test-only');

  let selfTest = { pass: 0, total: 0, failures: [] };
  if (wantSelfTest || selfTestOnly) {
    selfTest = await runSelfTest(serverGoRoot, manifestPath);
    const line = `PASS client-contracts selftest: ${selfTest.pass}/${selfTest.total} executable malformed-manifest assertions`
      + ' (temp-dir workspaces only; the real tree is never touched)';
    if (selfTest.failures.length === 0) process.stdout.write(`${line}\n`);
    else { for (const f of selfTest.failures) process.stderr.write(`  FAIL selftest ${f}\n`); process.exitCode = 1; return; }
  }
  if (selfTestOnly) return;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`FAIL client-contracts: manifest unreadable: ${manifestPath} (${e.message})\n`);
    process.exitCode = 1;
    return;
  }
  let additions;
  try {
    additions = JSON.parse(await readFile(additionsPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`FAIL client-contracts: migration additions index unreadable: ${additionsPath} (${e.message})\n`);
    process.exitCode = 1;
    return;
  }
  const result = await verifyIndex(manifest, {
    rootDir: serverGoRoot,
    useGitBaseline: true,
    crossCheckPins: true,
    additions,
  });
  if (result.ok) {
    process.stdout.write(
      `PASS client-contracts: ${manifest.entries.length} frozen fixtures + ${manifest.migrations.files.length} frozen migrations + ${additions.files?.length ?? 0} registered additions verified`
      + ` (hash/inventory/schema/consumers/pins/git-baseline vs ${manifest.baselineCommit.slice(0, 7)} for the frozen set; additions hash-pinned by migration-additions.json); read-only run, no golden regenerated\n`,
    );
  } else {
    for (const { code, detail } of result.errors) process.stderr.write(`  FAIL [${code}] ${detail}\n`);
    process.stderr.write(`FAIL client-contracts: ${result.errors.length} error(s) in the capability index\n`);
    process.exitCode = 1;
  }
}

await main();
