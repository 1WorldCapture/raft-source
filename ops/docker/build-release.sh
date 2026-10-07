#!/usr/bin/env bash
# Build the private-deployment Docker images + linux-x64 downloads artifacts
# for one commit. See docs/self-hosting/prod-docker.md for the release flow.
#   usage: build-release.sh <full-sha> <branch> [artifacts-out-dir]
# Runs from the repo root of a build checkout (a clean worktree is fine).
# Produces:
#   raft-source-server:<branch>-<sha>
#   raft-source-web-selfhost:<branch>-<sha>
#   downloads/{cli,computer,daemon} in $3 (default ./deploy/docker/downloads)
# Logs every step; ends with ALL-DONE in $LOGDIR/server.log on success.
set -euo pipefail

SHA=${1:?usage: build-release.sh <full-sha> <branch> [artifacts-out-dir]}
BRANCH=${2:?usage: build-release.sh <full-sha> <branch> [artifacts-out-dir]}
OUT=${3:-deploy/docker/downloads}
PATH=/opt/node-v24/bin:$PATH
LOGDIR=${LOGDIR:-/root/.build-release-$SHA}
mkdir -p "$LOGDIR"
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

git -C . rev-parse --verify "$SHA^{commit}" >/dev/null || { echo "unknown commit $SHA" >&2; exit 1; }
git checkout -q "$SHA"

log "install (frozen)"
pnpm install --frozen-lockfile --silent >"$LOGDIR/install.log" 2>&1

log "server image -> raft-source-server:$BRANCH-$SHA"
docker build -f packages/server/Dockerfile \
  --build-arg RAFT_RELEASE_SHA="$SHA" \
  --build-arg RAFT_BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg RAFT_RELEASE_BRANCH="$BRANCH" \
  -t "raft-source-server:$BRANCH-$SHA" . >"$LOGDIR/server.log" 2>&1

log "web image -> raft-source-web-selfhost:$BRANCH-$SHA"
docker build -f packages/web/Dockerfile \
  --build-arg SELFHOST=1 --build-arg VITE_COMMIT_SHA="$SHA" \
  -t "raft-source-web-selfhost:$BRANCH-$SHA" . >"$LOGDIR/web.log" 2>&1

log "artifacts -> $OUT"
node scripts/build-release-artifacts.mjs --platforms linux-x64 --out "$OUT" >"$LOGDIR/artifacts.log" 2>&1

log "ALL-DONE images+artifacts for $SHA ($BRANCH)"
echo "ALL-DONE" >> "$LOGDIR/server.log"
