// GET /api/deployment-info — public deployment metadata for same-origin web
// clients (task #5, private deployment phase 2).
//
// The web image is mode-agnostic (one image serves any deployment), so the
// generated Computer install commands need a RUNTIME answer for "is this a
// private deployment". This endpoint is that answer: unauthenticated (the
// install-command surfaces render pre-login), no DB — it reads only the
// canonical switch. Deliberately NOT probing /downloads for artifacts: a
// present-vs-absent artifact check would be inference, not the switch.
import { Router } from "express";
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";

export const deploymentInfoRouter: Router = Router();

deploymentInfoRouter.get("/", (_req, res) => {
  res.json({ deploymentMode: isPrivateDeploymentMode() ? "private" : "standard" });
});

export default deploymentInfoRouter;
