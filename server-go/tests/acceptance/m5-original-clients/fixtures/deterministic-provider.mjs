// DETERMINISTIC LOCAL PROVIDER SUBSTITUTE — clearly labelled test double.
//
// This module is NOT a commercial model API and never contacts one. It answers
// the OpenAI-compatible `POST {base}/chat/completions` surface the original
// daemon BuiltInDriver (packages/daemon/src/drivers/pi.ts, provider kind
// "gateway", providerId "openai-compatible") actually calls.
//
// Two response phases share one script, chosen by the caller:
//   - text: a fixed assistant string and finish_reason "stop". Used for the
//     standing prompt and for the content-free wake when the caller wants to
//     prove a reported receipt. A text reply does not consume inbox bodies
//     and is not an autonomous tool loop.
//   - tool: an OpenAI tool_calls stream naming the original builtin `bash`
//     tool. The caller scripts the command. The next provider REQUEST is the
//     original runtime posting that tool result back. That is model-tool
//     consumption only when the caller actually selects this phase.
//
// Two transports share the script:
//   - fetchSeamProvider(): in-process fetch via installDaemonFetchMockForTests.
//   - startSocketProvider(): a real loopback HTTP server. The acceptance
//     runner uses this one against the real Go process.

export const PROVIDER_MODEL_NAME = 'm5-acceptance-deterministic';
export const PROVIDER_API_KEY = 'sk-local-deterministic-provider-fixture';
export const PROVIDER_ASSISTANT_REPLY = 'M5-DETERMINISTIC-PROVIDER-REPLY';

export function createProviderScript() {
  const requests = [];
  return {
    requests,
    recorded() {
      return requests.map((entry) => ({ ...entry }));
    },
    bodiesContaining(marker) {
      return requests.filter((entry) => entry.body.includes(marker));
    },
    sawMarker(marker) {
      return requests.some((entry) => entry.body.includes(marker));
    },
  };
}

export function textTurn(content = PROVIDER_ASSISTANT_REPLY) {
  return { kind: 'text', content };
}

export function bashToolTurn(id, command, timeoutSeconds = 90) {
  return {
    kind: 'tool',
    id,
    name: 'bash',
    arguments: {
      command,
      // Pi's bash tool treats this as seconds. No default exists, so an
      // unresponsive original CLI would otherwise hold the turn open.
      timeout: timeoutSeconds,
    },
  };
}

function sseChunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-m5-deterministic',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export function chatCompletionsSseBody(model, turn = textTurn()) {
  if (turn.kind === 'tool') {
    const args = typeof turn.arguments === 'string' ? turn.arguments : JSON.stringify(turn.arguments ?? {});
    return (
      sseChunk(model, {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: turn.id,
          type: 'function',
          function: { name: turn.name, arguments: '' },
        }],
      }) +
      sseChunk(model, { tool_calls: [{ index: 0, function: { arguments: args } }] }) +
      sseChunk(model, {}, 'tool_calls') +
      'data: [DONE]\n\n'
    );
  }
  const content = typeof turn.content === 'string' ? turn.content : PROVIDER_ASSISTANT_REPLY;
  return (
    sseChunk(model, { role: 'assistant', content: '' }) +
    sseChunk(model, { content }) +
    sseChunk(model, {}, 'stop') +
    'data: [DONE]\n\n'
  );
}

function answer(script, entry, respond) {
  const turn = respond ? respond(entry.body) : textTurn();
  entry.turnKind = turn?.kind === 'tool' ? 'tool' : 'text';
  return chatCompletionsSseBody(PROVIDER_MODEL_NAME, turn?.kind === 'tool' ? turn : textTurn(turn?.content));
}

/** In-process provider used when loopback sockets are unavailable. */
export function fetchSeamProvider(script = createProviderScript(), options = {}) {
  const respond = options.respond;
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let body = '';
    if (init?.body && typeof init.body === 'string') body = init.body;
    else if (init?.body instanceof Uint8Array) body = Buffer.from(init.body).toString('utf8');
    else if (input instanceof Request && method !== 'GET') body = await input.clone().text().catch(() => '');
    const entry = { transport: 'fetch-seam', method, url: String(url), body, at: new Date().toISOString() };
    script.requests.push(entry);
    if (String(url).includes('/chat/completions')) {
      return new Response(answer(script, entry, respond), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found (m5 local fixture)' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, script };
}

/**
 * Real loopback HTTP provider.
 * `options.respond(body)` may return textTurn() or bashToolTurn().
 * The default is text-only, which proves a receipt and not tool consumption.
 */
export async function startSocketProvider(script = createProviderScript(), options = {}) {
  const host = typeof options === 'string' ? options : (options.host ?? '127.0.0.1');
  const respond = typeof options === 'string' ? undefined : options.respond;
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = {
        transport: 'socket',
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body,
        at: new Date().toISOString(),
      };
      script.requests.push(entry);
      if ((req.url ?? '').includes('/chat/completions')) {
        let payload;
        try {
          payload = answer(script, entry, respond);
        } catch {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'deterministic provider script failed' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(payload);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found (m5 local fixture)' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  return {
    script,
    origin: `http://${host}:${address.port}`,
    baseUrl: `http://${host}:${address.port}/v1`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
