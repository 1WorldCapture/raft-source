// M5 original-client acceptance (worker E).
//
// Exported for the parent gate (Makefile / tests/acceptance/run.mjs). This
// module does not edit those files. It builds nothing when the parent passes
// an already-running loopback origin; `node index.mjs` starts its own
// disposable server on a dynamic port and a temporary data directory.
//
// Component under test: the real Go process (HTTP + machine WebSocket +
// delivery dispatcher, whatever this binary actually wired). The original
// CLI (packages/cli/src/index.ts) and original DaemonCore
// (packages/daemon/src/core.ts) run unmodified. The only substitute is the
// labelled local deterministic provider inside the daemon drive. The
// labelled machine-gateway fixture is not started.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  attachComputer, createVerifiedAccount, createWorkspace, deviceLogin,
  expectStatus, httpClient,
} from '../m3-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../../..');
const repo = path.resolve(here, '../../../..');
const daemonDrive = path.join(here, 'fixtures/daemon-core-drive.mjs');
const cliDrive = path.join(here, 'fixtures/cli-drive.mjs');

const execFileAsync = promisify(execFile);
const SAFE_LINE = /^(PASS|FAIL|API-BLOCKER|FACT|SUMMARY|MODE) m5-/;

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
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    LANG: process.env.LANG || 'C.UTF-8',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Run one original-client drive. The fixture may contain credentials.
 * Labelled result lines are forwarded as they are produced so a hang is
 * attributable without waiting for the child to exit. A secret scan still
 * covers the whole child output and withholds any line that matches.
 */
async function runDrive({ executable, script, fixture, home, timeoutMs, secrets, onLine }) {
  const child = spawn(executable, [script], {
    cwd: repo,
    env: childEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let pending = '';
  let timedOut = false;
  let leaked = false;
  const lines = [];
  const started = Date.now();
  const scriptName = path.basename(script);
  const pattern = sensitivePattern(secrets);
  const takeLine = (line) => {
    const trimmed = line.trim();
    if (!SAFE_LINE.test(trimmed)) return;
    if (pattern.test(trimmed)) {
      leaked = true;
      return;
    }
    lines.push(trimmed);
    onLine?.(trimmed);
  };
  const absorb = (chunk) => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) takeLine(line);
  };
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => { stdout += chunk; absorb(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; absorb(chunk); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify(fixture));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const heartbeat = setInterval(() => {
    const last = lines.at(-1) ?? 'none';
    takeLine(`FACT m5-original-clients drive-heartbeat script=${scriptName} elapsed-ms=${Date.now() - started} safe-lines=${lines.length} last=${last.slice(0, 180)}`);
  }, 10000);
  let result;
  try { result = await finished; } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
  if (pending) takeLine(pending);
  const combined = `${stdout}\n${stderr}`;
  if (leaked || pattern.test(combined)) {
    throw new Error(`${scriptName} output contained credential material (withheld)`);
  }
  if (timedOut) throw new Error(`${scriptName} exceeded ${timeoutMs}ms\n${lines.join('\n')}`);
  if (result.signal) throw new Error(`${scriptName} stopped by ${result.signal}\n${lines.join('\n')}`);
  return { ...result, lines };
}

function errorText(result) {
  const data = result?.data;
  if (!data || typeof data !== 'object') return `HTTP ${result?.status ?? 'none'}`;
  const error = typeof data.error === 'string' ? data.error : '';
  const code = typeof data.code === 'string' ? data.code : '';
  return [`HTTP ${result.status}`, code, error].filter(Boolean).join(' ');
}

async function mintAgentKey(request, token, agentId) {
  const minted = await request(`/api/agents/${agentId}/credentials`, {
    method: 'POST', token, body: { scopes: ['send', 'read', 'server', 'channels', 'mentions'] },
  });
  if (minted.status !== 200 && minted.status !== 201) {
    throw new Error(`agent credential mint failed (${errorText(minted)})`);
  }
  if (typeof minted.data?.apiKey !== 'string' || !minted.data.apiKey.startsWith('sk_agent_')) {
    throw new Error('agent credential mint did not return an sk_agent_* key');
  }
  return minted.data;
}

/**
 * @param {{
 *   origin: string,
 *   data: string,
 *   capture?: (event: { stream: 'stdout' | 'stderr', text: string }) => void,
 * }} args
 */
export async function verifyM5OriginalClients({ origin, data, capture } = {}) {
  if (!origin || !data) throw new Error('verifyM5OriginalClients requires origin and data');
  const request = httpClient(origin);
  const maildir = path.join(data, 'outbox');
  const tsx = path.join(repo, 'node_modules', '.bin', 'tsx');
  try { await access(tsx); } catch { throw new Error('repository tsx binary is not available'); }
  const home = await mkdtemp(path.join(tmpdir(), 'm5-original-clients-'));
  const lines = [];
  const note = (line) => { lines.push(line); console.log(line); };
  try {
    const owner = await createVerifiedAccount(request, maildir, 'm5orig');
    const workspace = await createWorkspace(request, owner, 'm5orig');
    const login = await deviceLogin(request, { approveToken: owner.accessToken, clientName: 'm5-original-clients' });
    const computer = await attachComputer(request, {
      userToken: login.session.accessToken, serverSlug: workspace.slug, name: 'm5-original-daemon',
    });
    const channels = await request('/api/channels', { token: owner.accessToken, server: workspace.id });
    expectStatus(channels, 200, 'channel list');
    const all = (channels.data ?? []).find((row) => row.systemKind === 'all' || row.name === 'all');
    if (!all?.id) throw new Error('workspace has no #all channel');

    const pin = await sourcePin(repo);
    note(`FACT m5-original-clients source-pin HEAD=${pin.head} packages/cli=${pin.cliTree} packages/daemon=${pin.daemonTree} worktree=${pin.dirty ? 'dirty' : 'clean'} diff=${pin.diffHash}`);

    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const inboxCreated = await request('/api/agents', {
      method: 'POST', token: owner.accessToken, server: workspace.id,
      body: { name: `m5inbox${suffix}`, description: 'original CLI claim acceptance agent', external: true },
    });
    if (inboxCreated.status !== 200) {
      throw new Error(`external agent create failed (${errorText(inboxCreated)})`);
    }
    const inboxAgent = inboxCreated.data;
    const inboxKey = await mintAgentKey(request, owner.accessToken, inboxAgent.id);

    const secrets = [
      owner.accessToken, owner.refreshToken, owner.password, owner.email,
      login.session?.accessToken, computer.apiKey, inboxKey.apiKey,
    ];

    {
      const daemon = await runDrive({
        executable: tsx, script: daemonDrive, home, timeoutMs: 600000, secrets,
        onLine: note,
        fixture: {
          repo,
          goServer: {
            origin,
            ownerAccessToken: owner.accessToken,
            workspaceId: workspace.id,
            computerApiKey: computer.apiKey,
            machineId: computer.machineId,
            allChannelId: all.id,
          },
        },
      });
      if (daemon.code !== 0) {
        const failure = daemon.lines.find((line) => line.startsWith('FAIL m5-daemon-core'));
        throw new Error(failure || `daemon drive exited ${daemon.code}`);
      }
      for (const required of [
        'PASS m5-daemon-core R1-real-server-machine-online',
        'PASS m5-daemon-core R-cold-start-session',
        'PASS m5-daemon-core R-tracked-ack',
        'PASS m5-daemon-core R-builtin-tool-consumption',
        'PASS m5-daemon-core R-reconnect-delivery',
      ]) {
        if (!daemon.lines.some((line) => line.startsWith(required))) {
          throw new Error(`daemon drive did not report ${required}`);
        }
      }
      const agentId = daemon.lines.find((line) => line.startsWith('FACT m5-daemon-core managed-agent-id '))?.split(' ').at(-1);
      const agentName = daemon.lines.find((line) => line.startsWith('FACT m5-daemon-core managed-agent-name '))?.split(' ').at(-1);
      if (!agentId || !agentName) throw new Error('daemon drive did not publish the managed agent identity');
      const replyKey = await mintAgentKey(request, owner.accessToken, agentId);
      secrets.push(replyKey.apiKey);

      const cli = await runDrive({
        executable: tsx, script: cliDrive, home, timeoutMs: 180000, secrets,
        onLine: note,
        fixture: {
          repo,
          mode: 'socket',
          goServer: {
            origin,
            workspaceId: workspace.id,
            ownerAccessToken: owner.accessToken,
            allChannelId: all.id,
            reply: {
              agentId, agentName, apiKey: replyKey.apiKey, credentialId: replyKey.credentialId,
            },
            inbox: {
              agentId: inboxAgent.id,
              agentName: inboxAgent.name,
              apiKey: inboxKey.apiKey,
              credentialId: inboxKey.credentialId,
            },
          },
        },
      });
      if (cli.code !== 0) {
        const failure = cli.lines.find((line) => line.startsWith('FAIL m5-original-cli'));
        throw new Error(failure || `CLI drive exited ${cli.code}`);
      }
      for (const required of [
        'PASS m5-original-cli C1 self-hosted-runner message-claim-three-arrays',
        'PASS m5-original-cli C1 self-hosted-runner message-ack',
        'PASS m5-original-cli C1 self-hosted-runner message-ack-idempotent',
        'PASS m5-original-cli C1 self-hosted-runner message-check-legacy',
        'PASS m5-original-cli C1 self-hosted-runner message-send',
        'PASS m5-original-cli C1 self-hosted-runner message-send-idempotent',
        'PASS m5-original-cli C1 self-hosted-runner message-read',
        'PASS m5-original-cli C2 managed-runner-via-original-daemon-proxy message-send',
      ]) {
        if (!cli.lines.some((line) => line.startsWith(required))) {
          throw new Error(`CLI drive did not report ${required}`);
        }
      }
      const replyMarker = cli.lines.find((line) => line.startsWith('FACT m5-original-cli reply-marker '))?.split(' ').at(-1);
      const managedMarker = cli.lines.find((line) => line.startsWith('FACT m5-original-cli managed-reply-marker '))?.split(' ').at(-1);
      const toolMarker = daemon.lines.find((line) => line.startsWith('FACT m5-daemon-core tool-reply-marker '))?.split(' ').at(-1);
      if (!replyMarker || !managedMarker || !toolMarker) throw new Error('drives did not publish reply markers');
      const history = await request(`/api/messages/channel/${all.id}?limit=50`, {
        token: owner.accessToken, server: workspace.id,
      });
      expectStatus(history, 200, 'web channel history');
      const messages = history.data?.messages ?? [];
      const visible = (marker) => messages.filter((row) => row?.content === marker && row.senderType === 'agent' && row.senderId === agentId);
      if (visible(toolMarker).length !== 1) {
        throw new Error('web history did not show exactly one builtin-tool agent reply');
      }
      if (visible(replyMarker).length !== 1) {
        throw new Error('web history did not show exactly one agent-credential reply');
      }
      if (visible(managedMarker).length !== 1) {
        throw new Error('web history did not show exactly one managed-runner agent reply');
      }
      note('PASS m5-original-clients web-history builtin-tool-reply senderType=agent count=1');
      note('PASS m5-original-clients web-history agent-credential-reply senderType=agent count=1');
      note('PASS m5-original-clients web-history managed-runner-reply senderType=agent count=1');
    }

    const blockers = lines.filter((line) => line.startsWith('API-BLOCKER '));
    if (capture) capture({ stream: 'stdout', text: `${lines.join('\n')}\n` });
    const expectedDeferred = new Set([
      'API-BLOCKER m5-original-cli message-resolve GET /internal/agent-api/messages/{id}/resolve not-implemented (messages family deferred)',
      'API-BLOCKER m5-original-cli resolve-channel original CLI calls GET /internal/agent-api/attachment-upload-capabilities before POST /resolve-channel; capabilities family returned not-implemented',
    ]);
    for (const blocker of blockers) {
      if (!expectedDeferred.has(blocker)) throw new Error(`unexpected original-client blocker: ${blocker}`);
    }
    note('SUMMARY m5-original-clients complete');
    return { ok: true, lines };
  } finally {
    await rm(home, { recursive: true, force: true });
    try {
      await access(home);
      throw new Error('cleanup failed: original-client home still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function sourcePin(repo) {
  const run = async (args, input) => (await execFileAsync('git', args, {
    cwd: repo, input, maxBuffer: 32 * 1024 * 1024,
  })).stdout.trim();
  const head = await run(['rev-parse', 'HEAD']);
  const cliTree = await run(['rev-parse', 'HEAD:packages/cli']);
  const daemonTree = await run(['rev-parse', 'HEAD:packages/daemon']);
  const status = await run(['status', '--porcelain', '--', 'packages/cli', 'packages/daemon', 'packages/shared']);
  let diffHash = 'none';
  if (status) {
    const diff = await execFileAsync('git', ['diff', 'HEAD', '--', 'packages/cli', 'packages/daemon', 'packages/shared'], {
      cwd: repo, maxBuffer: 32 * 1024 * 1024,
    });
    diffHash = await run(['hash-object', '--stdin'], diff.stdout);
  }
  return { head, cliTree, daemonTree, dirty: Boolean(status), diffHash };
}

async function startStandalone() {
  const dir = await mkdtemp(path.join(tmpdir(), 'm5-original-clients-server-'));
  const executable = path.join(dir, 'raft-server');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const data = path.join(dir, 'data');
  let compile;
  try {
    compile = await new Promise((resolve, reject) => {
      const child = spawn('go', ['build', '-o', executable, './cmd/raft-server'], {
        cwd: serverRoot,
        env: { ...process.env, CGO_ENABLED: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 180000);
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  if (compile.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`go build failed: ${compile.stderr.slice(-4000)}`);
  }
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    RAFT_GO_LISTEN: `127.0.0.1:${port}`,
    RAFT_GO_DATA_DIR: data,
    RAFT_GO_WEB_ORIGIN: origin,
    RAFT_GO_MAIL_MODE: 'outbox',
  };
  const child = spawn(executable, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-1024 * 1024); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-1024 * 1024); });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`server exited before readiness\n${logs.slice(-2000)}`);
      try {
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.status === 200) break;
      } catch { /* retry */ }
      if (attempt === 99) throw new Error('server readiness timed out');
      await sleep(100);
    }
    await verifyM5OriginalClients({ origin, data, capture() {} });
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), sleep(8000).then(() => child.kill('SIGKILL'))]);
    }
    await rm(dir, { recursive: true, force: true });
    try {
      await access(dir);
      throw new Error('cleanup failed: standalone server dir still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.RAFT_GO_TEST_URL;
  const data = process.env.RAFT_GO_TEST_DATA;
  if (origin && data) await verifyM5OriginalClients({ origin, data, capture() {} });
  else await startStandalone();
}
