/** First visible character of a server name for the rail tile, upper-cased (CJK/emoji kept whole). */
export function serverInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}
