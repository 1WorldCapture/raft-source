import { randomUUID } from "node:crypto";
import type { InboxPriorityRecommendation } from "@botiverse/raft-shared";

export interface AttentionCheckObservation {
  scope: "target" | "all";
  target?: string;
  outcome: string;
  returnedCount?: number;
}

/** One ephemeral observation per live runtime. Never affects delivery or policy. */
export class AttentionObservation {
  private last: { id: string; target: string; sessionId: string | null; checked: boolean } | null = null;

  present(recommendation: InboxPriorityRecommendation | null, sessionId: string | null): Record<string, unknown> {
    if (!recommendation) return {};
    this.last = { id: randomUUID(), target: recommendation.target, sessionId, checked: false };
    return {
      "attention.recommendation_id": this.last.id,
      "attention.recommended_target": recommendation.target,
      "attention.priority": recommendation.kind,
    };
  }

  check(input: AttentionCheckObservation, sessionId: string | null): Record<string, unknown> {
    const last = this.last?.sessionId === sessionId ? this.last : null;
    const successful = input.outcome === "returned" || input.outcome === "empty";
    const first = Boolean(last && !last.checked && successful);
    if (first && last) last.checked = true;
    return {
      "attention.check_scope": input.scope,
      "attention.check_target": input.scope === "target" ? input.target : undefined,
      "attention.check_outcome": input.outcome,
      "attention.returned_count": input.returnedCount,
      "attention.recommendation_id": last?.id,
      "attention.recommended_target": last?.target,
      "attention.linked": Boolean(last),
      // Global check's multiple HTTP pages share one recommendation but only the
      // first successful request counts as a first check. No new persistent ID.
      "attention.first_check": first,
      "attention.followed_recommendation": first && input.scope === "target" && input.target === last?.target,
    };
  }
}
