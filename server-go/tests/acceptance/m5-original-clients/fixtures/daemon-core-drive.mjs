// Original DaemonCore acceptance driver (worker E, M5).
//
// The component under test is the REAL ephemeral Go server on the fixture
// origin: machine WebSocket, agent:start, and agent:deliver. This process
// loads unmodified packages/daemon/src/core.ts (DaemonCore + AgentProcessManager
// + BuiltInDriver). A WebSocket send/message tap records frames and can
// deliberately discard initial agent:start frames to exercise automatic
// recovery. It never fabricates a daemon reply, session or acknowledgement.
//
// The model endpoint is the labelled deterministic local provider
// (deterministic-provider.mjs). It is not a commercial model and holds no
// paid credential. The first phase answers text: agent:deliver:ack is the
// daemon's original reported receipt, and the wake request must not contain
// the human body (bodyInModelTurns=false). That phase is not model
// consumption and not exactly-once. The second phase, only after that wake,
// returns a scripted builtin bash tool_call so the original raft CLI runs
// through the daemon-local credential proxy.
//
// stdin: { repo, goServer: { origin, ownerAccessToken, workspaceId,
//   computerApiKey, machineId, allChannelId } }
// stdout: PASS/FAIL/FACT lines prefixed m5-daemon-core.

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startSocketProvider, createProviderScript, bashToolTurn, textTurn, PROVIDER_MODEL_NAME, PROVIDER_API_KEY } from './deterministic-provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliHost = path.join(here, 'original-cli-host.mjs');
const fixture = await readStdinJson();
const repo = fixture.repo ?? path.resolve(here, '../../../../..');
const INBOX_WAKE = 'These messages have not been read. Choose when to read them with `raft message check`';
const go = fixture.goServer ?? null;

function fail(message) {
  console.error(`FAIL m5-daemon-core ${message}`);
  throw new Error(`m5-daemon-core: ${message}`);
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

function publicError(result) {
  const data = result?.data;
  if (!data || typeof data !== 'object') return `HTTP ${result?.status ?? 'none'}`;
  const error = typeof data.error === 'string' ? data.error : '';
  const code = typeof data.code === 'string' ? data.code : '';
  return [`HTTP ${result.status}`, code, error].filter(Boolean).join(' ');
}

async function productJSON(route, { method = 'GET', token, server, body } = {}) {
  const response = await fetch(new URL(route, go.origin), {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(server === undefined ? {} : { 'x-server-id': server }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text.length > 0) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { status: response.status, data };
}

function installWireTap() {
  const requireFromDaemon = createRequire(path.join(repo, 'packages/daemon/package.json'));
  const WebSocket = requireFromDaemon('ws');
  const wire = [];
  const sockets = new Set();
  let discardStarts = false;
  const originalSend = WebSocket.prototype.send;
  const originalOn = WebSocket.prototype.on;
  const isDaemonSocket = (socket) => String(socket?.url ?? '').includes('/daemon/connect');
  WebSocket.prototype.send = function send(data, ...args) {
    if (isDaemonSocket(this)) {
      sockets.add(this);
      record(wire, 'out', data);
    }
    return originalSend.call(this, data, ...args);
  };
  WebSocket.prototype.on = function on(event, listener, ...args) {
    if (isDaemonSocket(this)) sockets.add(this);
    if (event === 'message' && typeof listener === 'function' && isDaemonSocket(this)) {
      const wrapped = (data, ...rest) => {
        if (discardStarts) {
          let message;
          try { message = JSON.parse(String(data)); } catch { message = null; }
          if (message?.type === 'agent:start') {
            record(wire, 'dropped-in', data);
            return;
          }
        }
        record(wire, 'in', data);
        return listener.call(this, data, ...rest);
      };
      return originalOn.call(this, event, wrapped, ...args);
    }
    return originalOn.call(this, event, listener, ...args);
  };
  return {
    wire,
    suspendStarts() { discardStarts = true; },
    allowStarts() { discardStarts = false; },
    dropSockets() {
      for (const socket of sockets) {
        if (!isDaemonSocket(socket)) continue;
        try { socket.terminate(); } catch { /* already closed */ }
      }
    },
    restore() {
      WebSocket.prototype.send = originalSend;
      WebSocket.prototype.on = originalOn;
    },
  };
}

function record(wire, direction, data) {
  let text = '';
  if (typeof data === 'string') text = data;
  else if (Buffer.isBuffer(data)) text = data.toString('utf8');
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
  else return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  wire.push({ direction, msg, at: Date.now() });
}

function frames(wire, direction, after = 0) {
  return wire.filter((entry) => entry.direction === direction && entry.at >= after).map((entry) => entry.msg);
}

function step(label, detail = '') {
  const extra = detail ? ` ${redact(detail).slice(0, 180)}` : '';
  console.log(`FACT m5-daemon-core step ${label}${extra}`);
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let detail = 'not ready';
  let lastLog = 0;
  const slug = label.replaceAll(' ', '-');
  while (Date.now() < deadline) {
    const result = await predicate();
    if (typeof result === 'string') detail = result;
    else if (result) return result;
    if (Date.now() - lastLog >= 5000) {
      step(`waiting=${slug} elapsed-ms=${Date.now() - started}`, detail);
      lastLog = Date.now();
    }
    await sleep(100);
  }
  fail(`timed out waiting for ${label} (${redact(detail).slice(0, 180)})`);
}

function snapshotMatches(snapshot, expected) {
  return Boolean(snapshot)
    && snapshot.occurrenceId
    && snapshot.messageId === expected.messageId
    && snapshot.machineId === expected.machineId
    && snapshot.launchId === expected.launchId
    && snapshot.sessionId === expected.sessionId;
}

function ackFor(wire, messageId, after = 0) {
  return frames(wire, 'out', after).filter((msg) => msg.type === 'agent:deliver:ack' && msg.mentionDelivery?.messageId === messageId);
}

function toolTexts(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return []; }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return messages.filter((message) => message?.role === 'tool').map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
  ));
}

function section(text, name) {
  const start = text.indexOf(`M5-SECTION ${name}`);
  if (start < 0) return '';
  const next = text.indexOf('M5-SECTION ', start + `M5-SECTION ${name}`.length);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function redact(text) {
  return String(text)
    .replace(/sk_(?:computer|machine|agent|daemon)_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\(node:\d+\) \[DEP0205\][\s\S]*?where the warning was created\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
}

function assistantUsedBash(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return false; }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return messages.some((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls)
    && message.tool_calls.some((call) => call?.function?.name === 'bash'));
}

const builtInOnlyDetection = (daemonVersion) => () => ({
  ids: ['builtin'],
  versions: { builtin: daemonVersion },
});

async function buildCore(coreModule, apmModule, { serverUrl, apiKey, daemonVersion, dataDir, slockHome, machineStateDir }) {
  const core = new coreModule.DaemonCore({
    serverUrl,
    apiKey,
    daemonVersion,
    slockHome,
    dataDir,
    machineStateDir,
    slockCliPath: cliHost,
    runtimeDetector: builtInOnlyDetection(daemonVersion),
    agentManagerFactory: (sendToServer, daemonApiKey, options = {}) => new apmModule.AgentProcessManager(
      sendToServer,
      daemonApiKey,
      {
        dataDir: options.dataDir ?? dataDir,
        serverUrl: options.serverUrl ?? serverUrl,
        slockCliPath: options.slockCliPath ?? cliHost,
        slockHome: options.slockHome ?? slockHome,
        runtimeSessionHomeDir: path.join(slockHome, 'runtime-sessions'),
      },
    ),
  });
  return core;
}

async function main() {
  if (!go?.origin || !go.computerApiKey || !go.machineId || !go.allChannelId) {
    fail('real Go server fixture is required; this drive does not substitute a machine gateway');
  }
  const tap = installWireTap();
  const coreModule = await fileImport('packages/daemon/src/core.ts');
  const apmModule = await fileImport('packages/daemon/src/agentProcessManager.ts');
  if (typeof coreModule.DaemonCore !== 'function') fail('original core module is missing DaemonCore');
  if (typeof apmModule.AgentProcessManager !== 'function') fail('original agentProcessManager module is missing AgentProcessManager');

  const suffix = randomUUID().slice(0, 8);
  const marker = `M5-TRACKED-${suffix}`;
  const replyMarker = `M5-BUILTIN-TOOL-REPLY-${suffix}`;
  const checkCommand = [
    'raft_path=$(command -v raft || true)',
    'printf \'%s\\n\' "M5-RAFT-PATH ${raft_path:-missing}"',
    "printf '%s\\n' 'M5-SECTION check'",
    'raft message check',
    'check_status=$?',
    "printf '%s\\n' 'M5-SECTION read'",
    "raft message read --target '#all' --limit 30",
    'read_status=$?',
    'exit $((check_status || read_status))',
  ].join('\n');
  // `--json` prints {ok,state,messageId} and does not echo the stdin body.
  // The section header makes that tool result attributable; the persisted
  // body is checked later in Web history. The idempotency key keeps one
  // held-draft retry from inserting a second visible row.
  const sendKey = `m5-builtin-${suffix}`;
  const sendCommand = [
    "printf '%s\\n' 'M5-SECTION send'",
    `printf '%s' '${replyMarker}' | raft message send --target '#all' --json --idempotency-key '${sendKey}'`,
  ].join('\n');
  let providerStage = 'receipt';
  let checkReissues = 0;
  let sendAttempts = 0;
  const providerScript = createProviderScript();
  const provider = await startSocketProvider(providerScript, {
    respond(body) {
      const wake = body.includes(INBOX_WAKE);
      const tools = toolTexts(body);
      const sendSections = tools.map((text) => section(text, 'send')).filter(Boolean);
      let turn = textTurn();
      let reason = 'text';
      if (providerStage === 'receipt') {
        if (wake) {
          providerStage = 'await-check';
          turn = bashToolTurn('call_m5_builtin_check', checkCommand);
          reason = 'issue-check';
        } else {
          reason = 'cold-text';
        }
      } else if (providerStage === 'await-check') {
        if (tools.length === 0) {
          // The tool-result request is the one that carries role=tool.
          // One empty follow-up is tolerated; further empties are not a poll.
          if (checkReissues < 1) {
            checkReissues += 1;
            turn = bashToolTurn('call_m5_builtin_check', checkCommand);
            reason = 'reissue-check-no-tool-result';
          } else {
            providerStage = 'done';
            reason = 'check-no-tool-result';
          }
        } else {
          const checkHasMarker = tools.some((text) => section(text, 'check').includes(marker));
          const readHasMarker = tools.some((text) => section(text, 'read').includes(marker));
          if (checkHasMarker && readHasMarker) {
            providerStage = 'await-send';
            sendAttempts = 1;
            turn = bashToolTurn('call_m5_builtin_send', sendCommand);
            reason = 'issue-send';
          } else if (tools.some((text) => /timeout:\d+/.test(text))) {
            providerStage = 'done';
            reason = 'check-tool-timeout';
          } else {
            providerStage = 'done';
            reason = 'check-missing-marker';
          }
        }
      } else if (providerStage === 'await-send') {
        const sent = sendSections.some((text) => /"state"\s*:\s*"sent"/.test(text));
        const held = sendSections.some((text) => /SEND_HELD_AS_DRAFT|"state"\s*:\s*"held"/.test(text));
        if (sent) {
          providerStage = 'done';
          reason = 'send-sent';
        } else if (held && sendAttempts < 2) {
          sendAttempts += 1;
          turn = bashToolTurn('call_m5_builtin_send_retry', sendCommand);
          reason = 'retry-send-held';
        } else if (sendSections.length > 0) {
          providerStage = 'done';
          reason = 'send-not-sent';
        } else if (tools.length === 0 && sendAttempts < 2) {
          sendAttempts += 1;
          turn = bashToolTurn('call_m5_builtin_send', sendCommand);
          reason = 'send-awaiting-tool-result';
        } else {
          providerStage = 'done';
          reason = 'send-unmatched';
        }
      }
      if (reason !== 'cold-text') {
        const flags = [
          tools.some((text) => text.includes('M5-SECTION check')) ? 'check' : '',
          tools.some((text) => text.includes('M5-SECTION read')) ? 'read' : '',
          tools.some((text) => text.includes('M5-SECTION send')) ? 'send' : '',
          tools.some((text) => /"state"\s*:\s*"sent"/.test(text)) ? 'state-sent' : '',
          tools.some((text) => text.includes('INVALID_JSON_RESPONSE')) ? 'invalid-json' : '',
          tools.some((text) => /timeout:\d+/.test(text)) ? 'tool-timeout' : '',
        ].filter(Boolean).join('+') || 'none';
        console.log(`FACT m5-daemon-core provider-turn stage=${providerStage} reason=${reason} requests=${providerScript.requests.length} tool-flags=${flags}`);
      }
      return turn;
    },
  });
  const rootDir = await mkdtemp(path.join(tmpdir(), 'm5-daemon-core-'));
  const daemonVersion = '0.0.0-m5-original-core';
  let core = null;
  try {
    core = await buildCore(coreModule, apmModule, {
      serverUrl: go.origin,
      apiKey: go.computerApiKey,
      daemonVersion,
      dataDir: path.join(rootDir, 'data'),
      slockHome: path.join(rootDir, 'home'),
      machineStateDir: path.join(rootDir, 'machine'),
    });
    step('phase=core-starting');
    core.start();
    await waitFor('machine online', async () => {
      const row = await productJSON(`/api/servers/${go.workspaceId}/machines`, {
        token: go.ownerAccessToken, server: go.workspaceId,
      });
      const machine = row.data?.machines?.find((item) => item.id === go.machineId);
      return machine?.daemonVersion === daemonVersion && machine?.status === 'online' ? machine : null;
    }, 30000);
    if (!frames(tap.wire, 'out').some((msg) => msg.type === 'ready')) {
      fail('wire tap did not observe the daemon ready frame');
    }
    console.log('PASS m5-daemon-core R1-real-server-machine-online version-present runtimes=builtin');

    const agentName = `m5wire${suffix}`;
    // The public create route auto-starts a bound managed Agent. Lose its
    // initial start frames without faking ACK/session facts, then require
    // periodic server recovery after a real mention (no manual Start).
    tap.suspendStarts();
    const created = await productJSON('/api/agents', {
      method: 'POST', token: go.ownerAccessToken, server: go.workspaceId,
      body: {
        name: agentName,
        description: 'original daemon core acceptance agent',
        runtime: 'builtin',
        model: PROVIDER_MODEL_NAME,
        machineId: go.machineId,
        formDefinitionRef: { protocolVersion: 1, runtimeId: 'builtin', schemaVersion: 'builtin-pi.create.v2' },
        runtimeConfig: {
          version: 1,
          runtime: 'builtin',
          provider: { kind: 'gateway', providerId: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: PROVIDER_API_KEY },
          model: { kind: 'custom', name: PROVIDER_MODEL_NAME },
          mode: { kind: 'default' },
        },
      },
    });
    if (created.status !== 200) fail(`agent create failed (${publicError(created)})`);
    const agent = created.data;
    console.log(`FACT m5-daemon-core managed-agent-id ${agent.id}`);
    console.log(`FACT m5-daemon-core managed-agent-name ${agent.name}`);
    const droppedStart = await waitFor('discarded initial agent:start', async () => (
      frames(tap.wire, 'dropped-in').find((msg) => msg.type === 'agent:start' && msg.agentId === agent.id) ?? null
    ), 30000);
    if (frames(tap.wire, 'in').some((msg) => msg.type === 'agent:start' && msg.agentId === agent.id)
      || frames(tap.wire, 'out').some((msg) => msg.type === 'agent:session' && msg.agentId === agent.id)) {
      fail('cold-start fault injection did not keep the original daemon unstarted');
    }

    const mentioned = await productJSON('/api/v2/messages', {
      method: 'POST', token: go.ownerAccessToken, server: go.workspaceId,
      body: {
        channelId: go.allChannelId,
        content: marker,
        mentions: [{ type: 'agent', id: agent.id, name: agent.name }],
      },
    });
    if (mentioned.status !== 200 || !mentioned.data?.message?.id) {
      fail(`human mention before start failed (${publicError(mentioned)})`);
    }
    const message = mentioned.data.message;
    console.log('PASS m5-daemon-core R-mention-before-session persisted=true deliver-before-start=not-required');

    // Do not invoke the human Start route or replay the discarded frame.
    // The real Go dispatcher must recover the unconfirmed start itself.
    tap.allowStarts();
    step('phase=await-automatic-start');
    const startFrame = await waitFor('automatic agent:start', async () => (
      frames(tap.wire, 'in').find((msg) => msg.type === 'agent:start' && msg.agentId === agent.id) ?? null
    ), 30000);
    if (!startFrame.launchId || !startFrame.startDispatchId || !startFrame.config) {
      fail('automatic agent:start is missing the persistent launch/dispatch/config contract');
    }
    if (startFrame.launchId !== droppedStart.launchId || startFrame.startDispatchId !== droppedStart.startDispatchId) {
      fail('automatic start recovery replaced the persisted launch or dispatch id');
    }
    for (const forbidden of ['wakeMessage', 'resumeMessages', 'resumePrompt', 'unreadSummary']) {
      if (Object.hasOwn(startFrame, forbidden) || Object.hasOwn(droppedStart, forbidden)) {
        fail(`initial or recovered cold-start frame carries ${forbidden}`);
      }
    }
    if (startFrame.config.sessionId) fail('fresh automatic start carries a saved session');
    step('phase=await-session');
    const sessionFrame = await waitFor('agent:session', async () => (
      [...frames(tap.wire, 'out')].reverse().find((msg) => msg.type === 'agent:session' && msg.agentId === agent.id) ?? null
    ), 90000);
    if (!sessionFrame.sessionId) fail('agent:session carried no sessionId');
    if (!sessionFrame.launchId || sessionFrame.launchId !== startFrame.launchId) {
      fail('agent:session does not match the observed automatic start launch');
    }
    const sessionIndex = tap.wire.findIndex((entry) => entry.direction === 'out' && entry.msg === sessionFrame);
    const earlyDelivery = tap.wire.slice(0, sessionIndex).some((entry) => (
      entry.direction === 'in' && entry.msg.type === 'agent:deliver' && entry.msg.mentionDelivery?.messageId === message.id
    ));
    if (earlyDelivery) fail('tracked input arrived before the original daemon reported its session');
    await waitFor('server persisted session', async () => {
      const detail = await productJSON(`/api/agents/${agent.id}`, { token: go.ownerAccessToken, server: go.workspaceId });
      return detail.data?.sessionId === sessionFrame.sessionId ? detail.data : null;
    }, 30000);
    const coldBodies = provider.script.requests.filter((entry) => entry.body.includes(marker) && !entry.body.includes(INBOX_WAKE));
    if (coldBodies.length > 0) fail('cold-start provider turn contained the mention body (wake promotion)');
    console.log('PASS m5-daemon-core R-cold-start-session runtime=builtin provider=deterministic-local initial-start-loss=true recovery=same-launch-and-dispatch manual-start=false start-wire-observed=true wakeMessage=absent launch-matches-session=true deliver-before-session=false bodyInModelTurns=false');

    const expected = {
      messageId: message.id,
      machineId: go.machineId,
      launchId: sessionFrame.launchId,
      sessionId: sessionFrame.sessionId,
    };
    const ack = await waitFor('tracked ack', async () => {
      const terminal = frames(tap.wire, 'out').find((msg) => msg.type === 'agent:delivery:terminal_error' && msg.mentionDelivery?.messageId === message.id);
      if (terminal) fail(`tracked delivery ended ${terminal.code} before ack`);
      return ackFor(tap.wire, message.id).find((msg) => snapshotMatches(msg.mentionDelivery, expected) && msg.deliveryId === msg.mentionDelivery.occurrenceId && msg.seq === message.seq) ?? null;
    }, 60000);
    const occurrenceId = ack.mentionDelivery.occurrenceId;
    const inbound = frames(tap.wire, 'in').find((msg) => msg.type === 'agent:deliver' && msg.deliveryId === occurrenceId);
    if (!inbound) fail('daemon ack has no matching inbound agent:deliver');
    if (!snapshotMatches(inbound.mentionDelivery, expected) || inbound.seq !== message.seq || inbound.agentId !== agent.id) {
      fail('inbound agent:deliver identity does not match the session the daemon reported');
    }
    const stages = frames(tap.wire, 'out')
      .filter((msg) => msg.type === 'agent:delivery:transition' && msg.mentionDelivery?.occurrenceId === occurrenceId)
      .map((msg) => msg.stage);
    if (!stages.includes('daemon_received') || !stages.includes('daemon_drained')) {
      fail(`original transition frames missing (saw ${stages.join('>') || 'none'})`);
    }
    const wake = await waitFor('content-free provider wake', async () => (
      provider.script.requests.find((entry) => entry.body.includes(INBOX_WAKE)) ?? null
    ), 60000);
    if (wake.body.includes(marker)) {
      fail('content-free wake request contained the human marker; drained would not be only a reported receipt');
    }
    console.log(`PASS m5-daemon-core R-tracked-ack runtime=builtin occurrence-matches-deliveryId=true transitions=${stages.join('>')} bodyInModelTurns=false semantics=reported-receipt exactly-once=not-claimed live-llm=false`);

    step('phase=await-builtin-tool');
    const consumed = await waitFor('builtin bash tool consumption', async () => {
      const checkRequest = provider.script.requests.find((entry) => toolTexts(entry.body).some((text) => section(text, 'check').includes(marker) && section(text, 'read').includes(marker)));
      const sendRequest = provider.script.requests.find((entry) => toolTexts(entry.body).some((text) => /"state"\s*:\s*"sent"/.test(section(text, 'send'))));
      if (providerStage === 'done' && (!checkRequest || !sendRequest)) {
        const toolDump = provider.script.requests.flatMap((entry) => toolTexts(entry.body)).map((text) => redact(text)).join(' || ') || 'no role=tool content';
        const contract = toolDump.includes('INVALID_JSON_RESPONSE')
          ? ' contract=parent_channel_name/parent_channel_type JSON null is rejected by agentApiMessageEnvelopeSchema (omitted parents parse)'
          : '';
        fail(`builtin tool phase ended without check/send evidence (${toolDump})${contract}`);
      }
      if (!checkRequest || !sendRequest) {
        return `stage=${providerStage} requests=${provider.script.requests.length}`;
      }
      const checkText = toolTexts(checkRequest.body).find((text) => text.includes('M5-SECTION check')) ?? '';
      return { checkRequest, checkText, sendRequest };
    }, 150000);
    const checkSection = section(consumed.checkText, 'check');
    const readSection = section(consumed.checkText, 'read');
    const raftPath = (consumed.checkText.split('\n').find((line) => line.startsWith('M5-RAFT-PATH ')) ?? '').slice('M5-RAFT-PATH '.length).trim();
    if (!raftPath || raftPath === 'missing' || !raftPath.endsWith('/raft')) {
      fail(`builtin bash did not resolve the daemon raft wrapper (${redact(consumed.checkText)})`);
    }
    if (!checkSection.includes(marker)) {
      fail(`bash raft message check tool result did not contain the human marker (${redact(consumed.checkText)})`);
    }
    if (!readSection.includes(marker)) {
      fail(`bash raft message read tool result did not contain the human marker (${redact(consumed.checkText)})`);
    }
    if (!assistantUsedBash(consumed.checkRequest.body) || !assistantUsedBash(consumed.sendRequest.body)) {
      fail('provider tool-result request did not carry the original bash tool call');
    }
    const sendText = toolTexts(consumed.sendRequest.body).map((text) => section(text, 'send')).find((text) => /"state"\s*:\s*"sent"/.test(text)) ?? '';
    if (!/"state"\s*:\s*"sent"/.test(sendText)) {
      fail(`bash raft message send tool result was not state=sent (${redact(sendText)})`);
    }
    const history = await productJSON(`/api/messages/channel/${go.allChannelId}?limit=50`, {
      token: go.ownerAccessToken, server: go.workspaceId,
    });
    if (history.status !== 200) fail(`web history after builtin send failed (${publicError(history)})`);
    const visible = (history.data?.messages ?? []).filter((row) => row?.content === replyMarker && row.senderType === 'agent' && row.senderId === agent.id);
    if (visible.length !== 1) {
      fail(`web history builtin tool reply count=${visible.length} (expected 1)`);
    }
    console.log(`FACT m5-daemon-core tool-reply-marker ${replyMarker}`);
    console.log('PASS m5-daemon-core R-builtin-tool-consumption runtime=builtin tool=bash cli=packages/cli/src/index.ts proxy=daemon-local check-section-has-human-marker=true read-section-has-human-marker=true send-tool=raft-message-send web-count=1 semantics=model-tool-consumption live-llm=false receipt-phase=separate');

    step('phase=reconnect');
    const dropAt = Date.now();
    tap.dropSockets();
    const retryMarker = `M5-RETRY-${suffix}`;
    const retried = await productJSON('/api/v2/messages', {
      method: 'POST', token: go.ownerAccessToken, server: go.workspaceId,
      body: {
        channelId: go.allChannelId,
        content: retryMarker,
        mentions: [{ type: 'agent', id: agent.id, name: agent.name }],
      },
    });
    if (retried.status !== 200 || !retried.data?.message?.id) fail(`offline mention failed (${publicError(retried)})`);
    const retryMessage = retried.data.message;
    await waitFor('daemon reconnect ready', async () => (
      frames(tap.wire, 'out', dropAt).some((msg) => msg.type === 'ready') ? true : null
    ), 30000);
    const retryAck = await waitFor('reconnect delivery ack', async () => {
      const terminal = frames(tap.wire, 'out', dropAt).find((msg) => msg.type === 'agent:delivery:terminal_error' && msg.mentionDelivery?.messageId === retryMessage.id);
      if (terminal) fail(`reconnect delivery ended ${terminal.code}`);
      return ackFor(tap.wire, retryMessage.id, dropAt).find((msg) => msg.deliveryId && msg.deliveryId === msg.mentionDelivery?.occurrenceId) ?? null;
    }, 120000);
    const replay = ackFor(tap.wire, message.id, dropAt);
    if (replay.some((msg) => msg.deliveryId !== occurrenceId)) {
      fail('reconnect ack for the already-acked mention used a different occurrence');
    }
    const retrySnap = retryAck.mentionDelivery ?? {};
    const retryExpected = { ...expected, messageId: retryMessage.id };
    if (!snapshotMatches(retrySnap, retryExpected) || retryAck.agentId !== agent.id || retryAck.seq !== retryMessage.seq) {
      fail('new-message reconnect ACK does not match the unchanged daemon launch/session and message seq');
    }
    if (retrySnap.occurrenceId === occurrenceId) fail('a different message reused the first message occurrence');
    const retryInbound = frames(tap.wire, 'in', dropAt).find((msg) => (
      msg.type === 'agent:deliver' && msg.deliveryId === retrySnap.occurrenceId
    ));
    if (!retryInbound || !snapshotMatches(retryInbound.mentionDelivery, retryExpected)
      || retryInbound.agentId !== agent.id || retryInbound.seq !== retryMessage.seq) {
      fail('new-message reconnect ACK has no matching authenticated inbound delivery');
    }
    // This is a new input following a socket drop in the SAME daemon
    // process. It does not deliberately lose an ACK or crash the daemon.
    console.log('PASS m5-daemon-core R-reconnect-delivery same-process-reconnect=true new-message-deliver-and-ack=true identity=unchanged lost-ack-retry=not-tested daemon-crash=not-tested exactly-once=not-claimed');
    console.log('SUMMARY m5-daemon-core real-server-complete runtime=builtin provider=deterministic-local live-llm=false phases=receipt-then-tool-consumption');
  } finally {
    if (core) await core.stop().catch(() => {});
    tap.restore();
    await provider.close().catch(() => {});
    let cleanupError = null;
    try {
      await rm(rootDir, { recursive: true, force: true });
      await access(rootDir);
      cleanupError = new Error('daemon temp dir still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupError = error;
    }
    if (cleanupError) {
      console.error(`FAIL m5-daemon-core cleanup ${cleanupError.message}`);
      process.exitCode = 1;
    } else {
      console.log('FACT m5-daemon-core cleanup temp-dir-removed=true');
    }
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  if (!String(error?.message ?? '').startsWith('m5-daemon-core:')) {
    console.error(`FAIL m5-daemon-core unexpected error: ${error?.stack ?? error}`);
  }
}
