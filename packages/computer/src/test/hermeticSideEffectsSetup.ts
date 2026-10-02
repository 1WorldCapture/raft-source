// Enforce zero real remote connections and browser launches, even if a test
// forgets injection or a presenter swallows the transport/open error.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { installSideEffectGuard, auditEvents } from './sideEffectGuard.mjs';

const allocated = await mkdtemp(path.join(tmpdir(), 'raft-test-side-effects-'));
const previous = process.env.RAFT_TEST_SIDE_EFFECT_ROOT;
const guard = installSideEffectGuard(allocated);
const root = guard.root;
function assertNoViolations(): void {
  const events = auditEvents(root);
  if (events.length) throw new Error(`HERMETIC_SIDE_EFFECT_VIOLATION: ${JSON.stringify(events)}`);
}
beforeEach((context) => { process.env.RAFT_TEST_CURRENT_CASE = context.task.name; });
afterEach(assertNoViolations);
afterAll(async () => {
  try { assertNoViolations(); }
  finally {
    if (root === allocated) guard.restore();
    if (previous === undefined) delete process.env.RAFT_TEST_SIDE_EFFECT_ROOT;
    else process.env.RAFT_TEST_SIDE_EFFECT_ROOT = previous;
    await rm(allocated, { recursive: true, force: true });
  }
});
