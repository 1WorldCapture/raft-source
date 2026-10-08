// Disposable loopback reverse proxy with the same route table as
// packages/web/vite.config.ts server.proxy and preview.proxy:
//   /api and /internal  -> changeOrigin + xfwd (http-proxy header rules)
//   /daemon             -> ws:true, Host left unchanged, no xfwd
// Node's HTTP and net modules only. No Vite, no browser, no extra packages.
import http from 'node:http';
import net from 'node:net';

const BODY_LIMIT = 1024 * 1024;

function loopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function routeKind(requestUrl) {
  const pathOnly = (requestUrl ?? '/').split('?')[0];
  if (pathOnly === '/api' || pathOnly.startsWith('/api/')) return 'http';
  if (pathOnly === '/internal' || pathOnly.startsWith('/internal/')) return 'http';
  if (pathOnly === '/daemon' || pathOnly.startsWith('/daemon/')) return 'daemon';
  return null;
}

// http-proxy changeOrigin omits the port when it is the protocol default.
function changeOriginHost(target) {
  const implied = target.protocol === 'https:' ? '443' : '80';
  if (!target.port || target.port === implied) return target.hostname;
  return `${target.hostname}:${target.port}`;
}

// http-proxy xfwd reads the port from the incoming Host header.
function forwardedPort(hostHeader, encrypted) {
  const match = typeof hostHeader === 'string' ? hostHeader.match(/:(\d+)/) : null;
  if (match) return match[1];
  return encrypted ? '443' : '80';
}

function appendForwarded(existing, value) {
  if (existing === undefined || existing === '') return value;
  return `${existing},${value}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        reject(Object.assign(new Error('proxy body limit'), { code: 'LIMIT' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startSameOriginProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  if (target.protocol !== 'http:' || !loopback(target.hostname) || !target.port) {
    throw new Error('same-origin proxy requires an http loopback target with an explicit port');
  }
  const observations = [];
  const sockets = new Set();
  const upstreamHost = changeOriginHost(target);

  const server = http.createServer((req, res) => {
    const kind = routeKind(req.url);
    if (kind !== 'http') {
      res.writeHead(404);
      res.end();
      return;
    }
    readBody(req).then((body) => {
      const headers = { ...req.headers };
      delete headers.connection;
      delete headers['proxy-connection'];
      delete headers['transfer-encoding'];
      headers.host = upstreamHost;
      headers['content-length'] = String(body.length);
      const remote = req.socket.remoteAddress ?? '';
      headers['x-forwarded-for'] = appendForwarded(headers['x-forwarded-for'], remote);
      headers['x-forwarded-port'] = appendForwarded(headers['x-forwarded-port'], forwardedPort(req.headers.host, false));
      headers['x-forwarded-proto'] = appendForwarded(headers['x-forwarded-proto'], 'http');
      observations.push({
        kind: 'http',
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        host: headers.host,
        xForwardedFor: headers['x-forwarded-for'],
        xForwardedPort: headers['x-forwarded-port'],
        xForwardedProto: headers['x-forwarded-proto'],
      });
      const upstream = http.request({
        hostname: target.hostname,
        port: Number(target.port),
        method: req.method,
        path: req.url,
        headers,
      }, (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders.connection;
        delete responseHeaders['transfer-encoding'];
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
      });
      upstream.setTimeout(15000, () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(error?.code === 'LIMIT' ? 413 : 400);
      res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (routeKind(req.url) !== 'daemon') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let host = req.headers.host ?? '';
    const raw = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      raw.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    observations.push({
      kind: 'upgrade',
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      host,
      xForwardedFor: null,
      xForwardedPort: null,
      xForwardedProto: null,
    });
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(upstream);
    const fail = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', fail);
    socket.on('error', fail);
    upstream.once('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${raw.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('same-origin proxy did not bind a loopback port');

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    upstreamHost,
    observations() { return observations.map((entry) => ({ ...entry })); },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      if (server.listening) {
        await Promise.race([
          new Promise((resolve) => server.close(() => resolve())),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      server.unref?.();
    },
  };
}
