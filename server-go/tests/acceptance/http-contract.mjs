// Independent black-box checks. Run only against an isolated local test server.
// No production accounts, credentials, or token-bearing responses are logged.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const origin = process.env.RAFT_GO_TEST_URL;
const maildir = process.env.RAFT_GO_TEST_MAILDIR;
if (!origin || !maildir) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_MAILDIR to an isolated local test instance.');
const u = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Acceptance tests are restricted to loopback.');
const suffix = Date.now().toString(36);
const email = `http-${suffix}@example.test`;
const password = `Only-test-${suffix}-Password!`;
const nextPassword = `${password}-changed`;
const legal = { acceptTerms: true, termsVersion: '2026-05-12', privacyVersion: '2026-05-12', legalAcceptanceSource: 'signup' };
const passed = [];

async function request(route, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(new URL(route, origin), {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data, headers: response.headers };
}
function status(result, expected, context) { assert.equal(result.status, expected, `${context}: unexpected HTTP status`); }
function tokenShape(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 20, 'token must be nonempty');
}
async function check(name, work) {
  await work(); passed.push(name); console.log(`PASS ${name}`);
}
async function files(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...await files(full));
    else if (item.isFile()) out.push(full);
  }
  return out;
}
async function mailToken(kind) {
  // The mailbox is intentional generated public output, never source-code evidence.
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const file of (await files(maildir)).reverse()) {
      const text = await readFile(file, 'utf8');
      if (!text.includes(email)) continue;
      const decoded = text.replaceAll('\\u0026', '&').replaceAll('=3D', '=').replaceAll('\\/', '/');
      const found = decoded.match(new RegExp(`[?&]${kind}=([A-Za-z0-9._~-]+)`));
      if (found) return found[1];
    }
    await sleep(100);
  }
  throw new Error(`No ${kind} mail arrived in private test mailbox`);
}

let session, second, verifyToken, rotated;
await check('health, readiness and provider contract', async () => {
  status(await request('/healthz'), 200, 'liveness');
  status(await request('/readyz'), 200, 'readiness');
  const providers = await request('/api/auth/providers'); status(providers, 200, 'providers');
  assert.deepEqual(providers.data.providers, []);
});
await check('unauthenticated access and required legal acceptance', async () => {
  status(await request('/api/auth/me'), 401, 'me');
  const bad = await request('/api/auth/register', { method: 'POST', body: { email, password } });
  assert.ok(bad.status >= 400 && bad.status < 500, 'missing legal acceptance must fail');
});
await check('signup returns legacy User and JWT wire shapes', async () => {
  const result = await request('/api/auth/register', { method: 'POST', body: { email, password, ...legal } });
  status(result, 200, 'signup'); session = result.data;
  tokenShape(session.accessToken); tokenShape(session.refreshToken);
  assert.equal(session.user.email, email);
  assert.equal(session.user.emailVerified, false);
  assert.equal(session.user.profileSetupCompletedAt, null);
  for (const field of ['id', 'name', 'displayName', 'avatarUrl', 'gravatarHash', 'preferredLanguage', 'displayLanguage', 'autoTranslationEnabled']) assert.ok(Object.hasOwn(session.user, field), `User missing ${field}`);
  const claims = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, session.user.id); assert.equal(claims.type, 'access');
  assert.ok(claims.exp * 1000 > Date.now());
  const me = await request('/api/auth/me', { token: session.accessToken });
  status(me, 200, 'me'); assert.equal(me.data.id, session.user.id); assert.equal(me.data.user, undefined);
});
await check('duplicate signup, invalid credentials and unverified access denied', async () => {
  status(await request('/api/auth/register', { method: 'POST', body: { email, password, ...legal } }), 409, 'duplicate email');
  status(await request('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } }), 401, 'wrong password');
  status(await request('/api/auth/login', { method: 'POST', body: { email: `absent-${email}`, password } }), 401, 'unknown account');
  status(await request('/api/servers', { token: session.accessToken }), 403, 'unverified workspace list');
  status(await request('/api/auth/me', { token: `${session.accessToken}tampered` }), 401, 'tampered access');
});
await check('real verification mail, wrong-purpose rejection and single use', async () => {
  verifyToken = await mailToken('verify');
  const wrongPurpose = await request('/api/auth/reset-password', { method: 'POST', body: { token: verifyToken, password: nextPassword } });
  assert.ok(wrongPurpose.status >= 400 && wrongPurpose.status < 500, 'verification token cannot reset password');
  status(await request('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken }, token: session.accessToken }), 200, 'verify email');
  const again = await request('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken }, token: session.accessToken });
  assert.ok(again.status >= 400 && again.status < 500, 'verification token must be single use');
  const me = await request('/api/auth/me', { token: session.accessToken }); assert.equal(me.data.emailVerified, true);
});
await check('profile validation, setup gate and bare workspace array', async () => {
  status(await request('/api/servers', { token: session.accessToken }), 403, 'unfinished profile');
  for (const name of ['system', 'pending_test', 'a', '123bad']) {
    const available = await request(`/api/auth/me/username-available?name=${encodeURIComponent(name)}`, { token: session.accessToken });
    status(available, 200, 'username precheck'); assert.equal(available.data.available, false);
  }
  const result = await request('/api/auth/me/complete-profile', { method: 'POST', token: session.accessToken, body: { name: `user_${suffix}`, displayName: 'SQLite Contract Tester' } });
  status(result, 200, 'complete profile'); assert.equal(result.data.id, session.user.id);
  assert.match(result.data.profileSetupCompletedAt, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
  const workspaces = await request('/api/servers', { token: session.accessToken }); status(workspaces, 200, 'workspace list'); assert.deepEqual(workspaces.data, []);
  const unsupported = await request('/api/servers', { method: 'POST', token: session.accessToken, body: { name: 'Not yet', slug: 'not-yet' } });
  assert.ok(unsupported.status >= 400, 'unimplemented workspace creation must not claim success');
});
await check('profile patch cannot grant verification, workspace or identity privileges', async () => {
  const patch = await request('/api/auth/me', { method: 'PATCH', token: session.accessToken, body: { displayName: 'Updated Name', displayLanguage: 'en', preferredTimezone: 'UTC' } });
  status(patch, 200, 'preference patch'); assert.equal(patch.data.displayName, 'Updated Name');
  await request('/api/auth/me', { method: 'PATCH', token: session.accessToken, body: { id: 'other', email: 'other@example.test', emailVerified: false, role: 'admin' } });
  const me = await request('/api/auth/me', { token: session.accessToken });
  assert.equal(me.data.id, session.user.id); assert.equal(me.data.email, email); assert.equal(me.data.emailVerified, true);
});
await check('simultaneous refresh uses one successor and remains live', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => request('/api/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } })));
  for (const result of results) status(result, 200, 'parallel refresh');
  assert.equal(new Set(results.map(r => r.data.refreshToken)).size, 1, 'parallel rotations must return same refresh successor');
  rotated = results[0].data;
  status(await request('/api/auth/me', { token: rotated.accessToken }), 200, 'rotated access');
});
await check('logout revokes current family, not an independent login', async () => {
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password } }); status(login, 200, 'second login'); second = login.data;
  const logout = await request('/api/auth/logout', { method: 'POST', body: { refreshToken: rotated.refreshToken }, token: rotated.accessToken });
  assert.ok(logout.status === 200 || logout.status === 204);
  status(await request('/api/auth/me', { token: rotated.accessToken }), 401, 'revoked access');
  status(await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: rotated.refreshToken } }), 401, 'revoked refresh');
  status(await request('/api/auth/me', { token: second.accessToken }), 200, 'other family preserved');
});
await check('reset response non-enumeration, mail, password change and all-session revoke', async () => {
  const known = await request('/api/auth/forgot-password', { method: 'POST', body: { email } });
  const unknown = await request('/api/auth/forgot-password', { method: 'POST', body: { email: `absent-${email}` } });
  status(known, 200, 'forgot known'); status(unknown, 200, 'forgot unknown'); assert.deepEqual(known.data, unknown.data);
  const resetToken = await mailToken('reset');
  status(await request('/api/auth/reset-password', { method: 'POST', body: { token: resetToken, password: nextPassword } }), 200, 'reset');
  status(await request('/api/auth/me', { token: second.accessToken }), 401, 'reset revoked access');
  status(await request('/api/auth/refresh', { method: 'POST', body: { refreshToken: second.refreshToken } }), 401, 'reset revoked refresh');
  status(await request('/api/auth/login', { method: 'POST', body: { email, password } }), 401, 'old password rejected');
  status(await request('/api/auth/login', { method: 'POST', body: { email, password: nextPassword } }), 200, 'new password login');
  const again = await request('/api/auth/reset-password', { method: 'POST', body: { token: resetToken, password } });
  assert.ok(again.status >= 400 && again.status < 500, 'reset token single use');
});
console.log(`HTTP acceptance passed: ${passed.length} groups. No secrets emitted.`);
