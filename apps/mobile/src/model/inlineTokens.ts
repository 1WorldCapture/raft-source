import { extractRaftRefTargets } from "@botiverse/raft-shared/src/raftRefs.ts";
import type { MessageMention } from "./messages";

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; id?: string; type?: string; self: boolean }
  | { kind: "channel"; text: string }
  | { kind: "thread"; text: string }
  | { kind: "task"; text: string };

/** Split plain text into mention chips and raft ref chips. Ref grammar comes from `raftRefs`. */
export function inlineTokens(
  text: string,
  mentions: MessageMention[] | undefined,
  currentUserId: string | undefined,
): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = mentionPattern(mentions);
  if (!pattern) return refTokens(text);
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push(...refTokens(text.slice(cursor, start)));
    const name = match[1] ?? "";
    const mention = mentions?.find((item) => item.name === name);
    tokens.push({
      kind: "mention",
      text: `@${name}`,
      id: mention?.id,
      type: mention?.type,
      self: Boolean(currentUserId && mention?.id === currentUserId),
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) tokens.push(...refTokens(text.slice(cursor)));
  return tokens;
}

function mentionPattern(mentions: MessageMention[] | undefined): RegExp | null {
  const names = (mentions ?? [])
    .map((mention) => mention.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  return new RegExp(`@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`, "gu");
}

function refTokens(text: string): InlineToken[] {
  const refs = extractRaftRefTargets(text, { dedupe: false }).filter((ref) => ref.target.kind !== "user");
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start < cursor) continue;
    if (ref.start > cursor) tokens.push({ kind: "text", text: text.slice(cursor, ref.start) });
    const kind = ref.target.kind === "task"
      ? "task"
      : ref.target.kind === "channel-thread" || ref.target.kind === "dm-thread" || ref.target.kind === "message" || ref.target.kind === "dm-message"
        ? "thread"
        : "channel";
    tokens.push({ kind, text: text.slice(ref.start, ref.end) });
    cursor = ref.end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens.filter((token) => token.text.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
