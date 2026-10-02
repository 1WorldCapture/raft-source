#!/usr/bin/env bash
# Regression tests for ops/self-host/render-nginx.sh TLS + /computer/ support
# (PR #127 review): without TLS vars the rendered conf must keep the plain
# shape; with them it must gain 443 ssl + redirect-80; /computer/ locations
# must render either way. Runs nginx -t only when an nginx binary is present.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OPS=$HERE/..
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK"/opshome "$WORK/certs"
# render-nginx.sh validates with nginx -t, which loads the real certificate —
# use a throwaway self-signed pair, not fake bytes.
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "$WORK/certs/k.pem" -out "$WORK/certs/c.pem" \
    -subj "/CN=raft.example.internal" >/dev/null 2>&1
else
  printf fakecert > "$WORK/certs/c.pem"; printf fakekey > "$WORK/certs/k.pem"
fi

base_env() {  # base_env <file> <web-root>
  cat > "$1" <<EOF
RAFT_ROOT=$WORK/none
RAFT_OPS_HOME=$WORK/opshome
RAFT_WEB_RELEASES=$WORK/webrel
RAFT_WEB_CURRENT=$WORK/webcur
RAFT_SERVER_PORT=3101
RAFT_COMPUTER_WEB_ROOT=$2
RAFT_PUBLIC_PORTS="3001"
RAFT_REDIRECT_PORTS=""
RAFT_CLIENT_MAX_BODY=256m
NODE_BIN_DIR=/usr/bin:/bin
EOF
}

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "R1 default render (no TLS vars): plain listeners, /computer/ present"
base_env "$WORK/env.plain" /srv/raft-computer
RAFT_OPS_ENV=$WORK/env.plain "$OPS/render-nginx.sh" >/dev/null 2>&1 || { bad "render failed"; exit 1; }
C=$WORK/opshome/nginx/raft.conf
grep -q 'listen 3001' "$C" && ok "plain listen 3001" || bad "missing plain listen"
grep -q 'server_name _;' "$C" && ok "default server_name" || bad "server_name changed without TLS vars"
! grep -q 'ssl_certificate' "$C" && ok "no ssl without TLS vars" || bad "unexpected ssl in default render"
grep -q 'location = /computer/manifest.json' "$C" && ok "/computer/ locations rendered" || bad "missing /computer/"
grep -q 'alias /srv/raft-computer/manifest.json' "$C" && ok "computer root rendered" || bad "missing computer root alias"

echo "R2 old env.local (no RAFT_COMPUTER_WEB_ROOT): render still works, defaults applied"
base_env "$WORK/env.old" /srv/raft-computer
sed -i '/^RAFT_COMPUTER_WEB_ROOT=/d' "$WORK/env.old"
RAFT_OPS_ENV=$WORK/env.old "$OPS/render-nginx.sh" >/dev/null 2>&1 \
  && grep -q 'alias /srv/raft-computer/manifest.json' "$C" && ok "default /srv/raft-computer applied" || bad "old env must keep working via default"

echo "R3 TLS render: 443 ssl + redirect 80 + server_name"
base_env "$WORK/env.tls" /srv/raft-computer
cat >> "$WORK/env.tls" <<EOF
RAFT_TLS_SERVER_NAME=raft.example.internal
RAFT_TLS_CERT=$WORK/certs/c.pem
RAFT_TLS_KEY=$WORK/certs/k.pem
EOF
RAFT_OPS_ENV=$WORK/env.tls "$OPS/render-nginx.sh" >/dev/null 2>&1 || { bad "TLS render failed"; exit 1; }
grep -q 'listen 443 ssl http2' "$C" && ok "443 ssl http2" || bad "missing 443 ssl"
grep -q 'server_name raft.example.internal;' "$C" && ok "TLS server_name" || bad "missing TLS server_name"
grep -q "return 301 https://raft.example.internal\$request_uri" "$C" && ok "80 redirect" || bad "missing https redirect"
grep -q 'ssl_certificate' "$C" && grep -q 'ssl_protocols TLSv1.2 TLSv1.3' "$C" && ok "cert directives" || bad "missing cert directives"
grep -q 'location = /health { include raft-proxy.conf; }' "$C" && ok "/health on 80" || bad "missing /health on 80"

echo "R4 TLS render with missing cert file: refused"
printf 'RAFT_TLS_CERT=%s/certs/missing.pem\n' "$WORK" >> "$WORK/env.tls"
RAFT_OPS_ENV=$WORK/env.tls "$OPS/render-nginx.sh" >/dev/null 2>&1 && bad "must refuse missing cert" || ok "refused missing cert"

echo "R5 partial TLS variables: refused, never silent HTTP fallback"
# a good conf exists from R3; every partial combo must refuse AND leave it as-is
cp "$C" "$C.baseline"
partial=0; refused=0
for extra in "RAFT_TLS_SERVER_NAME=raft.example.internal" \
             "RAFT_TLS_CERT=$WORK/certs/c.pem" \
             "RAFT_TLS_KEY=$WORK/certs/k.pem" \
             "RAFT_TLS_SERVER_NAME=raft.example.internal
RAFT_TLS_CERT=$WORK/certs/c.pem" \
             "RAFT_TLS_SERVER_NAME=raft.example.internal
RAFT_TLS_KEY=$WORK/certs/k.pem" \
             "RAFT_TLS_CERT=$WORK/certs/c.pem
RAFT_TLS_KEY=$WORK/certs/k.pem"; do
  partial=$((partial+1))
  base_env "$WORK/env.p" /srv/raft-computer
  printf '%s\n' "$extra" >> "$WORK/env.p"
  if RAFT_OPS_ENV=$WORK/env.p "$OPS/render-nginx.sh" >/dev/null 2>&1; then
    bad "partial combo accepted: $(echo "$extra" | tr '\n' ',')"
  else
    refused=$((refused+1))
  fi
done
cmp -s "$C" "$C.baseline" && conf_unchanged=1 || conf_unchanged=0
[ $refused -eq $partial ] && [ $conf_unchanged -eq 1 ] \
  && ok "all $partial partial combos refused, rendered conf untouched" \
  || bad "refused=$refused/$partial, conf_unchanged=$conf_unchanged"

echo
echo "passed=$PASS failed=$FAIL"
[ $FAIL -eq 0 ]
