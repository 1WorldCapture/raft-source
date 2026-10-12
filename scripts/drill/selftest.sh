#!/usr/bin/env bash
# Self-test for the drill guards (task #32).
#
#   scripts/drill/selftest.sh
#
# Exercises the guards against a FAKE build and FAKE LaunchAgents directory,
# including the failure paths. The failure cases are the point: a guard that has
# never been seen to fail is not known to work.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

# lib.sh enables errexit for drill scripts. This is a test harness: it must
# accumulate failures and report them all, not die on the first one.
set +e

TMP="$(mktemp -d /tmp/drill-selftest.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

ok()   { printf '  ok   %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL+1)); }

# Run a snippet that is expected to FAIL; returns its exit code.
expect_fail() {
  local label="$1"; shift
  local rc=0
  # `|| rc=$?` keeps this a condition context (so errexit can't fire) while
  # preserving the subshell's real status.
  ( set +e; "$@" ) >/dev/null 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then ok "$label (rejected, rc=$rc)"; else bad "$label (should have been rejected)"; fi
}

echo "== fake dist provenance =="
mkdir -p "$TMP/good"
cat > "$TMP/good/chunk.js" <<'EOF'
function readDaemonProvenance(bakedSha = true ? "46b898887d750e0c0cb1d64c82e091dfc8ce56c5" : void 0) {}
EOF
mkdir -p "$TMP/unknown"
cat > "$TMP/unknown/chunk.js" <<'EOF'
function readDaemonProvenance(bakedSha = true ? "unknown" : void 0) {}
EOF
mkdir -p "$TMP/shapeless"
echo "function somethingElse() {}" > "$TMP/shapeless/chunk.js"

EXPECT=46b898887d750e0c0cb1d64c82e091dfc8ce56c5

got="$(drill::read_baked_commit "$TMP/good")"
[[ "$got" == "$EXPECT" ]] && ok "reads a baked commit" || bad "read '$got' expected '$EXPECT'"

expect_fail "a dist with no baked commit is rejected" drill::read_baked_commit "$TMP/shapeless"
expect_fail "a dist baked as unknown is rejected" drill::assert_dist_provenance "$TMP/unknown" "$EXPECT" test
expect_fail "a stale dist is rejected" drill::assert_dist_provenance "$TMP/good" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" test

# matching provenance passes
( drill::assert_dist_provenance "$TMP/good" "$EXPECT" test ) >/dev/null 2>&1 \
  && ok "matching provenance accepted" || bad "matching provenance was rejected"

echo "== fingerprints =="
fp1="$(drill::fingerprint "$TMP/good")"
fp2="$(drill::fingerprint "$TMP/unknown")"
[[ -n "$fp1" && "$fp1" != "$fp2" ]] && ok "fingerprints differ per content" || bad "fingerprint collision or empty"
[[ "$fp1" == "$(drill::fingerprint "$TMP/good")" ]] && ok "fingerprint is stable" || bad "fingerprint not stable"

echo "== LaunchAgents gate =="
FAKE_LA="$TMP/LaunchAgents"
mkdir -p "$FAKE_LA"
drill::launchagents_path() { printf '%s\n' "$FAKE_LA"; }
touch "$FAKE_LA/a.plist" "$FAKE_LA/b.plist"
drill::snapshot_launchagents "$TMP/before.txt"
drill::snapshot_launchagents "$TMP/after.txt"
drill::diff_launchagents "$TMP/before.txt" "$TMP/after.txt" >/dev/null 2>&1 \
  && ok "identical snapshots pass" || bad "identical snapshots were rejected"
touch "$FAKE_LA/c.plist"
drill::snapshot_launchagents "$TMP/after2.txt"
expect_fail "a changed LaunchAgents snapshot fails the gate" drill::diff_launchagents "$TMP/before.txt" "$TMP/after2.txt"

echo "== process cleanup =="
# Relative-path cmdline is the case that silently failed before.
sleep 30 &
victim=$!
( drill::kill_pid_tree "sleep 30" ) >/dev/null 2>&1
if kill -0 "$victim" 2>/dev/null; then bad "victim process survived cleanup"; else ok "victim process killed"; fi
drill::kill_pid_tree "definitely-not-a-running-pattern-xyz" >/dev/null 2>&1 \
  && ok "no-match cleanup is a no-op" || bad "no-match cleanup failed"

echo
printf 'selftest: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1