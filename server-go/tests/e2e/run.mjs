// Executable acceptance against the UNMODIFIED packages/web application.
// No API mocking, no auth-state injection, no external server, no saved tokens.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, start, stop, ready, freePort, sleep, emailLink, redact } from './support.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const goRoot = path.resolve(here, '../..');
const root = path.resolve(goRoot, '..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');
const temp = await mkdtemp(path.join(tmpdir(), 'raft-go-web-'));
const artifacts = path.join(here, 'artifacts');
await mkdir(artifacts, { recursive: true });
const report = { startedAt: new Date().toISOString(), passed: [], apiRequests: [], blockedExternal: [], pageErrors: [], success: false };
let backend, web, browser, context, page;
let stage = 'build';
const secret = randomBytes(12).toString('hex');
const email = `e2e-${secret.slice(0, 8)}@example.test`;
const password = `Test-only-${secret}!`;
const newPassword = `${password}-new`;
const handle = `e2e_${secret.slice(0, 10)}`;
const displayName = 'SQLite Browser Tester';
const apiPort = await freePort();
let webPort = await freePort();
while (webPort === apiPort) webPort = await freePort();
const origin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const dataDir = path.join(temp, 'data');
const binary = path.join(temp, process.platform === 'win32' ? 'raft-server.exe' : 'raft-server');
const backendEnv = env({ RAFT_GO_LISTEN: `127.0.0.1:${apiPort}`, RAFT_GO_DATA_DIR: dataDir, RAFT_GO_WEB_ORIGIN: origin,
  RAFT_GO_MAIL_MODE: 'outbox', RAFT_GO_ACCESS_TOKEN_TTL: '4s' });
const note = name => { report.passed.push(name); console.log(`PASS ${name}`); };
const endpoint = (response, p, method) => new URL(response.url()).pathname === p && response.request().method() === method;
const responseTo = (p, method = 'POST') => page.waitForResponse(r => endpoint(r, p, method), { timeout: 20000 });
async function workspace(p = page) { await p.locator('#server-create-name').waitFor({ state: 'visible', timeout: 30000 }); }
async function login(pw) {
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(pw);
  const reply = responseTo('/api/auth/login');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  return reply;
}
async function logout() {
  const reply = responseTo('/api/auth/logout');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  const r = await reply; assert.ok(r.status() === 200 || r.status() === 204, 'logout status');
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 30000 });
}
try {
  await exec('go', ['build', '-o', binary, './cmd/raft-server'], { cwd: goRoot, timeout: 180000, maxBuffer: 2 ** 20 });
  backend = start(binary, [], { cwd: temp, env: backendEnv });
  await ready(`${apiOrigin}/readyz`, backend);
  web = start('pnpm', ['--dir', path.join(root, 'packages/web'), 'exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: root,
    env: env({ SLOCK_SERVER_PORT: String(apiPort), SLOCK_WEB_PROXY_TARGET: '', VITE_API_URL: '', VITE_DEV_PORT: String(webPort),
      VITE_SLOCKDEV: '', VITE_SLOCKDEV_EMAIL: '', VITE_SLOCKDEV_PASSWORD: '', VITE_DEPLOYMENT_ENV: 'go-sqlite-e2e' }),
  });
  await ready(origin, web, 120000);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin) return route.continue();
    report.blockedExternal.push({ host: url.host, path: url.pathname });
    return route.abort(); // external font/avatar downloads cannot contact any old API
  });
  context.on('response', r => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) report.apiRequests.push({ method: r.request().method(), path: u.pathname, status: r.status(), local: u.origin === origin });
  });
  context.on('page', p => p.on('pageerror', error => report.pageErrors.push(redact(error.message).slice(0, 500))));
  page = await context.newPage(); page.setDefaultTimeout(20000);
  stage = 'registration';
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#login-email').waitFor({ timeout: 120000 });
  await page.getByText('Create one', { exact: true }).click();
  await page.locator('#register-email').fill(email);
  await page.locator('#register-password').fill(password);
  // The existing styled checkbox overlays the native input. Use the real
  // keyboard interaction instead of forcing a click through its visual span.
  await page.locator('input[type="checkbox"]').focus();
  await page.locator('input[type="checkbox"]').press('Space');
  assert.ok(await page.locator('input[type="checkbox"]').isChecked());
  const registration = responseTo('/api/auth/register');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const registered = await registration; assert.equal(registered.status(), 200, 'registration');
  const firstSession = await registered.json();
  assert.equal(firstSession.user.emailVerified, false);
  assert.ok(firstSession.accessToken && firstSession.refreshToken);
  await page.getByText('Check your email', { exact: true }).waitFor();
  note('original Web registration and unverified-email gate');

  stage = 'email verification';
  const verifyURL = await emailLink(path.join(dataDir, 'outbox'), 'verify', email, origin);
  await page.goto(verifyURL, { waitUntil: 'domcontentloaded' });
  await page.locator('#identity-handle').waitFor({ timeout: 30000 });
  note('real development mail link verifies email, no bypass');

  stage = 'profile completion';
  await page.locator('#identity-handle').fill(handle);
  await page.locator('#identity-display-name').fill(displayName);
  const completion = responseTo('/api/auth/me/complete-profile');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const completed = await completion; assert.equal(completed.status(), 200, 'profile completion');
  const user = await completed.json(); assert.equal(user.name, handle); assert.ok(user.profileSetupCompletedAt);
  await workspace();
  await page.screenshot({ path: path.join(artifacts, 'workspace-entry.png'), fullPage: true });
  note('original profile form and real workspace-create entry');

  stage = 'expired token restore';
  const refreshBefore = report.apiRequests.filter(r => r.path === '/api/auth/refresh' && r.status === 200).length;
  await sleep(5000);
  await page.reload({ waitUntil: 'domcontentloaded' }); await workspace();
  assert.ok(report.apiRequests.filter(r => r.path === '/api/auth/refresh' && r.status === 200).length > refreshBefore, 'original refresh coordinator must rotate expired access token');
  note('expired access token restored by unmodified Web refresh coordinator');

  stage = 'two tabs';
  const tab = await context.newPage(); await tab.goto(origin, { waitUntil: 'domcontentloaded' }); await workspace(tab);
  await sleep(5000);
  await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), tab.reload({ waitUntil: 'domcontentloaded' })]);
  await Promise.all([workspace(page), workspace(tab)]); await tab.close();
  note('two real browser tabs preserve login through expiration');

  stage = 'process restart persistence';
  await stop(backend);
  backend = start(binary, [], { cwd: temp, env: backendEnv });
  await ready(`${apiOrigin}/readyz`, backend);
  await sleep(5000);
  await page.reload({ waitUntil: 'domcontentloaded' }); await workspace();
  note('SQLite account, signing key and refresh state survive process restart');

  stage = 'logout and login';
  await logout();
  assert.equal((await login('wrong-password')).status(), 401, 'wrong password');
  assert.equal((await login(password)).status(), 200, 'correct login'); await workspace();
  note('real logout, rejected password and successful login');

  stage = 'password recovery';
  await logout();
  await page.getByText('Forgot password?', { exact: true }).click();
  await page.locator('input[type="email"]').fill(email);
  const forgot = responseTo('/api/auth/forgot-password');
  await page.getByRole('button', { name: 'Send Reset Link', exact: true }).click();
  assert.equal((await forgot).status(), 200, 'forgot password');
  const resetURL = await emailLink(path.join(dataDir, 'outbox'), 'reset', email, origin);
  await page.goto(resetURL, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="password"]').nth(0).fill(newPassword);
  await page.locator('input[type="password"]').nth(1).fill(newPassword);
  const reset = responseTo('/api/auth/reset-password');
  await page.getByRole('button', { name: 'Reset Password', exact: true }).click();
  assert.equal((await reset).status(), 200, 'reset password');
  await page.getByRole('button', { name: /Back to Sign In/i }).click();
  await page.locator('#login-email').waitFor();
  assert.equal((await login(password)).status(), 401, 'old password must no longer work');
  assert.equal((await login(newPassword)).status(), 200, 'new password login'); await workspace();
  note('original forgot/reset pages and password replacement');

  stage = 'scope and network verification';
  await page.locator('#server-create-name').fill('Not Yet Implemented');
  const unsupported = responseTo('/api/servers');
  await page.getByRole('button', { name: /Create Server/i }).click();
  assert.equal((await unsupported).status(), 501, 'workspace creation remains explicitly unsupported');
  assert.ok(report.apiRequests.every(r => r.local), 'all application APIs must stay local');
  // Original devtools import react-grab, which checks its own version API.
  // It remains blocked (not mocked). Exempt only that exact non-Raft request.
  assert.ok(!report.blockedExternal.some(r => /(^|\/)api\//.test(r.path) && !(r.host === 'www.react-grab.com' && r.path === '/api/version')), 'no old/production Raft API endpoint was attempted');
  const allowedUnsupported = new Set(['/api/servers', '/api/product-events']);
  const failed = report.apiRequests.filter(r => r.status >= 500 && !(r.status === 501 && allowedUnsupported.has(r.path)));
  assert.equal(failed.length, 0, `unexpected API errors: ${JSON.stringify(failed)}`);
  assert.equal(report.pageErrors.length, 0, 'no uncaught page errors');
  note('no fake workspace success, no legacy backend, no uncaught browser exceptions');
  report.success = true;
} catch (error) {
  report.failure = { stage, message: redact(error.stack ?? error.message ?? error).replaceAll(password, '[redacted]').replaceAll(newPassword, '[redacted]') };
  if (page) { try { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); } catch {} }
  console.error(`FAIL ${stage}: ${report.failure.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stop(web); await stop(backend);
  await rm(temp, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser acceptance: ${report.passed.length} stages, success=${report.success}. Sanitized report: server-go/tests/e2e/artifacts/result.json`);
}
