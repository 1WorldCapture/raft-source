// Test-only connection/process boundary. Loaded before business imports and
// inherited by Node descendants; production entry points never import it.
import net from 'node:net';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const key = Symbol.for('raft.test.sideEffectGuard');
const envKey = 'RAFT_TEST_SIDE_EFFECT_ROOT';
const moduleUrl = import.meta.url;
const browsers = new Set(['open', 'xdg-open', 'start', 'osascript', 'chrome', 'google-chrome', 'chromium', 'firefox', 'safari', 'msedge', 'google chrome', 'chromium-browser', 'microsoft edge', 'brave-browser', 'brave browser', 'opera']);

export function auditEvents(root) {
  const file = path.join(root, 'violations.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

export function installSideEffectGuard(root) {
  if (globalThis[key]) return globalThis[key];
  mkdirSync(root, { recursive: true });
  const ports = path.join(root, 'ports');
  mkdirSync(ports, { recursive: true });
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const findTool = (name) => (process.env.PATH ?? '').split(path.delimiter)
    .map((directory) => path.join(directory, name)).find((file) => !file.startsWith(root + path.sep) && existsSync(file));
  const nativeTool = fileURLToPath(new URL('./nativeToolGuard.mjs', moduleUrl));
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  for (const tool of ['curl', 'wget', ...browsers]) {
    const real = findTool(tool);
    if (real && (tool === 'curl' || tool === 'wget')) {
      process.env[tool === 'curl' ? 'RAFT_TEST_REAL_CURL' : 'RAFT_TEST_REAL_WGET'] ??= real;
    }
    if (process.platform !== 'win32' && !existsSync(path.join(bin, tool))) {
      writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeTool)} ${quote(tool)} "$@"\n`, { mode: 0o755 });
    } else if (process.platform === 'win32' && !existsSync(path.join(bin, tool + '.cmd'))) {
      writeFileSync(path.join(bin, tool + '.cmd'), `@"${process.execPath}" "${nativeTool}" ${tool} %*\r\n`);
    }
  }
  process.env[envKey] = root;
  const originals = [];
  const replace = (object, name, value) => {
    originals.push(() => { object[name] = value.original; });
    object[name] = value;
  };
  const denied = (kind, target) => {
    const event = { kind, target, pid: process.pid, test: process.env.RAFT_TEST_CURRENT_CASE ?? 'module initialization' };
    appendFileSync(path.join(root, 'violations.jsonl'), JSON.stringify(event) + '\n');
    throw new Error(`HERMETIC_${kind.toUpperCase()}_VIOLATION: ${target}`);
  };
  const portState = (port) => {
    const entries = readdirSync(ports).filter((name) => name.endsWith(`-${port}`));
    if (entries.some((name) => readFileSync(path.join(ports, name), 'utf8') === 'live')) return 'live';
    return entries.length ? 'closed' : 'unknown';
  };
  const checkAddress = (host, port) => {
    const normalized = String(host ?? 'localhost').replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(normalized) || portState(port) === 'unknown') {
      denied('network', `${normalized}:${port}`);
    }
    if (portState(port) === 'closed') {
      // Cancellation can cause a pool reconnect after fixture teardown. Refuse
      // without opening a socket or blaming a legitimate cleanup path. This
      // also prevents an unrelated service reusing the closed port being hit.
      throw Object.assign(new Error('test fixture has closed'), { code: 'ECONNREFUSED' });
    }
  };
  const listen = net.Server.prototype.listen;
  const guardedListen = function (...args) {
    let registration;
    this.prependOnceListener('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object') {
        registration = path.join(ports, `${process.pid}-${address.port}`);
        writeFileSync(registration, 'live');
      }
    });
    this.once('close', () => { if (registration) writeFileSync(registration, 'closed'); });
    return listen.apply(this, args);
  };
  guardedListen.original = listen;
  replace(net.Server.prototype, 'listen', guardedListen);
  const connect = net.Socket.prototype.connect;
  const guardedConnect = function (...args) {
    // Node normalizes connect arguments into an array before re-entering.
    const input = Array.isArray(args[0]) ? args[0] : args;
    const first = input[0];
    if (first && typeof first === 'object') {
      if (!first.path) checkAddress(first.host, first.port);
    } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
      checkAddress(typeof input[1] === 'string' ? input[1] : 'localhost', first);
    } // Named pipes / Unix sockets carry no remote network destination.
    return connect.apply(this, args);
  };
  guardedConnect.original = connect;
  replace(net.Socket.prototype, 'connect', guardedConnect);

  const checkProcess = (command, args = []) => {
    const name = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '');
    const words = args.map(String);
    if (browsers.has(name) || (name === 'cmd' && words.some((word) => word.toLowerCase() === 'start'))
      || (/^(powershell|pwsh)$/.test(name) && /start-process|invoke-item/i.test(words.join(' ')))) {
      denied('browser', name);
    }
    // Cover shells starting native browser tools directly, including absolute
    // paths. Normal installer shell fixtures remain usable.
    if (/^(sh|bash|zsh|cmd|powershell|pwsh)$/.test(name)
      && /(?:^|[\s;|&])(?:\S*\/)?(?:open|xdg-open|osascript|google-chrome|firefox|chrome|chromium|chromium-browser|safari|msedge|brave-browser|opera)\s/.test(words.join(' '))) {
      denied('browser', 'shell browser command');
    }
    if (name === 'curl' || name === 'wget') {
      for (const word of words.filter((word) => /^https?:\/\//i.test(word))) {
        const url = new URL(word);
        checkAddress(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
      }
    }
  };
  const childEnv = (options = {}) => {
    const env = { ...process.env, ...(options.env ?? {}) };
    // Preserve loaders such as tsx and installer fixtures, but always preload
    // the guard in Node children, even when an explicit env omits it.
    env[envKey] ??= root;
    env.PATH = `${path.join(env[envKey], 'bin')}${path.delimiter}${env.PATH ?? ''}`;
    // Probe roots are allocated by the negative regression helper. Their
    // children receive shims when the preload installs in that root.
    if (!env.NODE_OPTIONS?.includes(moduleUrl)) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${moduleUrl}`.trim();
    }
    return { ...options, env };
  };
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = cp[method];
    const wrapper = function (command, ...rest) {
      const args = Array.isArray(rest[0]) ? rest.shift() : [];
      checkProcess(command, args);
      const options = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {};
      const name = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '');
      if (name === 'curl' || name === 'wget') {
        return original.call(this, process.execPath, [nativeTool, name, ...args], childEnv(options), ...rest);
      }
      return original.call(this, command, args, childEnv(options), ...rest);
    };
    // util.promisify(execFile) must retain its stdout/stderr result contract.
    const custom = Symbol.for('nodejs.util.promisify.custom');
    if (original[custom]) wrapper[custom] = (command, ...rest) => new Promise((resolve, reject) => {
      wrapper(command, ...rest, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
    });
    wrapper.original = original;
    replace(cp, method, wrapper);
  }
  for (const method of ['exec', 'execSync']) {
    const original = cp[method];
    const wrapper = function (command, ...rest) {
      checkProcess('sh', ['-c', command]);
      const options = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {};
      return original.call(this, command, childEnv(options), ...rest);
    };
    const custom = Symbol.for('nodejs.util.promisify.custom');
    if (original[custom]) wrapper[custom] = (command, ...rest) => new Promise((resolve, reject) => {
      wrapper(command, ...rest, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
    });
    wrapper.original = original;
    replace(cp, method, wrapper);
  }
  syncBuiltinESMExports();
  const guard = { root, checkProcess, deny: denied, restore() {
    for (const restore of originals.reverse()) restore();
    syncBuiltinESMExports();
    delete globalThis[key];
  } };
  globalThis[key] = guard;
  return guard;
}

if (process.env[envKey]) installSideEffectGuard(process.env[envKey]);
