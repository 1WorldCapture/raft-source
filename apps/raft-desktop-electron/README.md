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
