// Bootstrap-armor for `migrate-home` (drill 290-anna-②b run-B finding):
// killed the spawning app ~2ms after spawn and the CLI died silently —
// before #286's sink installs, an early stdout write against the dead pipe
// surfaces as a stream 'error' with no listener attached yet (and SIGHUP /
// SIGPIPE take their default dispositions too), so the process dies with
// no marker and no result file. This module must be the FIRST import of
// cli.ts: it installs the swallow-handlers during module evaluation, while
// the rest of the import graph is still loading. Gated on argv so every
// other command keeps its default signal behavior.
if (process.argv.some((arg) => arg === "migrate-home")) {
  process.on("SIGPIPE", () => {});
  process.on("SIGHUP", () => {});
  process.stdout?.on?.("error", () => {});
  process.stderr?.on?.("error", () => {});
}
