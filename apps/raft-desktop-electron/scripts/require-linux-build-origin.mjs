#!/usr/bin/env node
// Guard for `dist:linux`: refuse to package a Linux build that silently talks
// to the official backend. VITE_API_URL is baked at build time (renderer +
// main-process bundle); without it the app defaults to the official origin and
// only a runtime env var could redirect it. The Linux builds we make are for
// test/private environments, so an explicit origin is required.
// Opt out for a genuine official build with RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN=1.
import { resolveBuildApiConfig } from "../buildConfig.mjs";

export function checkLinuxBuildOrigin(env = process.env) {
  const raw = typeof env.VITE_API_URL === "string" ? env.VITE_API_URL.trim() : "";
  if (raw === "" && env.RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN !== "1") {
    return { ok: false, message: "dist:linux requires VITE_API_URL (e.g. https://raft.example:8443): without it the build is baked to the OFFICIAL backend. Set RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN=1 only for an official build." };
  }
  let config;
  try {
    config = resolveBuildApiConfig(env);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  if (config.isOfficial && env.RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN !== "1") {
    return { ok: false, message: `VITE_API_URL ${config.apiOrigin} is an official origin; set RAFT_LINUX_ALLOW_OFFICIAL_ORIGIN=1 to build for it on purpose.` };
  }
  return { ok: true, message: `dist:linux will bake API origin ${config.apiOrigin}${config.isOfficial ? " (official, explicitly allowed)" : ""}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkLinuxBuildOrigin();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(`[dist:linux] ${result.message}`);
    process.exit(1);
  }
}
