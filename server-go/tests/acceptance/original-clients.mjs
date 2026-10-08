// Original, unmodified Computer and Daemon clients against the assembled Go server.
// Registration uses the M3 product harness. Device login, attach, preflight,
// server list, identity, machine roster, runners, and the daemon socket are
// the TypeScript classes themselves, loaded by tsx in a child process.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedAccount, createWorkspace, expectStatus, httpClient } from './m3-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const drive = path.join(here, '../fixtures/original-clients/drive.mjs');
const CHILD_TIMEOUT_MS = 100000;
const OUTPUT_LIMIT = 1024 * 1024;

function sensitivePattern(secrets) {
  const literals = secrets
    .filter((value) => typeof value === 'string' && value.length >= 8)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const embedded = literals.length > 0 ? `${literals.join('|')}|` : '';
  return new RegExp(
    `${embedded}sk_(?:computer|machine|agent|daemon)_[A-Za-z0-9_-]+|Bearer\\s+\\S+|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.|(?:accessToken|refreshToken|apiKey|deviceCode|userCode|password)\\s*[:=]\\s*\\S+`,
    'i',
  );
}

function childEnv(home) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LANG: process.env.LANG || 'C.UTF-8',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function passLines(stdout) {
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('PASS original-clients'));
}

/**
 * @param {{
 *   origin: string,
 *   data: string,
 *   capture: (event: { stream: 'stdout' | 'stderr', text: string }) => void,
 *   executable?: string,
 * }} args
 *   origin: loopback Go base URL (no path). The test also opens its own
 *   same-origin proxy in front of this URL.
 *   data: server data directory; the private outbox is data/outbox.
 *   capture: receives each captured subprocess stream once, after it has
 *   been checked for credential material. A leak throws and capture is not called.
 *   executable: optional absolute path to the repository tsx binary.
 *   Defaults to <repo>/node_modules/.bin/tsx.
 */
export async function verifyOriginalClients({ origin, data, capture, executable } = {}) {
  if (typeof capture !== 'function') throw new Error('verifyOriginalClients requires capture(event)');
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const owner = await createVerifiedAccount(request, maildir, 'original');
  const profile = await request('/api/auth/me', { token: owner.accessToken });
  expectStatus(profile, 200, 'original-client fixture profile');
  const workspace = await createWorkspace(request, owner, 'original');
  const tsx = executable ?? path.join(repo, 'node_modules', '.bin', 'tsx');
  try { await access(tsx); } catch { throw new Error('repository tsx binary is not available for the original client test'); }
  const home = await mkdtemp(path.join(tmpdir(), 'raft-original-clients-'));
  const fixture = {
    directOrigin: new URL(origin).origin,
    ownerAccessToken: owner.accessToken,
    ownerUserId: owner.user.id,
    ownerEmail: profile.data.email,
    ownerName: profile.data.name,
    ownerDisplayName: profile.data.displayName ?? null,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
  };
  const pattern = sensitivePattern([owner.accessToken, owner.refreshToken, owner.password, owner.email]);
  let stdout = '';
  let stderr = '';
  let child;
  let timedOut = false;
  try {
    child = spawn(tsx, [drive], { cwd: repo, env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > OUTPUT_LIMIT) { timedOut = true; child.kill('SIGKILL'); }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > OUTPUT_LIMIT) { timedOut = true; child.kill('SIGKILL'); }
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(JSON.stringify(fixture));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
    let result;
    try { result = await finished; } finally { clearTimeout(timer); }
    const combined = `${stdout}\n${stderr}`;
    if (pattern.test(combined)) {
      throw new Error('original client subprocess output contained credential material');
    }
    capture({ stream: 'stdout', text: stdout });
    capture({ stream: 'stderr', text: stderr });
    if (timedOut) throw new Error('original client subprocess exceeded its deadline or output limit');
    const passed = passLines(stdout);
    if (result.signal) throw new Error(`original client subprocess stopped by ${result.signal}`);
    if (result.code !== 0) {
      const failure = stderr.split('\n').map((line) => line.trim()).find((line) => line.startsWith('FAIL original-clients'));
      throw new Error(failure || `original client subprocess exited ${result.code}`);
    }
    for (const required of ['PASS original-clients direct', 'PASS original-clients proxy', 'PASS original-clients proxy-forwarded /api /internal /daemon']) {
      if (!passed.includes(required)) throw new Error(`original client subprocess did not report ${required}`);
    }
    if (!passed.some((line) => line.startsWith('PASS original-clients device-verification-origin '))) {
      throw new Error('original client subprocess did not report the device verification origin');
    }
    for (const line of passed) console.log(line);
    return { ok: true, verificationOrigin: passed.find((line) => line.startsWith('PASS original-clients device-verification-origin '))?.split(' ').at(-1) ?? null };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL');
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL;
  const data = process.env.RAFT_GO_TEST_DATA;
  if (!origin || !data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyOriginalClients({ origin, data, capture() {} });
}
