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
echo $$ > "$LOGDIR/pid"   # callers verify liveness via this pidfile, not pgrep
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

# Free-space gate: builds fail unpredictably on a nearly-full disk (observed
# layer-export corruption above ~87% on the 39G prod box). Refuse to start
# unless the build filesystem has enough headroom. Override with
# RAFT_BUILD_MIN_FREE_GB (in GiB) if a smaller box ever needs it.
MIN_FREE_GB=${RAFT_BUILD_MIN_FREE_GB:-12}
FREE_GB=$(df -BG --output=avail . | tail -1 | tr -dc '0-9')
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  echo "ABORT: ${FREE_GB}G free (< ${MIN_FREE_GB}G floor) on $(df --output=source . | tail -1) — clean up first (docs/self-hosting/prod-docker.md, 磁盘治理)" >&2
  exit 1
fi
log "free-space gate OK: ${FREE_GB}G ≥ ${MIN_FREE_GB}G"

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
