// M3 acceptance harness — shared black-box helpers used by every m3-*.mjs module.
// Real product flows only: accounts come from register + private outbox verification,
// workspaces from POST /api/servers, Computer keys from the real device grant + attach.
// No seeded credentials, no setup-complete shortcuts, credentials never logged.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const isoMillis = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function httpClient(origin) {
  const parsed = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('M3 acceptance requires an isolated loopback instance.');
  }
  return async (route, { method = 'GET', body, token, server, headers = {} } = {}) => {
    const response = await fetch(new URL(route, origin), {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(server === undefined ? {} : { 'X-Server-Id': server }), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, data, headers: response.headers };
  };
}

export function expectStatus(result, expected, context) {
  assert.equal(result.status, expected, `${context}: HTTP status (response bodies and credentials intentionally omitted)`);
}

export function expectUUID(value, context) { assert.match(value ?? '', UUID_RE, context); }
export function exactKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }

async function findMailToken(maildir, email) {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const item of await readdir(maildir, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const text = await readFile(path.join(maildir, item.name), 'utf8');
      if (!text.includes(email)) continue;
      const decoded = text.replaceAll('\\u0026', '&').replaceAll('=3D', '=').replaceAll('\\/', '/');
      const token = decoded.match(/[?&]verify=([A-Za-z0-9._~-]+)/)?.[1];
      if (token) return token;
    }
    await sleep(100);
  }
  throw new Error('Verification mail did not arrive in the private test mailbox.');
}

// Full real signup: register -> outbox verification -> profile completion.
// Same contract the M2 suite exercises; nothing about M3 membership is assumed.
export async function createVerifiedAccount(request, maildir, label) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  const email = `${label}-${suffix}@example.test`;
  const password = `Private-test-${suffix}-Password!`;
  const signup = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password, acceptTerms: true, termsVersion: '2026-05-12', privacyVersion: '2026-05-12', legalAcceptanceSource: 'signup' },
  });
  expectStatus(signup, 200, 'M3 fixture account signup');
  const account = { ...signup.data, email, password };
  const verify = await findMailToken(maildir, email);
  expectStatus(await request('/api/auth/verify-email', { method: 'POST', token: account.accessToken, body: { token: verify } }), 200, 'M3 fixture account verification');
  expectStatus(await request('/api/auth/me/complete-profile', { method: 'POST', token: account.accessToken, body: { name: `m3_${suffix}`, displayName: 'M3 Acceptance Owner' } }), 200, 'M3 fixture account profile');
  return account;
}

export async function createWorkspace(request, account, label) {
  const suffix = randomUUID().slice(0, 8);
  const created = await request('/api/servers', {
    method: 'POST', token: account.accessToken,
    body: { name: `M3 ${label}`, slug: `m3-${label.toLowerCase()}-${suffix}` },
  });
  expectStatus(created, 200, 'M3 fixture workspace creation');
  return created.data;
}

// Real device-code grant: authorize -> approve as the given user -> token poll.
// Mirrors packages/computer/src/services/login.ts against /api/auth/device/*.
export async function deviceLogin(request, { approveToken, clientName = 'raft-computer' }) {
  const grant = await request('/api/auth/device/authorize', { method: 'POST', body: { clientName } });
  expectStatus(grant, 201, 'device authorize');
  const approve = await request('/api/auth/device/approve', { method: 'POST', token: approveToken, body: { userCode: grant.data.userCode } });
  expectStatus(approve, 200, 'device approve');
  for (let attempt = 0; attempt < 150; attempt++) {
    const poll = await request('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.data.deviceCode } });
    if (poll.status === 200) return { grant: grant.data, session: poll.data };
    if (poll.status === 400 && poll.data?.code === 'authorization_pending') { await sleep(100); continue; }
    throw new Error(`device token poll returned HTTP ${poll.status} (code ${poll.data?.code ?? 'none'}) before issuing a session`);
  }
  throw new Error('device token poll never issued a session');
}

// Real Computer attach with a device-issued user session; the raw key stays in memory.
export async function attachComputer(request, { userToken, serverSlug, name }) {
  const attached = await request('/api/computer/attach', { method: 'POST', token: userToken, body: { serverSlug, name } });
  expectStatus(attached, 201, 'computer attach');
  return attached.data;
}

// Bounded poll helper for eventually-consistent reads (connection status etc.).
export async function pollUntil(description, fn, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description} (last observation did not satisfy the condition)`);
}
