// Agent-facing text helper shared by the CLI renderer and the daemon (wake briefing panel).
// Extracted from upstream's agentMessageText.ts so only this hardening primitive is ported:
// a message body must not be able to start a line that looks like a message header.

/**
 * Prefix every continuation line of a quoted body with `  │ `, so body text
 * never reaches column 0. Structural lines (`[target=…]` / `[1/5 seq=…]` headers,
 * read cursors, footers) always start at column 0, so a line-anchored reader
 * (`grep '^\['`) cannot be handed a forged one by message content. The `│` is
 * non-whitespace on purpose: a reader that trims each line still sees it. It is
 * the same quote marker as the freshness-hold digest previews. Remove the first
 * four characters after each line separator to recover the original body.
 */
export const AGENT_BODY_CONTINUATION_PREFIX = "  │ ";
// Every separator a universal-newline reader (Python `str.splitlines()`, etc.)
// breaks on, not just `\n`: a body could otherwise start an unprefixed line
// with a lone `\r`, NEL or U+2028. `\r\n` is matched first as one separator.
// Exported without the `g` flag so callers' `.test()` / `.exec()` carry no
// `lastIndex` state; global uses build their own from `.source`.
export const AGENT_BODY_LINE_SEPARATOR = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const AGENT_BODY_LINE_SEPARATOR_GLOBAL = new RegExp(AGENT_BODY_LINE_SEPARATOR.source, "g");
export function indentAgentBodyContinuationLines(text: string): string {
  // The separator itself is kept, so removing the prefix restores the exact body.
  return text.replace(AGENT_BODY_LINE_SEPARATOR_GLOBAL, (separator) => `${separator}${AGENT_BODY_CONTINUATION_PREFIX}`);
}

