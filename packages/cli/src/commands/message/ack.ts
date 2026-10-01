// `raft message ack` — fork patch (ZCode integration): acknowledge a batch
// previously returned by `raft message claim`. The token (or the whole
// `Claim-Ack: <token>` line) is read from stdin when no argument is given, so
// callers can keep it out of argv. Idempotent: re-acking is a no-op.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText, NL } from "../../core/renderer.js";
import { decodeClaimAckToken, isEmptyAckBatch } from "./_claimAck.js";

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const messageAckCommand = defineCommand(
  {
    name: "ack",
    description: "Acknowledge a batch returned by `raft message claim` (token as argument or on stdin).",
    arguments: ["[token]"],
  },
  async (ctx, rawToken: string | undefined) => {
    const source = rawToken?.trim()
      ? rawToken
      : await readAll(ctx.io.stdin ?? process.stdin);
    const batch = decodeClaimAckToken(source);
    if (!batch) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Invalid Claim-Ack token.",
        suggestedNextAction: "Pass the token printed on the `Claim-Ack:` line of `raft message claim`.",
      });
    }
    if (isEmptyAckBatch(batch)) {
      writeText(ctx.io, adoptCliReplyText("Acked 0 inbox items."), NL);
      return;
    }
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.events.ack(batch);
    if (!res.ok || !res.data) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    writeText(ctx.io, adoptCliReplyText(`Acked ${res.data.removed_count} inbox item${res.data.removed_count === 1 ? "" : "s"}.`), NL);
  },
);

export function registerAckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageAckCommand, runtimeOptions);
}
