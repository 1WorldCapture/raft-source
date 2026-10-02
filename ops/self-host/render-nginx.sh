#!/usr/bin/env bash
# Render nginx templates into $RAFT_OPS_HOME/nginx and validate. Usage: render-nginx.sh [--reload]
#
# TLS: when RAFT_TLS_SERVER_NAME + RAFT_TLS_CERT + RAFT_TLS_KEY are all set, the
# main server listens on 443 ssl and port 80 only redirects to https (keeping
# /health answerable over plain http). Without them the output is unchanged:
# plain listeners on RAFT_PUBLIC_PORTS. Re-rendering never drops a live TLS
# setup that is expressed through these variables — hand-edits to the rendered
# file WILL be lost, so express TLS here instead.
set -eu
source "$(dirname "$0")/lib.sh"
SRC=$OPS_DIR/nginx; OUT=$RAFT_OPS_HOME/nginx
mkdir -p "$OUT"/{run,logs,temp}
# Default keeps old env.local files (git-ignored, not upgraded by git pull) working.
RAFT_COMPUTER_WEB_ROOT=${RAFT_COMPUTER_WEB_ROOT:-/srv/raft-computer}
LISTEN=""; for p in $RAFT_PUBLIC_PORTS; do LISTEN+="    listen $p;      listen [::]:$p;"$'\n'; done
SERVER_NAME="_"; HTTP_SERVER=""; TLS_SETUP=""
if [ -n "${RAFT_TLS_SERVER_NAME:-}" ] && [ -n "${RAFT_TLS_CERT:-}" ] && [ -n "${RAFT_TLS_KEY:-}" ]; then
  [ -f "$RAFT_TLS_CERT" ] || { echo "RAFT_TLS_CERT not found: $RAFT_TLS_CERT" >&2; exit 1; }
  [ -f "$RAFT_TLS_KEY" ] || { echo "RAFT_TLS_KEY not found: $RAFT_TLS_KEY" >&2; exit 1; }
  SERVER_NAME=$RAFT_TLS_SERVER_NAME
  LISTEN="    listen 443 ssl http2;"$'\n'"    listen [::]:443 ssl http2;"$'\n'
  TLS_SETUP="    ssl_certificate     $RAFT_TLS_CERT;"$'\n'"    ssl_certificate_key $RAFT_TLS_KEY;"$'\n'"    ssl_protocols TLSv1.2 TLSv1.3;"
  HTTP_SERVER='server {'$'\n''    listen 80;      listen [::]:80;'$'\n''    server_name '"$SERVER_NAME"';'$'\n\n''    access_log logs/access.log raft;'$'\n''    error_log  logs/error.log warn;'$'\n\n''    location = /health { include raft-proxy.conf; }'$'\n''    location / { return 301 https://'"$SERVER_NAME"'$request_uri; }'$'\n''}'$'\n\n'
fi
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
python3 - "$SRC/raft.conf.tmpl" "$OUT/raft.conf" "$LISTEN" "$RAFT_SERVER_PORT" "$RAFT_WEB_CURRENT" "$RAFT_CLIENT_MAX_BODY" "$REDIRECT" "$RAFT_COMPUTER_WEB_ROOT" "$SERVER_NAME" "$HTTP_SERVER" "$TLS_SETUP" <<'PY'
import sys
src, dst, listen, port, web, body, redirect, computer_root, server_name, http_server, tls_setup = sys.argv[1:]
s = open(src).read()
s = (s.replace('@@LISTEN@@\n', listen).replace('@@RAFT_SERVER_PORT@@', port)
      .replace('@@RAFT_WEB_CURRENT@@', web).replace('@@RAFT_CLIENT_MAX_BODY@@', body).replace('@@REDIRECT_SERVERS@@', redirect)
      .replace('@@RAFT_COMPUTER_WEB_ROOT@@', computer_root)
      .replace('@@SERVER_NAME@@', server_name).replace('@@HTTP_SERVER@@', http_server).replace('@@TLS_SETUP@@\n', tls_setup))
assert '@@' not in s, 'unrendered placeholder'
open(dst, 'w').write(s)
PY
nginx -p "$OUT" -c nginx.conf -t
[ "${1:-}" = --reload ] && nginx -p "$OUT" -c nginx.conf -s reload && log "nginx reloaded"
log "rendered $OUT"
