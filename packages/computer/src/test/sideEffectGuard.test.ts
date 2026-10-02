// Negative probes run in disposable child processes. Their own audit files
// prove denial before a real side effect, without weakening the suite guard.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execute = promisify(execFile);
async function probe(source: string): Promise<Array<{ kind: string; target: string }>> {
  const root = await mkdtemp(path.join(tmpdir(), 'raft-side-effect-probe-'));
  try {
    await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: path.resolve(import.meta.dirname, '../..'), timeout: 10_000,
      env: { ...process.env, RAFT_TEST_SIDE_EFFECT_ROOT: root,
        RAFT_HOME: path.join(root, 'home'), SLOCK_HOME: path.join(root, 'home'),
        VITEST: '', HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '', http_proxy: '', all_proxy: '' },
    });
    try { return (await readFile(path.join(root, 'violations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('global fetch, undici and https cannot reach an official endpoint in a Node child', async () => {
  const events = await probe(`
    import { fetch as undiciFetch } from 'undici';
    import https from 'node:https';
    for (const fetcher of [globalThis.fetch, undiciFetch]) {
      try { await fetcher('https://api.raft.build/api/auth/device/authorize'); } catch {}
    }
    try { await new Promise((resolve, reject) => https.get('https://app.raft.build/login/device', resolve).on('error', reject)); } catch {}
  `);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.kind === 'network'));
});

test('a local address belonging to no test server is refused before connection', async () => {
  const events = await probe(`try { await fetch('http://127.0.0.1:32123/'); } catch {}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'network');
});

test('a test-owned server redirect cannot escape to the official service', async () => {
  const events = await probe(`
    import { createServer } from 'node:http';
    const server = createServer((_, response) => { response.writeHead(302, { location: 'https://api.raft.build/' }); response.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await fetch('http://127.0.0.1:' + server.address().port); } catch {}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  `);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'network');
});

test('browser process entry points are denied in child processes and shells', async () => {
  const events = await probe(`
    import { spawn, execFileSync, execSync } from 'node:child_process';
    for (const action of [() => spawn('open', ['https://app.raft.build/']),
      () => execFileSync('xdg-open', ['https://app.raft.build/']),
      () => execSync('/usr/bin/open https://app.raft.build/')]) { try { action(); } catch {} }
  `);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.kind === 'browser'));
});

test('a login presenter with deliberately missing openUrl injection never opens a browser', async () => {
  const events = await probe(`
    import { createServer } from 'node:http';
    import { runLogin } from './src/login.ts';
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url.endsWith('authorize')) {
        response.statusCode = 201; response.end(JSON.stringify({ deviceCode: 'fixture', userCode: 'ABCD-1234',
          verificationUri: 'https://app.raft.build/login/device', expiresIn: 5, interval: 1 }));
      } else { response.statusCode = 403; response.end(JSON.stringify({ code: 'access_denied' })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await runLogin({ serverUrl: 'http://127.0.0.1:' + server.address().port }); } catch {}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  `);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'browser');
});


test('a shell-native curl cannot send an official request', async () => {
  const events = await probe(`
    import { spawnSync } from 'node:child_process';
    spawnSync('sh', ['-c', 'curl -fsSL https://api.raft.build/'], { stdio: 'pipe' });
  `);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'network');
});


test('nested Node children with an explicit environment still inherit the network guard', async () => {
  const events = await probe(`
    import { execFileSync } from 'node:child_process';
    execFileSync(process.execPath, ['--input-type=module', '-e', "try { await fetch('https://api.raft.build/'); } catch {}"], { env: {} });
  `);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'network');
});

test('an unmocked real authorization client fails before requesting an official device code', async () => {
  const events = await probe(`
    import { login } from './src/services/login.ts';
    try { await login({ slockHome: process.env.RAFT_HOME, serverUrl: 'https://api.raft.build' }); } catch {}
  `);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'network');
});


test('CI fails the named case even when business code swallows a denied request', async () => {
  const directory = await mkdtemp(path.join(import.meta.dirname, 'guard-probe-'));
  const audit = await mkdtemp(path.join(tmpdir(), 'raft-swallowed-request-'));
  const packageRoot = path.resolve(import.meta.dirname, '../..');
  try {
    const fixture = path.join(directory, 'swallowed.probe.ts');
    const config = path.join(directory, 'vitest.config.mjs');
    await writeFile(fixture, `import { test } from 'vitest';
      test('deliberately swallowed official request', async () => {
        try { await fetch('https://api.raft.build/'); } catch {}
      });`);
    await writeFile(config, `export default { test: { pool: 'forks', maxWorkers: 1, minWorkers: 1,
      include: [${JSON.stringify(fixture)}], setupFiles: [${JSON.stringify(path.join(packageRoot, 'src/test/hermeticSideEffectsSetup.ts'))}],
      testTimeout: 10000, hookTimeout: 10000 } };`);
    await assert.rejects(() => execute(process.execPath, [path.join(packageRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
      cwd: packageRoot, timeout: 30_000, env: { ...process.env, RAFT_TEST_SIDE_EFFECT_ROOT: audit },
    }), (error: unknown) => {
      const output = (error as { stdout: string; stderr: string }).stdout + (error as { stderr: string }).stderr;
      assert.match(output, /deliberately swallowed official request/);
      assert.match(output, /HERMETIC_SIDE_EFFECT_VIOLATION/);
      return true;
    });
    const events = (await readFile(path.join(audit, 'violations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].test, 'deliberately swallowed official request');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(audit, { recursive: true, force: true });
  }
});


test('a closed fixture port never permits a connection to an unrelated replacement', async () => {
  const events = await probe(`
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    const original = createServer();
    await new Promise(resolve => original.listen(0, '127.0.0.1', resolve));
    const port = original.address().port;
    await new Promise(resolve => original.close(resolve));
    let contacted = false;
    const foreign = createServer((_, response) => { contacted = true; response.end(); });
    await new Promise(resolve => foreign.listen.original.call(foreign, port, '127.0.0.1', resolve));
    await assert.rejects(() => fetch('http://127.0.0.1:' + port));
    assert.equal(contacted, false);
    await new Promise(resolve => foreign.close(resolve));
  `);
  assert.deepEqual(events, []);
});


test('direct native clients reject URL overrides and never follow a fixture redirect', async () => {
  const events = await probe(`
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { spawnSync } from 'node:child_process';
    const server = createServer((_, response) => {
      response.writeHead(302, { location: 'https://api.raft.build/' }); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    // Asynchronous invocation lets the fixture serve while curl is running.
    const { execFile } = await import('node:child_process');
    await new Promise(resolve => execFile(process.env.RAFT_TEST_REAL_CURL, ['-L', url], (error) => {
      assert.ok(error, 'redirect must stop without following the remote URL'); resolve();
    }));
    for (const extra of [['--url=https://api.raft.build/'], ['api.raft.build'],
      ['ftp://api.raft.build/'], ['--config', '/dev/null'], ['--resolve', 'host:80:127.0.0.1']]) {
      const result = spawnSync(process.env.RAFT_TEST_REAL_CURL, [url, ...extra], { stdio: 'pipe' });
      assert.notEqual(result.status, 0);
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  `);
  assert.equal(events.length, 5);
  assert.ok(events.every(event => event.kind === 'network'));
});
