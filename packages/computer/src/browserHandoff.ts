import { spawn } from "node:child_process";

type TtyReadable = NodeJS.ReadableStream & {
  isTTY?: boolean;
  pause?: () => unknown;
  resume?: () => unknown;
};

export function canInstallEnterToOpenUrl(input: NodeJS.ReadableStream | undefined): boolean {
  const tty = input as TtyReadable | undefined;
  return Boolean(tty?.isTTY === true && typeof tty.on === "function" && typeof tty.off === "function");
}

export function openUrlInBrowser(url: string): void {
  // NOTE: real-side-effect prevention for the test suite lives in
  // src/test/sideEffectGuard.mjs (PR #135): it intercepts at the actual
  // network/browser/subprocess boundaries and records the denial, so a
  // forgotten openUrl stub fails CI with the named case. An earlier
  // function-level throw here shadowed those boundary events and broke the
  // guard's own regressions, so this function stays side-effect-faithful.
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // Best-effort convenience only. The URL is already printed for manual copy.
  });
  child.unref();
}

export function installEnterToOpenUrl(options: {
  input: NodeJS.ReadableStream | undefined;
  url: string;
  openUrl?: (url: string) => void;
}): () => void {
  if (!canInstallEnterToOpenUrl(options.input)) return () => {};

  const input = options.input as TtyReadable;
  const openUrl = options.openUrl ?? openUrlInBrowser;
  let active = true;

  const cleanup = () => {
    if (!active) return;
    active = false;
    input.off("data", onData);
    input.pause?.();
  };

  const onData = (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!text.includes("\n") && !text.includes("\r")) return;
    cleanup();
    openUrl(options.url);
  };

  input.on("data", onData);
  input.resume?.();
  return cleanup;
}
