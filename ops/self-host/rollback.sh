#!/usr/bin/env bash
# Restore the state saved by the last deploy (or the backup dir given as $1):
# previous commit, packages/server/.env, web release; then restart raft-server.
set -eu
source "$(dirname "$0")/lib.sh"
B=${1:-$(cat "$STATE/last_backup")}
[ -f "$B/prev_sha" ] || die "no backup at $B"
PREV=$(cat "$B/prev_sha")
cd "$RAFT_ROOT"
CUR=$(git rev-parse HEAD)
log "rollback $CUR -> $PREV using $B"
git checkout -q -B deploy "$PREV"
if changed "$CUR" "$PREV" pnpm-lock.yaml '*package.json' patches; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --prefer-offline
fi
cp -a "$B/server.env" "$ENVF"
if [ -s "$B/prev_web" ]; then ln -sfn "$(cat "$B/prev_web")" "$RAFT_WEB_CURRENT.tmp" && mv -T "$RAFT_WEB_CURRENT.tmp" "$RAFT_WEB_CURRENT"; fi
pm2 restart "$RAFT_PM2_SERVER" >/dev/null
# Independent of RAFT_HEALTH_TIMEOUT: a rollback should wait generously before giving up.
wait_http "http://127.0.0.1:$RAFT_SERVER_PORT/health" "${RAFT_ROLLBACK_TIMEOUT:-180}" || die "server still unhealthy after rollback"
log "rolled back to $PREV"
