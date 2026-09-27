/** Lines kept in one virtualized row. A 96KB preview stays a short list, not one Text. */
export const TEXT_PREVIEW_LINES_PER_CHUNK = 40;

/** Characters kept in one virtualized row. Caps pathological one-line files (minified JSON). */
export const TEXT_PREVIEW_CHARS_PER_CHUNK = 2000;

/**
 * Split preview text into FlatList rows. Blank lines stay blank. An empty file
 * yields no rows. Oversized lines are hard-split on a surrogate-pair-safe boundary
 * so a single Text never holds the whole payload.
 */
export function chunkTextLines(text: string, linesPerChunk = TEXT_PREVIEW_LINES_PER_CHUNK): string[] {
  if (text.length === 0) return [];
  const size = linesPerChunk > 0 ? linesPerChunk : TEXT_PREVIEW_LINES_PER_CHUNK;
  const pieces: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length <= TEXT_PREVIEW_CHARS_PER_CHUNK) {
      pieces.push(line);
      continue;
    }
    for (const piece of splitLongLine(line)) {
      pieces.push(piece);
    }
  }
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const piece of pieces) {
    if (current.length >= size || (current.length > 0 && currentLength + 1 + piece.length > TEXT_PREVIEW_CHARS_PER_CHUNK)) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }
    current.push(piece);
    currentLength += current.length > 1 ? 1 + piece.length : piece.length;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/** Cut one long line into fixed-size slices, never between a surrogate pair. */
function splitLongLine(line: string): string[] {
  const slices: string[] = [];
  let start = 0;
  while (start < line.length) {
    let end = start + TEXT_PREVIEW_CHARS_PER_CHUNK;
    if (end >= line.length) {
      slices.push(line.slice(start));
      break;
    }
    const before = line.charCodeAt(end - 1);
    const after = line.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      end -= 1;
    }
    slices.push(line.slice(start, end));
    start = end;
  }
  return slices;
}
