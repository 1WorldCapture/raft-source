/**
 * The Brutal-class view of a source file or rendered markup.
 *
 * The Elegant sweep writes a hard-coded Brutal class as
 * `<semantic class> theme-brutal:<brutal class>` (see scripts/theme-sweep-codemod.mjs).
 * Contract tests that pin the BRUTAL recipe (`border-2 border-black bg-white ...`)
 * keep their intent by reading this view: the semantic half is dropped and the
 * `theme-brutal:` prefix removed, which gives back exactly the pre-sweep class text.
 */
export function brutalView(text: string): string {
  return text.replace(/(?<=^|[\s"'`{(])[^\s"'`]+ theme-brutal:(?=[^\s"'`])/g, "");
}
