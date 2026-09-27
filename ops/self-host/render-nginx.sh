#!/usr/bin/env bash
# Render nginx templates into $RAFT_OPS_HOME/nginx and validate. Usage: render-nginx.sh [--reload]
set -eu
source "$(dirname "$0")/lib.sh"
SRC=$OPS_DIR/nginx; OUT=$RAFT_OPS_HOME/nginx
mkdir -p "$OUT"/{run,logs,temp}
LISTEN=""; for p in $RAFT_PUBLIC_PORTS; do LISTEN+="    listen $p;      listen [::]:$p;"$'\n'; done
cp "$SRC/nginx.conf.tmpl" "$OUT/nginx.conf"
cp "$SRC/raft-proxy.conf" "$OUT/raft-proxy.conf"
python3 - "$SRC/raft.conf.tmpl" "$OUT/raft.conf" "$LISTEN" "$RAFT_SERVER_PORT" "$RAFT_WEB_CURRENT" "$RAFT_CLIENT_MAX_BODY" <<'PY'
import sys
src, dst, listen, port, web, body = sys.argv[1:]
s = open(src).read()
s = (s.replace('@@LISTEN@@\n', listen).replace('@@RAFT_SERVER_PORT@@', port)
      .replace('@@RAFT_WEB_CURRENT@@', web).replace('@@RAFT_CLIENT_MAX_BODY@@', body))
assert '@@' not in s, 'unrendered placeholder'
open(dst, 'w').write(s)
PY
nginx -p "$OUT" -c nginx.conf -t
[ "${1:-}" = --reload ] && nginx -p "$OUT" -c nginx.conf -s reload && log "nginx reloaded"
log "rendered $OUT"
