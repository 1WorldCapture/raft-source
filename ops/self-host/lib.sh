# Shared helpers for ops/self-host scripts. Source it; do not execute.
set -o pipefail
# Never let variables inherited from the calling shell reach the server or the migrator:
# dotenv does NOT override existing env vars, so an exported DATABASE_URL (e.g. from a shell
# that once sourced a .env, or from an agent runtime) would silently point commands at the
# wrong database, and pm2 would store it in the app's env.
unset DATABASE_URL JWT_SECRET REDIS_URL SCOPE_ATTESTATION_SECRET PORT HOST TRUST_PROXY \
      NODE_ENV SERVER_URL APP_URL CORS_ORIGIN RAFT_RELEASE_SHA RAFT_BUILD_AT RAFT_RELEASE_BRANCH
OPS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)   # absolute: scripts cd around
RAFT_OPS_ENV=${RAFT_OPS_ENV:-$OPS_DIR/env.local}
[ -f "$RAFT_OPS_ENV" ] || { echo "missing $RAFT_OPS_ENV (copy env.example)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$RAFT_OPS_ENV"
: "${RAFT_ROOT:?}" "${RAFT_OPS_HOME:?}" "${RAFT_WEB_RELEASES:?}" "${RAFT_WEB_CURRENT:?}" "${RAFT_SERVER_PORT:?}" "${RAFT_COMPUTER_WEB_ROOT:?}"
export PATH="$NODE_BIN_DIR:/usr/local/sbin:/usr/sbin:/sbin:$PATH"   # nginx lives in /usr/sbin
ENVF=$RAFT_ROOT/packages/server/.env
STATE=$RAFT_OPS_HOME/state
mkdir -p "$RAFT_OPS_HOME"/{state,backups,logs,build}

log(){ echo "[$(date -u +%FT%TZ)] $*"; }
die(){ log "ERROR: $*"; exit 1; }

# set_env KEY VALUE — replace or append KEY in packages/server/.env without echoing values.
set_env(){ python3 - "$ENVF" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:]
lines = open(path).read().splitlines()
out, done = [], False
for line in lines:
    if re.match(rf'^\s*{re.escape(key)}\s*=', line):
        if not done:
            out.append(f'{key}={value}')
            done = True
        continue
    out.append(line)
if not done:
    out.append(f'{key}={value}')
open(path, 'w').write('\n'.join(out) + '\n')
PY
}

# wait_http URL SECONDS — succeed once URL answers 200.
wait_http(){ local url=$1 secs=$2 i=0
  while [ "$i" -lt "$secs" ]; do
    [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "$url")" = 200 ] && return 0
    sleep 1; i=$((i + 1))
  done; return 1; }

# switch_web SHA — atomically point RAFT_WEB_CURRENT at a published release.
switch_web(){ local target=$RAFT_WEB_RELEASES/$1
  [ -f "$target/index.html" ] || die "web release $target missing"
  ln -sfn "$target" "$RAFT_WEB_CURRENT.tmp" && mv -T "$RAFT_WEB_CURRENT.tmp" "$RAFT_WEB_CURRENT"; }

# changed PREV NEXT PATH... — true if any PATH differs between two commits.
changed(){ local a=$1 b=$2; shift 2; ! git -C "$RAFT_ROOT" diff --quiet "$a" "$b" -- "$@"; }
