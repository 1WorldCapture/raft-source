// GET /api/deployment-info — public deployment metadata for same-origin web
// clients and the manual renderer (task #5/#6, private deployment phase 2).
//
// The web image is mode-agnostic (one image serves any deployment), so the
// generated install commands need a RUNTIME answer for "is this a private
// deployment" and, when it is, WHERE the client artifacts live. This
// endpoint is that answer: unauthenticated (install-command surfaces render
// pre-login), no DB. Deliberately NOT probing /downloads for artifacts: a
// present-vs-absent artifact check would be inference, not the switch.
//
// SECURITY (PM review, task #6): the download URLs are built ONLY from the
// configured SERVER_URL — never from the request's Host or X-Forwarded-Host.
// This endpoint is unauthenticated; deriving the origin from request headers
// would let anyone forge a Host header and get attacker-origin install
// commands rendered into the UI and the agent manual (host-header injection).
// When SERVER_URL is unset the downloads object is omitted entirely — no
// URL is better than an untrusted URL.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";

import { downloadsDir } from "./downloads.js";

export const deploymentInfoRouter: Router = Router();

/** Trusted public origin — configuration only, never request headers. */
function configuredOrigin(): string | null {
  const origin = process.env.SERVER_URL?.trim().replace(/\/+$/, "");
  return origin ? origin : null;
}

async function readLatestVersion(product: "cli" | "daemon"): Promise<string | null> {
  try {
    const raw = await readFile(path.join(downloadsDir(), product, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

deploymentInfoRouter.get("/", async (req, res) => {
  void req; // The response deliberately ignores request-derived origins.
  if (!isPrivateDeploymentMode()) {
    res.json({ deploymentMode: "standard" });
    return;
  }
  // Operator-configured replacements for official link surfaces (task #7):
  // docs / legal links. Absent → the web hides docs links and keeps the
  // official legal links (PM decision: license/privacy links stay).
  const publicDocsUrl = process.env.RAFT_PUBLIC_DOCS_URL?.trim() || null;
  const termsUrl = process.env.RAFT_PUBLIC_TERMS_URL?.trim() || null;
  const privacyUrl = process.env.RAFT_PUBLIC_PRIVACY_URL?.trim() || null;
  const links = {
    ...(publicDocsUrl ? { docsUrl: publicDocsUrl } : {}),
    ...(termsUrl || privacyUrl
      ? { legal: { ...(termsUrl ? { termsUrl } : {}), ...(privacyUrl ? { privacyUrl } : {}) } }
      : {}),
  };
  const linksField = Object.keys(links).length > 0 ? { links } : {};
  const origin = configuredOrigin();
  if (!origin) {
    // Private without a configured public origin: report the mode (the web
    // shows its "cannot confirm" notice rather than official commands) but
    // never guess an origin.
    res.json({ deploymentMode: "private", ...linksField });
    return;
  }
  const [cliVersion, daemonVersion] = await Promise.all([
    readLatestVersion("cli"),
    readLatestVersion("daemon"),
  ]);
  res.json({
    deploymentMode: "private",
    downloads: {
      computerBase: `${origin}/downloads/computer`,
      ...(cliVersion ? { cli: `${origin}/downloads/cli/${cliVersion}/raft-${cliVersion}.tgz` } : {}),
      ...(daemonVersion ? { daemon: `${origin}/downloads/daemon/${daemonVersion}/raft-daemon-${daemonVersion}.tgz` } : {}),
    },
    ...linksField,
  });
});

export default deploymentInfoRouter;
