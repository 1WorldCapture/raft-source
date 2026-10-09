// LABELLED SERVER-DISPATCH SUBSTITUTE (worker E, M5).
//
// Not used by the acceptance runner (index.mjs / daemon-core-drive.mjs).
// Those execute the original DaemonCore against the real Go server. This
// module only exists so a future diagnostic can replay ServerToMachineMessage
// frames without pretending to be that server. Do not treat a pass that
// used this gateway as M5 client acceptance.

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../..');

export function gatewayUnavailable(message) {
  const error = new Error(`machine-gateway: ${message}`);
  error.name = 'MachineGatewayUnavailable';
  return error;
}

/**
 * @param {{
 *   fixtureMachineKey: string,
 *   machineId: string,
 *   serverId: string,
 *   repoRoot?: string,
 * }} args
 */
export async function startMachineGateway({ fixtureMachineKey, machineId, serverId, repoRoot = repo }) {
  const requireFromDaemon = createRequire(path.join(repoRoot, 'packages/daemon/package.json'));
  const WebSocketServer = requireFromDaemon('ws').WebSocketServer;
  if (typeof WebSocketServer !== 'function') throw gatewayUnavailable('ws WebSocketServer did not resolve from packages/daemon');

  const frames = [];
  const sockets = new Set();
  const waiters = [];

  const server = http.createServer((req, res) => {
    // The daemon only dials /daemon/connect over WebSocket; any plain HTTP
    // request here (e.g. a stray runner mint) is answered 404 so legs fail
    // loudly instead of hanging.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'machine-gateway: websocket upgrade required' }));
  });
  const wss = new WebSocketServer({ server, path: '/daemon/connect' });

  const record = (msg) => {
    frames.push({ ...msg, at: new Date().toISOString() });
    for (const waiter of waiters.splice(0)) waiter();
  };

  wss.on('connection', (socket, request) => {
    const auth = request.headers.authorization ?? '';
    if (auth !== `Bearer ${fixtureMachineKey}`) {
      socket.close(4401, 'invalid_machine_key');
      return;
    }
    sockets.add(socket);
    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'ping' }));
        return;
      }
      record(msg);
    });
    socket.on('close', () => sockets.delete(socket));
    // The real server speaks first with the authenticated machine context.
    socket.send(JSON.stringify({ type: 'machine:context', machineId, serverId, protocolVersion: 1 }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  const gateway = {
    kind: 'labelled-server-dispatch-substitute',
    origin: `http://127.0.0.1:${port}`,
    frames,
    send(msg) {
      const payload = JSON.stringify(msg);
      for (const socket of sockets) socket.send(payload);
    },
    /** Wait until some recorded machine frame satisfies the predicate. */
    async waitFor(label, predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = frames.find(predicate);
        if (match) return match;
        await new Promise((resolve) => waiters.push(resolve));
        // waiters resolve synchronously on record; add a small sleep safety net.
        await sleep(20);
      }
      throw gatewayUnavailable(`timed out waiting for ${label}`);
    },
    async close() {
      for (const socket of sockets) {
        try { socket.terminate(); } catch { /* already closed */ }
      }
      sockets.clear();
      await new Promise((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return gateway;
}

/** A five-tuple tracked-mention snapshot exactly as the server will send it. */
export function mentionSnapshot({ occurrenceId, messageId, machineId, launchId, sessionId }) {
  return { occurrenceId, messageId, machineId, launchId, sessionId };
}

export function gatewayAgentMessage({ messageId, seq, marker, channelName = 'm5-gateway-channel' }) {
  return {
    channel_id: `ch-${channelName}`,
    channel_name: channelName,
    channel_type: 'channel',
    sender_id: 'user-m5-gateway-owner',
    sender_name: 'm5-gateway-owner',
    sender_type: 'human',
    content: `gateway tracked mention ${marker}`,
    timestamp: new Date().toISOString(),
    seq,
    message_id: messageId,
    mentioned: true,
  };
}

export function gatewayAgentConfig(providerBaseUrl, agentId) {
  return {
    name: agentId,
    displayName: 'M5 Gateway Agent',
    description: 'daemon-core gateway fixture agent',
    model: 'm5-acceptance-deterministic',
    runtime: 'builtin',
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: {
      version: 1,
      runtime: 'builtin',
      provider: { kind: 'gateway', providerId: 'openai-compatible', baseUrl: providerBaseUrl, apiKey: 'sk-local-deterministic-provider-fixture' },
      model: { kind: 'custom', name: 'm5-acceptance-deterministic' },
      mode: { kind: 'default' },
    },
    sessionId: null,
    serverUrl: 'http://127.0.0.1:9',
    authToken: 'sk_machine_m5_local_fixture',
    // Fixture credential: skips the runner-credential mint so the gateway
    // never needs the mint HTTP surface. The REAL mint path against the Go
    // server is exercised by the real-server leg, not here.
    agentCredentialKey: 'sk_agent_m5_local_fixture_never_real',
    agentCredentialId: 'cred-m5-local-fixture',
  };
}

export function randomId() {
  return randomUUID();
}
