import type { AgentInboxTargetRow } from "./agentInbox.js";

export const INBOX_PRIORITY_KINDS = [
  "human_dm", "human_mention", "agent_dm", "agent_mention", "ordinary",
] as const;
export type InboxPriorityKind = (typeof INBOX_PRIORITY_KINDS)[number];

export interface InboxPriorityMessageFacts {
  sender_type?: string;
  senderType?: string;
  channel_type?: string;
  parent_channel_type?: string;
  mentioned?: boolean;
  non_member_mention?: boolean;
}

export interface InboxPriorityRecommendation {
  target: string;
  kind: InboxPriorityKind;
}

export function isInboxPriorityKind(value: unknown): value is InboxPriorityKind {
  return typeof value === "string" && (INBOX_PRIORITY_KINDS as readonly string[]).includes(value);
}

/** Sender and directedness must come from the SAME message, never latestSenderType. */
export function classifyInboxMessage(message: InboxPriorityMessageFacts): InboxPriorityKind {
  const sender = message.sender_type ?? message.senderType;
  // Conflicting aliases are not evidence of human authority.
  if (message.sender_type && message.senderType && message.sender_type !== message.senderType) return "ordinary";
  if (sender !== "human" && sender !== "agent") return "ordinary";
  const dm = message.channel_type === "dm"
    || (message.channel_type === "thread" && message.parent_channel_type === "dm");
  if (dm) return sender === "human" ? "human_dm" : "agent_dm";
  if (message.mentioned === true || message.non_member_mention === true) {
    return sender === "human" ? "human_mention" : "agent_mention";
  }
  return "ordinary";
}

export function aggregateInboxPriority(messages: readonly InboxPriorityMessageFacts[]): InboxPriorityKind {
  let rank = INBOX_PRIORITY_KINDS.length - 1;
  for (const message of messages) rank = Math.min(rank, INBOX_PRIORITY_KINDS.indexOf(classifyInboxMessage(message)));
  return INBOX_PRIORITY_KINDS[rank]!;
}

function rowRank(row: AgentInboxTargetRow): number {
  if (row.pendingCount <= 0) return 6;
  if (isInboxPriorityKind(row.attentionPriority)) return INBOX_PRIORITY_KINDS.indexOf(row.attentionPriority);
  if (row.attentionPriority !== undefined) return 4; // Unknown future values never gain human priority.
  // Legacy producers have no per-message aggregation. Preserve coarse DM/@ ordering,
  // but never infer human priority from the last sender of a mixed conversation.
  if (row.target.startsWith("dm:@") || row.flags.includes("dm")) return 2;
  if (row.flags.includes("mention") || row.flags.includes("non_member_mention")) return 3;
  return 4;
}

function firstSeq(row: AgentInboxTargetRow): number {
  return Number.isSafeInteger(row.firstPendingSeq) && row.firstPendingSeq! > 0
    ? row.firstPendingSeq! : Number.MAX_SAFE_INTEGER;
}

/**
 * messages.seq uses one messages-table bigserial sequence (schema.ts and
 * prepareSystemMessageForOrderedDelivery), not a per-channel counter. Within
 * one registered Server's Inbox it is a deterministic cross-target ordering.
 * Gaps/reservations are legal: this is NOT commit time or a read/ACK watermark.
 */
export function rankInboxTargets(rows: readonly AgentInboxTargetRow[]): AgentInboxTargetRow[] {
  return [...rows].sort((a, b) => rowRank(a) - rowRank(b)
    || firstSeq(a) - firstSeq(b)
    || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

export function recommendInboxTarget(
  rankedRows: readonly AgentInboxTargetRow[],
  eligibleTargets: ReadonlySet<string>,
): InboxPriorityRecommendation | null {
  const row = rankedRows.find((candidate) => candidate.pendingCount > 0
    && eligibleTargets.has(candidate.target) && isInboxPriorityKind(candidate.attentionPriority));
  return row ? { target: row.target, kind: row.attentionPriority as InboxPriorityKind } : null;
}

const LABELS: Record<InboxPriorityKind, string> = {
  human_dm: "human direct message",
  human_mention: "human direct mention",
  agent_dm: "agent direct message",
  agent_mention: "agent direct mention",
  ordinary: "ordinary conversation activity",
};

/** No caller-provided prose or shell interpolation in the recommendation. */
export function formatInboxPriorityRecommendation(
  recommendation: InboxPriorityRecommendation | null,
  scope: "updates" | "snapshot",
): string {
  if (!recommendation) return "";
  const target = recommendation.target;
  // Normal displayed refs fit this grammar; unusual names remain readable via
  // the normal CLI, but we must not generate an executable injection in help.
  const command = /^[^\s'"`$\\\x00-\x1f\x7f]+$/u.test(target)
    ? `\nPrefer reading one conversation at a time: raft message check --target '${target}'`
    : "\nPrefer raft message check --target with the exact target above (quote it for your shell).";
  return `Suggested first ${scope === "updates" ? "among these updates" : "in this inbox snapshot"}: ${JSON.stringify(target)} (${LABELS[recommendation.kind]}).${command}\nIf this conversation is unrelated to your current task, finish your current step before switching. This is a recommendation, not an instruction to interrupt immediately.`;
}
