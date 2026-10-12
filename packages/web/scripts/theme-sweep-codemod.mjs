#!/usr/bin/env node
// Elegant theme sweep codemod (upstream-port C1).
//
// Rewrites hard-coded Brutal utility classes to
//   <semantic Elegant class> theme-brutal:<original class>
// so Brutal renders EXACTLY the original class (the `theme-brutal:` variant
// wins) while every other theme paints from raft-ui's semantic tokens
// (text-foreground-*, bg-layer-*, border-line-*, ...). The mapping mirrors the
// choices upstream made in v1.21.2 (measured over its diffs), so an area that
// was swept by upstream by hand converges on the same tokens.
//
// Usage: node scripts/theme-sweep-codemod.mjs [--check] <file-or-dir>...
//   --check  print what would change and exit 1 if anything would (guard mode)
//
// Idempotent: a class already guarded by `theme-brutal:` is left alone, and a
// class that has no mapping is left alone.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEXT_BLACK = {
  "": "text-foreground-strong",
  80: "text-foreground-strong",
  75: "text-foreground-strong",
  70: "text-foreground-muted",
  65: "text-foreground-muted",
  60: "text-foreground-muted",
  55: "text-foreground-muted",
  50: "text-foreground-muted",
  45: "text-foreground-hint",
  40: "text-foreground-hint",
  35: "text-foreground-placeholder",
  30: "text-foreground-placeholder",
  25: "text-foreground-placeholder",
  20: "text-foreground-placeholder",
};

const BRUTAL_FILLS = {
  cream: "bg-layer-canvas-muted",
  pink: "bg-accent-soft",
  cyan: "bg-info-soft",
  blue: "bg-info-soft",
  orange: "bg-warning-soft",
  lime: "bg-success-soft",
  red: "bg-danger-soft",
  lavender: "bg-secondary-200",
  stone: "bg-fill-muted",
};

const SHADOWS = {
  "shadow-brutal-xs": "shadow-raft-xs",
  "shadow-brutal-sm": "shadow-raft-xs",
  "shadow-brutal": "shadow-raft-sm",
  "shadow-brutal-md": "shadow-raft-sm",
  "shadow-brutal-lg": "shadow-raft-md",
  "shadow-brutal-active": "shadow-none",
};

/** Elegant replacement for one variant-free class, or null when unmapped. */
export function elegantClass(cls) {
  let m;
  if ((m = /^text-black(?:\/(\d+))?$/.exec(cls))) return TEXT_BLACK[m[1] ?? ""] ?? null;
  if ((m = /^bg-white(?:\/(\d+))?$/.exec(cls))) return m[1] ? `bg-layer-panel/${m[1]}` : "bg-layer-panel";
  if ((m = /^border-black(?:\/(\d+))?$/.exec(cls))) {
    const n = m[1] ? Number(m[1]) : 100;
    return n >= 40 ? "border-line-strong" : "border-line-muted";
  }
  if ((m = /^(border)(-[tblrxy])?-2$/.exec(cls))) return `border${m[2] ?? ""}`;
  if ((m = /^bg-soft-signal(?:\/(\d+))?$/.exec(cls))) return m[1] ? `bg-primary-soft/${m[1]}` : "bg-primary-soft";
  if ((m = /^bg-brutal-([a-z]+)(?:\/(\d+))?$/.exec(cls))) {
    const base = BRUTAL_FILLS[m[1]];
    return base ? (m[2] ? `${base}/${m[2]}` : base) : null;
  }
  if ((m = /^bg-black(?:\/(\d+))?$/.exec(cls))) {
    if (!m[1]) return "bg-foreground-strong";
    return Number(m[1]) <= 10 ? "bg-fill-muted" : `bg-foreground/${m[1]}`;
  }
  if (cls in SHADOWS) return SHADOWS[cls];
  if (/^divide-black(?:\/\d+)?$/.test(cls)) return "divide-line-muted";
  if (/^ring-black(?:\/\d+)?$/.test(cls)) return "ring-line-strong";
  if (/^outline-black(?:\/\d+)?$/.test(cls)) return "outline-line-strong";
  if (/^placeholder:text-black(?:\/\d+)?$/.test(cls)) return null; // handled via variant split below
  return null;
}

const VARIANTS = String.raw`(?:[a-zA-Z0-9_\-\[\]=.()&>*~]+:)*`;
const BASE = String.raw`(?:text-black|bg-white|border-black|border(?:-[tblrxy])?-2|bg-soft-signal|bg-brutal-[a-z]+|bg-black|shadow-brutal(?:-[a-z]+)?|divide-black|ring-black|outline-black)(?:\/\d+)?`;
const TOKEN = new RegExp(String.raw`(?<=[\s"'\`{(])(${VARIANTS})(!?)(${BASE})(?=[\s"'\`)}$])`, "g");

// ---------------------------------------------------------------------------
// Responsive overrides.
//
// `theme-brutal:` is a registered variant, so a guarded base class such as
// `theme-brutal:border-b-2` is emitted AFTER (and therefore beats) an unguarded
// responsive override in the same string such as `md:border-b-0`. In the
// original class text the override won at its breakpoint, so Brutal would now
// show the border where it used to be removed. The fix keeps the Brutal view
// exactly the original token set and only restores the precedence: every
// unguarded responsive token whose property group clashes with a guarded class
// in the same string gets a guarded twin (`theme-brutal:md:border-b-0`), which
// stacks two variants and sorts after the single-variant guarded base.
const RESPONSIVE = /^(?:(?:max-)?(?:sm|md|lg|xl|2xl):)+/;

function groupsOf(utility) {
  const u = utility.replace(/^!/, "");
  let m;
  if ((m = /^border(?:-([tblrxy]))?(?:-(?:\d+))?$/.exec(u))) return [`bw:${m[1] ?? ""}`];
  if (/^border-(?:black|transparent|line-|brutal-|white)/.test(u)) return ["bc"];
  if (/^bg-(?!gradient|\[url|none$|clip|cover|center|no-repeat|repeat)/.test(u)) return ["bg"];
  if (/^shadow(?:-|$)/.test(u)) return ["sh"];
  if (/^text-(?:black|white|foreground|brutal|primary|muted)/.test(u)) return ["tc"];
  return [];
}

function sidesClash(a, b) {
  if (a === "" || b === "") return true;
  if (a === b) return true;
  return (a === "x" && (b === "l" || b === "r")) || (b === "x" && (a === "l" || a === "r"))
    || (a === "y" && (b === "t" || b === "b")) || (b === "y" && (a === "t" || a === "b"));
}

function clashes(g1, g2) {
  if (g1.startsWith("bw:") && g2.startsWith("bw:")) return sidesClash(g1.slice(3), g2.slice(3));
  return g1 === g2;
}

function guardResponsiveOverrides(line) {
  return line.replace(/(["'`])((?:(?!\1).)*)\1/g, (whole, quote, body) => {
    if (!body.includes("theme-brutal:")) return whole;
    const tokens = body.split(/(\s+)/);
    const guardedGroups = [];
    const guardedSet = new Set();
    for (const t of tokens) {
      if (!t.includes("theme-brutal:")) continue;
      guardedSet.add(t);
      const utility = t.split(":").pop();
      guardedGroups.push(...groupsOf(utility));
    }
    if (guardedGroups.length === 0) return whole;
    let changed = false;
    const next = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      next.push(t);
      if (!t || /^\s+$/.test(t) || t.includes("theme-brutal:")) continue;
      if (!RESPONSIVE.test(t)) continue;
      const utility = t.split(":").pop();
      const g = groupsOf(utility);
      if (g.length === 0 || !g.some((x) => guardedGroups.some((y) => clashes(x, y)))) continue;
      // The semantic half of a swept pair (`md:border-r theme-brutal:md:border-r-2`) is
      // directly followed by its guarded class: it is not an override.
      let j = i + 1;
      while (j < tokens.length && /^\s*$/.test(tokens[j])) j += 1;
      if (j < tokens.length && tokens[j].startsWith("theme-brutal:")
        && groupsOf(tokens[j].split(":").pop()).some((x) => g.some((y) => clashes(x, y)))
        && tokens[j].slice("theme-brutal:".length).startsWith(RESPONSIVE.exec(t)[0])) continue;
      const twin = `theme-brutal:${t}`;
      if (tokens.includes(twin)) continue;
      next.push(" ", twin);
      changed = true;
      guardedSet.add(twin);
    }
    return changed ? `${quote}${next.join("")}${quote}` : whole;
  });
}

export function transformSource(source) {
  let changes = 0;
  const lines = source.split("\n");
  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    // Prose: skip pure comment lines (JSX comment blocks keep their text).
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("{/*")) return line;
    // Identity strings must keep their exact text: an object KEY (`"bg-x": value`) is
    // looked up by the caller's original class, and `theme-sweep-ignore` opts a line out.
    if (/^\s*["'`][^"'`]*["'`]\s*:/.test(line) || line.includes("theme-sweep-ignore") || /\bconfirmColor\b/.test(line)) return line;
    const swept = line.replace(TOKEN, (whole, variants, bang, cls, offset, str) => {
      // Already guarded: `theme-brutal:` is the LAST variant before an original class.
      if (variants.includes("theme-brutal:")) return whole;
      const elegant = elegantClass(cls);
      if (!elegant) return whole;
      // `border-2` family only changes width: Elegant keeps 1px, Brutal keeps 2px.
      changes += 1;
      return `${variants}${bang}${elegant} theme-brutal:${variants}${bang}${cls}`;
    });
    const guarded = guardResponsiveOverrides(swept);
    if (guarded !== swept) changes += 1;
    return guarded;
  });
  return { text: out.join("\n"), changes };
}

function* walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* walk(join(path, name));
  } else if (/\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path)) {
    yield path;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const targets = args.filter((a) => !a.startsWith("--"));
  let total = 0;
  let files = 0;
  for (const target of targets) {
    for (const file of walk(target)) {
      const source = readFileSync(file, "utf8");
      const { text, changes } = transformSource(source);
      if (changes === 0) continue;
      total += changes;
      files += 1;
      if (!check) writeFileSync(file, text);
      else console.log(`${file}: ${changes}`);
    }
  }
  console.log(`${check ? "would change" : "changed"} ${total} classes in ${files} files`);
  if (check && total > 0) process.exit(1);
}
