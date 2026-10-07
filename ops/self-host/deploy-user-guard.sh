#!/usr/bin/env bash
# Side-effect-free guard sourced by deploy.sh / rollback.sh BEFORE lib.sh
# (lib.sh creates state dirs on source; sourcing it as root would leave them
# root-owned). Two failures this guard prevents (measured 2026-10-07, task #7):
#   1. pm2 resolving the invoker's PM2_HOME — root's domain has no raft-server
#   2. root-owned node_modules entries poisoning later raft-user pnpm installs
if [ "$(id -u)" = "0" ]; then
  echo "deploy tooling: refusing to run as root — run it as the deployment user, e.g." >&2
  echo "  runuser -u raft -- bash ops/self-host/deploy.sh <ref>" >&2
  exit 1
fi
# Non-interactive pnpm: with a large lockfile delta pnpm asks for a TTY
# confirmation to purge node_modules and aborts without one
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). CI=true is pnpm's documented
# non-interactive switch and changes no script logic.
export CI="${CI:-true}"
