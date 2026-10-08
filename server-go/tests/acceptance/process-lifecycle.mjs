// Real-process acceptance, independent of Web UI and browser automation.
// All accounts, key corruption and writes are confined to the runner's temp dir.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyProcessLifecycle({ origin, data, start, stop, capture, executable, env }) {
  const email = `restart-${Date.now().toString(36)}@example.test`;
  const password = 'Temporary-restart-check-password!';
  const request = async (route, { method = 'GET', body, token } = {}) => {
    const response = await fetch(new URL(route, origin), {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, data: await response.json() };
  };
  const registered = await request('/api/auth/register', {
    method: 'POST', body: { email, password, acceptTerms: true, termsVersion: '2026-05-12', privacyVersion: '2026-05-12' },
  });
  assert.equal(registered.status, 200, 'restart fixture registration');
  const account = registered.data;
  const mailbox = await capture(executable, ['mailbox', '-json', 'latest'], { env });
  assert.equal(mailbox.code, 0, 'mailbox CLI exits successfully');
  const mail = JSON.parse(mailbox.stdout);
  assert.equal(mail.to, email, 'mailbox CLI returns the latest actual email');
  assert.equal(mail.kind, 'verify');
  assert.ok(mail.links.some(link => new URL(link).origin === 'http://127.0.0.1:5175'), 'verification link honors configured origin');
  const keyFile = path.join(data, 'keys', 'jwt-secret');
  const originalKey = await readFile(keyFile);

  const rotated = await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: account.refreshToken } });
  assert.equal(rotated.status, 200, 'rotate before process restart');
  await stop();
  await start();
  assert.ok((await readFile(keyFile)).equals(originalKey), 'signing key is unchanged across process restart');
  const me = await request('/api/auth/me', { token: rotated.data.accessToken });
  assert.equal(me.status, 200, 'old access token works after process restart');
  assert.equal(me.data.id, account.user.id, 'account identity survives process restart');
  const refreshed = await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: rotated.data.refreshToken } });
  assert.equal(refreshed.status, 200, 'refresh session persisted across process restart');
  const access = refreshed.data.accessToken;
  assert.equal((await request('/api/auth/verify-email', { method: 'POST', token: access, body: { token: mail.token } })).status, 200, 'verification token issued before restart remains usable');
  assert.equal((await request('/api/auth/me/complete-profile', { method: 'POST', token: access, body: { name: 'restart_user', displayName: 'Restart Tester' } })).status, 200);
  const patch = await request('/api/auth/me', { method: 'PATCH', token: access, body: { displayLanguage: 'en', preferredTimezone: 'UTC' } });
  assert.equal(patch.status, 200, 'persist profile preferences');
  const other = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(other.status, 200, 'password hash survived restart');
  assert.equal((await request('/api/auth/logout', { method: 'POST', token: access, body: { refreshToken: refreshed.data.refreshToken } })).status, 200);
  await stop();
  await start();
  assert.equal((await request('/api/auth/me', { token: access })).status, 401, 'revocation survives process restart');
  assert.equal((await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: refreshed.data.refreshToken } })).status, 401, 'revoked refresh cannot revive after restart');
  const retained = await request('/api/auth/me', { token: other.data.accessToken });
  assert.equal(retained.status, 200, 'independent session survives');
  assert.equal(retained.data.name, 'restart_user');
  assert.equal(retained.data.displayLanguage, 'en');
  assert.equal(retained.data.emailVerified, true);
  assert.deepEqual((await request('/api/servers', { token: other.data.accessToken })).data, [], 'verified profile reaches the real empty workspace list');
  console.log('PASS real process restarts preserve account, signing key, profile, tokens and revocations');
  console.log('PASS private mailbox CLI and configured verification-link origin');

  await stop();
  try {
    const damaged = Buffer.from('deliberately-invalid-test-key');
    await writeFile(keyFile, damaged, { mode: 0o600 });
    const failed = await capture(executable, [], { env, timeout: 15000 });
    assert.notEqual(failed.code, 0, 'corrupt signing key must prevent startup');
    assert.ok((await readFile(keyFile)).equals(damaged), 'failed startup must not silently rotate a corrupt key');
    assert.ok(!failed.stdout.includes(password), 'startup errors do not print credentials');
  } finally {
    await writeFile(keyFile, originalKey, { mode: 0o600 });
  }
  await start();
  assert.equal((await request('/api/auth/me', { token: other.data.accessToken })).status, 200, 'restoring original key recovers the existing session');
  console.log('PASS corrupt-key startup fails closed and restoring the key preserves sessions');
}
