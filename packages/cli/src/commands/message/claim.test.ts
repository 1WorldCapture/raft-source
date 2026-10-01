import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { messageClaimCommand } from "./claim.js";
import { messageAckCommand } from "./ack.js";
import { messageReceiptCommand } from "./receipt.js";
import { CLAIM_ACK_LINE_PREFIX, decodeClaimAckToken, encodeClaimAckToken } from "./_claimAck.js";

function memoryIo(stdinText?: string): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
      ...(stdinText !== undefined ? { stdin: Readable.from([stdinText]) } : {}),
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

type Handler = (method: string, path: string, body?: unknown) => ApiResponse<unknown>;

function contextWith(io: CliIo, handler: Handler, requests: Array<{ method: string; path: string; body: unknown }>) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return handler(method, path, body);
      },
    }) as any,
  });
}

test("claim ack token round-trips and rejects garbage", () => {
  const batch = { seqs: [7, 9], message_ids: ["m-1"], third_party_event_ids: [] };
  const token = encodeClaimAckToken(batch);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeClaimAckToken(token), batch);
  assert.deepEqual(decodeClaimAckToken(`${CLAIM_ACK_LINE_PREFIX}${token}\n`), batch);
  assert.equal(decodeClaimAckToken("not a token!"), null);
  assert.equal(decodeClaimAckToken(Buffer.from(JSON.stringify({ v: 2, s: [], m: [], t: [] })).toString("base64url")), null);
  assert.equal(decodeClaimAckToken(Buffer.from(JSON.stringify({ v: 1, s: [-1], m: [], t: [] })).toString("base64url")), null);
});

test("message claim prints the batch and a single trailing Claim-Ack line without acking", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextWith(io, (_method, path) => {
    assert.equal(path, "/internal/agent-api/events/claim?since=latest");
    return {
      ok: true,
      status: 200,
      error: null,
      data: {
        events: [{
          seq: 7,
          channel_type: "public",
          channel_name: "proj-runtime",
          message_id: "abcd1234-0000-0000-0000-000000000000",
          timestamp: "2026-05-28T00:00:00.000Z",
          sender_type: "human",
          sender_name: "xxchan",
          content: "review this",
        }],
        last_seen_msgId: null,
        last_seen_seq: 7,
        reply_target: null,
        pending_notice_ids: [],
        wake_reason: null,
        has_more: false,
        ack: { seqs: [7], message_ids: [], third_party_event_ids: [] },
      },
    };
  }, requests);

  await messageClaimCommand.handler(ctx);

  assert.equal(requests.length, 1, "claim must not issue an ack request");
  const output = stdout.join("");
  assert.match(output, /@xxchan: review this/);
  const ackLines = output.split("\n").filter((line) => line.startsWith(CLAIM_ACK_LINE_PREFIX));
  assert.equal(ackLines.length, 1);
  assert.ok(output.trimEnd().endsWith(ackLines[0]!), "Claim-Ack is the last line");
  assert.deepEqual(decodeClaimAckToken(ackLines[0]!), { seqs: [7], message_ids: [], third_party_event_ids: [] });
});

test("message claim omits the Claim-Ack line for an empty inbox", async () => {
  const { io, stdout } = memoryIo();
  const ctx = contextWith(io, () => ({
    ok: true,
    status: 200,
    error: null,
    data: {
      events: [],
      last_seen_msgId: null,
      last_seen_seq: null,
      reply_target: null,
      pending_notice_ids: [],
      wake_reason: null,
      has_more: false,
      ack: { seqs: [], message_ids: [], third_party_event_ids: [] },
    },
  }), []);
  await messageClaimCommand.handler(ctx);
  assert.equal(stdout.join("").includes(CLAIM_ACK_LINE_PREFIX), false);
});

test("message ack reads the token from stdin and posts the batch", async () => {
  const token = encodeClaimAckToken({ seqs: [7], message_ids: [], third_party_event_ids: [] });
  const { io, stdout } = memoryIo(`${CLAIM_ACK_LINE_PREFIX}${token}\n`);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextWith(io, () => ({ ok: true, status: 200, error: null, data: { ok: true, removed_count: 1 } }), requests);
  await messageAckCommand.handler(ctx, undefined);
  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/events/ack",
    body: { seqs: [7], message_ids: [], third_party_event_ids: [] },
  }]);
  assert.equal(stdout.join(""), "Acked 1 inbox item.\n");
});

test("message ack rejects an invalid token without a request", async () => {
  const { io } = memoryIo("garbage!!\n");
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextWith(io, () => { throw new Error("unexpected request"); }, requests);
  await assert.rejects(() => messageAckCommand.handler(ctx, undefined), /Invalid Claim-Ack token/);
  assert.equal(requests.length, 0);
});

test("message receipt renders sent and not_found", async () => {
  const sentIo = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await messageReceiptCommand.handler(contextWith(sentIo.io, () => ({
    ok: true,
    status: 200,
    error: null,
    data: { status: "sent", message_id: "msg-1", message_seq: 3, channel_id: "c-1", created_at: "2026-05-28T00:00:00.000Z" },
  }), requests), "zcode:send/1", {});
  assert.equal(requests[0]!.path, "/internal/agent-api/send-receipts/zcode%3Asend%2F1");
  assert.equal(sentIo.stdout.join(""), "Receipt: sent. Message ID: msg-1\n");

  const missingIo = memoryIo();
  await messageReceiptCommand.handler(contextWith(missingIo.io, () => ({
    ok: true,
    status: 200,
    error: null,
    data: { status: "not_found" },
  }), []), "zcode:send-2", {});
  assert.match(missingIo.stdout.join(""), /^Receipt: not_found\./);
});
