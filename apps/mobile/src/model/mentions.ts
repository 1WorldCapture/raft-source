import { createRaftStructuredUserRefRegex } from "@botiverse/raft-shared/src/raftRefs.ts";
import type { MessageMention } from "./messages";

export interface MentionSegment {
  text: string;
  mention: boolean;
}

/**
 * Highlight `@name` only when the structured mention list contains that name
 * and the handle is not followed by a letter, number, underscore, or hyphen.
 * The boundary comes from `@botiverse/raft-shared`.
 */
export function mentionSegments(content: string, mentions: MessageMention[] | undefined): MentionSegment[] {
  const names = (mentions ?? [])
    .map((mention) => mention.name?.replace(/^@/, ""))
    .filter((name): name is string => Boolean(name));
  if (names.length === 0 || !content.includes("@")) return [{ text: content, mention: false }];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const name of names) {
    const pattern = createRaftStructuredUserRefRegex(name);
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return [{ text: content, mention: false }];

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: content.slice(cursor, range.start), mention: false });
    segments.push({ text: content.slice(range.start, range.end), mention: true });
    cursor = range.end;
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor), mention: false });
  return segments;
}

export function mentionsCurrentUser(mentions: MessageMention[] | undefined, userId: string | undefined): boolean {
  if (!userId) return false;
  return (mentions ?? []).some((mention) => mention.id === userId);
}
