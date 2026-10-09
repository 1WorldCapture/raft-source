// Original-daemon protocol acceptance driver (worker E, M5).
//
// Executes the ORIGINAL daemon classes — packages/daemon/src/agentProcessManager.ts
// AgentProcessManager + packages/daemon/src/drivers/pi.ts BuiltInDriver/PiSdkRuntimeSession
// — against a clearly labelled deterministic local provider substitute (see
// deterministic-provider.mjs). No commercial API, no credentials, no global
// services, no production file edits. The parent process (run.mjs) starts this
// file with the repository tsx binary so the TypeScript sources load unchanged.
//
// What is ORIGINAL here: AgentProcessManager start/deliver/tracked-mention
// machinery, BuiltInDriver + PiSdkRuntimeSession + the real pi-ai
// openai-completions client stack, and the AgentMessage / mentionDelivery
// identity contract from @botiverse/raft-shared.
// What is a SUBSTITUTE: the model provider transport (fetch-seam when this
// sandbox forbids loopback sockets; a real loopback HTTP server otherwise).
// This driver does NOT claim to be the full DaemonCore wire loop; that runs in
// daemon-core-drive.mjs when sockets are available.
//
// stdin: JSON fixture { repo, mode: "fetch-seam" | "socket" }
// stdout: "PASS m5-original-daemon <leg> ..." lines (parent parses these)
// failure: exit!=0 with a "FAIL m5-original-daemon ..." line on stderr.

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchSeamProvider, startSocketProvider, PROVIDER_MODEL_NAME, PROVIDER_API_KEY } from './deterministic-provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureInput = await readStdinJson();
const repo = fixtureInput.repo ?? path.resolve(here, '../../../../..');
const mode = fixtureInput.mode === 'socket' ? 'socket' : 'fetch-seam';

function fail(message) {
  console.error(`FAIL m5-original-daemon ${message}`);
  throw new Error(`m5-original-daemon: ${message}`);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) fail('no fixture on stdin');
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`fixture on stdin is not JSON: ${error.message}`);
  }
}

function fileImport(relativePath) {
  return import(pathToFileURL(path.join(repo, relativePath)).href);
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let detail = 'not ready';
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result === true) return;
    if (typeof result === 'string') detail = result;
    await sleep(50);
  }
  fail(`timed out waiting for ${label} (${detail})`);
}

// Mirrors packages/daemon/src/agentProcessManager.builtin.e2e.test.ts
// cleanupTestManager: the manager owns timers that must not keep the process
// alive after the legs finish.
function cleanupTestManager(manager) {
  if (manager.agentStartPumpTimer) clearTimeout(manager.agentStartPumpTimer);
  for (const ap of manager.agents?.values?.() ?? []) {
    ap.notifications.clearTimer();
    if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
    if (ap.activityHeartbeat?.kind === 'active') clearInterval(ap.activityHeartbeat.timer);
    if (ap.startup?.kind === 'waiting' && ap.startup.timer) clearTimeout(ap.startup.timer);
    if (ap.exit?.kind === 'live' && ap.exit.stalledRecoverySigtermTimer) clearTimeout(ap.exit.stalledRecoverySigtermTimer);
    if (ap.compaction?.kind === 'active' && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    if (ap.runtimeErrorDeliveryBackoff?.kind === 'backing_off' && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
  }
  manager.agents?.clear?.();
}

function builtInGatewayConfig(providerBaseUrl, agentId) {
  return {
    name: agentId,
    displayName: 'M5 Acceptance Agent',
    description: 'original-daemon protocol acceptance fixture agent',
    model: PROVIDER_MODEL_NAME,
    runtime: 'builtin',
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: {
      version: 1,
      runtime: 'builtin',
      provider: {
        kind: 'gateway',
        providerId: 'openai-compatible',
        baseUrl: providerBaseUrl,
        apiKey: PROVIDER_API_KEY,
      },
      model: { kind: 'custom', name: PROVIDER_MODEL_NAME },
      mode: { kind: 'default' },
    },
    sessionId: null,
    // Clearly labelled fixture credential: never valid against a real server,
    // never minted, only carried so the daemon skips the runner-credential
    // mint HTTP path (that path is exercised against the real Go server in
    // daemon-core-drive.mjs, not here).
    serverUrl: 'http://127.0.0.1:9',
    authToken: 'sk_machine_m5_local_fixture',
    agentCredentialKey: 'sk_agent_m5_local_fixture_never_real',
    agentCredentialId: 'cred-m5-local-fixture',
  };
}

function humanMentionMessage({ messageId, seq, marker, channelName = 'm5-acceptance' }) {
  return {
    channel_id: 'ch-m5-acceptance',
    channel_name: channelName,
    channel_type: 'channel',
    sender_id: 'user-m5-owner',
    sender_name: 'm5-owner',
    sender_type: 'human',
    content: `please process ${marker}`,
    timestamp: new Date().toISOString(),
    seq,
    message_id: messageId,
    mentioned: true,
  };
}

function trackedContext({ occurrenceId, messageId, machineId, launchId, sessionId }) {
  const observations = { transitions: [], terminalErrors: [], ackedAt: null, ackCount: 0 };
  return {
    observations,
    context: {
      deliveryId: occurrenceId,
      transient: false,
      mentionDelivery: { occurrenceId, messageId, machineId, launchId, sessionId },
      onMentionTransition: (stage, outcome) => observations.transitions.push({ stage, outcome, at: new Date().toISOString() }),
      onMentionTerminalError: (code) => observations.terminalErrors.push({ code, at: new Date().toISOString() }),
      onMentionAck: () => {
        observations.ackedAt = new Date().toISOString();
        observations.ackCount += 1;
      },
    },
  };
}

async function main() {
  const loaded = await fileImport('packages/daemon/src/agentProcessManager.ts');
  const { AgentProcessManager } = loaded;
  if (typeof AgentProcessManager !== 'function') fail('original agentProcessManager module is missing AgentProcessManager');

  let restoreFetch = null;
  let socketProvider = null;
  let providerBaseUrl;
  let script;
  if (mode === 'fetch-seam') {
    const daemonFetchModule = await fileImport('packages/daemon/src/daemonFetch.ts');
    if (typeof daemonFetchModule.installDaemonFetchMockForTests !== 'function') {
      fail('original daemonFetch test seam installDaemonFetchMockForTests is missing');
    }
    const seam = fetchSeamProvider();
    restoreFetch = daemonFetchModule.installDaemonFetchMockForTests(seam.fetch);
    // Second ORIGINAL test seam: the daemon binds a loopback credential proxy
    // for every managed runner credential. This sandbox forbids any listen(),
    // so install the module's own __setAgentCredentialProxyServerFactoryForTest
    // hook with a non-binding stand-in. The proxy's REQUEST HANDLER code is
    // still the original; only its socket is absent, and no CLI wrapper is
    // exec'd by these legs (the provider answers through the fetch seam).
    const proxyModule = await fileImport('packages/daemon/src/agentCredentialProxy.ts');
    if (typeof proxyModule.__setAgentCredentialProxyServerFactoryForTest !== 'function') {
      fail('original agentCredentialProxy test seam is missing');
    }
    proxyModule.__setAgentCredentialProxyServerFactoryForTest(() => nonBindingProxyServer());
    script = seam.script;
    providerBaseUrl = 'http://127.0.0.1:9/v1'; // never dialed; the fetch seam answers
    console.log('MODE m5-original-daemon provider=fetch-seam (original daemonFetch + agentCredentialProxy test seams; loopback sockets unavailable)');
  } else {
    socketProvider = await startSocketProvider();
    script = socketProvider.script;
    providerBaseUrl = socketProvider.baseUrl;
    console.log(`MODE m5-original-daemon provider=socket ${socketProvider.origin} (deterministic local OpenAI-compatible substitute)`);
  }

  const sentFrames = [];
  const rootDir = await mkdtemp(path.join(tmpdir(), 'm5-original-daemon-'));
  const dataDir = path.join(rootDir, 'data');
  const machineId = randomUUID();
  const marker = `M5-MENTION-MARKER-${randomUUID().slice(0, 8)}`;

  const newManager = (extraOptions = {}) => {
    const manager = new AgentProcessManager(
      (msg) => sentFrames.push({ ...msg, at: new Date().toISOString() }),
      'sk_machine_m5_local_fixture',
      {
        dataDir,
        serverUrl: 'http://127.0.0.1:9',
        slockHome: path.join(rootDir, 'slock-home'),
        slockCliPath: '__m5_cli_fixture',
        runtimeSessionHomeDir: path.join(rootDir, 'runtime-sessions'),
        ...extraOptions,
      },
    );
    return manager;
  };

  try {
    // ---------------------------------------------------------------------------
    // D1 cold-start-session: first start with NO wakeMessage, NO resume context.
    // The original manager must obtain a session through the real BuiltInDriver
    // session_init path and report agent:session — the runtime identity a
    // tracked mention requires — without any business wake input.
    // ---------------------------------------------------------------------------
    {
      const manager = newManager();
      const agentId = 'm5-agent-cold';
      const launchId = `launch-${randomUUID()}`;
      try {
        await manager.startAgent(agentId, builtInGatewayConfig(providerBaseUrl, agentId), undefined, undefined, undefined, launchId);
        const sessionFrame = await observe(async () => lastSessionFrame(sentFrames, agentId), 30000);
        if (!sessionFrame.sessionId) fail('D1 agent:session frame carried no sessionId');
        if (sessionFrame.launchId !== launchId) fail(`D1 agent:session launchId ${sessionFrame.launchId} != start launchId ${launchId}`);
        const statusFrames = sentFrames.filter((f) => f.type === 'agent:status' && f.agentId === agentId);
        if (!statusFrames.some((f) => f.status === 'active')) fail('D1 daemon did not report agent active after start');
        // Model-input evidence: the cold start DID reach the provider (the
        // standing-prompt turn), and that first turn carries no mention marker
        // (nothing was promoted into the startup input).
        await waitFor('D1 provider standing-prompt turn', async () => (script.requests.length > 0 ? true : 'no provider request yet'), 30000);
        if (script.bodiesContaining(marker).length > 0) fail('D1 cold-start turn already contained the mention marker before any mention existed');
        console.log(`PASS m5-original-daemon D1-cold-start-session mode=${mode} runtime=builtin session=${sessionFrame.sessionId.slice(0, 8)}… launch=${launchId.slice(0, 14)}… provider-turns=${script.requests.length} wakeMessage=absent`);
        await manager.stopAgent(agentId).catch(() => {});
      } finally {
        cleanupTestManager(manager);
      }
    }

    // ---------------------------------------------------------------------------
    // D2 tracked-mention-live-delivery: with a live process + real session, a
    // tracked mention with the full five-tuple identity is accepted
    // (daemon_received) and completes with daemon_drained + ACK. For the
    // builtin runtime the daemon wakes the model with a CONTENT-FREE inbox
    // notice and keeps the body in the daemon-local inbox (consumed later via
    // the agent-inbox CLI flow), so the ACK is recorded as a daemon REPORTED
    // RECEIPT for runtime-session input — not as model body consumption.
    // ---------------------------------------------------------------------------
    {
      const manager = newManager();
      const agentId = 'm5-agent-live';
      const launchId = `launch-${randomUUID()}`;
      try {
        await manager.startAgent(agentId, builtInGatewayConfig(providerBaseUrl, agentId), undefined, undefined, undefined, launchId);
        const sessionFrame = await observe(async () => lastSessionFrame(sentFrames, agentId), 30000);
        // Deliver at the deterministic idle point: the standing-prompt turn has
        // finished and the runtime session waits for stdin. (Delivering while
        // the first turn streams routes through the busy-mention queue instead.)
        await waitFor('D2 runtime idle after cold-start turn', () => (sentFrames.some((f) => f.type === 'agent:activity' && f.agentId === agentId && f.detailKind === 'idle') ? true : 'no idle activity'), 30000);
        const messageId = randomUUID();
        const occurrenceId = randomUUID();
        const { observations, context } = trackedContext({
          occurrenceId, messageId, machineId, launchId, sessionId: sessionFrame.sessionId,
        });
        const turnsBefore = script.requests.length;
        const accepted = await manager.deliverMessage(agentId, humanMentionMessage({ messageId, seq: 42, marker }), context);
        if (accepted !== true && !(accepted instanceof Promise)) fail(`D2 deliverMessage returned ${accepted}`);
        await waitFor('D2 daemon_received transition', () => (observations.transitions.some((t) => t.stage === 'daemon_received') ? true : 'no daemon_received'), 15000);
        await waitFor('D2 drained + ACK', () => (observations.transitions.some((t) => t.stage === 'daemon_drained') && observations.ackedAt ? true : 'no drained/ack'), 30000);
        if (observations.terminalErrors.length > 0) fail(`D2 terminal errors: ${JSON.stringify(observations.terminalErrors)}`);
        // What the drained ACK actually attests for the builtin runtime: the
        // ORIGINAL daemon writes a CONTENT-FREE "[Raft inbox notice: ...]" to
        // the live runtime session (agentProcessManager.ts stdin_idle_delivery
        // -> completeTrackedMentionDelivery); the mention BODY stays in the
        // daemon-local inbox until the agent pulls it via `raft message
        // check/read`. Assert both halves of that contract honestly:
        //  (a) a provider turn AFTER the delivery carries the inbox notice (the
        //      runtime really was woken by this delivery), and
        //  (b) the marker BODY never appears in any provider turn (the daemon
        //      did not inject the body; drained is a reported receipt, not
        //      model body consumption).
        await waitFor('D2 inbox-notice turn after delivery', async () => {
          const later = script.requests.slice(turnsBefore).filter((entry) => entry.body.includes('[Raft inbox notice:'));
          return later.length > 0 ? true : `turns=${script.requests.length} noticeTurns=${later.length}`;
        }, 30000);
        if (script.bodiesContaining(marker).length > 0) {
          fail('D2 mention BODY appeared in a provider turn; the daemon injected the body (unexpected for the stdin inbox path)');
        }
        const drainedAt = observations.transitions.find((t) => t.stage === 'daemon_drained')?.at;
        console.log(`PASS m5-original-daemon D2-tracked-live-delivery mode=${mode} occurrence=${occurrenceId.slice(0, 8)}… turns-before=${turnsBefore} transitions=${observations.transitions.map((t) => t.stage).join('>')} ack=${observations.ackedAt != null} drained=${drainedAt ?? 'none'} bodyInModelTurns=false semantics=content-free-inbox-notice+reported-receipt`);
        await manager.stopAgent(agentId).catch(() => {});
      } finally {
        cleanupTestManager(manager);
      }
    }

    // ---------------------------------------------------------------------------
    // D3 identity gates (the cold-start contract): tracked mentions are
    // rejected — with the ORIGINAL terminal-error codes and NO ACK — when the
    // five-tuple identity does not close.
    // ---------------------------------------------------------------------------
    {
      // A manager whose start scheduler keeps a second start QUEUED, so the
      // delivery path sees a start in flight without a session.
      const manager = newManager({ runtimeStartScheduler: { maxConcurrentStarts: 1, minStartIntervalMs: 60000 } });
      const agentId = 'm5-agent-gates';
      const launchId = `launch-${randomUUID()}`;
      try {
        // D3a: first cold start, then a tracked mention whose sessionId is
        // wrong -> IDENTITY_DRIFT, zero ACK, zero drained.
        await manager.startAgent(agentId, builtInGatewayConfig(providerBaseUrl, agentId), undefined, undefined, undefined, launchId);
        const sessionFrame = await observe(async () => lastSessionFrame(sentFrames, agentId), 30000);
        const messageId = randomUUID();
        const drift = trackedContext({
          occurrenceId: randomUUID(), messageId, machineId,
          launchId, sessionId: `sess-drift-${randomUUID()}`,
        });
        await manager.deliverMessage(agentId, humanMentionMessage({ messageId, seq: 43, marker: `drift-${marker}` }), drift.context);
        await waitFor('D3a IDENTITY_DRIFT', () => (drift.observations.terminalErrors.some((e) => e.code === 'IDENTITY_DRIFT') ? true : `errors=${JSON.stringify(drift.observations.terminalErrors)}`), 15000);
        if (drift.observations.ackedAt || drift.observations.transitions.some((t) => t.stage === 'daemon_drained')) {
          fail('D3a drifted identity produced an ACK or drained report');
        }

        // D3b: deliveryId mismatch -> INSTRUMENT_FAILED, zero ACK.
        const badInstrument = trackedContext({
          occurrenceId: randomUUID(), messageId: randomUUID(), machineId, launchId, sessionId: sessionFrame.sessionId,
        });
        badInstrument.context.deliveryId = `not-the-occurrence-${randomUUID()}`;
        await manager.deliverMessage(agentId, humanMentionMessage({ messageId: randomUUID(), seq: 44, marker: `instr-${marker}` }), badInstrument.context);
        await waitFor('D3b INSTRUMENT_FAILED', () => (badInstrument.observations.terminalErrors.some((e) => e.code === 'INSTRUMENT_FAILED') ? true : `errors=${JSON.stringify(badInstrument.observations.terminalErrors)}`), 15000);
        if (badInstrument.observations.ackedAt) fail('D3b instrument failure still ACKed');

        // D3c: second agent, cold start still QUEUED (no session anywhere):
        // IDENTITY_UNKNOWN — the daemon refuses to accept a tracked mention
        // before first-start identity exists. This is the honest cold-start
        // gate; the message is NOT silently buffered as a wake substitute.
        const coldAgent = 'm5-agent-gates-cold';
        const coldLaunch = `launch-${randomUUID()}`;
        manager.startAgent(coldAgent, builtInGatewayConfig(providerBaseUrl, coldAgent), undefined, undefined, undefined, coldLaunch).catch(() => {});
        await waitFor('D3c queued start', () => (manager.agentStarts?.hasQueued?.(coldAgent) ? true : 'start not queued'), 15000);
        // Matching messageId/deliveryId (instrument intact) but the cold start
        // has produced no session yet, so the identity cannot close.
        const coldMessageId = randomUUID();
        const unknown = trackedContext({
          occurrenceId: randomUUID(), messageId: coldMessageId, machineId, launchId: coldLaunch, sessionId: `sess-never-${randomUUID()}`,
        });
        await manager.deliverMessage(coldAgent, humanMentionMessage({ messageId: coldMessageId, seq: 45, marker: `cold-${marker}` }), unknown.context);
        await waitFor('D3c IDENTITY_UNKNOWN', () => (unknown.observations.terminalErrors.some((e) => e.code === 'IDENTITY_UNKNOWN') ? true : `errors=${JSON.stringify(unknown.observations.terminalErrors)}`), 15000);
        if (unknown.observations.ackedAt) fail('D3c identity-unknown delivery was ACKed');
        await manager.stopAgent(coldAgent, { silent: true }).catch(() => {});
        console.log(`PASS m5-original-daemon D3-identity-gates mode=${mode} IDENTITY_DRIFT=1 INSTRUMENT_FAILED=1 IDENTITY_UNKNOWN=1 acks=0`);
        await manager.stopAgent(agentId).catch(() => {});
      } finally {
        cleanupTestManager(manager);
      }
    }

    // ---------------------------------------------------------------------------
    // D4 early-ACK-during-startup (honest verification): hold the agent's RESUME
    // start deterministically QUEUED (the original start coordinator rate-limits
    // starts across different agents, so a decoy start keeps the pump timer
    // pending and the resume item sits in the queue carrying its known
    // launch+session identity). The ORIGINAL manager then buffers the tracked
    // mention and completes the tracked delivery — daemon_drained + ACK — while
    // NO runtime process exists and the provider log shows no input turn at
    // all. This reproduces the daemon's startup-buffer early-ACK window (the
    // buffered-during-start branch of deliverMessage; cf. the source TODO that
    // a failed start never re-reports the already-ACKed occurrence). The ACK is
    // recorded as a daemon reported receipt ONLY — explicitly not model input.
    // ---------------------------------------------------------------------------
    {
      const manager = newManager({ runtimeStartScheduler: { maxConcurrentStarts: 1, minStartIntervalMs: 60000 } });
      const agentId = 'm5-agent-earlyack';
      const decoyId = 'm5-agent-earlyack-decoy';
      const launchId = `launch-${randomUUID()}`;
      try {
        await manager.startAgent(agentId, builtInGatewayConfig(providerBaseUrl, agentId), undefined, undefined, undefined, launchId);
        const sessionFrame = await observe(async () => lastSessionFrame(sentFrames, agentId), 30000);
        await manager.stopAgent(agentId).catch(() => {});
        await sleep(200);
        // Queue a decoy start for a DIFFERENT agent; the coordinator's
        // min-start-interval rate limit parks it (and the pump timer) for 60s.
        manager.startAgent(decoyId, builtInGatewayConfig(providerBaseUrl, decoyId), undefined, undefined, undefined, `launch-${randomUUID()}`).catch(() => {});
        await waitFor('D4 decoy start queued', () => (manager.agentStarts?.hasQueued?.(decoyId) ? true : 'decoy not queued'), 15000);
        // Resume start with the known identity; FIFO order keeps it queued
        // behind the rate-limited decoy.
        const resumeConfig = { ...builtInGatewayConfig(providerBaseUrl, agentId), sessionId: sessionFrame.sessionId };
        manager.startAgent(agentId, resumeConfig, undefined, undefined, undefined, launchId).catch(() => {});
        await waitFor('D4 resume start queued', () => (manager.agentStarts?.hasQueued?.(agentId) ? true : 'resume start not queued'), 15000);
        const messageId = randomUUID();
        const earlyMarker = `early-${marker}`;
        const earlyChannel = 'm5-earlyack-channel';
        const turnsAtDeliver = script.requests.length;
        const { observations, context } = trackedContext({
          occurrenceId: randomUUID(), messageId, machineId, launchId, sessionId: sessionFrame.sessionId,
        });
        await manager.deliverMessage(agentId, humanMentionMessage({ messageId, seq: 46, marker: earlyMarker, channelName: earlyChannel }), context);
        await waitFor('D4 early daemon_drained + ACK', () => (observations.transitions.some((t) => t.stage === 'daemon_drained') && observations.ackedAt ? true : 'no early drained/ack'), 15000);
        if (observations.terminalErrors.length > 0) fail(`D4 terminal errors: ${JSON.stringify(observations.terminalErrors)}`);
        if (manager.agents?.has?.(agentId)) fail('D4 agent unexpectedly has a live process during the queued start');
        // The decisive honesty check: the ACK fired while the resume start was
        // still QUEUED — no runtime session exists, so no turn can carry even
        // the content-free inbox notice for this channel, let alone the body.
        await sleep(500);
        const noticeTurns = script.requests.slice(turnsAtDeliver).filter((entry) => entry.body.includes(earlyChannel));
        if (noticeTurns.length > 0) fail('D4 a runtime turn named the early-ACK channel; the window was not process-free');
        if (script.bodiesContaining(earlyMarker).length > 0) fail('D4 provider already received the marker body');
        console.log(`PASS m5-original-daemon D4-early-ack-during-startup mode=${mode} ackAt=${observations.ackedAt} processPresent=false runtimeTurnsAfterDelivery=0 semantics=buffered-startup-receipt-not-model-input`);
        await manager.stopAgent(agentId, { silent: true }).catch(() => {});
        await manager.stopAgent(decoyId, { silent: true }).catch(() => {});
      } finally {
        cleanupTestManager(manager);
      }
    }

    console.log(`SUMMARY m5-original-daemon mode=${mode} providerRequests=${script.requests.length} outboundFrames=${sentFrames.length} marker=${marker}`);
  } finally {
    if (restoreFetch) restoreFetch();
    if (socketProvider) await socketProvider.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A stand-in http.Server-shaped object for the ORIGINAL
// __setAgentCredentialProxyServerFactoryForTest seam: it satisfies the
// listen/address/on/unref/close surface startProxyServer uses without opening
// a socket (impossible in this sandbox). The proxy handler passed to the
// factory is still constructed from the original module.
function nonBindingProxyServer() {
  return {
    listen(...args) {
      const callback = args.find((arg) => typeof arg === 'function');
      if (callback) setImmediate(callback);
    },
    address() {
      return { port: 47011, address: '127.0.0.1', family: 'IPv4' };
    },
    on() {},
    off() {},
    once(event, callback) {
      if (event === 'listening' && typeof callback === 'function') setImmediate(callback);
      return this;
    },
    unref() {},
    close(callback) {
      if (typeof callback === 'function') setImmediate(callback);
    },
  };
}

async function lastSessionFrame(frames, agentId) {
  const frame = [...frames].reverse().find((f) => f.type === 'agent:session' && f.agentId === agentId);
  return frame ?? null;
}

// Poll an async getter until it returns a non-null value (no fail on timeout;
// callers that need failure semantics wrap with waitFor).
async function observe(getter, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) return value;
    await sleep(50);
  }
  fail('observation window elapsed');
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  if (!String(error?.message ?? '').startsWith('m5-original-daemon:')) {
    console.error(`FAIL m5-original-daemon unexpected error: ${error?.stack ?? error}`);
  }
}
