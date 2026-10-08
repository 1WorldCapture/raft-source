// Builds a CGO-free server and exercises it against disposable local SQLite.
// Node is only a test runner dependency. Never starts Web UI or the TS server.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyProcessLifecycle } from './process-lifecycle.mjs';
import { verifyWorkspaceContract } from './workspaces-contract.mjs';
import { verifyWorkspaceLifecycle } from './workspaces-lifecycle.mjs';
import { verifyM1WorkspaceUpgrade } from './workspaces-upgrade.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'raft-go-http-'));
let child;
let logs = '';

// Every subprocess has a deadline and is reaped before temporary data removal.
function capture(program, args, { timeout = 120000, env = process.env, cwd = root, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const worker = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, timeout);
    worker.stdout.on('data', chunk => { stdout += chunk; if (inherit) process.stdout.write(chunk); });
    worker.stderr.on('data', chunk => { stderr += chunk; if (inherit) process.stderr.write(chunk); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${path.basename(program)} timed out; subprocess was stopped`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}
async function command(program, args, options = {}) {
  const result = await capture(program, args, { ...options, inherit: true });
  if (result.code !== 0) throw new Error(`${path.basename(program)} failed with exit code ${result.code}`);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stop({ strict = true } = {}) {
  if (!child) return;
  const running = child;
  child = null;
  if (running.exitCode !== null || running.signalCode !== null) {
    if (strict) throw new Error('Server exited unexpectedly before graceful shutdown');
    return;
  }
  const exited = once(running, 'exit');
  let forced = false;
  const timer = setTimeout(() => { forced = true; running.kill('SIGKILL'); }, 12000);
  running.kill('SIGTERM');
  try {
    const [code, signal] = await exited;
    if (strict && (forced || code !== 0 || signal !== null)) {
      throw new Error('Server did not stop gracefully within the shutdown deadline');
    }
  } finally {
    clearTimeout(timer);
  }
}
try {
  const executable = path.join(dir, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
  await command('go', ['build', '-o', executable, './cmd/raft-server'], { env: { ...process.env, CGO_ENABLED: '0' } });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const data = path.join(dir, 'data');
  // Deliberately do not inherit RAFT_GO_* or a persistent signing secret.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    RAFT_GO_LISTEN: `127.0.0.1:${port}`, RAFT_GO_DATA_DIR: data,
    RAFT_GO_WEB_ORIGIN: 'http://127.0.0.1:5175', RAFT_GO_MAIL_MODE: 'outbox',
  };
  const start = async () => {
    if (child) throw new Error('Refusing to start a duplicate test process');
    child = spawn(executable, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-1024 * 1024); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before readiness');
      try {
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {}
      await sleep(100);
    }
    throw new Error('Server readiness timed out');
  };
  await start();
  await command(process.execPath, [path.join(here, 'http-contract.mjs')], {
    env: { ...process.env, RAFT_GO_TEST_URL: origin, RAFT_GO_TEST_MAILDIR: path.join(data, 'outbox') },
  });
  await verifyProcessLifecycle({ origin, data, start, stop, capture, executable, env });
  const workspaceFixture = await verifyWorkspaceContract({ origin, data });
  await verifyWorkspaceLifecycle({ origin, data, start, stop, fixture: workspaceFixture });
  await verifyM1WorkspaceUpgrade({ origin, env, start, stop, capture });
  await stop();
  if (/[?&](verify|reset)=|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(logs)) {
    throw new Error('Server emitted credential-like material to logs');
  }
  console.log('PASS graceful shutdown and credential-safe process output');
  console.log('Backend HTTP acceptance complete; no Web UI was started or tested.');
} finally {
  await stop({ strict: false });
  await rm(dir, { recursive: true, force: true });
}
