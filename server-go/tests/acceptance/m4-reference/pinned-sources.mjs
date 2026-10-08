// M4 backend-compatibility reference tests — original TS source registry.
//
// Every original file executed or quoted by this suite is SHA-256 pinned here
// against the M4 implementation baseline (bc65213). If any pinned byte drifts,
// the suite refuses to run: regenerated "equivalence evidence" over a moving
// baseline is worse than no evidence. This mirrors the M2 reference-test rule
// (tests/acceptance/workspaces-reference.mjs).
//
// This file is test infrastructure only. It never modifies the original
// sources; segments are extracted from the pinned bytes at run time.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const M4_BASELINE_COMMIT = 'bc65213b377a992c381e809c72ba50ca9af367fd';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../../..');
export const serverGoRoot = path.resolve(here, '../../..');
export const contractsDir = path.join(serverGoRoot, 'contracts', 'm4');

// key -> { path (repo-relative), sha256 }
export const PINNED = Object.freeze({
  serverMessagesRoute: {
    path: 'packages/server/src/routes/messages.ts',
    sha256: '7a7ca204e4956cfb6bc180ccc7689f419c2197c51aa9e1f64a1e89ee8bd759a7',
  },
  serverChannelsRoute: {
    path: 'packages/server/src/routes/channels.ts',
    sha256: '1014a8e565e4cc2906616af8274eb4b1fd2a63b347839ae8ac5c33b761265109',
  },
  serverReadMutationsRoute: {
    path: 'packages/server/src/routes/readMutations.ts',
    sha256: '3c8587881b6dd9dd34cfa37863a40cf05136b4fae107b8d1b24fdd2974f55e0d',
  },
  serverReadMutationSequencer: {
    path: 'packages/server/src/services/readMutationSequencer.ts',
    sha256: 'd7b9c53834fffe3d196aa8340ecbcab29284b0ff3454b6ab32e4934e17f12800',
  },
  serverMessageRealtimeEvents: {
    path: 'packages/server/src/services/messageRealtimeEvents.ts',
    sha256: 'aa8b88ed8ec08cca36f858043be31807e08a97b694ba39e48bb070cce6f7edff',
  },
  serverMessageService: {
    path: 'packages/server/src/services/messageService.ts',
    sha256: 'd49aad2a3d25a6d4cef1225f16aacb80c2fbf1188d483782ce4654b3aa38d280',
  },
  sharedCanonicalMessageManifest: {
    path: 'packages/shared/src/canonicalMessageManifest.ts',
    sha256: 'f1cecab62c6380b5416f3cdf7a17c6efdd33445609c3c2aae10bbd7d8fed660f',
  },
  sharedActivityMute: {
    path: 'packages/shared/src/activityMute.ts',
    sha256: 'e356b1341dd626d2bab51b5f86ed61f8436cbc156b8d654bd8d949a4efb7230e',
  },
  sharedIndex: {
    path: 'packages/shared/src/index.ts',
    sha256: '9224fa36c718ec9b4d8a04ab0906c5d3ab597a03adaf2c48a3d3d78c33e750cb',
  },
  syncCoreUint64: {
    path: 'packages/sync-core/src/uint64.ts',
    sha256: '1551c72973aeecee7422009e931f7abc31d294b4e8779a97aecfd1fce3cc4781',
  },
  syncCoreCore: {
    path: 'packages/sync-core/src/core.ts',
    sha256: 'b3906ae8dcb80037de36f79630197129febc333b3f171c8d6f2b376181f21104',
  },
  syncCoreViolations: {
    path: 'packages/sync-core/src/violations.ts',
    sha256: '148effe9deaf4c5e88ff24cee6dc6a247cd08043f515ecbca1869addce72276c',
  },
  syncCoreActivityDomain: {
    path: 'packages/sync-core/src/domains/activity.ts',
    sha256: 'f4ef5ac8ff045a6de4c7327d27a32930ba3db70e8d54f7f33f8a6f164ad863f5',
  },
  activityRunner: {
    path: 'packages/sync-core/contracts/activity-v1/runner/runBehaviorVectors.ts',
    sha256: 'eb9bb37ccef7c545c9b3ea22638735ece54c9685f5e930a934d40089b22ba984',
  },
  activityJsonSchema: {
    path: 'packages/sync-core/contracts/activity-v1/generated/json-schema/activity-sync.schema.json',
    sha256: '58177bc39e9038b65d72b768dcf5ceb9687117b8d362cd7c21eec684e56fc248',
  },
  activityContractVectors: {
    path: 'packages/sync-core/contracts/activity-v1/fixtures/activity-sync.contract-vectors.jsonl',
    sha256: '89ef866cc5e16dd321945c422e5f9ae7919157312d4bafbc68e9241d6ae3bee3',
  },
  activityBehaviorVectors: {
    path: 'packages/sync-core/contracts/activity-v1/fixtures/activity-sync.behavior.jsonl',
    sha256: 'ac94f85c23656184724e7b91e4957e278b4a8554878600842c3684b9c7855bd1',
  },
  activityManifest: {
    path: 'packages/sync-core/contracts/activity-v1/manifest.json',
    sha256: '7743a8086e6d443656b7527486a6170439c3a0c8681e9b4f02e74e0165967cf1',
  },
  webMessageSyncDomain: {
    path: 'packages/web/src/store/messageSyncDomain.ts',
    sha256: '17e7f4bdc6bb959aec8be87a9f75e96e567cbaaa17925ed3fd06cc510b015b29',
  },
  webMessageStore: {
    path: 'packages/web/src/store/messageStore.ts',
    sha256: '4304afdeefa98ebe3e0fee858e4067cbb019da5c54a7489a676bcd8426b4760b',
  },
  webReadReceiptDomain: {
    path: 'packages/web/src/store/readReceiptDomain.ts',
    sha256: '12aad0e3a6e1b2d69adc3db2a69cff8f3fc7a70bbf2ff7ba52a31a08b343bb24',
  },
  webChannelDomain: {
    path: 'packages/web/src/store/channelDomain.ts',
    sha256: '2337d2458d0c994d51e7cb361483aacea843cbee55185245fc43c08b486a0392',
  },
  webReadStateSync: {
    path: 'packages/web/src/store/readStateSync.ts',
    sha256: 'ef1b5b56a7336b352294c8e32bb0343a8830a5e76edf4807a0cf115cd3928a37',
  },
  webNotificationPrefsSyncDomain: {
    path: 'packages/web/src/store/notificationPrefsSyncDomain.ts',
    sha256: 'bd167f42c37e186fb63c0900cc627b5fb6efa1f802a1dbbd73d742c8e3780d0d',
  },
  webReactionReadModels: {
    path: 'packages/web/src/store/reactionReadModels.ts',
    sha256: 'd22b8995e15fc8c24405434022ae91bb7beb985819ed50749fdd4767f9440b0b',
  },
});

const cache = new Map();

/** Reads a pinned source, verifying its SHA-256 first. Refuses on drift. */
export async function readPinned(key) {
  if (cache.has(key)) return cache.get(key);
  const pin = PINNED[key];
  if (!pin) throw new Error(`unknown pinned source key: ${key}`);
  const abs = path.join(repoRoot, pin.path);
  const source = await readFile(abs, 'utf8');
  const actual = createHash('sha256').update(source).digest('hex');
  if (actual !== pin.sha256) {
    throw new Error(
      `pinned source ${pin.path} changed (sha256 ${actual} != pinned ${pin.sha256}). `
      + `Re-review the M4 baseline before regenerating compatibility evidence.`,
    );
  }
  cache.set(key, source);
  return source;
}

/**
 * Extracts the contiguous segment [fromMarker, toMarker) from pinned bytes.
 * Markers must each occur exactly once, so a moved function cannot silently
 * select the wrong span.
 */
export function segmentOf(source, fromMarker, toMarker, label) {
  const from = source.indexOf(fromMarker);
  const to = source.indexOf(toMarker);
  if (from < 0) throw new Error(`segment ${label}: from-marker not found`);
  if (to < from) throw new Error(`segment ${label}: to-marker not found or precedes from-marker`);
  if (source.indexOf(fromMarker, from + 1) !== -1) {
    throw new Error(`segment ${label}: from-marker is not unique`);
  }
  return source.slice(from, to);
}

/** Deterministic JSON.stringify for byte-stable contract fixtures. */
export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
