// Reference verifier for the Go message slice: runs the REAL frozen TS/Web
// sources against Go-produced fixtures — no re-implementation, no key-list
// transcription.
//
// The Go test bundles this runner with the workspace's esbuild (static
// imports below pull the original TS modules into the bundle) and executes
// it with plain node, so no TS service/daemon is needed at verification time.
//
//   node <bundled> <fixtureDir>
//
// Verifications:
//   message_*.json      — every object carries the full canonicalRequired
//                         set of the ORIGINAL manifest module.
//   viewer_sequence.json— the ordered viewer snapshots produced by the Go
//                         store drive the ORIGINAL web reducer
//                         (applyVersionedViewerOverlaySnapshot); verdicts
//                         must match the expected sequence exactly.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_MESSAGE_MANIFEST } from "../../../../packages/shared/src/canonicalMessageManifest.ts";
import { reactionReadModelStore } from "../../../../packages/web/src/store/reactionReadModels.ts";

const fixtureDir = process.argv[2];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`REFERENCE-VERIFY-FAIL ${msg}`);
};

// 1. Canonical manifest over real Go message DTOs.
const required = CANONICAL_MESSAGE_MANIFEST.fields
  .filter((f) => f.class === "canonicalRequired")
  .map((f) => f.name);
for (const entry of readdirSync(fixtureDir).sort()) {
  if (!entry.startsWith("message_") || !entry.endsWith(".json")) continue;
  const parsed = JSON.parse(readFileSync(join(fixtureDir, entry), "utf8"));
  for (const field of required) {
    if (!(field in parsed)) fail(`${entry}: canonical required field ${field} missing`);
  }
}

// 2. Original viewer reducer over the ordered Go snapshot sequence.
const seqPath = join(fixtureDir, "viewer_sequence.json");
try {
  const fixture = JSON.parse(readFileSync(seqPath, "utf8"));
  const store = reactionReadModelStore;
  store.getState().activatePrincipal(fixture.principalId);
  if (store.getState().activePrincipalId !== fixture.principalId) {
    fail("viewer: principal activation failed");
  }
  fixture.snapshots.forEach((snapshot, index) => {
    const verdict = store.getState().applyVersionedViewerOverlaySnapshot(fixture.principalId, snapshot);
    const expected = fixture.expected[index];
    if (verdict.kind !== expected) {
      fail(`viewer snapshot ${index} (version ${snapshot.viewerVersion}): reducer said ${verdict.kind}${verdict.reason ? "/" + verdict.reason : ""}, expected ${expected}`);
    }
  });
  const finalSnapshot = fixture.snapshots[fixture.snapshots.length - 1];
  const state = store.getState();
  const key = JSON.stringify([fixture.principalId, finalSnapshot.serverId, finalSnapshot.messageId]);
  const stored = state.viewerSnapshotEmojis.get(key);
  if (JSON.stringify(stored ?? []) !== JSON.stringify(finalSnapshot.reactedEmojis)) {
    fail(`viewer final overlay ${JSON.stringify(stored)} != payload ${JSON.stringify(finalSnapshot.reactedEmojis)}`);
  }
} catch (err) {
  fail(`viewer sequence: ${err && err.message ? err.message : String(err)}`);
}

if (failures > 0) {
  process.exit(1);
}
console.log("REFERENCE-VERIFY-OK");
