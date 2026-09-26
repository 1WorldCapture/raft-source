import type { MessageMention } from "./messages";

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; id?: string; type?: string; self: boolean }
  | { kind: "channel"; text: string }
  | { kind: "thread"; text: string }
  | { kind: "task"; text: string };

const REF = /(^|[\s])((?:task #\d+)|(?:#[\p{L}\p{N}_-]+:[A-Za-z0-9]+)|(?:#[\p{L}\p{N}_-]+))/giu;

/** Split plain text into mention chips and #channel / thread / task chips. */
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
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(REF)) {
    const start = match.index ?? 0;
    const lead = match[1] ?? "";
    const chip = match[2] ?? "";
    const chipStart = start + lead.length;
    if (chipStart > cursor) tokens.push({ kind: "text", text: text.slice(cursor, chipStart) });
    if (/^task #\d+$/i.test(chip)) tokens.push({ kind: "task", text: chip });
    else if (chip.includes(":")) tokens.push({ kind: "thread", text: chip });
    else tokens.push({ kind: "channel", text: chip });
    cursor = chipStart + chip.length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens.filter((token) => token.text.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
