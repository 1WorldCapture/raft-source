// Executes ORIGINAL, unmodified TypeScript from the pinned M4 baseline.
//
// Technique (same contract as the M2 reference test
// tests/acceptance/workspaces-reference.mjs):
//   1. take a contiguous segment of the pinned source bytes;
//   2. erase TypeScript syntax with node's official type stripper
//      (node:module stripTypeScriptTypes — never a hand transpile);
//   3. mechanically remove leading `export ` keywords so the segment runs as a
//      script, and rewrite the segment's own single-line runtime imports into
//      bindings from ALREADY-EXECUTED original modules (dependency wiring only;
//      no logic is edited, and every rewrite asserts it fired exactly once);
//   4. execute in a fresh vm context and harvest the named declarations.
//
// Every byte that runs is original source. What is NOT executed anywhere in
// this suite: express handlers, drizzle/PostgreSQL paths, socket.io, zustand
// stores — those surfaces are frozen as source-derived contract entries instead
// (clearly labelled) because executing them would require the TS server,
// Postgres or a browser.
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PINNED, repoRoot, readPinned, segmentOf } from './pinned-sources.mjs';

// The workspace's own TypeScript compiler (the exact version the original
// packages build with) is used ONLY for segments that contain non-erasable
// syntax (a constructor parameter property); node's type stripper refuses
// those. Official compiler, original bytes, zero hand editing.
const requireFromSyncCore = createRequire(
  path.join(repoRoot, 'packages/sync-core/package.json'),
);
const workspaceTypescript = requireFromSyncCore('typescript');

const recordedWarnings = [];

function deexport(code, label) {
  // Drop bare re-export statements entirely: after type erasure they may keep a
  // dangling trailing comma, and the re-exported bindings are already wired in
  // via their original module. Removal is mechanical (statement-granular).
  const noReexport = code.replace(/^export \{[^}]*\};?\s*$/gm, '');
  const out = noReexport.replace(/^export /gm, '');
  if (out === noReexport && /^export /m.test(noReexport)) {
    throw new Error(`segment ${label}: export removal unexpectedly failed`);
  }
  return out;
}

function wireImport(code, importLine, replacement, label) {
  const count = code.split(importLine).length - 1;
  if (count !== 1) {
    throw new Error(`segment ${label}: expected exactly one import line to wire, found ${count}`);
  }
  return code.replace(importLine, replacement);
}

function runSegment({ label, code, globals = {}, names, mode = 'strip' }) {
  const stripped = mode === 'transform'
    ? workspaceTypescript.transpileModule(code, {
        compilerOptions: {
          target: workspaceTypescript.ScriptTarget.ES2022,
          module: workspaceTypescript.ModuleKind.ESNext,
        },
      }).outputText
    : stripTypeScriptTypes(code, { mode: 'strip' });
  const script = deexport(stripped, label);
  const context = {
    ...globals,
    console: {
      warn: (...args) => recordedWarnings.push(args.map(String).join(' ')),
      log: () => {},
      error: () => {},
    },
    BigInt,
  };
  context.globalThis = context;
  const value = vm.runInNewContext(`${script}\n;({ ${names.join(',')} });`, context, {
    timeout: 10000,
    filename: `m4-reference/${label}`,
  });
  return { value, context };
}

/** Executes a whole pinned file that has no runtime imports. */
async function execWholeFile(key, names) {
  const source = await readPinned(key);
  return runSegment({ label: PINNED[key].path, code: source, names }).value;
}

// ---------------------------------------------------------------------------
// Original-module loader. `loadOriginalModules()` is idempotent.
// ---------------------------------------------------------------------------

let modulesPromise = null;

export function loadOriginalModules() {
  modulesPromise ??= buildModules();
  return modulesPromise;
}

async function buildModules() {
  const m = {};

  // -- server: message route parsers (messages.ts, two contiguous segments) --
  {
    const source = await readPinned('serverMessagesRoute');
    const head = segmentOf(
      source,
      'const MAX_MESSAGE_LENGTH = 32_000;',
      'class ForwardRequestError',
      'messages.parsers.head',
    );
    const tail = segmentOf(
      source,
      'function parseReactionEmoji(',
      'function parseDateFilter(',
      'messages.parsers.tail',
    );
    const { value } = runSegment({
      label: 'messages.parsers',
      code: `${head}\n${tail}`,
      names: [
        'MAX_MESSAGE_LENGTH', 'MAX_RANDOM_ID_LENGTH', 'MAX_REACTION_LENGTH', 'UUID_RE',
        'parseStructuredMentions', 'parseRandomId', 'parseHumanMessageCreateBody',
        'parseReactionEmoji', 'parseReactionActorPageLimit', 'parseMessagePageCursor',
      ],
    });
    m.messagesParsers = value;
  }

  // -- server: canonical message socket projection (whole file, type imports only) --
  m.messageSocketProjection = await execWholeFile('serverMessageRealtimeEvents', [
    'projectMessageSocketPayload', 'projectRichMessageSocketPayload',
  ]);

  // -- server: read-mutation wire parser (route segment + real error class) --
  {
    const routeSource = await readPinned('serverReadMutationsRoute');
    const parsePayloadCode = segmentOf(
      routeSource,
      'function parsePayload(',
      'function sendReadMutationError(',
      'readMutations.parsePayload',
    );
    const sequencerSource = await readPinned('serverReadMutationSequencer');
    const errorClassCode = segmentOf(
      sequencerSource,
      'export class ReadMutationError',
      'export class ReadMutationFailpointError',
      'readMutationSequencer.ReadMutationError',
    );
    // The constructor uses a TypeScript parameter property (`readonly code`),
    // which pure type-stripping refuses; the official transform mode compiles
    // it without any hand editing.
    const { value } = runSegment({
      label: 'readMutations.parser',
      code: `${errorClassCode}\n${parsePayloadCode}`,
      names: ['ReadMutationError', 'parsePayload'],
      mode: 'transform',
    });
    m.readMutationParser = value;
  }

  // -- server: channel route parsers (channels.ts contiguous segment) --
  {
    const source = await readPinned('serverChannelsRoute');
    const { value } = runSegment({
      label: 'channels.parsers',
      code: segmentOf(
        source,
        'function parseChannelVisibility(',
        'function parseJointInviteRequests(',
        'channels.parsers',
      ),
      names: ['parseChannelVisibility', 'normalizeStringList'],
    });
    m.channelsParsers = value;
  }

  // -- shared: canonical message manifest (whole file, pure) --
  m.canonicalManifest = await execWholeFile('sharedCanonicalMessageManifest', [
    'CANONICAL_MESSAGE_MANIFEST_VERSION', 'CANONICAL_MESSAGE_MANIFEST',
    'CANONICAL_MESSAGE_FIELD_DESCRIPTORS', 'CANONICAL_NESTED_WIRE_SHAPES',
    'CANONICAL_MESSAGE_EXCLUSIONS', 'CANONICAL_REQUIRED_MESSAGE_FIELDS',
    'OPTIONAL_AGGREGATE_MESSAGE_FIELDS', 'canonicalMessageManifestJson',
  ]);

  // -- shared: activity mute eligibility (whole file, pure) --
  m.sharedActivityMute = await execWholeFile('sharedActivityMute', [
    'ACTIVITY_MUTE_SUPPORTED_CHANNEL_TYPES', 'channelTypeSupportsActivityMute',
  ]);

  // -- shared: name validation (contiguous segment of the barrel) --
  {
    const source = await readPinned('sharedIndex');
    const { value } = runSegment({
      label: 'shared.validateName',
      code: segmentOf(
        source,
        'export const NAME_REGEX',
        'export type AgentNameValidationReason',
        'shared.validateName',
      ),
      names: ['NAME_REGEX', 'NAME_MIN_LENGTH', 'NAME_MAX_LENGTH', 'validateNameReason', 'validateName'],
    });
    m.sharedValidateName = value;
  }

  // -- sync-core: uint64 primitives (whole file, pure) --
  m.uint64 = await execWholeFile('syncCoreUint64', ['isUInt64String', 'compareUInt64String']);

  // -- sync-core: violation buffer (whole file, type imports only) --
  m.violations = await execWholeFile('syncCoreViolations', ['createSyncViolationBuffer']);

  // -- sync-core: the deterministic core (whole file; one runtime import wired) --
  {
    const source = await readPinned('syncCoreCore');
    const wired = wireImport(
      source,
      'import { createSyncViolationBuffer } from "./violations.js";',
      'const { createSyncViolationBuffer } = __m4_violations;',
      'sync-core/core.ts',
    );
    const { value } = runSegment({
      label: 'sync-core.core',
      code: wired,
      globals: { __m4_violations: m.violations },
      names: ['createSyncCore'],
    });
    m.core = value;
  }

  // -- sync-core: Activity pure reducer domain (whole file; uint64 import wired) --
  {
    const source = await readPinned('syncCoreActivityDomain');
    const wired = wireImport(
      source,
      'import { compareUInt64String, isUInt64String, type UInt64String } from "../uint64.js";',
      'const { compareUInt64String, isUInt64String } = __m4_uint64;',
      'sync-core/domains/activity.ts',
    );
    const { value } = runSegment({
      label: 'sync-core.activity',
      code: wired,
      globals: { __m4_uint64: m.uint64 },
      names: [
        'ACTIVITY_DOMAIN', 'initialActivityState', 'foldActivityEvent',
        'fingerprintActivityEvent', 'encodeActivityScopeId', 'createActivityDomain',
      ],
    });
    m.activityDomain = value;
  }

  // A real sync-core factory: original core + original Activity domain, exactly
  // as the production behavior-vector runner composes them.
  m.createActivitySyncCore = () => m.core.createSyncCore({
    domains: [m.activityDomain.createActivityDomain()],
  });

  // -- sync-core: contract behavior runner (contiguous segment; deps wired) --
  {
    const source = await readPinned('activityRunner');
    const code = segmentOf(
      source,
      'export const SEQUENCED_INGRESS_BRANCHES',
      'export interface BehaviorRunReport',
      'activity.runner',
    );
    const { value } = runSegment({
      label: 'activity.runner',
      code,
      globals: {
        createHash: (await import('node:crypto')).createHash,
        createSyncCore: m.core.createSyncCore,
        ACTIVITY_DOMAIN: m.activityDomain.ACTIVITY_DOMAIN,
        createActivityDomain: m.activityDomain.createActivityDomain,
        encodeActivityScopeId: m.activityDomain.encodeActivityScopeId,
      },
      names: ['SEQUENCED_INGRESS_BRANCHES', 'canonicalJson', 'sha256Hex', 'exactSeq', 'scopeIdOf', 'applyStep', 'runCase'],
    });
    m.activityRunner = value;
  }

  // -- web: canonical display sort (contiguous segment of messageStore.ts) --
  {
    const source = await readPinned('webMessageStore');
    const { value } = runSegment({
      label: 'web.messageStore.sort',
      code: segmentOf(
        source,
        'export function compareMessagesForDisplay(',
        'function getMaxDisplaySeq(',
        'web.messageStore.sort',
      ),
      names: ['compareMessagesForDisplay', 'sortBySeq'],
    });
    m.webSort = value;
  }

  // -- web: canonical message fold (messageSyncDomain.ts contiguous segment) --
  {
    const source = await readPinned('webMessageSyncDomain');
    const code = segmentOf(
      source,
      'export const MESSAGES_SYNC_DOMAIN',
      'export type MessageSyncCoreConsumeResult',
      'web.messageSyncDomain.fold',
    );
    const { value } = runSegment({
      label: 'web.messageSyncDomain',
      code,
      globals: {
        CANONICAL_MESSAGE_FIELD_DESCRIPTORS: m.canonicalManifest.CANONICAL_MESSAGE_FIELD_DESCRIPTORS,
        sortBySeq: m.webSort.sortBySeq,
      },
      names: [
        'MESSAGES_SYNC_DOMAIN', 'createInitialMessageDomainState',
        'applyMessageDomainEvent', 'createMessagesSyncDomain',
        'mergeCanonicalMessageProjection',
      ],
    });
    m.webMessageFold = value;
  }

  // -- web: read-receipt pure domain (whole file, zero imports) --
  m.webReadReceipt = await execWholeFile('webReadReceiptDomain', [
    'normalizeReadReceiptHydrate', 'normalizeScopeReadUpdated', 'mergePeerReadAdvance',
    'mergeReadReceiptHydrate', 'projectAgentReadReceipt', 'projectReadReceipt',
  ]);

  // -- web: channel domain normalizers/reducers (whole file; shared import wired) --
  {
    const source = await readPinned('webChannelDomain');
    const wired = wireImport(
      source,
      'import { channelTypeSupportsActivityMute } from "@botiverse/raft-shared";',
      'const { channelTypeSupportsActivityMute } = __m4_sharedActivityMute;',
      'web/store/channelDomain.ts',
    );
    const { value } = runSegment({
      label: 'web.channelDomain',
      code: wired,
      globals: { __m4_sharedActivityMute: m.sharedActivityMute },
      names: [
        'normalizeActivityMuteState', 'normalizeMessageDisplayPrefs',
        'applyActivityMuteState', 'matchesActivityMuteState',
        'applyMessageDisplayPrefsState', 'matchesMessageDisplayPrefsState',
        'canToggleActivityMute', 'toChannel', 'sortChannels',
        'hydrateChannels', 'hydrateDmChannels', 'patchChannel', 'removeChannel',
        'refreshExistingDm', 'activityFrom',
      ],
    });
    m.webChannelDomain = value;
  }

  // -- web: read-state ingress ledger (contiguous segment; uint64 import wired) --
  {
    const source = await readPinned('webReadStateSync');
    // The uint64 import sits ABOVE the extracted segment, so the wiring is
    // prepended to the segment instead of replacing the import line (the line
    // itself stays pinned inside the file; we only assert it exists).
    const importLine = 'import { isUInt64String } from "@botiverse/raft-sync-core/src/uint64.js";';
    if (source.split(importLine).length - 1 !== 1) {
      throw new Error('web/store/readStateSync.ts: uint64 import line not unique');
    }
    const code = `const { isUInt64String } = __m4_uint64;\n${segmentOf(
      source,
      'export type ReadStateIngressCorruptReason',
      'registerServerReset(',
      'web.readStateSync.ledger',
    )}`;
    const { value } = runSegment({
      label: 'web.readStateSync',
      code,
      globals: { __m4_uint64: m.uint64 },
      names: [
        'normalizeReadStateUpdated', 'normalizeReadStateUpdatedBulk',
        'consumeReadStateUpdate', 'consumeReadStateSnapshot',
        'consumeReadStateSnapshotRows', 'getAcceptedReadState',
        'getReadStateLedgerGeneration', 'hasAcceptedReadStateChangedAfter',
        'resetReadStateSyncForTests',
      ],
    });
    m.webReadStateSync = value;
  }

  // -- web: notification-prefs fold (three contiguous segments of one file) --
  {
    const source = await readPinned('webNotificationPrefsSyncDomain');
    const head = segmentOf(
      source,
      'export const NOTIFICATION_PREFS_SYNC_DOMAIN',
      'let notificationPrefsSyncCore',
      'web.notificationPrefs.head',
    );
    const scopeId = segmentOf(
      source,
      'export function scopeIdForNotificationPrefsUpdate(',
      'function prefsVersionForNotificationPrefsUpdate(',
      'web.notificationPrefs.scopeId',
    );
    // sameNotificationPrefsUpdate is the final declaration in the file; take it
    // to EOF after asserting the marker is unique.
    const equalityFrom = source.indexOf('function sameNotificationPrefsUpdate(');
    if (equalityFrom < 0 || source.indexOf('function sameNotificationPrefsUpdate(', equalityFrom + 1) !== -1) {
      throw new Error('web.notificationPrefs.equality: marker not unique');
    }
    const equality = source.slice(equalityFrom);
    const { value } = runSegment({
      label: 'web.notificationPrefs',
      code: `${head}\n${scopeId}\n${equality}`,
      names: [
        'NOTIFICATION_PREFS_SYNC_DOMAIN', 'createInitialNotificationPrefsDomainState',
        'applyNotificationPrefsDomainEvent', 'createNotificationPrefsSyncDomain',
        'scopeIdForNotificationPrefsUpdate', 'sameNotificationPrefsUpdate',
      ],
    });
    m.webNotificationPrefs = value;
  }

  m.recordedWarnings = recordedWarnings;
  return m;
}

/** Loads the generated Activity JSON Schema bundle (pinned bytes, parsed). */
export async function loadActivityJsonSchema() {
  const pin = PINNED.activityJsonSchema;
  const raw = await readFile(path.join(repoRoot, pin.path), 'utf8');
  return JSON.parse(raw);
}
