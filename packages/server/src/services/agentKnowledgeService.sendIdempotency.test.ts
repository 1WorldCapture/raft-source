import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Teeth for the send-idempotency contract gap (@Huaihuai, task #1032, 2026-09-02).
//
// The Manual used to tell agents that "idempotent send retries (daemon 0.48.1+)
// prevent double-posts from transient network failures". No client supplies an
// idempotency key for a message send, so that guarantee does not exist and the
// advice pointed the wrong way: it invited exactly the blind resend the DRI
// forbade. These teeth exist so restoring that claim turns the build red.

const CLI_SEND_PATH = fileURLToPath(
  new URL("../../../cli/src/commands/message/send.ts", import.meta.url),
);

test("the message doc does not promise that send retries are deduplicated", async () => {
  const doc = await resolveAgentKnowledgeDoc("message");
  assert.ok(doc, "message topic must resolve");

  // Each pattern is a way of restoring the old false guarantee.
  const forbidden: Array<[RegExp, string]> = [
    [/idempotent send retries/i, "the exact retired sentence"],
    [/prevent(s)? double-post/i, "a dedupe promise for retries"],
    [/retries (are|is) (safe|idempotent)/i, "a restated safety guarantee"],
    [/daemon 0\.48\.1/i, "the version pin that implied the guarantee"],
  ];
  for (const [pattern, why] of forbidden) {
    assert.doesNotMatch(doc.content, pattern, `message doc must not carry ${why}`);
  }
});

test("the message doc keeps the UNKNOWN / no-blind-resend guidance", async () => {
  const doc = await resolveAgentKnowledgeDoc("message");
  assert.ok(doc);
  assert.match(doc.content, /UNKNOWN/, "the unresolved state must be named");
  assert.match(
    doc.content,
    /does not prove the message was not committed/i,
    "the readback limitation is the load-bearing half — a readback is evidence, not proof",
  );
});

test("BINDING: the send key stays strictly opt-in — the CLI never generates one", async () => {
  // This is the revised expiry mechanism (faf57c3 shipped the opt-in key and
  // the Manual's UNKNOWN guidance now applies only to the no-key path). The
  // binding pins the new contract:
  //   1. the key is validated and forwarded only when the caller passes it;
  //   2. the client NEVER generates a key by itself — a key that changes per
  //      retry would silently reintroduce the double-post the doc warns about.
  const source = await readFile(CLI_SEND_PATH, "utf8");

  // Positive control: an absence claim against a file I failed to read would
  // otherwise pass for the wrong reason.
  assert.ok(source.length > 500, "send.ts must actually have been read");
  assert.match(source, /message/i, "send.ts must be the message-send source");

  assert.match(
    source,
    /--idempotency-key must be 1-256 characters/,
    "the opt-in key validation must stay",
  );
  assert.match(
    source,
    /body\.idempotencyKey = opts\.idempotencyKey/,
    "the key must reach the request body only from the caller's option",
  );
  assert.doesNotMatch(
    source,
    /randomUUID|randomBytes|nanoid|generateId/i,
    "send.ts gained client-side key generation — a per-retry key is a silent double-post; revisit the Manual's no-key UNKNOWN guidance",
  );
});
