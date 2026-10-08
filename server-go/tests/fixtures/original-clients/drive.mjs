// Isolated original-client driver. Parent starts this with the repository
// tsx binary so packages/computer and packages/daemon TypeScript load unchanged.
// The private fixture arrives on stdin. Nothing secret is written to argv or env.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startSameOriginProxy } from './proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const daemonPackageJson = path.join(repo, 'packages/daemon/package.json');
const requireFromDaemon = createRequire(daemonPackageJson);
const SENSITIVE = /sk_(?:computer|machine|agent|daemon)_[A-Za-z0-9_-]+|Bearer\s+\S+|"(?:accessToken|refreshToken|apiKey|deviceCode|userCode|password)"\s*:/i;

const resources = {
  proxy: null,
  connection: null,
  sockets: new Set(),
};

function fail(message) {
  throw new Error(message);
}

function safeDiagnostic(error) {
  const text = error instanceof Error ? (error.stack || error.message) : 'unknown failure';
  const clipped = text.split('\n').slice(0, 6).join('\n');
  if (SENSITIVE.test(clipped)) return 'failed (diagnostic withheld)';
  return clipped;
}

function fileImport(relativePath) {
  return import(pathToFileURL(path.join(repo, relativePath)).href);
}

function loopbackOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is not an absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`${label} must be http or https`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) fail(`${label} must be loopback`);
  return url.origin;
}

async function loadOriginalClients() {
  const [computer, daemon, purge, manifest, migration, shared] = await Promise.all([
    fileImport('packages/computer/src/apiClient.ts'),
    fileImport('packages/daemon/src/connection.ts'),
    fileImport('packages/daemon/src/agentPurge.ts'),
    fileImport('packages/daemon/src/registry.manifest.ts'),
    fileImport('packages/shared/src/agentMigrationResumable.ts'),
    fileImport('packages/shared/src/index.ts'),
  ]);
  for (const name of ['DeviceAuthClient', 'ComputerAttachClient', 'ServersClient', 'AuthClient', 'ServerMachinesClient', 'RunnersClient']) {
    if (typeof computer[name] !== 'function') fail(`original computer client is missing ${name}`);
  }
  if (typeof daemon.DaemonConnection !== 'function') fail('original daemon module is missing DaemonConnection');
  const wsResolved = requireFromDaemon.resolve('ws');
  if (!wsResolved.includes(`${path.sep}ws${path.sep}`)) fail('ws did not resolve from packages/daemon/package.json');
  const WebSocket = requireFromDaemon('ws');
  if (typeof WebSocket !== 'function') fail('daemon ws package did not export a constructor');
  const daemonVersion = requireFromDaemon('./package.json').version;
  if (typeof daemonVersion !== 'string' || daemonVersion.length === 0) fail('daemon package version is missing');
  return { computer, DaemonConnection: daemon.DaemonConnection, WebSocket, daemonVersion, purge, manifest, migration, shared };
}

function readyFrame(protocol, daemonVersion) {
  // Same object emitReady sends when no Computer supervisor is attached and
  // no migration transfer is listening. Runtime inventory is one explicit
  // report: this process does not probe or launch CLIs.
  return {
    type: 'ready',
    capabilities: [
      'agent:start',
      'agent:stop',
      protocol.purge,
      'agent:deliver',
      'workspace:files',
      protocol.wiki,
      ...protocol.builtIn,
    ],
    runtimes: ['original-client'],
    runtimeVersions: { 'original-client': '0' },
    runningAgents: [],
    hostname: os.hostname(),
    os: `${os.platform()} ${os.arch()}`,
    daemonVersion,
    migrationTransport: {
      provisioned: false,
      endpoint: null,
      leaseSource: null,
      protocol: protocol.migrationProtocol,
      capabilities: [...protocol.migrationCapabilities, protocol.migrationArchive],
      observedAt: new Date().toISOString(),
    },
  };
}

function protocolConstants(loaded) {
  const purge = loaded.purge.AGENT_PURGE_CAPABILITY;
  const builtIn = loaded.manifest.BUILT_IN_READY_CAPABILITIES;
  const wiki = loaded.shared.WIKI_WORKSPACE_PACK_CAPABILITY;
  const migrationProtocol = loaded.migration.AGENT_MIGRATION_RESUMABLE_PROTOCOL;
  const migrationCapabilities = loaded.migration.AGENT_MIGRATION_RESUMABLE_CAPABILITIES;
  const migrationArchive = loaded.migration.AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY;
  if (purge !== 'agent:purge') fail('AGENT_PURGE_CAPABILITY drifted from the daemon source');
  if (!Array.isArray(builtIn) || builtIn.length === 0) fail('BUILT_IN_READY_CAPABILITIES is empty');
  if (typeof wiki !== 'string' || typeof migrationProtocol !== 'string' || typeof migrationArchive !== 'string') {
    fail('ready protocol constants did not load from the TypeScript sources');
  }
  return { purge, builtIn, wiki, migrationProtocol, migrationCapabilities, migrationArchive };
}

async function productJSON(baseUrl, route, { method = 'GET', token, server, body } = {}) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(server ? { 'x-server-id': server } : {}),
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

function codeOf(result) {
  return result.data && typeof result.data.code === 'string' ? result.data.code : 'none';
}

async function deviceSession(clients, baseUrl, fixture, { approve }) {
  const device = new clients.DeviceAuthClient(baseUrl);
  const grant = await device.authorize('raft-computer');
  if (typeof grant.deviceCode !== 'string' || typeof grant.userCode !== 'string') fail('device authorize returned no codes');
  if (!(grant.expiresIn > 0) || !(grant.interval >= 1)) fail('device authorize omitted expiresIn or interval');
  const verification = new URL(grant.verificationUri);
  if (verification.pathname !== '/login/device') fail('verificationUri path is not /login/device');
  if (verification.origin === new URL(baseUrl).origin) fail('verificationUri points at the API origin');
  const complete = new URL(grant.verificationUriComplete ?? grant.verificationUri);
  if (complete.searchParams.get('user_code') !== grant.userCode) fail('verificationUriComplete did not pre-fill user_code');
  const before = await device.token(grant.deviceCode);
  if (approve) {
    if (before.status !== 'pending') fail(`token before approval was ${before.status}`);
  }
  const decision = await productJSON(baseUrl, '/api/auth/device/approve', {
    method: 'POST',
    token: fixture.ownerAccessToken,
    body: { userCode: grant.userCode, approve },
  });
  if (decision.status !== 200 || decision.data?.ok !== true) {
    fail(`device approve failed (HTTP ${decision.status}, code ${codeOf(decision)})`);
  }
  if (decision.data.action !== (approve ? 'approved' : 'denied')) fail('device approve action did not match the product request');
  if (!approve) {
    const denied = await device.token(grant.deviceCode);
    if (denied.status !== 'denied') fail(`denied device grant surfaced ${denied.status}`);
    return { verificationOrigin: verification.origin };
  }
  const deadline = Date.now() + 15000;
  let session = null;
  while (Date.now() < deadline) {
    const polled = await device.token(grant.deviceCode);
    if (polled.status === 'success') { session = polled; break; }
    if (polled.status === 'pending') { await sleep(200); continue; }
    const detail = polled.status === 'error' ? ` code ${polled.code}` : '';
    fail(`device token status ${polled.status}${detail}`);
  }
  if (!session) fail('device token was not issued');
  if (session.userId !== fixture.ownerUserId) fail('device token user does not match the approving account');
  return { accessToken: session.accessToken, verificationOrigin: verification.origin };
}

function assertIdentity(identity, fixture) {
  if (identity.status !== 'success') fail(`identity me returned ${identity.status}`);
  const user = identity.user;
  if (user.id !== fixture.ownerUserId || user.email !== fixture.ownerEmail || user.name !== fixture.ownerName) {
    fail('identity me did not match the verified account');
  }
  if (user.displayName !== fixture.ownerDisplayName) fail('identity me displayName did not match the verified profile');
}

function assertServers(listed, fixture) {
  if (listed.status !== 'success') fail(`ServersClient list returned ${listed.status}${listed.code ? ` code ${listed.code}` : ''}`);
  const match = listed.servers.find((server) => server.id === fixture.workspaceId && server.slug === fixture.workspaceSlug);
  if (!match) fail('ServersClient list omitted the attached workspace');
  if (match.role !== 'owner') fail('ServersClient list did not report the owner role');
}

function assertAttach(attached, fixture) {
  if (attached.status !== 'success') fail(`computer attach returned ${attached.status}${attached.code ? ` code ${attached.code}` : ''}`);
  if (typeof attached.apiKey !== 'string' || !attached.apiKey.startsWith('sk_computer_') || attached.apiKey.length < 20) {
    fail('attach did not return an sk_computer_ credential');
  }
  if (!/^[0-9a-f-]{36}$/i.test(attached.machineId ?? '') || !/^[0-9a-f-]{36}$/i.test(attached.serverMachineId ?? '')) {
    fail('attach did not return machine and computer ids');
  }
  if (attached.machineId === attached.serverMachineId) fail('attach used one id for both the machine and the computer');
  if (attached.serverId !== fixture.workspaceId || attached.serverSlug !== fixture.workspaceSlug || attached.resumed !== false) {
    fail('attach did not bind a fresh computer to the workspace');
  }
  return attached;
}

async function assertRunners(clients, baseUrl, apiKey) {
  const runners = new clients.RunnersClient(baseUrl, apiKey);
  for (const request of [undefined, { all: true }]) {
    const listed = request ? await runners.list(request) : await runners.list();
    if (listed.status === 'unauthorized') {
      fail('RunnersClient list was unauthorized; the original client requires the implemented runners extension');
    }
    if (listed.status !== 'success') fail(`RunnersClient list returned ${listed.status}${listed.code ? ` code ${listed.code}` : ''}`);
    if (JSON.stringify(listed.whitelist) !== JSON.stringify(['agentId', 'name', 'status', 'model', 'runtime'])) {
      fail('RunnersClient whitelist was not the server control-plane list');
    }
    if (!Array.isArray(listed.runners)) fail('RunnersClient runners payload was not an array');
  }
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

async function assertReadyLanded(baseUrl, token, fixture, attached, daemonVersion) {
  const expectedOs = `${os.platform()} ${os.arch()}`;
  const expectedHost = os.hostname();
  await waitFor('ready facts', async () => {
    const directory = await productJSON(baseUrl, `/api/servers/${fixture.workspaceId}/machines`, {
      token, server: fixture.workspaceId,
    });
    if (directory.status !== 200 || !Array.isArray(directory.data?.machines)) return `directory HTTP ${directory.status}`;
    const row = directory.data.machines.find((machine) => machine && machine.id === attached.machineId);
    if (!row) return 'machine missing';
    if (row.daemonVersion !== daemonVersion) return 'daemonVersion pending';
    if (row.hostname !== expectedHost || row.os !== expectedOs) return 'host facts pending';
    if (!Array.isArray(row.runtimes) || row.runtimes.length !== 1 || row.runtimes[0] !== 'original-client') return 'runtimes pending';
    if (row.status !== 'online') return 'status pending';
    const versions = row.runtimeVersions;
    if (!versions || versions['original-client'] !== '0') return 'runtimeVersions pending';
    return true;
  }, 8000);
}

async function exerciseDaemon(DaemonConnection, WebSocket, baseUrl, apiKey, attached, fixture, protocol, daemonVersion) {
  const state = {
    connects: 0,
    disconnects: 0,
    inboundPings: 0,
    pongsSent: 0,
    contexts: [],
    firstTypes: [],
    awaitingFirst: false,
    rejected: null,
  };
  let latest = null;
  const connection = new DaemonConnection({
    serverUrl: baseUrl,
    apiKey,
    minReconnectDelayMs: 200,
    connectTimeoutMs: 10000,
    onConnect() {
      state.connects += 1;
      state.awaitingFirst = true;
      connection.send(readyFrame(protocol, daemonVersion));
    },
    onDisconnect() {
      state.disconnects += 1;
    },
    onMessage(msg) {
      const type = msg && typeof msg.type === 'string' ? msg.type : 'unknown';
      if (state.awaitingFirst) {
        state.awaitingFirst = false;
        state.firstTypes.push(type);
        if (type === 'machine:context') state.contexts.push(msg);
      } else if (type === 'ping') {
        // packages/daemon/src/core.ts answers a server ping with pong.
        state.inboundPings += 1;
        connection.send({ type: 'pong' });
        state.pongsSent += 1;
      }
    },
    onHandshakeRejected(event) {
      state.rejected = event;
      try { connection.disconnect(); } catch { /* already closing */ }
    },
    wsFactory(url, options) {
      const socket = new WebSocket(url, options);
      latest = socket;
      resources.sockets.add(socket);
      socket.on('close', () => resources.sockets.delete(socket));
      return socket;
    },
  });
  resources.connection = connection;
  try {
    connection.connect();
    await waitFor('machine context', () => {
      if (state.rejected) return 'handshake rejected';
      return state.contexts.length === 1 && state.connects >= 1;
    }, 8000);
    if (state.rejected) fail(`websocket handshake rejected (HTTP ${state.rejected.statusCode}, reason ${state.rejected.reason ?? 'none'})`);
    if (state.firstTypes[0] !== 'machine:context') fail('the first daemon frame was not machine:context');
    const context = state.contexts[0];
    if (context.machineId !== attached.machineId || context.serverId !== fixture.workspaceId) {
      fail('machine:context did not identify the attached machine');
    }
    const pingsBefore = state.inboundPings;
    const pongsBefore = state.pongsSent;
    connection.send({ type: 'ping' });
    await waitFor('ping echo', () => state.inboundPings > pingsBefore && state.pongsSent > pongsBefore, 5000);
    await assertReadyLanded(baseUrl, fixture.deviceAccessToken, fixture, attached, daemonVersion);
    if (state.disconnects !== 0) fail('the daemon socket closed before the reconnect probe');
    const victim = latest;
    if (!victim) fail('the live websocket was not captured');
    const connectsBefore = state.connects;
    const disconnectsBefore = state.disconnects;
    victim.terminate();
    await waitFor('reconnect', () => {
      if (state.rejected) return 'handshake rejected';
      return state.connects > connectsBefore && state.disconnects > disconnectsBefore && state.contexts.length >= 2;
    }, 5000);
    if (state.firstTypes[1] !== 'machine:context') fail('the reconnected daemon did not receive machine:context first');
    const again = state.contexts[1];
    if (again.machineId !== attached.machineId || again.serverId !== fixture.workspaceId) {
      fail('the reconnected machine:context identified a different machine');
    }
    const replayPings = state.inboundPings;
    connection.send({ type: 'ping' });
    await waitFor('reconnected ping echo', () => state.inboundPings > replayPings, 5000);
  } finally {
    try { connection.disconnect(); } catch { /* closing */ }
    if (resources.connection === connection) resources.connection = null;
    for (const socket of [...resources.sockets]) {
      try { socket.terminate(); } catch { /* already closed */ }
    }
  }
}

async function exercise(loaded, protocol, baseUrl, fixture, label) {
  const clients = loaded.computer;
  if (label === 'direct') {
    await deviceSession(clients, baseUrl, fixture, { approve: false });
  }
  const session = await deviceSession(clients, baseUrl, fixture, { approve: true });
  fixture.deviceAccessToken = session.accessToken;
  const identity = await new clients.AuthClient(baseUrl, session.accessToken).me();
  assertIdentity(identity, fixture);
  const listed = await new clients.ServersClient(baseUrl, session.accessToken).list();
  assertServers(listed, fixture);
  const suffix = Math.random().toString(16).slice(2, 10);
  const attached = assertAttach(
    await new clients.ComputerAttachClient(baseUrl, session.accessToken).attach(fixture.workspaceSlug, `original-${label}-${suffix}`),
    fixture,
  );
  const preflight = await new clients.ComputerAttachClient(baseUrl, session.accessToken).preflight(attached.apiKey);
  if (preflight.ok !== true || preflight.serverSlug !== fixture.workspaceSlug) fail('computer preflight did not confirm the workspace');
  const machines = await new clients.ServerMachinesClient(baseUrl, session.accessToken).list(fixture.workspaceId);
  if (machines.status !== 'success') fail(`ServerMachinesClient list returned ${machines.status}`);
  const row = machines.machines.find((machine) => machine.id === attached.machineId);
  if (!row || row.isComputer !== true || row.computerAttachedByCurrentUser !== true) {
    fail('ServerMachinesClient did not list the attached computer');
  }
  await assertRunners(clients, baseUrl, attached.apiKey);
  await exerciseDaemon(loaded.DaemonConnection, loaded.WebSocket, baseUrl, attached.apiKey, attached, fixture, protocol, loaded.daemonVersion);
  console.log(`PASS original-clients ${label}`);
  return session.verificationOrigin;
}

function assertProxyObservations(proxy, fixture) {
  const seen = proxy.observations();
  const http = seen.filter((entry) => entry.kind === 'http');
  const upgrades = seen.filter((entry) => entry.kind === 'upgrade');
  const has = (method, path) => http.some((entry) => entry.method === method && entry.path === path);
  if (!has('POST', '/api/auth/device/authorize')) fail('proxy did not forward device authorize');
  if (!has('POST', '/api/auth/device/approve')) fail('proxy did not forward device approve');
  if (!has('POST', '/api/auth/device/token')) fail('proxy did not forward device token');
  if (!has('GET', '/api/auth/me')) fail('proxy did not forward identity me');
  if (!has('GET', '/api/servers/')) fail('proxy did not observe ServersClient trailing-slash list');
  if (http.some((entry) => entry.path === '/api/servers' || entry.path === '/api/servers?')) {
    fail('ServersClient requested the servers list without the trailing slash');
  }
  if (!has('POST', '/api/computer/attach')) fail('proxy did not forward computer attach');
  if (!has('POST', '/internal/computer/preflight')) fail('proxy did not forward computer preflight');
  if (!has('GET', '/internal/computer/runners')) fail('proxy did not forward runners list');
  if (!has('GET', '/internal/computer/runners?scope=server')) fail('proxy did not forward the server-scoped runners list');
  const machinesPath = `/api/servers/${fixture.workspaceId}/machines`;
  if (!http.some((entry) => entry.method === 'GET' && entry.path === machinesPath)) fail('proxy did not forward the machine directory');
  for (const entry of http) {
    if (entry.host !== proxy.upstreamHost) fail('proxy did not rewrite Host for an HTTP API route');
    if (!String(entry.xForwardedFor).includes('127.0.0.1')) fail('proxy did not set X-Forwarded-For');
    if (entry.xForwardedPort !== String(proxy.port)) fail('proxy did not set X-Forwarded-Port from the incoming Host');
    if (entry.xForwardedProto !== 'http') fail('proxy did not set X-Forwarded-Proto');
  }
  if (upgrades.length < 2) fail('proxy did not tunnel the daemon connect and its reconnect');
  for (const entry of upgrades) {
    if (!entry.path.startsWith('/daemon/connect')) fail('daemon upgrade path was not /daemon/connect');
    if (entry.host !== `127.0.0.1:${proxy.port}`) fail('daemon proxy rewrote Host; Vite leaves that header unchanged');
    if (entry.xForwardedFor !== null || entry.xForwardedPort !== null || entry.xForwardedProto !== null) {
      fail('daemon proxy added xfwd headers');
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) fail('missing private fixture on stdin');
  let fixture;
  try { fixture = JSON.parse(text); } catch { fail('private fixture was not JSON'); }
  return fixture;
}

function requireString(fixture, key) {
  if (typeof fixture[key] !== 'string' || fixture[key].length === 0) fail('private fixture is incomplete');
  return fixture[key];
}

async function closeClientDispatchers() {
  try {
    const undici = await import(pathToFileURL(path.join(repo, 'packages/computer/node_modules/undici/index.js')).href);
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch { /* the original client may not have opened a dispatcher */ }
}

async function cleanup() {
  try { resources.connection?.disconnect(); } catch { /* closing */ }
  resources.connection = null;
  for (const socket of [...resources.sockets]) {
    try { socket.terminate(); } catch { /* already closed */ }
  }
  resources.sockets.clear();
  if (resources.proxy) {
    const proxy = resources.proxy;
    resources.proxy = null;
    await proxy.close();
  }
  await closeClientDispatchers();
}

async function main() {
  const raw = await readStdin();
  const fixture = {
    ownerAccessToken: requireString(raw, 'ownerAccessToken'),
    ownerUserId: requireString(raw, 'ownerUserId'),
    ownerEmail: requireString(raw, 'ownerEmail'),
    ownerName: requireString(raw, 'ownerName'),
    ownerDisplayName: raw.ownerDisplayName === null ? null : requireString(raw, 'ownerDisplayName'),
    workspaceId: requireString(raw, 'workspaceId'),
    workspaceSlug: requireString(raw, 'workspaceSlug'),
    directOrigin: loopbackOrigin(requireString(raw, 'directOrigin'), 'direct origin'),
  };
  const loaded = await loadOriginalClients();
  const protocol = protocolConstants(loaded);
  resources.proxy = await startSameOriginProxy(fixture.directOrigin);
  const verificationOrigin = await exercise(loaded, protocol, fixture.directOrigin, fixture, 'direct');
  console.log(`PASS original-clients device-verification-origin ${verificationOrigin}`);
  const proxyOrigin = await exercise(loaded, protocol, resources.proxy.origin, fixture, 'proxy');
  if (proxyOrigin !== verificationOrigin) fail('device verification origin changed between the direct and proxied clients');
  assertProxyObservations(resources.proxy, fixture);
  console.log('PASS original-clients proxy-forwarded /api /internal /daemon');
}

function acceptKey(key) {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

async function selfCheck() {
  const loaded = await loadOriginalClients();
  protocolConstants(loaded);
  const upgraded = new Set();
  const stub = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/servers/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(204);
    res.end();
  });
  stub.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const key = req.headers['sec-websocket-key'];
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  });
  let stubPort = 0;
  try {
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = stub.address().port;
    resources.proxy = await startSameOriginProxy(`http://127.0.0.1:${stubPort}`);
    const listed = await new loaded.computer.ServersClient(resources.proxy.origin, 'self-check').list();
    if (listed.status !== 'success') fail('self-check ServersClient did not receive the trailing-slash list');
    const probed = await fetch(`${resources.proxy.origin}/internal/health`, { signal: AbortSignal.timeout(5000) });
    if (probed.status !== 204) fail(`self-check HTTP proxy returned ${probed.status}`);
    const servers = resources.proxy.observations().find((entry) => entry.method === 'GET' && entry.path === '/api/servers/');
    const internal = resources.proxy.observations().find((entry) => entry.kind === 'http' && entry.path === '/internal/health');
    if (!servers || servers.host !== `127.0.0.1:${stubPort}` || servers.xForwardedProto !== 'http') {
      fail('self-check proxy did not apply the Vite HTTP header rules to /api/servers/');
    }
    if (!internal || internal.xForwardedPort !== String(resources.proxy.port)) {
      fail('self-check proxy did not set X-Forwarded-Port');
    }
    let opened = false;
    const connection = new loaded.DaemonConnection({
      serverUrl: resources.proxy.origin,
      apiKey: 'self-check',
      connectTimeoutMs: 5000,
      wsFactory(url, options) {
        const socket = new loaded.WebSocket(url, options);
        resources.sockets.add(socket);
        return socket;
      },
      onConnect() { opened = true; },
      onDisconnect() {},
      onMessage() {},
    });
    resources.connection = connection;
    connection.connect();
    await waitFor('self-check daemon open', () => opened, 5000);
    connection.disconnect();
    const upgrade = resources.proxy.observations().find((entry) => entry.kind === 'upgrade');
    if (!upgrade || upgrade.host !== `127.0.0.1:${resources.proxy.port}` || !upgrade.path.startsWith('/daemon/connect')) {
      fail('self-check daemon upgrade did not keep the proxy Host');
    }
    console.log('PASS original-clients self-check');
  } finally {
    try { resources.connection?.disconnect(); } catch { /* closing */ }
    for (const socket of upgraded) socket.destroy();
    if (typeof stub.closeAllConnections === 'function') stub.closeAllConnections();
    if (stub.listening) {
      await Promise.race([
        new Promise((resolve) => stub.close(() => resolve())),
        sleep(1000),
      ]);
    }
    stub.unref?.();
  }
}

const deadline = setTimeout(() => {
  console.error('FAIL original-clients deadline exceeded');
  void cleanup().finally(() => process.exit(1));
}, 80000);

try {
  if (process.argv.includes('--self-check')) await selfCheck();
  else await main();
} catch (error) {
  console.error(`FAIL original-clients ${safeDiagnostic(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { await cleanup(); } catch { /* already closed */ }
}
