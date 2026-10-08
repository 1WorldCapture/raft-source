// Parent-owned isolated protocol spike runner. All generated modules, sums,
// binaries and logs live under an owned temporary directory; no fixed ports,
// no main go.mod mutation, no UI/browser, and no live-service replacement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const source = path.join(here, 'm4-socket-spike');
const client = path.join(repo, 'node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js');
const dependency = 'github.com/zishang520/socket.io/servers/socket/v3';
const dir = await mkdtemp(path.join(tmpdir(), 'raft-go-socket-poc-'));
const tracked = new Set();
const servers = [];
const compileOnly = process.argv.includes('--compile-only');
const version = process.env.RAFT_M4_SOCKET_CANDIDATE_VERSION || 'latest';

function run(program, args, { timeout = 90000, cwd = dir, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    tracked.add(child);
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-256 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-256 * 1024); });
    child.once('error', error => { clearTimeout(timer); tracked.delete(child); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      tracked.delete(child);
      if (expired) reject(new Error(`${path.basename(program)} timed out; child reaped`));
      else if (code !== 0) reject(new Error(`${path.basename(program)} ${args[0] || ''} failed (${code ?? signal})\n${stderr.slice(-16000)}\n${stdout.slice(-16000)}`));
      else resolve({ stdout, stderr });
    });
  });
}
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function startServer(executable, listenPort, origins) {
  const child = spawn(executable, ['-addr', `127.0.0.1:${listenPort}`, '-origins', origins, '-heartbeat-ms', '1000'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tracked.add(child);
  servers.push(child);
  let logs = '', spawnError;
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
  child.once('error', error => { spawnError = error; });
  child.once('close', () => tracked.delete(child));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Spike exited before readiness: ${logs.slice(-4000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${listenPort}/healthz`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status === 200) return child;
    } catch {}
    await sleep(100);
  }
  throw new Error('Owned spike readiness timed out');
}
async function stop(child, strict) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (strict) throw new Error('Spike exited unexpectedly before controlled shutdown');
    return;
  }
  const done = once(child, 'exit');
  let forced = false;
  const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 12000);
  child.kill('SIGINT');
  try {
    const [code, signal] = await done;
    if (strict) assert.ok(!forced && code === 0 && signal === null, 'hijacked sockets must close and process must exit cleanly');
  } finally {
    clearTimeout(timer);
  }
}
let interrupted = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of tracked) child.kill('SIGKILL');
  });
}
try {
  await access(client);
  await copyFile(path.join(source, 'main.go'), path.join(dir, 'main.go'));
  await writeFile(path.join(dir, 'go.mod'), 'module spike.local/m4-socket\n\ngo 1.26.0\n');
  console.log('P0 resolving candidate in an isolated temporary module');
  await run('go', ['get', `${dependency}@${version}`]);
  await run('go', ['mod', 'tidy']);
  const meta = JSON.parse((await run('go', ['mod', 'download', '-json', dependency])).stdout);
  console.log('P0 candidate identity', JSON.stringify({ path: meta.Path, version: meta.Version, sum: meta.Sum, goModSum: meta.GoModSum }));
  const executable = path.join(dir, process.platform === 'win32' ? 'spike.exe' : 'spike');
  await run('go', ['build', '-o', executable, '.'], { env: { ...process.env, CGO_ENABLED: '0' } });
  console.log('PASS candidate CGO-free compilation');
  if (!compileOnly) {
    const mainPort = await port();
    let originPort = await port();
    while (originPort === mainPort) originPort = await port();
    const main = await startServer(executable, mainPort, '*');
    const restricted = await startServer(executable, originPort, 'http://good.example');
    const polling = await fetch(`http://127.0.0.1:${mainPort}/socket.io/?EIO=4&transport=polling`, { signal: AbortSignal.timeout(2000) });
    await polling.arrayBuffer();
    assert.equal(polling.status, 400, 'unsupported polling must not fake a handshake');
    const result = await run(process.execPath, [path.join(source, 'client.mjs'), String(mainPort), String(originPort)], {
      timeout: 150000,
      env: { ...process.env, SPIKE_CLIENT_ENTRY: pathToFileURL(client).href },
    });
    process.stdout.write(result.stdout);
    assert.match(result.stdout, /SPIKE SUMMARY pass=\d+ fail=0/);
    assert.doesNotMatch(result.stdout, /SPIKE-FAIL/);
    await stop(main, true);
    await stop(restricted, true);
    console.log('PASS original Socket.IO client protocol and graceful process cleanup; no browser/UI');
  }
  assert.equal(interrupted, false, 'spike was interrupted');
} finally {
  for (const child of servers) await stop(child, false);
  for (const child of tracked) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = once(child, 'close');
    child.kill('SIGKILL');
    await done;
  }
  await rm(dir, { recursive: true, force: true });
}
