// `raft message receipt <key>` — fork patch (ZCode integration): authoritative
// lookup of a `raft message send --idempotency-key <key>` attempt. `sent` means
// the message was committed; `not_found` means it was not committed and a retry
// with the same key is safe (the server dedupes on the key).

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeJson, writeText, adoptCliReplyText, NL } from "../../core/renderer.js";

export const messageReceiptCommand = defineCommand(
  {
    name: "receipt",
    description: "Look up whether a send with the given --idempotency-key was committed.",
    arguments: ["<key>"],
    options: [{ flags: "--json", description: "Emit the receipt as JSON" }],
  },
  async (ctx, rawKey: string, opts: { json?: boolean }) => {
    const key = rawKey?.trim() ?? "";
    if (!key || key.length > 256) {
      throw new CliError({ code: "INVALID_ARG", message: "Receipt key must be 1-256 characters." });
    }
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.messages.receipt({ key });
    if (!res.ok || !res.data) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "READ_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (opts.json) {
      writeJson(ctx.io, res.data);
      return;
    }
    const line = res.data.status === "sent"
      ? `Receipt: sent. Message ID: ${res.data.message_id}`
      : "Receipt: not_found. The send was not committed; retrying with the same key is safe.";
    writeText(ctx.io, adoptCliReplyText(line), NL);
  },
);

export function registerReceiptCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageReceiptCommand, runtimeOptions);
}
