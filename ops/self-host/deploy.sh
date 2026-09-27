#!/usr/bin/env bash
# Deploy a commit to the live checkout with automatic rollback.
#   deploy.sh [git-ref] [--dry-run]
# Steps: build (zero impact) -> backup -> checkout -> install if lockfile changed -> migrate if
# migrations changed -> stamp RAFT_RELEASE_* -> switch web -> restart raft-server (+worker if its
# code changed) -> health checks. Any failure after the backup restores the previous commit, .env
# and web release. raft-daemon is NEVER restarted here (see the doc: it hosts local agents).
set -eu
source "$(dirname "$0")/lib.sh"
REF=$RAFT_DEPLOY_REF; DRY=0
for a in "$@"; do case $a in --dry-run) DRY=1 ;; *) REF=$a ;; esac; done
TS=$(date -u +%Y%m%dT%H%M%SZ)
exec > >(tee -a "$RAFT_OPS_HOME/logs/deploy-$TS.log") 2>&1

cd "$RAFT_ROOT"
git diff --quiet && git diff --cached --quiet || die "tracked files modified in $RAFT_ROOT; commit them to the deploy branch or stash first"
PREV=$(git rev-parse HEAD)
git fetch -q --all
NEXT=$(git rev-parse --verify "$REF^{commit}")
log "live $PREV -> target $NEXT ($REF)"
NEED_INSTALL=0; NEED_MIGRATE=0; NEED_WORKER=0; DAEMON_CHANGED=0
changed "$PREV" "$NEXT" pnpm-lock.yaml '*package.json' patches && NEED_INSTALL=1
changed "$PREV" "$NEXT" packages/server/drizzle && NEED_MIGRATE=1
changed "$PREV" "$NEXT" packages/trace-upload-worker packages/shared && NEED_WORKER=1
changed "$PREV" "$NEXT" packages/daemon packages/cli packages/computer && DAEMON_CHANGED=1
log "plan: install=$NEED_INSTALL migrate=$NEED_MIGRATE restart-worker=$NEED_WORKER daemon-code-changed=$DAEMON_CHANGED"
[ "$DRY" = 1 ] && { log "dry run, stopping here"; exit 0; }

"$OPS_DIR/build.sh" "$NEXT" | tail -1 >/dev/null

B=$RAFT_OPS_HOME/backups/$TS; mkdir -p "$B"
cp -a "$ENVF" "$B/server.env"
echo "$PREV" > "$B/prev_sha"; readlink "$RAFT_WEB_CURRENT" > "$B/prev_web" 2>/dev/null || true
printf '%s\n' "$B" > "$STATE/last_backup"
log "backup $B"

rollback(){ log "FAILED: $1 -> rolling back to $PREV"
  "$OPS_DIR/rollback.sh" "$B" || log "ROLLBACK FAILED — see $RAFT_OPS_HOME/logs, fix by hand"
  exit 1; }

T0=$(date +%s)
git checkout -q -B deploy "$NEXT" || rollback "checkout"
if [ "$NEED_INSTALL" = 1 ]; then
  log "pnpm install (lockfile changed)"
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --prefer-offline || rollback "pnpm install"
fi
if [ "$NEED_MIGRATE" = 1 ]; then
  # Migrations run against the live DB while the old server is still up; they are not undone on rollback.
  log "db:migrate:deploy"
  "$OPS_DIR/migrate.sh" || rollback "migration"
fi
set_env RAFT_RELEASE_SHA "$NEXT"
set_env RAFT_RELEASE_BRANCH "${REF#origin/}"
set_env RAFT_BUILD_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
switch_web "$NEXT" || rollback "web switch"
log "restart $RAFT_PM2_SERVER (API outage starts)"
pm2 restart "$RAFT_PM2_SERVER" >/dev/null || rollback "pm2 restart"
wait_http "http://127.0.0.1:$RAFT_SERVER_PORT/health" "$RAFT_HEALTH_TIMEOUT" || rollback "server not healthy"
for p in $RAFT_PUBLIC_PORTS; do wait_http "http://127.0.0.1:$p/health" 30 || rollback "public :$p not healthy"; done
log "server healthy after $(( $(date +%s) - T0 ))s"
[ "$NEED_WORKER" = 1 ] && { pm2 restart "$RAFT_PM2_WORKER" >/dev/null && log "worker restarted"; }
V=$(curl -s "http://127.0.0.1:$RAFT_SERVER_PORT/api/version")
case $V in *"$NEXT"*) log "api/version ok" ;; *) log "WARN api/version: $V" ;; esac
[ "$DAEMON_CHANGED" = 1 ] && log "NOTE daemon/cli/computer code changed; rebuild + restart $RAFT_PM2_DAEMON separately (see doc)"
log "deployed $NEXT"
