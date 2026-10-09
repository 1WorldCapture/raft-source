// Original CLI acceptance driver (worker E, M5).
//
// Runs packages/cli/src/index.ts as a child process (commander, renderer,
// exit codes). Two client modes from packages/cli/AGENTS.md:
//   self-hosted-runner — RAFT_PROFILE credential file, direct /internal/agent-api
//   managed-runner — original daemon credential proxy holds the sk_agent_* key
//
// Claim-Ack coverage uses the original _claimAck.ts decoder: the token is
// base64url JSON {v, s, m, t} and nothing else. POST /events/ack is whatever
// that decoder returns (three arrays). No server secret is involved.
//
// stdin: { repo, mode, goServer: { origin, workspaceId, ownerAccessToken,
//   allChannelId, reply: {agentId, agentName, apiKey, credentialId},
//   inbox: {agentId, agentName, apiKey, credentialId} } }
// The claim mention is posted inside this process, immediately before the
// single claim. An empty claim is a failure and is not polled.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = await readStdinJson();
const repo = fixture.repo ?? path.resolve(here, '../../../../..');
const socketMode = fixture.mode === 'socket' && fixture.goServer;

function fail(message) {
  console.error(`FAIL m5-original-cli ${message}`);
  throw new Error(`m5-original-cli: ${message}`);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) fail('no fixture on stdin');
  return JSON.parse(text);
}

function fileImport(relativePath) {
  return import(pathToFileURL(path.join(repo, relativePath)).href);
}

const CLI_ENTRY = 'packages/cli/src/index.ts';
const CLI_TIMEOUT_MS = 45000;

async function runCli(args, { env, stdin } = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(repo, CLI_ENTRY), ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: env?.HOME ?? process.env.HOME,
      TMPDIR: env?.TMPDIR ?? process.env.TMPDIR,
      NO_COLOR: '1',
      ...env,
    },
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CLI_TIMEOUT_MS);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (stdin !== undefined) child.stdin.end(stdin);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  if (timedOut) fail(`CLI invocation timed out: raft ${args.join(' ')}`);
  return { code, stdout, stderr };
}

function assertEnvelope({ stderr, code, expectedCode, context }) {
  if (code === 0) fail(`${context}: expected a non-zero exit for ${expectedCode}, got 0`);
  const labelled = /Error:/.test(stderr) && new RegExp(`Code:\\s*${expectedCode}`).test(stderr);
  if (!labelled) fail(`${context}: stderr was not the labelled error envelope with Code: ${expectedCode}`);
}

function notImplemented(result) {
  return result.code !== 0 && /not_implemented|This agent API route is not implemented|HTTP 501/.test(`${result.stderr}\n${result.stdout}`);
}

async function confirmDeferred501(go, route) {
  const response = await fetch(new URL(route, go.origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${go.reply.apiKey}`, 'x-server-id': go.workspaceId },
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (response.status !== 501 || data?.code !== 'not_implemented'
    || data?.error !== 'This agent API route is not implemented') {
    fail(`expected deferred route returned an unexpected response: ${route} HTTP ${response.status}`);
  }
}

function parseSendJson(stdout) {
  const line = stdout.split('\n').map((item) => item.trim()).find((item) => item.startsWith('{') && item.includes('"messageId"'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function writeProfile(dir, profile) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'credential.json'), JSON.stringify({
    schemaVersion: 1,
    serverUrl: profile.serverUrl,
    agentId: profile.agentId,
    serverId: profile.serverId,
    apiKey: profile.apiKey,
    credentialId: profile.credentialId,
    scopes: ['send', 'read', 'server', 'channels', 'mentions'],
  }));
}

async function postMention({ origin, token, server, channelId, agentId, agentName, marker }) {
  const response = await fetch(new URL('/api/v2/messages', origin), {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-server-id': server,
    },
    body: JSON.stringify({
      channelId,
      content: marker,
      mentions: [{ type: 'agent', id: agentId, name: agentName }],
    }),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data };
}

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'm5-original-cli-'));
  let proxyHandle = null;
  let proxyModule = null;
  let proxyLaunchId = null;
  let proxyAgentId = null;
  try {
    const noEnv = await runCli(['message', 'ack', 'definitely-not-a-token'], { env: { HOME: home } });
    assertEnvelope({ stderr: noEnv.stderr, code: noEnv.code, expectedCode: 'INVALID_ARG', context: 'C0a invalid claim token' });
    const noIdentity = await runCli(['message', 'claim'], { env: { HOME: home } });
    if (noIdentity.code === 0) fail('C0b claim without identity unexpectedly succeeded');
    if (!/MISSING_TOKEN|Error:/.test(noIdentity.stderr)) fail('C0b claim without identity did not render a bootstrap error envelope');
    const help = await runCli(['message', 'send', '--help'], { env: { HOME: home } });
    if (help.code !== 0 || !help.stdout.includes('--target')) fail('C0c send --help did not document --target');
    const profileDir = path.join(home, 'profiles', 'm5-cli-fixture');
    await writeProfile(profileDir, {
      serverUrl: socketMode ? fixture.goServer.origin : 'http://127.0.0.1:9',
      agentId: 'agent-m5-cli-fixture',
      serverId: null,
      apiKey: 'sk_agent_m5_local_fixture_never_real',
      credentialId: 'cred-m5-cli-fixture',
    });
    const whoami = await runCli(['auth', 'whoami'], {
      env: { HOME: home, RAFT_PROFILE: 'm5-cli-fixture', RAFT_PROFILE_DIR: profileDir },
    });
    if (whoami.code !== 0) fail('C0d whoami failed');
    const identity = JSON.parse(whoami.stdout);
    if (identity?.data?.clientMode !== 'self-hosted-runner') fail(`C0d whoami clientMode=${identity?.data?.clientMode}`);
    console.log('PASS m5-original-cli C0-parser-and-identity-contract whoami=self-hosted-runner envelope=INVALID_ARG/bootstrap help=--target');

    if (!socketMode) {
      console.log('BLOCKED m5-original-cli network-legs reason=no-real-server');
      return;
    }

    const go = fixture.goServer;
    console.log('FACT m5-original-cli step phase=socket-claim');
    const claimAck = await fileImport('packages/cli/src/commands/message/_claimAck.ts');
    if (typeof claimAck.decodeClaimAckToken !== 'function') fail('original Claim-Ack decoder is missing');

    const inboxDir = path.join(home, 'profiles', 'm5-inbox');
    await writeProfile(inboxDir, {
      serverUrl: go.origin, agentId: go.inbox.agentId, serverId: go.workspaceId,
      apiKey: go.inbox.apiKey, credentialId: go.inbox.credentialId,
    });
    const inboxEnv = { HOME: home, RAFT_PROFILE: 'm5-inbox', RAFT_PROFILE_DIR: inboxDir };
    await claimAckLeg('C1 self-hosted-runner', inboxEnv, go, claimAck);

    const replyDir = path.join(home, 'profiles', 'm5-reply');
    await writeProfile(replyDir, {
      serverUrl: go.origin, agentId: go.reply.agentId, serverId: go.workspaceId,
      apiKey: go.reply.apiKey, credentialId: go.reply.credentialId,
    });
    const replyEnv = { HOME: home, RAFT_PROFILE: 'm5-reply', RAFT_PROFILE_DIR: replyDir };
    console.log('FACT m5-original-cli step phase=socket-send');
    const reply = await sendLeg('C1 self-hosted-runner', replyEnv, `#${'all'}`, `M5-AGENT-REPLY-${randomUUID().slice(0, 8)}`);
    console.log(`FACT m5-original-cli reply-marker ${reply.marker}`);
    console.log(`FACT m5-original-cli reply-message-id ${reply.messageId}`);
    await readLeg('C1 self-hosted-runner', replyEnv, reply.marker);
    await resolveLeg('C1 self-hosted-runner', replyEnv, reply.messageId, go);

    proxyModule = await fileImport('packages/daemon/src/agentCredentialProxy.ts');
    if (typeof proxyModule.registerAgentCredentialProxy !== 'function') fail('original agentCredentialProxy module is missing registerAgentCredentialProxy');
    proxyLaunchId = `launch-m5-cli-${Date.now()}`;
    proxyAgentId = go.reply.agentId;
    proxyHandle = await proxyModule.registerAgentCredentialProxy({
      agentId: go.reply.agentId,
      launchId: proxyLaunchId,
      serverUrl: go.origin,
      apiKey: go.reply.apiKey,
      activeCapabilities: 'send,read,server,channels,mentions',
    });
    const managedEnv = {
      HOME: home,
      SLOCK_AGENT_ID: go.reply.agentId,
      SLOCK_SERVER_URL: go.origin,
      SLOCK_SERVER_ID: go.workspaceId,
      SLOCK_AGENT_PROXY_URL: proxyHandle.proxyUrl,
      SLOCK_AGENT_PROXY_TOKEN: proxyHandle.proxyToken,
    };
    const managedWhoami = await runCli(['auth', 'whoami'], { env: managedEnv });
    if (managedWhoami.code !== 0) fail('C2 whoami via original daemon proxy failed');
    const managedIdentity = JSON.parse(managedWhoami.stdout);
    if (managedIdentity?.data?.clientMode !== 'managed-runner') fail(`C2 whoami clientMode=${managedIdentity?.data?.clientMode}`);
    if (managedIdentity?.data?.secretSource !== 'agent-proxy-token-env') fail(`C2 whoami secretSource=${managedIdentity?.data?.secretSource}`);
    console.log('FACT m5-original-cli step phase=managed-proxy-send');
    const managed = await sendLeg('C2 managed-runner-via-original-daemon-proxy', managedEnv, '#all', `M5-MANAGED-REPLY-${randomUUID().slice(0, 8)}`);
    console.log(`FACT m5-original-cli managed-reply-marker ${managed.marker}`);
    console.log('SUMMARY m5-original-cli socket-legs-complete');
  } finally {
    if (proxyHandle && proxyModule && typeof proxyModule.unregisterAgentCredentialProxyForLaunch === 'function' && proxyAgentId && proxyLaunchId) {
      try { proxyModule.unregisterAgentCredentialProxyForLaunch({ agentId: proxyAgentId, launchId: proxyLaunchId }); } catch { /* best effort */ }
    }
    let cleanupError = null;
    try {
      await rm(home, { recursive: true, force: true });
      await access(home);
      cleanupError = new Error('cli temp dir still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupError = error;
    }
    if (cleanupError) {
      console.error(`FAIL m5-original-cli cleanup ${cleanupError.message}`);
      process.exitCode = 1;
    } else {
      console.log('FACT m5-original-cli cleanup temp-dir-removed=true');
    }
  }

  async function claimAckLeg(label, env, go, claimAck) {
    const server = await runCli(['server', 'info'], { env });
    if (server.code !== 0) fail(`${label} server-info failed`);
    console.log(`PASS m5-original-cli ${label} server-info ok`);

    const mentionMarker = `M5-INBOX-${randomUUID().slice(0, 8)}`;
    const createdMention = await postMention({
      origin: go.origin, token: go.ownerAccessToken, server: go.workspaceId,
      channelId: go.allChannelId, agentId: go.inbox.agentId, agentName: go.inbox.agentName, marker: mentionMarker,
    });
    if (createdMention.status !== 200 || !createdMention.data?.message?.id || typeof createdMention.data.message.seq !== 'number') {
      fail(`${label} human mention was not committed (${createdMention.status})`);
    }
    const mention = {
      messageId: createdMention.data.message.id,
      seq: createdMention.data.message.seq,
      marker: mentionMarker,
    };
    console.log(`PASS m5-original-cli ${label} human-mention-committed seq=${mention.seq}`);
    // One claim. An empty inbox is a failure. Do not sleep or re-claim through
    // a managed-scanner next_attempt_at deferral; that delay is a product bug.
    const claim = await runCli(['message', 'claim'], { env });
    if (claim.code !== 0) fail(`${label} message-claim failed (${claim.stderr.slice(0, 180)})`);
    const tokenLine = claim.stdout.split('\n').map((line) => line.trim()).find((line) => line.startsWith('Claim-Ack:'));
    if (!tokenLine) {
      fail(`${label} message-claim returned no Claim-Ack line (empty inbox is not retried)`);
    }
    const token = tokenLine.slice('Claim-Ack:'.length).trim();
    const raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const keys = Object.keys(raw).sort();
    if (keys.join(',') !== 'm,s,t,v') fail(`${label} Claim-Ack token keys were ${keys.join(',')} (expected v,s,m,t only)`);
    const batch = claimAck.decodeClaimAckToken(tokenLine);
    if (!batch) fail(`${label} original decoder rejected the Claim-Ack line`);
    if (!Array.isArray(batch.seqs) || !Array.isArray(batch.message_ids) || !Array.isArray(batch.third_party_event_ids)) {
      fail(`${label} decoded ack is missing one of the three arrays`);
    }
    // Original wire: a positive-seq message is acknowledged by seq only.
    // message_ids carries seq-less notice ids, never the public messages.id.
    const seqHit = batch.seqs.includes(mention.seq);
    const publicIdInAck = batch.message_ids.includes(mention.messageId);
    if (!seqHit || publicIdInAck) {
      fail(`${label} claim ack shape seq=${mention.seq} seq-hit=${seqHit} seqs=${batch.seqs.join(',') || 'none'} message-id-count=${batch.message_ids.length} public-id-in-message-ids=${publicIdInAck} marker-in-stdout=${claim.stdout.includes(mention.marker)}`);
    }
    if (batch.third_party_event_ids.length !== 0) fail(`${label} third_party_event_ids was not empty`);
    if (!claim.stdout.includes(mention.marker)) fail(`${label} claim output did not show the mention body`);
    console.log(`PASS m5-original-cli ${label} message-claim-three-arrays seqs+message_ids+third_party_event_ids token-keys=v,s,m,t positive-seq-ack=seqs public-message-id-in-message-ids=false`);

    const again = await runCli(['message', 'claim'], { env });
    if (again.code !== 0) fail(`${label} re-claim before ack failed`);
    const againBatch = claimAck.decodeClaimAckToken(again.stdout.split('\n').find((line) => line.startsWith('Claim-Ack:')) ?? '');
    if (!againBatch?.seqs?.includes(mention.seq)) {
      fail(`${label} re-claim did not return the same message seq=${mention.seq} seqs=${(againBatch?.seqs ?? []).join(',') || 'none'}`);
    }
    console.log(`PASS m5-original-cli ${label} message-claim-reissue same-message=true`);

    const ack = await runCli(['message', 'ack'], { env, stdin: `${tokenLine}\n` });
    if (ack.code !== 0 || !/Acked [1-9]\d* inbox items?\./.test(ack.stdout)) {
      fail(`${label} message-ack did not report a positive removed count`);
    }
    console.log(`PASS m5-original-cli ${label} message-ack`);
    const replay = await runCli(['message', 'ack'], { env, stdin: `${tokenLine}\n` });
    if (replay.code !== 0 || !replay.stdout.includes('Acked 0 inbox items.')) {
      fail(`${label} repeated ack was not idempotent`);
    }
    console.log(`PASS m5-original-cli ${label} message-ack-idempotent removed_count=0`);

    const checkMarker = `M5-CHECK-${randomUUID().slice(0, 8)}`;
    const created = await postMention({
      origin: go.origin, token: go.ownerAccessToken, server: go.workspaceId,
      channelId: go.allChannelId, agentId: go.inbox.agentId, agentName: go.inbox.agentName, marker: checkMarker,
    });
    if (created.status !== 200 || !created.data?.message?.id) {
      fail(`${label} could not create the legacy-check mention (${created.status})`);
    }
    const drained = await runCli(['message', 'check'], { env });
    if (drained.code !== 0) fail(`${label} message-check failed`);
    if (!drained.stdout.includes(checkMarker)) {
      fail(`${label} message-check did not return the committed mention (empty drain is not retried)`);
    }
    const second = await runCli(['message', 'check'], { env });
    if (second.code !== 0) fail(`${label} second message-check failed`);
    if (second.stdout.includes(checkMarker)) fail(`${label} legacy check did not consume the mention`);
    console.log(`PASS m5-original-cli ${label} message-check-legacy destructive-drain=true`);
  }

  async function sendLeg(label, env, target, marker) {
    const key = `m5-send-${randomUUID()}`;
    const first = await runCli(['message', 'send', '--target', target, '--json', '--idempotency-key', key], { env, stdin: marker });
    if (notImplemented(first)) fail(`${label} message-send API-BLOCKER route-not-implemented`);
    if (first.code !== 0) fail(`${label} message-send failed`);
    const sent = parseSendJson(first.stdout);
    if (!sent?.messageId || sent.ok !== true || sent.state !== 'sent') fail(`${label} message-send JSON was not {ok,state:sent,messageId}`);
    console.log(`PASS m5-original-cli ${label} message-send`);
    const second = await runCli(['message', 'send', '--target', target, '--json', '--idempotency-key', key], { env, stdin: marker });
    if (second.code !== 0) fail(`${label} message-send retry failed`);
    const replayed = parseSendJson(second.stdout);
    if (replayed?.messageId !== sent.messageId) fail(`${label} idempotent resend did not return the same messageId`);
    console.log(`PASS m5-original-cli ${label} message-send-idempotent`);
    return { marker, messageId: sent.messageId };
  }

  async function readLeg(label, env, marker) {
    const read = await runCli(['message', 'read', '--target', '#all', '--limit', '50'], { env });
    if (notImplemented(read)) fail(`${label} message-read API-BLOCKER route-not-implemented`);
    if (read.code !== 0) fail(`${label} message-read failed`);
    if (!read.stdout.includes(marker) || !read.stdout.includes('type=agent')) {
      fail(`${label} message-read did not show the agent reply`);
    }
    console.log(`PASS m5-original-cli ${label} message-read history-shows-agent-reply=true`);
  }

  async function resolveLeg(label, env, messageId, go) {
    const resolved = await runCli(['message', 'resolve', messageId], { env });
    if (resolved.code === 0 && resolved.stdout.includes(messageId.slice(0, 8))) {
      console.log(`PASS m5-original-cli ${label} message-resolve`);
    } else if (notImplemented(resolved)) {
      await confirmDeferred501(go, `/internal/agent-api/messages/${encodeURIComponent(messageId)}/resolve`);
      console.log('API-BLOCKER m5-original-cli message-resolve GET /internal/agent-api/messages/{id}/resolve not-implemented (messages family deferred)');
    } else {
      fail(`${label} message-resolve unexpected failure`);
    }
    const uploadPath = path.join(home, 'm5-resolve.txt');
    await writeFile(uploadPath, 'm5 resolve-channel probe\n');
    const upload = await runCli(['attachment', 'upload', '--path', uploadPath, '--target', '#all'], { env });
    if (upload.code === 0) {
      console.log(`PASS m5-original-cli ${label} resolve-channel`);
    } else if (notImplemented(upload)) {
      await confirmDeferred501(go, '/internal/agent-api/attachment-upload-capabilities');
      console.log('API-BLOCKER m5-original-cli resolve-channel original CLI calls GET /internal/agent-api/attachment-upload-capabilities before POST /resolve-channel; capabilities family returned not-implemented');
    } else if (/RESOLVE_FAILED|Could not resolve target/.test(`${upload.stderr}\n${upload.stdout}`)) {
      fail(`${label} resolve-channel rejected #all`);
    } else {
      fail(`${label} resolve-channel unexpected attachment-upload failure (exit ${upload.code})`);
    }
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  if (!String(error?.message ?? '').startsWith('m5-original-cli:')) {
    console.error(`FAIL m5-original-cli unexpected error: ${error?.stack ?? error}`);
  }
}
