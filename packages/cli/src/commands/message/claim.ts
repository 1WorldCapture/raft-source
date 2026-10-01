// `raft message claim` — fork patch (ZCode integration): non-blocking read of
// the agent inbox WITHOUT acknowledging it. The batch stays pending (and keeps
// producing wake hints) until `raft message ack` replays the trailing
// `Claim-Ack:` line. One request per invocation: claiming again before ack
// returns the same batch.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { formatMessages } from "./_format.js";
import { CLAIM_ACK_LINE_PREFIX, encodeClaimAckToken, isEmptyAckBatch } from "./_claimAck.js";

export const messageClaimCommand = defineCommand(
  {
    name: "claim",
    description: "Read the agent inbox without acknowledging it; prints a Claim-Ack line for `raft message ack`.",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.events.claim({ since: "latest" });
    if (!res.ok || !res.data) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    const messages = res.data.events ?? [];
    const status = res.data.has_more === true
      ? "\nMore messages are pending. Ack this batch, then run `raft message claim` again.\n"
      : messages.length > 0
        ? "\nNo more new inbox messages.\n"
        : "\n";
    const ackLine = isEmptyAckBatch(res.data.ack)
      ? ""
      : `${CLAIM_ACK_LINE_PREFIX}${encodeClaimAckToken(res.data.ack)}\n`;
    writeText(ctx.io, adoptCliReplyText(`${formatMessages(messages)}${status}${ackLine}`));
  },
);

export function registerClaimCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageClaimCommand, runtimeOptions);
}
