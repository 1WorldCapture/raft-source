#!/usr/bin/env bash
# Render nginx templates into $RAFT_OPS_HOME/nginx and validate. Usage: render-nginx.sh [--reload]
set -eu
source "$(dirname "$0")/lib.sh"
SRC=$OPS_DIR/nginx; OUT=$RAFT_OPS_HOME/nginx
mkdir -p "$OUT"/{run,logs,temp}
LISTEN=""; for p in $RAFT_PUBLIC_PORTS; do LISTEN+="    listen $p;      listen [::]:$p;"$'\n'; done
# Legacy ports that should send browsers to the canonical origin (first public port).
# Serving the same site on two ports makes them different browser origins, and the
# server marks responses Cross-Origin-Resource-Policy: same-origin, so e.g. attachment
# <img> URLs built from SERVER_URL break when the page is opened on the other port.
CANON=${RAFT_PUBLIC_PORTS%% *}; REDIRECT=""
for p in ${RAFT_REDIRECT_PORTS:-}; do
  REDIRECT+=$'\n'"server {"$'\n'"    listen $p;      listen [::]:$p;"$'\n'"    server_name _;"$'\n'"    access_log logs/access.log raft;"$'\n'"    return 301 \$scheme://\$host:$CANON\$request_uri;"$'\n'"}"$'\n'
done
cp "$SRC/nginx.conf.tmpl" "$OUT/nginx.conf"
cp "$SRC/raft-proxy.conf" "$OUT/raft-proxy.conf"
python3 - "$SRC/raft.conf.tmpl" "$OUT/raft.conf" "$LISTEN" "$RAFT_SERVER_PORT" "$RAFT_WEB_CURRENT" "$RAFT_CLIENT_MAX_BODY" "$REDIRECT" "$RAFT_COMPUTER_WEB_ROOT" <<'PY'
import sys
src, dst, listen, port, web, body, redirect, computer_root = sys.argv[1:]
s = open(src).read()
s = (s.replace('@@LISTEN@@\n', listen).replace('@@RAFT_SERVER_PORT@@', port)
      .replace('@@RAFT_WEB_CURRENT@@', web).replace('@@RAFT_CLIENT_MAX_BODY@@', body).replace('@@REDIRECT_SERVERS@@', redirect)
      .replace('@@RAFT_COMPUTER_WEB_ROOT@@', computer_root))
assert '@@' not in s, 'unrendered placeholder'
open(dst, 'w').write(s)
PY
nginx -p "$OUT" -c nginx.conf -t
[ "${1:-}" = --reload ] && nginx -p "$OUT" -c nginx.conf -s reload && log "nginx reloaded"
log "rendered $OUT"
