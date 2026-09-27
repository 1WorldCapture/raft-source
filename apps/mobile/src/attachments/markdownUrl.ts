/** Markdown viewer link/image gate: only absolute http(s) targets are
 *  followed or loaded; every other scheme (relative paths, data:, javascript:,
 *  mailto:, protocol-relative) is ignored and shown as inert text. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
