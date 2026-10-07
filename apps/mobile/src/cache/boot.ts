// Boot fast-path helpers — moved to packages/shared (desktop-data-cache
// task #6). The shared versions take the message parser as an injected
// parameter and are generic over the app's model types; these thin wrappers
// pin them to the mobile model so every existing call site is unchanged.
import { parseMessage, type RaftChannel, type RaftMessage } from "../model/messages";
import type { CachedMessage } from "./repo";
import {
  hydrateCachedMessages as hydrateGeneric,
  seedConversations as seedGeneric,
} from "@botiverse/raft-shared/src/cacheBoot.ts";

export {
  drainAfterPages,
  latestCoverageThrough,
  messageFetchPlan,
  rawPageForCache,
} from "@botiverse/raft-shared/src/cacheBoot.ts";

export function seedConversations(rows: Array<{ id: string; type: string; raw: unknown }>): RaftChannel[] {
  return seedGeneric<RaftChannel>(rows);
}

export function hydrateCachedMessages(rows: readonly CachedMessage[]): RaftMessage[] {
  return hydrateGeneric<RaftMessage>(rows, parseMessage);
}
