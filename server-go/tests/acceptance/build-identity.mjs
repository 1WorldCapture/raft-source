// Operator diagnostics for the running executable, not the current checkout.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function verifyBuildIdentity({ origin, capture, executable, env }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raft-build-identity-'));
  try {
    // version must not load config, open a port, create keys or migrate data.
    const version = await capture(executable, ['version'], {
      env: { ...env, RAFT_GO_DATA_DIR: path.join(dir, 'unused'), RAFT_GO_LISTEN: 'deliberately invalid', RAFT_GO_JWT_SECRET: 'too-short' },
      timeout: 15000,
    });
    assert.equal(version.code, 0, 'version must work without loading configuration');
    const local = JSON.parse(version.stdout);
    assert.equal(local.stage, 'm3');
    assert.deepEqual(Object.keys(local).sort(), ['stage', 'revision', 'modified', 'commitTime', 'buildTime', 'goVersion'].sort());
    assert.deepEqual(await readdir(dir), [], 'version must not create any data');
    const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const running = await response.json();
    assert.deepEqual(running, local, 'HTTP and executable must identify the same compiled build');
    const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.headers.get('x-raft-go-stage'), local.stage);
    assert.equal(health.headers.get('x-raft-go-revision'), local.revision);
    assert.equal(health.headers.get('x-raft-go-build-time'), local.buildTime);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'alive', stage: local.stage }, 'health body must agree with /version and build headers');
    console.log('PASS executable, /version, /healthz body and HTTP build headers agree; version command has no data/config side effects');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
