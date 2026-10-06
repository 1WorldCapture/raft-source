#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  DAEMON_CLI_USAGE,
  DaemonCore,
  parseDaemonCliArgs
} from "./chunk-X7C72HV7.js";
import "./chunk-IIMEICBM.js";
import "./chunk-YSEOPJ4H.js";
import "./chunk-LGQIX76U.js";
import "./chunk-4UYAMUT4.js";
import "./chunk-CB5SUWAA.js";

// src/index.ts
var parsedArgs = parseDaemonCliArgs(process.argv.slice(2));
if (!parsedArgs) {
  console.error(DAEMON_CLI_USAGE);
  process.exit(1);
}
var daemon = new DaemonCore({ ...parsedArgs, localTrace: true });
try {
  daemon.start();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
var shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
