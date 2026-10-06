// /downloads — self-hosted client artifacts (task #4, phase 2).
//
// Serves the release tree produced by scripts/build-downloads.mjs from
// DOWNLOADS_DIR (default /app/downloads; the compose deployment mounts or
// bakes the directory). Layout:
//   computer/manifest.json                {"version": "<latest>"}
//   computer/<v>/manifest.json            {"targets": {"<platform-key>": {file, sha256, size}}}
//   computer/<v>/<file>                   the SEA binaries
//   cli/manifest.json + cli/<v>/...       CLI tarballs (same shape)
//
// Public (installers run before any credential exists) but rate-limited.
// The self-hosted nginx serves these files DIRECTLY from a shared volume
// (alias) in the standard deployment — binary bytes never touch Node. These
// routes remain for deployments without the fronting nginx and for the small
// manifest files, which are cheap either way.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";

export function downloadsDir(): string {
  return process.env.RAFT_DOWNLOADS_DIR?.trim() || "/app/downloads";
}

const PRODUCT_SEGMENTS = new Set(["computer", "cli"]);

const downloadsRouter: Router = Router();

// manifest.json files must never be cached across a version swap.
downloadsRouter.get("/:product/manifest.json", async (req, res) => {
  const product = String(req.params.product);
  if (!PRODUCT_SEGMENTS.has(product)) {
    res.status(404).json({ error: "Unknown downloads product" });
    return;
  }
  const file = safeJoin(downloadsDir(), product, "manifest.json");
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("Content-Type", "application/json");
    createReadStream(file).pipe(res);
  } catch {
    // A private deployment without artifacts loses the "new version" hint —
    // the same degradation as the external lookup failing offline.
    res.status(404).json({ error: "downloads_manifest_missing", code: isPrivateDeploymentMode() ? "private_mode_no_artifacts" : "downloads_disabled" });
  }
});

// Versioned manifests are immutable per version.
downloadsRouter.get("/:product/:version/manifest.json", async (req, res) => {
  const { product, version } = req.params as { product: string; version: string };
  if (!PRODUCT_SEGMENTS.has(product) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const file = safeJoin(downloadsDir(), product, version, "manifest.json");
  try {
    await stat(file);
    res.setHeader("Cache-Control", "public, immutable, max-age=31536000");
    res.setHeader("Content-Type", "application/json");
    createReadStream(file).pipe(res);
  } catch {
    res.status(404).json({ error: "version_manifest_missing" });
  }
});

// Artifact files: immutable, streamed, with long-lived caching.
downloadsRouter.get("/:product/:version/:fileName", async (req, res) => {
  const { product, version, fileName } = req.params as { product: string; version: string; fileName: string };
  if (!PRODUCT_SEGMENTS.has(product) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const file = safeJoin(downloadsDir(), product, version, fileName);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.setHeader("Cache-Control", "public, immutable, max-age=31536000");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", info.size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.status(404).json({ error: "artifact_missing" });
  }
});

downloadsRouter.get("/", (_req, res) => {
  res.json({ products: [...PRODUCT_SEGMENTS], dir_configured: Boolean(process.env.RAFT_DOWNLOADS_DIR?.trim()) });
});

function safeJoin(base: string, ...segments: string[]): string {
  const joined = path.join(base, ...segments);
  const resolvedBase = path.resolve(base);
  if (!path.resolve(joined).startsWith(resolvedBase + path.sep)) {
    throw new Error("path escapes downloads dir");
  }
  return joined;
}

export default downloadsRouter;
