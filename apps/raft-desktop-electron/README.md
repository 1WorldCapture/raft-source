# Raft Desktop (Electron)

The native macOS app for Raft. Bundles its own frontend, talks directly to a
Raft backend, and hosts the local Computer service (see `src/app/computerHost.ts`).

## Building

```sh
pnpm --filter @botiverse/raft-desktop-electron build      # dev bundle (dist/)
pnpm --filter @botiverse/raft-desktop-electron dist:mac   # packaged .app / .dmg
```

## Configuring the backend (build time)

The backend origin is baked in at build time from the `VITE_API_URL`
environment variable — server addresses never live in the repo. The single
source is `buildConfig.mjs`; the vite config (renderer) and the tsup config
(main process) both read it.

- **Unset** → the official production backend (`https://api.raft.build`). The
  build is byte-identical to the stock official build: same CSP, same CORS
  bridge origins, same update behavior.
- **Set to an official origin** (`https://api.raft.build` or
  `https://api-aws-staging.botiverse.dev`) → behaves exactly like unset.
- **Set to any other http(s) origin** → a self-hosted build. The value must be
  a bare origin (a path is tolerated and dropped; credentials/query fragments
  are rejected); anything unparseable fails the build. Self-hosted builds:
  - the renderer CSP widens `connect-src`/`img-src`/`media-src` by exactly the
    configured origin and its `ws://`/`wss://` counterpart — never bare
    `http:`/`ws:` schemes;
  - the main-process CORS bridge (`API_ORIGINS`) and the OAuth authorization
    allowlist admit exactly the configured origin/host, with http allowed only
    for that one origin;
  - auto-update is disabled (the official update feed would otherwise replace
    a self-hosted app with an official one).

```sh
# Example: build + package against a self-hosted server
VITE_API_URL=http://your-raft-host:3001 pnpm --filter @botiverse/raft-desktop-electron dist:mac
```

`buildConfig.test.ts` and `src/app/configuredApiOrigin.test.ts` pin the
parsing, CSP-widening, allowlist, and update-disabling behavior.

## Configuring the server (runtime, phase 3-1)

A stock build can be pointed at a private deployment AT RUNTIME — no rebuild
needed. Resolution order (`src/app/serverOriginConfig.ts`):

1. `userData/server-origin.json` — the user's persisted choice (top bar →
   server-address icon → dialog);
2. `RAFT_DESKTOP_API_ORIGIN` env — CI/automation convenience, held to the
   same validation;
3. the baked build-time origin (default; stock official builds behave
   byte-identically to before when nothing is configured).

Rules and behavior:

- **https only.** The bundled renderer's stock CSP allows just `https`/`wss`
  connect targets, so a runtime `http://` origin — localhost included —
  cannot work without editing the shipped CSP, which the official-build
  byte-stability rule forbids. The settings dialog explains this and points
  http self-hosted users to the build-time path above. A bare host typed
  into the dialog is auto-prefixed with `https://`.
- Origin must be a bare https origin (optional port); path, query, fragment,
  and credentials are rejected. Invalid persisted values (file or env) are
  ignored with a warning — never brick boot.
- **A change applies at relaunch** and is deliberately a full sign-out: the
  persisted `generation` counter rides the preload-injected environment
  (`__RAFT_DESKTOP_ENVIRONMENT__`, minimal `{apiOrigin, socketOrigin,
  generation}` tuple) so the renderer clears auth/session state per origin
  switch. The counter is monotonic across resets — a stale token from one
  origin can never ride into another.
- Main-process surfaces follow the runtime origin: the CORS bridge, the
  OAuth authorization allowlist, the Computer host's deployment origin, and
  the app updater (official updates only while talking to an official
  backend).
- Computer upgrade checks read the current origin's own
  `/downloads/computer` manifest tree for private origins (zero official
  egress), the official CDN otherwise. Before attaching, foreign-origin
  attachments under the active home are archived to
  `servers-retired-<id>/` (recoverable, never deleted) — one home never
  holds two origins' attachments, so upgrade-source resolution can never
  hit its AMBIGUOUS fail-closed.

### Isolated test builds

`pnpm --filter @botiverse/raft-desktop-electron dist:mac:isolated` packages
a variant with its own appId/productName (`electron-builder.isolated.yml`)
— a fully separate app identity for real-machine verification of this
feature without touching an installed Raft Desktop. Default-off: no release
script references the variant, and the isolated build skips `raft://`
deep-link registration so it cannot steal links from the installed app.

## Private-deployment app updates (phase 3-2)

macOS in-place auto-update requires a SIGNED app — verified on real hardware
with a minimal unsigned build (electron-updater 6.8.9: check/download/sha512
all pass, then Squirrel.Mac's ShipIt rejects the swap: "Code signature … did
not pass validation"; matches the official Electron docs). Private builds
are unsigned, so when the runtime server origin is private the app runs a
**detect → notify → manual install** flow instead:

- `main/privateUpdateChecker.ts` fetches
  `${origin}/downloads/desktop/latest-mac.yml` (start +30s, every 24h, and
  the menu's Check for Updates), strictly parses `version` + the first
  `files[].url`, and compares plain semver triples against the running
  version. The resolved download URL must be **https and exactly the
  current server origin** — a tampered feed carrying an absolute/external
  URL is discarded with a warning; the renderer never receives the URL and
  `shell.openExternal` only ever opens the main-process-validated value.
- The renderer shows a top-bar pill (「新版 v…」); clicking opens the
  download in the system browser. Official origins never start the checker
  — the official electron-updater path is unchanged.
- **Installing an unsigned download manually (Gatekeeper)**: after
  downloading, open the .dmg with right-click → **Open** (or allow it under
  **System Settings → Privacy & Security**), then drag Raft Desktop onto
  /Applications to replace the installed app. The pill's hover text carries
  these steps too. Same-Team-signed private builds (like the ones built on a
  machine with the team certificate) skip the Gatekeeper dance entirely.

The feed format is electron-builder's generic-provider `latest-mac.yml`, so
a future signed private build can switch to in-place updates against the
same URLs without server-side changes.

