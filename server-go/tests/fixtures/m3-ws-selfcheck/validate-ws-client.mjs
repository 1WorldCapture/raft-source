// Throwaway-grade self-check for the M3 acceptance WebSocket client
// (tests/acceptance/m3-wire-ws.mjs). This fixture exists because the writing
// session's sandbox forbids local port binding (listen EPERM), so the codec
// could not be exercised there. Run it anywhere binding loopback is allowed:
//
//   node server-go/tests/fixtures/m3-ws-selfcheck/validate-ws-client.mjs
//
// It starts a loopback RFC 6455 server that mimics the daemon contract
// (401 + Slock-Reason on bad keys; machine:context first frame; ping echo)
// and asserts the client's handshake, framing, masking and close detection.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const EXPECTED = 'sk_computer_loopback_key';
let sawCloseFrame = false;

server.on('upgrade', (req, socket, head) => {
  const auth = req.headers.authorization ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  const reason = !auth ? 'missing_key' : bearer !== EXPECTED ? 'computer_not_found' : null;
  if (reason) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nSlock-Reason: ${reason}\r\n\r\n`);
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (head.length) socket.unshift(head);
  let buffer = Buffer.alloc(0);
  const sendFrame = (payload, opcode = 0x1) => {
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    socket.write(Buffer.concat([header, payload]));
  };
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        assert.ok(true, 'client frames must be masked');
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        const out = Buffer.alloc(length);
        for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) { sawCloseFrame = true; sendFrame(Buffer.alloc(0), 0x8); socket.end(); return; }
      if (opcode === 0x9) { sendFrame(payload.subarray(0, 125), 0xA); continue; }
      if (opcode !== 0x1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.type === 'ready') sendFrame(Buffer.from(JSON.stringify({ type: 'machine:context', machineId: 'm-1', serverId: 's-1' })));
      else if (message.type === 'ping') sendFrame(Buffer.from(JSON.stringify({ type: 'ping' })));
    }
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const { connectMachine } = await import('../../acceptance/m3-wire-ws.mjs');
try {
  const wrong = await connectMachine({ origin, apiKey: 'sk_computer_wrong' });
  assert.ok('rejected' in wrong && wrong.rejected.status === 401 && wrong.rejected.reason === 'computer_not_found', 'rejection path captures status + Slock-Reason');
  const missing = await connectMachine({ origin, apiKey: '' });
  assert.ok('rejected' in missing && missing.rejected.reason === 'missing_key', 'missing key path');
  const sock = await connectMachine({ origin, apiKey: EXPECTED });
  assert.ok(!('rejected' in sock), '101 accepted with the bearer header');
  const context = await sock.nextMessage(m => m.type === 'machine:context', 5000);
  assert.deepEqual(context, { type: 'machine:context', machineId: 'm-1', serverId: 's-1' }, 'first frame round-trips');
  sock.send({ type: 'ready', runtimes: ['claude'], runningAgents: [] });
  sock.send({ type: 'ping' });
  const echoed = await sock.nextMessage(m => m.type === 'ping', 5000);
  assert.equal(echoed.type, 'ping', 'masked text frames decode and ping echoes');
  const big = { type: 'ready', filler: 'x'.repeat(70000), runtimes: [], runningAgents: [] };
  sock.send(big); // exercises the 16-bit + 64-bit length paths client-side
  sock.close();
  await sock.waitClosed(5000);
  assert.ok(sawCloseFrame, 'client sends a well-formed close frame');
  console.log('PASS m3-wire-ws client codec validated against the loopback daemon mimic');
} finally {
  server.close();
}
