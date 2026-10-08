// Real RFC6455 client for M3 black-box protocol checks. Reuse the unchanged
// daemon package's installed ws dependency (pnpm-local createRequire) rather
// than maintaining a second incomplete framing parser. This preserves custom
// Authorization and rejected-upgrade Slock-Reason inspection, handles frames
// included in the HTTP upgrade head, fragmentation, TLS and control ping/pong.
// This is a test dependency only; the Go server has no Node runtime dependency.
import { createRequire } from 'node:module';

const requireDaemon = createRequire(new URL('../../../packages/daemon/package.json', import.meta.url));
const WebSocket = requireDaemon('ws');

export class MachineSocket {
  constructor(socket) {
    this.socket = socket;
    this.status = null;
    this.headers = {};
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.closeInfo = null;
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
    socket.on('upgrade', response => {
      this.status = response.statusCode;
      this.headers = response.headers;
    });
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch {
        this.fail(new Error('machine peer sent malformed JSON'));
        socket.terminate();
        return;
      }
      const index = this.waiters.findIndex(waiter => waiter.match(message));
      const waiter = index >= 0 ? this.waiters.splice(index, 1)[0] : null;
      if (waiter) waiter.resolve(message);
      else {
        if (this.messages.length >= 1024) {
          this.fail(new Error('machine test peer backlog exceeded its bound'));
          socket.terminate();
          return;
        }
        this.messages.push(message);
      }
    });
    socket.on('close', code => {
      this.closeInfo = { code };
      this.fail(new Error(`machine socket closed before the awaited message arrived (code=${code})`));
    });
    // Never include a URL or credentials in test errors. ws may put a URL in
    // its raw error; the enclosing upgrade promise reports a safe category.
    socket.on('error', () => this.fail(new Error('machine websocket transport failed')));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.resolveClosed(this.closeInfo);
  }

  send(message) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('machine socket is not open');
    this.socket.send(JSON.stringify(message));
  }

  async nextMessage(match = () => true, timeoutMs = 10000) {
    for (let index = 0; index < this.messages.length; index++) {
      if (match(this.messages[index])) return this.messages.splice(index, 1)[0];
    }
    if (this.closed) throw new Error('machine socket already closed before the awaited message');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(entry);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a machine websocket message`));
      }, timeoutMs);
      const entry = {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
        match,
      };
      this.waiters.push(entry);
    });
  }

  async waitClosed(timeoutMs = 10000) {
    if (this.closed) return this.closeInfo;
    let timer;
    try {
      return await Promise.race([
        this.closedPromise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('machine websocket close deadline exceeded')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  close() {
    // Test teardown must not leave a close handshake/timer alive after its
    // private server is stopped. Abrupt network loss is also a valid daemon
    // disconnect scenario and is handled by the server's grace policy.
    this.socket.terminate();
  }
}

// Resolves with MachineSocket or {rejected:{status,reason}}. A missing key
// intentionally omits Authorization (not an invalid empty Bearer token).
export function connectMachine({ origin, apiKey, useQueryKey = false, path = '/daemon/connect', headers = {} }) {
  const url = new URL(path, origin);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  if (useQueryKey) url.searchParams.set('key', apiKey ?? '');
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      handshakeTimeout: 15000,
      maxPayload: 4 * 1024 * 1024,
      headers: { ...(!useQueryKey && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
    });
    const peer = new MachineSocket(socket); // listeners exist before open/head frames
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(peer);
    });
    socket.once('unexpected-response', (_request, response) => {
      if (settled) return;
      const reason = response.headers['slock-reason'];
      settled = true;
      response.resume();
      response.once('end', () => {
        socket.terminate();
        resolve({ rejected: { status: response.statusCode, reason: typeof reason === 'string' && reason ? reason : null } });
      });
      response.once('error', () => { socket.terminate(); reject(new Error('machine rejection response failed')); });
    });
    socket.once('error', () => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('machine websocket upgrade failed'));
    });
  });
}
