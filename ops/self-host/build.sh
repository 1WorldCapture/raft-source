#!/usr/bin/env bash
# Build a release WITHOUT touching the live checkout or any running process:
# clean worktree at the target commit -> pnpm install -> web production build -> publish to $RAFT_WEB_RELEASES/<sha>.
# Usage: build.sh [git-ref]   (default: $RAFT_DEPLOY_REF). Prints the full SHA on the last line.
set -eu
source "$(dirname "$0")/lib.sh"
REF=${1:-$RAFT_DEPLOY_REF}
git -C "$RAFT_ROOT" fetch -q --all
SHA=$(git -C "$RAFT_ROOT" rev-parse --verify "$REF^{commit}")
W=$RAFT_OPS_HOME/build/$SHA
if [ -f "$RAFT_WEB_RELEASES/$SHA/index.html" ]; then log "web release $SHA already published"; echo "$SHA"; exit 0; fi
[ -d "$W" ] || git -C "$RAFT_ROOT" worktree add -q --detach "$W" "$SHA"
cd "$W"
log "pnpm install ($SHA)"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --prefer-offline >&2
# NODE_ENV must be production: an inherited NODE_ENV=development makes Vite ship dev-only
# tooling (react-scan/react-grab) and the build's own bundle check fails.
log "web build"
# VITE_COMMIT_SHA makes the build emit /desktop-manifest.json (desktop compatibility manifest).
NODE_ENV=production VITE_COMMIT_SHA="$SHA" VITE_BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  VITE_RELEASE_BRANCH="${RAFT_DEPLOY_REF#origin/}" pnpm --filter @botiverse/raft-web run build >&2
mkdir -p "$RAFT_WEB_RELEASES/$SHA.partial"
cp -a packages/web/dist/. "$RAFT_WEB_RELEASES/$SHA.partial/"
mv -T "$RAFT_WEB_RELEASES/$SHA.partial" "$RAFT_WEB_RELEASES/$SHA"
log "published $RAFT_WEB_RELEASES/$SHA"
echo "$SHA"
