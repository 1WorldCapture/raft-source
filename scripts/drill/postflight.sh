#!/usr/bin/env bash
# Drill postflight: prove nothing outlived the drill.
#
#   scripts/drill/postflight.sh <repo> <workdir> [kill-pattern ...]
#
# Runs regardless of how the drill ended (call it from an EXIT trap). Every
# check that can fail, fails loudly and non-zero:
#   1. kill leftover drill processes by pid tree (patterns as args)
#   2. remove ONLY /tmp-rooted login items
#   3. diff the owner's LaunchAgents against the preflight snapshot
#   4. confirm the drill's temp home is gone
#   5. confirm the operator's ref was restored
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

REPO="${1:-}"
WORK="${2:-/tmp/drill-preflight}"
shift 2 2>/dev/null || true
[[ -n "$REPO" ]] || drill::fail "usage: postflight.sh <repo> <workdir> [kill-pattern ...]"

LA_BEFORE="$WORK/launchagents-before.txt"
LA_AFTER="$WORK/launchagents-after.txt"
STATUS=0

drill::log "postflight: repo=$REPO work=$WORK"

# --- 1. processes -----------------------------------------------------------
for pattern in "$@"; do
  drill::kill_pid_tree "$pattern" || STATUS=1
done

# --- 2. only /tmp-rooted login items ---------------------------------------
drill::remove_tmp_loginitems >/dev/null || STATUS=1

# --- 3. owner LaunchAgents must match the preflight snapshot ----------------
if [[ -f "$LA_BEFORE" ]]; then
  drill::snapshot_launchagents "$LA_AFTER"
  drill::diff_launchagents "$LA_BEFORE" "$LA_AFTER" || STATUS=1
else
  drill::warn "no preflight snapshot at $LA_BEFORE — cannot run the LaunchAgents gate"
  STATUS=1
fi

# --- 4. drill temp homes ----------------------------------------------------
# Only ever the exact homes this drill declared (RAFT_DRILL_HOMES, space
# separated). Never glob-sweep /tmp: an unrelated tool's directory must not be
# removable as collateral of a drill cleanup.
if [[ -n "${RAFT_DRILL_HOMES:-}" ]]; then
  for home in $RAFT_DRILL_HOMES; do
    [[ -n "$home" ]] || continue
    case "$home" in
      /tmp/*) ;;
      *) drill::fail "refusing to remove a drill home outside /tmp: $home"; STATUS=1; continue ;;
    esac
    [[ -d "$home" ]] || continue
    rm -rf "$home"
    if [[ -d "$home" ]]; then
      drill::fail "drill home survived cleanup: $home"
      STATUS=1
    else
      drill::log "drill home removed: $home"
    fi
  done
else
  drill::warn "RAFT_DRILL_HOMES unset — nothing to remove; set it to the exact home(s) this drill created"
fi

# --- 5. operator ref restored ----------------------------------------------
# Restoring the BRANCH matters, not just the commit: a tree left detached makes
# the next `git push` publish a stale local branch while reporting success.
RESTORE_FILE="$WORK/restore-ref.txt"
if [[ -f "$RESTORE_FILE" ]]; then
  want_commit="$(sed -n '1p' "$RESTORE_FILE")"
  want_branch="$(sed -n '2p' "$RESTORE_FILE")"
  have="$(git -C "$REPO" rev-parse HEAD)"
  have_branch="$(git -C "$REPO" symbolic-ref --short -q HEAD 2>/dev/null || echo "")"
  ok=1
  [[ "$have" == "$want_commit" ]] || ok=0
  [[ -z "$want_branch" || "$have_branch" == "$want_branch" ]] || ok=0
  if [[ "$ok" -eq 1 ]]; then
    drill::log "operator ref restored: ${have:0:12}$(printf '%s' "${have_branch:+ (branch $have_branch)}")"
  else
    drill::fail "operator ref not restored: have=${have:0:12}$(printf '%s' "${have_branch:+ ($have_branch)}") want=${want_commit:0:12}$(printf '%s' "${want_branch:+ ($want_branch)}")"
    STATUS=1
  fi
else
  drill::warn "no restore-ref recorded at $RESTORE_FILE — skipping ref-restore check"
fi

if [[ "$STATUS" -ne 0 ]]; then
  drill::fail "postflight found residue — see warnings above; treat the drill as INVALID until explained"
fi
drill::log "POSTFLIGHT OK"