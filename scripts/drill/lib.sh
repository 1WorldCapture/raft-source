#!/usr/bin/env bash
# Shared guards for isolated drill / observation runs (task #32).
#
# Sourced by scripts/drill/*.sh. Nothing here reads a credential: callers pass
# secrets through the environment, never through this library or a committed
# file.
#
# Design rule for every guard: when the check cannot be satisfied, FAIL LOUDLY.
# A drill whose identity or isolation cannot be proven is worse than no drill,
# because it produces confident numbers from an unverified environment.

set -euo pipefail

# Logs go to STDERR so that stdout carries only function return values. Mixing
# the two silently corrupts every caller that does ORIGINAL_HEAD="$(drill::...)".
drill::log() { printf '[drill] %s\n' "$*" >&2; }
drill::warn() { printf '[drill] WARN: %s\n' "$*" >&2; }
drill::fail() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

drill::require_cmd() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || drill::fail "required command not found: $cmd"
  done
}

# ---------------------------------------------------------------------------
# Working tree / rebuild
# ---------------------------------------------------------------------------

# Refuse to touch a tree that has uncommitted work. Deliberately NOT
# switchable: a bypass here means "overwrite someone's in-progress work", which
# is the one outcome a drill must never produce.
drill::require_clean_tree() {
  local dirty
  dirty="$(git -C "$1" status --porcelain)"
  [[ -z "$dirty" ]] || drill::fail "working tree is dirty; refusing to switch refs (would lose work):
$dirty"
}

# Restore the ref a drill moved the tree to, for paths the build itself cannot
# cover: SIGINT (Ctrl-C), SIGTERM, or the process dying outright.
#
# Restoring the COMMIT alone is not enough. `git checkout <sha>` leaves the
# worktree DETACHED, so a drill that restores by sha silently breaks the next
# `git push` — the push then publishes the stale local BRANCH while reporting
# success. When the tree started on a branch, the branch is what we restore.
drill::restore_ref_trap() {
  local repo="$1" original="$2" original_branch="${3:-}"
  [[ -n "$original" ]] || return 0
  local current current_branch
  current="$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo "")"
  current_branch="$(git -C "$repo" symbolic-ref --short -q HEAD 2>/dev/null || echo "")"
  if [[ -n "$original_branch" ]]; then
    if [[ "$current_branch" == "$original_branch" && "$current" == "$original" ]]; then
      return 0
    fi
    drill::warn "restoring branch $original_branch (was ${current_branch:-detached}@${current:0:12})"
    git -C "$repo" checkout --quiet "$original_branch" 2>/dev/null && return 0
    drill::warn "branch checkout failed; falling back to the exact commit"
  elif [[ -n "$current" && "$current" == "$original" ]]; then
    return 0
  fi
  git -C "$repo" checkout --quiet "$original" 2>/dev/null \
    || drill::fail "could not restore ${original:0:12} — worktree left at ${current:0:12}; recover with: git -C $repo checkout $original"
}

# Rebuild shared + daemon + computer from an exact commit.
#
# Operates in the operator's own worktree rather than a throwaway git worktree.
# That is a deliberate trade-off, documented in scripts/drill/README.md: a
# separate worktree needs its own `pnpm install`, and symlinking the existing
# node_modules makes pnpm resolve workspace packages through the ORIGINAL
# tree's symlinks — so the "isolated" build would silently compile the
# operator's checkout instead. Isolation here comes from refusing a dirty tree
# and guaranteeing the ref is restored, not from a second checkout.
#
# The commit matters: a `dist/` whose package.json version matches the release
# can still have been built from a different commit, and that mismatch once made
# an observation quietly mixed versions. Building all three keeps the shared
# sources in the same frame as the two packages that consume them.
drill::rebuild_at_ref() {
  local repo="$1" ref="$2"
  drill::require_cmd git pnpm node
  drill::require_clean_tree "$repo"

  local before before_branch
  before="$(git -C "$repo" rev-parse HEAD)"
  # Empty when the operator was already detached; then we restore the commit only.
  before_branch="$(git -C "$repo" symbolic-ref --short -q HEAD 2>/dev/null || echo "")"
  drill::log "rebuilding shared+daemon+computer at $ref (was ${before:0:12}${before_branch:+, branch $before_branch})"

  # A dirty tree is refused above; a failed build must not leave the operator on
  # the wrong ref, so restore in all paths.
  if ! git -C "$repo" checkout --quiet --detach "$ref"; then
    drill::fail "cannot check out $ref"
  fi
  # Build chatter goes to stderr so this function's stdout carries ONLY the
  # restore ref — otherwise the caller's `$(...)` capture swallows pnpm output.
  if ! ( cd "$repo" && env -u PI_PACKAGE_DIR pnpm --filter @botiverse/raft-shared --filter @botiverse/raft-daemon --filter @botiverse/raft-computer run build ) >&2; then
    git -C "$repo" checkout --quiet "$before" || true
    drill::fail "build failed at $ref; restored ${before:0:12}"
  fi
  printf '%s\n%s\n' "$before" "$before_branch"
}

# ---------------------------------------------------------------------------
# Build identity
# ---------------------------------------------------------------------------

# Read the commit baked into a built daemon dist by scripts/build-provenance.mjs.
#
# This is intentionally a narrow textual probe. If the bundler renames the
# function the probe stops matching — and that MUST be a hard failure, because
# the alternative (silently skipping identity verification) is the exact class
# of bug this guard exists to catch.
drill::read_baked_commit() {
  local dist_dir="$1"
  local sha
  sha="$(grep -ohE 'bakedSha = [^,]*"[0-9a-f]{7,40}"' -r "$dist_dir" 2>/dev/null | head -1 | grep -oE '[0-9a-f]{7,40}' || true)"
  [[ -n "$sha" ]] || drill::fail "could not read a baked commit from $dist_dir (build provenance missing or bundler changed shape) — refusing to treat this build as identified"
  printf '%s\n' "$sha"
}

# Assert a built dist really came from the expected commit. Version numbers are
# NOT accepted as identity: they come from package.json and repeat across commits.
drill::assert_dist_provenance() {
  local dist_dir="$1" expected="$2" label="${3:-dist}"
  local baked
  baked="$(drill::read_baked_commit "$dist_dir")"
  if [[ "$baked" == "unknown" ]]; then
    drill::fail "$label has no baked commit (built without git) — cannot verify identity; set RAFT_BUILD_COMMIT and rebuild"
  fi
  local expected_short="${expected:0:12}"
  local baked_short="${baked:0:12}"
  [[ "$baked_short" == "$expected_short" ]] \
    || drill::fail "$label provenance mismatch: baked=$baked_short expected=$expected_short (stale or mixed dist)"
  drill::log "$label provenance OK: ${baked_short}"
}

# Content fingerprint, independent of any version string.
drill::fingerprint() {
  local dir="$1"
  find "$dir" -type f -exec shasum {} \; 2>/dev/null | sed "s#$dir/##" | sort | shasum | cut -c1-16
}

# ---------------------------------------------------------------------------
# Endpoint policy
# ---------------------------------------------------------------------------
# Owner directive (2026-10-12): our environments are reached over tailscale
# ONLY, by their `*.ts.net` name — never the public `*.1wc.io` names. This is
# not cosmetic. A drill pointed at 1wc.io can be cut off mid-handshake by a local
# proxy (observed 2026-10-12: mihomo/TUN fake-IP killed TLS right after
# ClientHello, which looked exactly like a broken server). A drill that fails
# that way is indistinguishable from a real finding, so we refuse to start one.
#
# Loopback stays allowed: drills also run against a throwaway server we host
# ourselves in an isolated root, which is the whole point of the isolation work.
drill::assert_tailscale_endpoint() {
  local url="$1" host
  [[ -n "$url" ]] || drill::fail "empty endpoint"
  # `[0-9][0-9]*` rather than `[0-9]\+`: BSD sed (macOS) does not support the
  # GNU `\+` repetition operator and reads it as a literal plus, which silently
  # leaves the port attached and then rejects a perfectly good tailnet host.
  host="$(printf '%s' "$url" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|/.*$||' -e 's|^.*@||' -e 's|:\([0-9][0-9]*\)$||')"
  case "$host" in
    *.ts.net|localhost|127.0.0.1|::1|'[::1]') return 0 ;;
  esac
  # Escape hatch is explicit and loud, so nobody "fixes" a guard by widening it.
  if [[ "${RAFT_DRILL_ALLOW_ANY_ENDPOINT:-}" == "1" ]]; then
    drill::warn "endpoint $host is off-tailnet — allowed because RAFT_DRILL_ALLOW_ANY_ENDPOINT=1"
    return 0
  fi
  drill::fail "endpoint host '$host' is not a *.ts.net tailnet name or loopback.
    Owner policy: environments are reached over tailscale only, not *.1wc.io.
    Point RAFT_TEST_BASE_URL at https://<host>.ts.net:<port>, or set
    RAFT_DRILL_ALLOW_ANY_ENDPOINT=1 if you really mean to bypass this."
}

# ---------------------------------------------------------------------------
# Owner isolation
# ---------------------------------------------------------------------------

drill::launchagents_path() { printf '%s\n' "${HOME}/Library/LaunchAgents"; }

# The owner's real LaunchAgents are off limits. A drill snapshot exists so we can
# PROVE we restored them, not so we can clear them.
drill::snapshot_launchagents() {
  local out="$1"
  ls "$(drill::launchagents_path)" 2>/dev/null | sort > "$out" || true
}

drill::diff_launchagents() {
  local before="$1" after="$2"
  if diff -q "$before" "$after" >/dev/null 2>&1; then
    drill::log "LaunchAgents gate PASS (identical to pre-run snapshot)"
    return 0
  fi
  printf '[drill] FAIL: LaunchAgents differ from pre-run snapshot:\n' >&2
  diff "$before" "$after" >&2 || true
  return 1
}

# Remove only login items rooted in a temp home. Anything else — above all the
# owner's real carrier — is reported and left alone.
drill::remove_tmp_loginitems() {
  local removed=0
  local p h l
  for p in "$(drill::launchagents_path)"/build.raft.computer.login.*.plist; do
    [[ -e "$p" ]] || continue
    h="$(grep -A1 '<key>RAFT_HOME</key>' "$p" 2>/dev/null | grep '<string>' | sed -E 's/.*<string>(.*)<\/string>.*/\1/')"
    case "$h" in
      /tmp/*)
        l="$(basename "$p" .plist | sed 's/^build.raft.computer.login.//')"
        launchctl bootout "gui/$(id -u)/build.raft.computer.login.$l" 2>/dev/null || true
        rm -f "$p" && drill::log "removed drill LaunchAgent $l (RAFT_HOME=$h)" && removed=$((removed+1))
        ;;
      *) drill::warn "leaving non-drill login item untouched: $p (RAFT_HOME=${h:-<none>})" ;;
    esac
  done
  printf '%s\n' "$removed"
}

# ---------------------------------------------------------------------------
# Process cleanup
# ---------------------------------------------------------------------------

# Kill by pid tree. Matching a cmdline substring is not enough: a drill process
# started as `node packages/computer/dist/...` carries a RELATIVE path, so an
# absolute-only pattern silently matches nothing and the process survives
# holding its machine lock.
drill::kill_pid_tree() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  # shellcheck disable=SC2086
  drill::log "killing pids for '$pattern': $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  sleep 2
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [[ -z "$pids" ]] || drill::fail "drill processes still alive after SIGKILL: $(echo "$pids" | tr '\n' ' ')"
  drill::log "no processes remain for '$pattern'"
}