#!/usr/bin/env bash
# Drill preflight: prove the environment before spending 10+ minutes on it.
#
#   scripts/drill/preflight.sh <repo> <ref> <workdir>
#
# Does, in order:
#   1. snapshot the owner's ~/Library/LaunchAgents (for the postflight diff gate)
#   2. rebuild shared + daemon + computer at an exact commit
#   3. assert each dist carries that commit baked in, and print fingerprints
#
# Exits non-zero on any doubt. A drill that cannot identify its own build must
# not proceed — see scripts/drill/lib.sh.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

REPO="${1:-}"
REF="${2:-HEAD}"
WORK="${3:-/tmp/drill-preflight}"
[[ -n "$REPO" ]] || drill::fail "usage: preflight.sh <repo> <ref> <workdir>"

mkdir -p "$WORK"
LA_BEFORE="$WORK/launchagents-before.txt"
LA_AFTER="$WORK/launchagents-after-rebuild.txt"

drill::require_cmd git pnpm node grep shasum

drill::log "preflight: repo=$REPO ref=$REF work=$WORK"

# --- 1. owner isolation snapshot BEFORE anything runs ------------------------
drill::snapshot_launchagents "$LA_BEFORE"
drill::log "LaunchAgents snapshot: $(wc -l < "$LA_BEFORE" | tr -d ' ') entr(ies)"

# --- 2. rebuild at the exact commit -----------------------------------------
ORIGINAL_HEAD="$(drill::rebuild_at_ref "$REPO" "$REF")"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
drill::log "rebuilt at ${TARGET_SHA:0:12} (original HEAD was ${ORIGINAL_HEAD:0:12})"

# Rebuilding must not have introduced or removed an owner login item.
drill::snapshot_launchagents "$LA_AFTER"
drill::diff_launchagents "$LA_BEFORE" "$LA_AFTER" \
  || drill::fail "the rebuild changed the owner's LaunchAgents — investigate before running a drill"

# --- 3. prove build identity ------------------------------------------------
for pkg in daemon computer; do
  DIST="$REPO/packages/$pkg/dist"
  [[ -d "$DIST" ]] || drill::fail "missing $DIST after rebuild"
  drill::assert_dist_provenance "$DIST" "$TARGET_SHA" "$pkg"
  drill::log "$pkg fingerprint: $(drill::fingerprint "$DIST")"
done

cat <<EOF
[drill] PREFLIGHT OK
[drill]   target commit : ${TARGET_SHA:0:12} ($TARGET_SHA)
[drill]   daemon  dist  : $(drill::fingerprint "$REPO/packages/daemon/dist")
[drill]   computer dist : $(drill::fingerprint "$REPO/packages/computer/dist")
[drill]   restore ref   : ${ORIGINAL_HEAD:0:12}
[drill]   launchagents  : $LA_BEFORE
EOF
printf '%s\n' "$ORIGINAL_HEAD" > "$WORK/restore-ref.txt"