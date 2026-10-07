// PATH shims cover native tools launched by installer shell descendants.
import { spawnSync } from 'node:child_process';
import { installSideEffectGuard } from './sideEffectGuard.mjs';
const root = process.env.RAFT_TEST_SIDE_EFFECT_ROOT;
const guard = installSideEffectGuard(root);
const tool = process.argv[2];
const args = process.argv.slice(3);
try {
  guard.checkProcess(tool, args);
  if (!['curl', 'wget'].includes(tool)) guard.deny('browser', tool);
  // Native clients are restricted to literal URLs. Config/proxy/host overrides
  // and redirects cannot tunnel an official request through an allowed URL.
  const flags = tool === 'curl'
    ? new Set(['--fail', '--silent', '--show-error', '--location', '--head', '--progress-bar'])
    : new Set(['--quiet', '--show-progress']);
  const values = tool === 'curl'
    ? new Set(['-o', '--output', '--connect-timeout', '--max-time', '--retry', '--retry-delay', '--retry-max-time'])
    : new Set(['-O', '--output-document', '--tries', '--timeout']);
  let urls = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^(https?|file):\/\//i.test(arg)) { urls++; continue; }
    if (flags.has(arg) || (tool === 'curl' && /^-[fsSLI]+$/.test(arg))) continue;
    const equal = arg.indexOf('=');
    if (equal > 0 && values.has(arg.slice(0, equal))) continue;
    if (values.has(arg) && index + 1 < args.length) { index++; continue; }
    if (tool === 'wget' && /^-q?O.+$/.test(arg)) continue;
    // Fail closed on bare destinations, alternate protocols and option forms
    // which could source an additional URL or override connection routing.
    guard.deny('network', 'native client unsupported argument');
  }
  if (!urls) guard.deny('network', 'native client missing literal URL');
  for (const arg of args.filter((arg) => /^file:\/\//i.test(arg))) {
    if (new URL(arg).hostname && new URL(arg).hostname !== 'localhost') guard.deny('network', 'remote file URL');
  }
  const real = process.env[tool === 'curl' ? 'RAFT_TEST_REAL_CURL' : 'RAFT_TEST_REAL_WGET'];
  if (!real) throw new Error(`No real ${tool} executable available for local fixture`);
  const extra = tool === 'curl' ? ['--max-redirs', '0', '--noproxy', '*'] : ['--max-redirect=0', '--no-proxy'];
  // Only this validated helper invokes the real executable. Direct Node
  // curl/wget calls are routed here by the child-process wrapper as well.
  const invoke = spawnSync.original ?? spawnSync;
  const result = invoke(real, [...(tool === 'curl' ? ['-q'] : []), ...args, ...extra], {
    stdio: 'inherit', env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' },
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
}
