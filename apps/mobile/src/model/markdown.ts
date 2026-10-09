export type MarkdownPiece =
  | { type: "text"; text: string }
  | { type: "bold"; text: string; children: MarkdownPiece[] }
  | { type: "code"; text: string }
  | { type: "codeBlock"; text: string }
  | { type: "link"; text: string; url: string }
  | { type: "list"; text: string; marker: string; indent: number }
  | { type: "heading"; level: number; text: string }
  | { type: "quote"; text: string };

// Bold: `**` + non-space ... non-space + `**`; the text may contain single `*`,
// code spans and links (rendered by recursing into `children`).
const INLINE = /(\*\*(\S(?:.*?\S)?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s]+))/g;

/** Small subset: fenced code, lists, bold, inline code, and links. */
export function markdownPieces(content: string): MarkdownPiece[] {
  const pieces: MarkdownPiece[] = [];
  const blocks = content.split(/```/);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      const newline = block.indexOf("\n");
      const code = newline === -1 ? block : block.slice(newline + 1);
      pieces.push({ type: "codeBlock", text: code.replace(/\n$/, "") });
      return;
    }
    for (const line of block.split("\n")) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        pieces.push({ type: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
        continue;
      }
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        pieces.push({ type: "quote", text: quote[1] ?? "" });
        continue;
      }
      const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (list) {
        const marker = /^\d/.test(list[2] ?? "") ? (list[2] ?? "") : "•";
        const spaces = (list[1] ?? "").replace(/\t/g, "    ").length;
        pieces.push({ type: "list", text: list[3] ?? "", marker, indent: Math.min(4, Math.floor(spaces / 2)) });
        continue;
      }
      pieces.push(...inlinePieces(line));
      pieces.push({ type: "text", text: "\n" });
    }
  });
  while (pieces.length > 0 && pieces[pieces.length - 1]?.type === "text" && pieces[pieces.length - 1]?.text === "\n") {
    pieces.pop();
  }
  return pieces.filter((piece) => piece.text.length > 0 || piece.type !== "text");
}

/** Inline pieces of one line of text (also used for list, heading and quote bodies). */
export function inlinePieces(line: string): MarkdownPiece[] {
  const pieces: MarkdownPiece[] = [];
  let cursor = 0;
  for (const match of line.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push({ type: "text", text: line.slice(cursor, start) });
    if (match[2]) pieces.push({ type: "bold", text: match[2], children: inlinePieces(match[2]) });
    else if (match[3]) pieces.push({ type: "code", text: match[3] });
    else if (match[4] && match[5]) pieces.push({ type: "link", text: match[4], url: match[5] });
    else if (match[6]) pieces.push({ type: "link", text: match[6], url: match[6] });
    cursor = start + match[0].length;
  }
  if (cursor < line.length) pieces.push({ type: "text", text: line.slice(cursor) });
  return pieces;
}
