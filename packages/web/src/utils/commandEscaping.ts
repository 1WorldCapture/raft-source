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
