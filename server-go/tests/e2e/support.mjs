import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const sleep = delay;
export function redact(v) {
  return String(v).replace(/([?&](?:verify|reset|token|code)=)[^&\s"<>]+/gi, '$1[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
}
export async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
export function env(extra = {}) {
  const out = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot', 'GOTOOLCHAIN']) if (process.env[key]) out[key] = process.env[key];
  return { ...out, ...extra };
}
export function start(program, args, options = {}) {
  const logs = [];
  const child = spawn(program, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.on('error', error => logs.push(redact(error.message)));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    logs.push(redact(chunk.toString()).slice(-1000)); if (logs.length > 20) logs.shift();
  });
  return { child, logs };
}
export async function stop(managed) {
  if (!managed) return;
  const { child } = managed;
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  const exited = once(child, 'exit');
  const signal = s => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, s); } catch {} };
  signal('SIGTERM'); await Promise.race([exited, delay(4000)]);
  if (running()) { signal('SIGKILL'); await exited; }
}
export async function ready(url, managed, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) throw new Error(`Test process exited before ready: ${managed.logs.join('').slice(-1500)}`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status === 200) return; } catch {}
    await delay(150);
  }
  throw new Error(`Readiness timeout for ${new URL(url).pathname}: ${managed.logs.join('').slice(-1500)}`);
}
export async function emailLink(dir, kind, email, origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let names = []; try { names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort().reverse(); } catch {}
    for (const name of names) {
      let mail; try { mail = JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch { continue; }
      if ((mail.to ?? mail.To) !== email) continue;
      const html = mail.html ?? mail.HTML ?? '';
      const candidates = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'));
      for (const candidate of candidates) {
        const u = new URL(candidate);
        if (u.searchParams.has(kind)) {
          if (u.origin !== origin) throw new Error('Verification link points outside the isolated Web origin.');
          return u.href;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`No ${kind} mail reached private development outbox.`);
}
