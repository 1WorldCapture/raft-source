// `app.relaunch()` re-runs the app with the original argv, but a Chromium switch such as `--user-data-dir` is not
// reliably carried over (Anna's "connect current deployment" test: the relaunched instance opened the default userData).
// Pin the effective userData path on the new command line so the new instance is the same instance.
export interface RelaunchApp {
  getPath(name: "userData"): string;
  relaunch(options?: { args: string[] }): void;
}

export function relaunchPreservingUserData(app: RelaunchApp, argv: readonly string[] = process.argv): void {
  const args = argv.slice(1).filter((arg) => !/^--user-data-dir(=|$)/.test(arg));
  // A bare `--user-data-dir <path>` leaves its value behind as a stray positional argument: drop it too.
  const original = argv.slice(1);
  const bare = original.findIndex((arg) => arg === "--user-data-dir");
  if (bare >= 0 && bare + 1 < original.length) {
    const value = original[bare + 1];
    const at = args.indexOf(value);
    if (at >= 0) args.splice(at, 1);
  }
  app.relaunch({ args: [...args, `--user-data-dir=${app.getPath("userData")}`] });
}
