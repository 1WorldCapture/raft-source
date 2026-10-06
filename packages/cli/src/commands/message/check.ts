// `raft message check` — non-blocking drain of /internal/agent-api/events.
//
// Non-blocking is a hard requirement (kuku redline): the CLI must return
// promptly with whatever is in the inbox, never hold the request open.
//
// Agent API /events consumes/acks returned messages server-side; the CLI does
// not perform a separate acknowledgement request.

import type { Command } from "commander";
import { daemonApiInboxTargetCheckBodySchema } from "@botiverse/raft-shared";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath.js";
import { CliError, type CliErrorCode } from "../../core/errors.js";
import { apiFailureError } from "../_apiFailure.js";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { drainInbox } from "./_inbox.js";
import { formatMessages } from "./_format.js";

export const messageCheckCommand = defineCommand(
  {
    name: "check",
    description: "Drain the agent inbox (non-blocking). Without --target, retains the global drain. --target consumes one bounded page of this managed daemon's local pending conversation; not server history.",
    options: [
      { flags: "--target <target>", description: "Displayed #channel, #channel:shortid, dm:@peer or dm:@peer:shortid. Managed runners only; never falls back to a full-inbox read." },
      { flags: "--limit <n>", description: "With --target only: 1–200 messages, default 50; serialized byte budget may return fewer. Repeat explicitly for another page." },
    ],
  },
  async (ctx, opts: { target?: string; limit?: string } = {}) => {
    if (opts.target === undefined && opts.limit !== undefined) {
      throw new CliError({ code: "INVALID_ARG", message: "--limit requires --target. The full-inbox command is unchanged." });
    }
    if (opts.target !== undefined) {
      const input = daemonApiInboxTargetCheckBodySchema.safeParse({
        target: opts.target,
        ...(opts.limit !== undefined ? { limit: /^\d+$/.test(opts.limit) ? Number(opts.limit) : Number.NaN } : {}),
      });
      if (!input.success) {
        throw new CliError({ code: "INVALID_ARG", message: "Use a displayed conversation target and an integer --limit from 1 to 200." });
      }
      const agentContext = ctx.loadAgentContext();
      if (agentContext.clientMode !== "managed-runner") {
        throw new CliError({
          code: "TARGET_CHECK_UNSUPPORTED",
          message: "Target-scoped pending check requires a managed daemon runner.",
          suggestedNextAction: "Use message read --target for history, or explicitly choose the existing full message check. No global read was performed.",
        });
      }
      const response = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).inbox.checkTarget(input.data);
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) {
          throw new CliError({ code: "TARGET_CHECK_UNSUPPORTED", message: "This daemon does not support target-scoped pending check.", suggestedNextAction: "Upgrade the managed Desktop/Daemon and bundled CLI together, or use message read --target. No global read was performed." });
        }
        const localCodes: readonly CliErrorCode[] = ["TARGET_CHECK_UNAVAILABLE", "TARGET_AMBIGUOUS", "TARGET_METADATA_UNAVAILABLE", "MESSAGE_TOO_LARGE", "INVALID_ARG"];
        const code = localCodes.find((candidate) => candidate === response.errorCode);
        if (code) throw new CliError({ code, message: response.error ?? code, suggestedNextAction: response.suggestedNextAction ?? "Use message read/resolve for wider context. This command never retries as a global read." });
        throw apiFailureError(response, "CHECK_FAILED");
      }
      if (!response.data || response.data.target !== input.data.target) {
        throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Target check returned no data or a different target." });
      }
      const page = response.data;
      const text = page.returned_count === 0
        ? `No pending messages for ${JSON.stringify(page.target)} in the current daemon inbox. This is not a statement about server history.\n`
        : `Pending messages for ${JSON.stringify(page.target)} (current daemon inbox)\n${formatMessages(page.messages)}\n${page.returned_count} returned; ${page.remaining_count} more pending for this target in this snapshot.\n${page.has_more ? "Use the same target check for another page when needed.\n" : ""}`;
      writeText(ctx.io, adoptCliReplyText(text));
      // Sparse target pages prove only these IDs, never a read-through high-water.
      return;
    }
    const agentContext = ctx.loadAgentContext();
    const result = await drainInbox(
      agentContext,
      { block: false },
      ctx.createApiClient(agentContext),
    );
    const drainStatus = result.hasMore
      ? "\nMore messages are pending. Run `raft message check` again.\n"
      : result.drainComplete
        ? "\nNo more new inbox messages.\n"
        : "\n";
    writeText(ctx.io, adoptCliReplyText(`${formatMessages(result.messages)}${drainStatus}`));
    // `/events` batches are sparse attention drains, not contiguous history
    // slices. Printing a high-seq @mention here must not seed `seenUpToSeq`,
    // or older unseen messages in the same target can be buried as model-seen.
  },
);

export function registerCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageCheckCommand, runtimeOptions);
}
