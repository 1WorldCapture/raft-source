import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { raftCspPlugin, resolveBuildApiConfig } from "../buildConfig.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Single source (buildConfig.mjs): the API origin from VITE_API_URL, defaulting
// to the official production backend. Self-hosted builds additionally widen the
// index.html CSP by exactly the configured origin via raftCspPlugin.
const apiConfig = resolveBuildApiConfig();

export default defineConfig({
  root: dir,
  plugins: [react(), raftCspPlugin(apiConfig)],
  // Bundle the web app's static assets (brand icons, etc.) so components that
  // reference /brand/... resolve under the app:// origin.
  publicDir: path.resolve(dir, "../../../packages/web/public"),
  // The app is served from the app:// ORIGIN (not file://), so assets must be
  // ABSOLUTE from the origin root. A relative base ("./") breaks on any deep
  // route: after client-side navigation to e.g. app://raft/computers, a reload
  // (Cmd+R) or raft:// deep link re-serves index.html, and "./assets/x.js"
  // resolves against /computers/ → the app:// SPA-fallback returns index.html
  // for the script → blank white screen. Absolute "/" always resolves to
  // app://raft/assets/... regardless of the current route.
  base: "/",
  resolve: {
    // The desktop and shared web source resolve different pnpm peer instances.
    // Providers and consumers must share one UI/React module identity.
    dedupe: ["react", "react-dom", "raft-ui"],
    alias: {
      // Reuse the Slock web app's api/store/i18n/utils/components layer.
      "@web": path.resolve(dir, "../../../packages/web/src"),
    },
  },
  define: {
    // The bundled frontend talks directly to the backend baked at build time.
    "import.meta.env.VITE_API_URL": JSON.stringify(apiConfig.apiOrigin),
    // The reused web version util reads this; provide the desktop app version.
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      process.env.VITE_APP_VERSION ?? "0.1.0-desktop",
    ),
  },
  build: {
    outDir: path.resolve(dir, "../dist/frontend"),
    emptyOutDir: true,
    target: "chrome126",
  },
});
