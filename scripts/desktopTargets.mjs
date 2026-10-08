// Which macOS desktop artifacts a private release builds and publishes.
//
// Policy (owner, 2026-10-08): desktop ships for macOS arm64 only. Transition:
// the default stays dmg+zip because already-installed apps <= 0.1.6 only
// prompt for an update when latest-mac.yml carries their arch's dmg. Once
// those are upgraded, switch the default to zip only (change DEFAULT_FORMATS).
//
// `arm64` builds only the arm64 cursor-sdk assets and passes
// `--mac <formats> --arm64` to electron-builder (CLI flags override the
// per-arch target lists in electron-builder.yml, which the official signed
// release flow still uses unchanged). `all` is the legacy dual-arch dmg+zip
// build (`dist:mac`).

export const DESKTOP_ARCH_CHOICES = ["arm64", "all"];
const FORMAT_ORDER = ["dmg", "zip"];

export const DEFAULT_FORMATS = "zip,dmg";

export function resolveDesktopTargets({ arch = "arm64", formats = DEFAULT_FORMATS } = {}) {
  if (!DESKTOP_ARCH_CHOICES.includes(arch)) {
    throw new Error(`--desktop-arch must be one of: ${DESKTOP_ARCH_CHOICES.join(", ")} (got: ${arch})`);
  }
  const requested = String(formats).split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = requested.filter((f) => !FORMAT_ORDER.includes(f));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`--desktop-formats must be a comma list of: ${FORMAT_ORDER.join(", ")} (got: ${formats})`);
  }
  const list = FORMAT_ORDER.filter((f) => requested.includes(f));
  if (arch === "all") {
    if (list.length !== FORMAT_ORDER.length) {
      throw new Error("--desktop-arch all builds the legacy dmg+zip set for both architectures; use --desktop-formats dmg,zip with it");
    }
    return { arch, arches: ["arm64", "x64"], formats: list, script: "dist:mac", builderArgs: [] };
  }
  return { arch, arches: ["arm64"], formats: list, script: "dist:mac:arm64", builderArgs: ["--mac", ...list, "--arm64"] };
}
