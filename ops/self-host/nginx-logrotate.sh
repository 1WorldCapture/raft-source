#!/usr/bin/env bash
# Rotate the pm2-managed nginx logs (for hosts without logrotate/cron). pm2 runs it on a cron
# schedule (see ecosystem.config.cjs.example); keeps 14 days, gzipped.
set -u
source "$(dirname "$0")/lib.sh"
D=$RAFT_OPS_HOME/nginx/logs; S=$(date -u +%Y%m%dT%H%M%S)
for f in access error; do [ -s "$D/$f.log" ] && mv "$D/$f.log" "$D/$f.log.$S"; done
nginx -p "$RAFT_OPS_HOME/nginx" -c nginx.conf -s reopen
sleep 2; gzip -f "$D"/*.log."$S" 2>/dev/null
find "$D" -name '*.log.*.gz' -mtime +14 -delete
log "rotated $S"
