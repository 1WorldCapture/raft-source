import { Router, type Router as ExpressRouter } from "express";
import { readComputerDeploymentConfig } from "../config/computerDeploymentConfig.js";

/**
 * Public read-only deployment info for Computer onboarding surfaces
 * (contract v1): `GET /api/deployment/computer-setup`.
 *
 * **Deliberately unauthenticated.** The machine being onboarded has a terminal,
 * not a Raft session, and the web page rendering the commands needs this data
 * before any sign-in flow on that machine exists. Only public values travel:
 * origins, backend selection, and channel — never tokens, filesystem paths,
 * process environment, or secrets. The response is `no-store` so no
 * browser/CDN cache outlives a config change.
 *
 * Not-ready deployments answer HTTP 200 with `status: "missing" | "invalid"`
 * and field NAMES only — the web surface must render a visible error and
 * disable command copying. Half-built payloads or echoed raw values would let
 * a broken deployment look like a working official one.
 *
 * Configuration is re-read from process.env per request; editing the .env FILE
 * still requires a process restart through the deployment flow before the
 * change reaches this endpoint.
 */
export const deploymentComputerSetupRouter: ExpressRouter = Router();

deploymentComputerSetupRouter.get("/computer-setup", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const result = readComputerDeploymentConfig();

  if (result.status !== "ready") {
    res.status(200).json({
      schemaVersion: 1,
      status: result.status,
      fields: result.fields,
    });
    return;
  }

  const { serverUrl, backend, releaseBase, handsOrigin, installChannel } = result.config;
  res.status(200).json({
    schemaVersion: 1,
    status: "ready",
    serverUrl,
    releaseSource: {
      backend,
      releaseBase,
      // handsOrigin is meaningful only for the hands backend; omitting it for
      // manifest keeps the payload shape the two backends' consumers switch on.
      ...(backend === "hands" && handsOrigin ? { handsOrigin } : {}),
    },
    installChannel,
  });
});
