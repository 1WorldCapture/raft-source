// Command-argument escaping for the onboarding command builders.
//
// Contract v1 (私有部署配置契约 v1, "命令与本机发布源"): every dynamic value
// (slug, URL, machine id, version, release base) must be escaped for the
// TARGET command interpreter. Plain string concatenation or JSON.stringify
// does not count as escaping. These helpers produce single-quoted literals
// for POSIX shells and for PowerShell respectively.

/**
 * Quote a value for POSIX sh/bash/zsh. Wraps the value in single quotes and
 * splices embedded single quotes as `'\''`, which is the portable way to
 * represent a literal quote inside a single-quoted string. Inside single
 * quotes no other character is special, so this is total over arbitrary input.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quote a value for PowerShell. Single-quoted PowerShell strings are literal;
 * the only character needing escape is the single quote itself, doubled (`''`).
 * Subexpression and format operators ($(), --%, backtick) lose their meaning
 * inside single quotes, so this is total over arbitrary input.
 */
export function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Escape one path SEGMENT for interpolation inside a POSIX double-quoted
 * string. Inside double quotes the shell expands `$` and backticks, so both
 * are backslash-escaped here along with `"` and `\`. Used when a value must
 * keep an intentional variable reference (e.g. a literal `$HOME` prefix) while
 * user-influenced data stays inert.
 */
export function shellDoubleQuoteSegment(segment: string): string {
  return segment.replace(/([\\`"$])/g, "\\$1");
}

/**
 * Escape one path SEGMENT for interpolation inside a PowerShell double-quoted
 * string. PowerShell's escape character is the backtick; `$`, `"` and the
 * backtick itself must be escaped so only the intended variable reference
 * (e.g. `$env:USERPROFILE`) expands.
 */
export function powerShellDoubleQuoteSegment(segment: string): string {
  return segment.replace(/([`"$])/g, "`$1");
}
