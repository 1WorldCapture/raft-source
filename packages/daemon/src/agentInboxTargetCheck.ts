import {
  daemonApiInboxTargetCheckResponseSchema,
  TARGET_CHECK_DEFAULT_LIMIT,
  TARGET_CHECK_MAX_RESPONSE_BYTES,
  type DaemonApiRequestBodyByRoute,
  type DaemonApiResponseByRoute,
} from "@botiverse/raft-shared";
import type { AgentProxyVisibleMessage } from "./agentCredentialProxy.js";
import { formatInboxMessageTarget, isTargetCheckMessage } from "./agentInboxProjection.js";
import { normalizeInboxVisibleMessages } from "./agentInboxStateMachine.js";

export class TargetCheckError extends Error {
  constructor(
    readonly code: "TARGET_AMBIGUOUS" | "TARGET_METADATA_UNAVAILABLE" | "MESSAGE_TOO_LARGE" | "TARGET_CHECK_INVALID_RESPONSE",
    message: string,
    readonly status = 409,
    readonly messageId?: string,
  ) { super(message); this.name = "TargetCheckError"; }
}

export interface TargetCheckPlan {
  response: DaemonApiResponseByRoute["inboxTargetCheck"];
  serialized: string;
  /** Original metadata is preserved for the existing visible ledger's target key. */
  consumedMessages: AgentProxyVisibleMessage[];
}

function stableId(message: AgentProxyVisibleMessage): string {
  return message.message_id || message.id || "";
}
function seq(message: AgentProxyVisibleMessage): number {
  return Number.isSafeInteger(message.seq) && message.seq! > 0 ? message.seq! : Number.MAX_SAFE_INTEGER;
}

/**
 * Pure preparation over ONE registration's snapshot. Never fetches upstream or
 * mutates pending. All failure paths finish before the caller consumes any ID.
 */
export function prepareTargetCheck(
  pending: readonly AgentProxyVisibleMessage[],
  input: DaemonApiRequestBodyByRoute["inboxTargetCheck"],
  maxResponseBytes = TARGET_CHECK_MAX_RESPONSE_BYTES,
): TargetCheckPlan {
  const matches = pending.filter((message) => formatInboxMessageTarget(message) === input.target
    && !message.third_party_event
    && !stableId(message).startsWith("runtime-profile-migration-")
    && !stableId(message).startsWith("runtime-profile-daemon-release-"));
  if (matches.some((message) => !isTargetCheckMessage(message))) {
    throw new TargetCheckError("TARGET_METADATA_UNAVAILABLE", "This local target has incomplete message identity metadata; no messages were consumed.");
  }
  if (new Set(matches.map((message) => message.channel_id)).size > 1) {
    throw new TargetCheckError("TARGET_AMBIGUOUS", "This displayed target matches multiple local conversations; no messages were consumed. Use message read/resolve with an unambiguous reference.");
  }
  const unique = new Map<string, AgentProxyVisibleMessage>();
  for (const message of matches) {
    const id = stableId(message);
    const previous = unique.get(id);
    // Conflicting copies must not silently consume a different revision/body.
    if (previous && (previous.channel_id !== message.channel_id || previous.content !== message.content)) {
      throw new TargetCheckError("TARGET_METADATA_UNAVAILABLE", "Conflicting local copies of a message; no messages were consumed.");
    }
    if (!previous) unique.set(id, message);
  }
  const candidates = [...unique.values()].sort((a, b) => seq(a) - seq(b)
    || (stableId(a) < stableId(b) ? -1 : stableId(a) > stableId(b) ? 1 : 0));
  const makeResponse = (page: AgentProxyVisibleMessage[]): DaemonApiResponseByRoute["inboxTargetCheck"] => {
    const parsed = daemonApiInboxTargetCheckResponseSchema.safeParse({
      scope: "daemon_pending_target",
      target: input.target,
      messages: normalizeInboxVisibleMessages(page),
      returned_count: page.length,
      remaining_count: candidates.length - page.length,
      has_more: candidates.length > page.length,
    });
    if (!parsed.success) {
      throw new TargetCheckError("TARGET_CHECK_INVALID_RESPONSE", "Local message metadata could not be encoded safely; no messages were consumed.", 500);
    }
    return parsed.data;
  };
  const selected: AgentProxyVisibleMessage[] = [];
  let response = makeResponse(selected);
  let serialized = JSON.stringify(response);
  for (const message of candidates.slice(0, input.limit ?? TARGET_CHECK_DEFAULT_LIMIT)) {
    const next = [...selected, message];
    const nextResponse = makeResponse(next);
    const nextSerialized = JSON.stringify(nextResponse);
    // Count the entire serialized JSON, including UTF-8, escaping and attachments.
    if (Buffer.byteLength(nextSerialized, "utf8") > maxResponseBytes) {
      if (selected.length === 0) {
        throw new TargetCheckError("MESSAGE_TOO_LARGE", "The first pending message exceeds the response budget. Use message read/resolve for its full content; no messages were consumed.", 413, stableId(message));
      }
      break;
    }
    selected.push(message);
    response = nextResponse;
    serialized = nextSerialized;
  }
  return { response, serialized, consumedMessages: selected };
}
