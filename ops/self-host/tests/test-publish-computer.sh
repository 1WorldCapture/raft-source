#!/usr/bin/env bash
# Regression tests for ops/self-host/publish-computer.sh (PR #127 review).
# Runs on the deploy host (needs GNU coreutils: flock, mv -T, diff
# --no-dereference). Usage: tests/test-publish-computer.sh — exits non-zero on
# the first failure. Everything happens in a throwaway temp root.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OPS=$HERE/..
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"/root "$WORK"/ops/state

cat > "$WORK/env.local" <<EOF
RAFT_ROOT=$WORK/none
RAFT_OPS_HOME=$WORK/ops
RAFT_WEB_RELEASES=$WORK/webrel
RAFT_WEB_CURRENT=$WORK/webcur
RAFT_SERVER_PORT=3101
RAFT_COMPUTER_WEB_ROOT=$WORK/root
NODE_BIN_DIR=/usr/bin:/bin
EOF
export RAFT_OPS_ENV=$WORK/env.local

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
latest() { python3 -c "import json;print(json.load(open('$WORK/root/manifest.json'))['version'])" 2>/dev/null || echo NONE; }

# stage_version <dir> <version> [--no-sha|--wrong-size|--version-field=X|--no-photon]
stage_version() {
  local dir=$1 version=$2; shift 2
  local no_sha=0 wrong_size=0 version_field=$version no_photon=0
  for a in "$@"; do
    case $a in
      --no-sha) no_sha=1 ;;
      --wrong-size) wrong_size=1 ;;
      --version-field=*) version_field=${a#*=} ;;
      --no-photon) no_photon=1 ;;
    esac
  done
  mkdir -p "$dir/$version"
  printf 'bin-a' > "$dir/$version/raft-computer-darwin-arm64"
  printf 'bin-b' > "$dir/$version/raft-computer-linux-x64"
  [ $no_photon -eq 1 ] || printf 'wasm' > "$dir/$version/photon_rs_bg.wasm"
  python3 - "$dir/$version" "$version_field" "$no_sha" "$wrong_size" "$no_photon" <<'PY'
import hashlib, json, os, sys
d, version, no_sha, wrong_size, no_photon = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
def e(f):
    p = os.path.join(d, f); data = open(p, "rb").read()
    entry = {"file": f, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data) if not wrong_size else len(data)+999}
    if no_sha: del entry["sha256"]
    return entry
m = {"version": version, "targets": {"darwin-arm64": e("raft-computer-darwin-arm64"), "linux-x64": e("raft-computer-linux-x64")}}
if not no_photon: m["photonWasm"] = e("photon_rs_bg.wasm")
json.dump(m, open(os.path.join(d, "manifest.json"), "w"))
PY
}
entry_scripts() {  # entry_scripts <dir>
  printf '#!/bin/sh\necho contract install\n' > "$1/install.sh"
  printf 'Write-Output "contract install"\n' > "$1/install.ps1"
}
run() { "$@" >/dev/null 2>&1; }

echo "T1 valid publish"
stage_version "$WORK/stage1" 1.2.3; entry_scripts "$WORK/stage1"
run "$OPS/publish-computer.sh" "$WORK/stage1" && [ "$(latest)" = "1.2.3" ] && ok "published, latest=1.2.3" || bad "valid publish"

echo "T2 missing sha256 -> refused, latest unchanged"
stage_version "$WORK/stage2" 2.0.0 --no-sha; entry_scripts "$WORK/stage2"
! run "$OPS/publish-computer.sh" "$WORK/stage2" && [ "$(latest)" = "1.2.3" ] && ok "refused" || bad "missing sha must refuse and keep latest"

echo "T3 wrong size -> refused, latest unchanged"
stage_version "$WORK/stage3" 2.0.0 --wrong-size; entry_scripts "$WORK/stage3"
! run "$OPS/publish-computer.sh" "$WORK/stage3" && [ "$(latest)" = "1.2.3" ] && ok "refused" || bad "wrong size must refuse and keep latest"

echo "T4 manifest version != dir name -> refused"
stage_version "$WORK/stage4" 2.0.0 --version-field=9.9.9; entry_scripts "$WORK/stage4"
! run "$OPS/publish-computer.sh" "$WORK/stage4" && [ "$(latest)" = "1.2.3" ] && ok "refused" || bad "version mismatch must refuse"

echo "T5 non-semver dir name -> refused"
mkdir -p "$WORK/stage5"; cp -R "$WORK/stage1/1.2.3" "$WORK/stage5/1oops"; entry_scripts "$WORK/stage5"
! run "$OPS/publish-computer.sh" "$WORK/stage5" && ok "refused" || bad "non-semver dir must refuse"

echo "T6 symlinked artifact -> refused"
stage_version "$WORK/stage6" 2.0.0
rm "$WORK/stage6/2.0.0/raft-computer-linux-x64"
ln -s "$WORK/stage1/1.2.3/raft-computer-linux-x64" "$WORK/stage6/2.0.0/raft-computer-linux-x64"
entry_scripts "$WORK/stage6"
! run "$OPS/publish-computer.sh" "$WORK/stage6" && [ "$(latest)" = "1.2.3" ] && ok "refused" || bad "symlink artifact must refuse"

echo "T7 first publish without entry scripts -> refused"
stage_version "$WORK/stage7" 2.0.0
sed "s|RAFT_COMPUTER_WEB_ROOT=.*|RAFT_COMPUTER_WEB_ROOT=$WORK/fresh-root|" "$WORK/env.local" > "$WORK/env.fresh"
mkdir -p "$WORK/fresh-root"
out=$(RAFT_OPS_ENV=$WORK/env.fresh "$OPS/publish-computer.sh" "$WORK/stage7" 2>&1) && bad "missing entries must refuse" || true
case "$out" in *install.sh*) ok "refused: $out" ;; *) bad "expected install.sh requirement, got: $out" ;; esac
[ ! -f "$WORK/fresh-root/manifest.json" ] && ok "fresh root latest untouched" || bad "fresh root must not gain a latest pointer"

echo "T8 same version, divergent content -> refused; identical -> idempotent"
stage_version "$WORK/stage8" 1.2.4; entry_scripts "$WORK/stage8"
run "$OPS/publish-computer.sh" "$WORK/stage8" && [ "$(latest)" = "1.2.4" ] || bad "publish 1.2.4"
printf 'tampered' > "$WORK/stage8/1.2.4/raft-computer-darwin-arm64"
python3 - "$WORK/stage8/1.2.4" <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]; m = json.load(open(d + "/manifest.json")); p = d + "/raft-computer-darwin-arm64"
data = open(p, "rb").read()
m["targets"]["darwin-arm64"].update(sha256=hashlib.sha256(data).hexdigest(), size=len(data))
json.dump(m, open(d + "/manifest.json", "w"))
PY
! run "$OPS/publish-computer.sh" "$WORK/stage8" && [ "$(latest)" = "1.2.4" ] && [ "$(cat "$WORK/root/1.2.4/raft-computer-darwin-arm64")" = "bin-a" ] \
  && ok "divergent refused, live dir untouched" || bad "divergent same-version must refuse"

echo "T9 concurrent publishes -> latest always a complete manifest"
stage_version "$WORK/stage9a" 3.0.0; entry_scripts "$WORK/stage9a"
stage_version "$WORK/stage9b" 3.0.1; entry_scripts "$WORK/stage9b"
( "$OPS/publish-computer.sh" "$WORK/stage9a" >/dev/null 2>&1 ) &
( "$OPS/publish-computer.sh" "$WORK/stage9b" >/dev/null 2>&1 ) &
CONCURRENT_OK=1
for _ in $(seq 1 40); do
  v=$(latest); case $v in 1.2.4|3.0.0|3.0.1) ;; *) CONCURRENT_OK=0; echo "  observed broken latest: $v" ;; esac
  sleep 0.05
done
wait
final=$(latest); { [ "$final" = "3.0.0" ] || [ "$final" = "3.0.1" ]; } && [ $CONCURRENT_OK -eq 1 ] \
  && ok "serialized, final=$final, no broken reads" || bad "concurrency: final=$final CONCURRENT_OK=$CONCURRENT_OK"

echo "T10 corrupted binary -> refused, latest unchanged"
stage_version "$WORK/stage10" 4.0.0; entry_scripts "$WORK/stage10"
printf 'corrupt' > "$WORK/stage10/4.0.0/raft-computer-darwin-arm64"
! run "$OPS/publish-computer.sh" "$WORK/stage10" && [ "$(latest)" = "$final" ] && ok "refused" || bad "corrupted binary must refuse"

echo "T11 version dir itself a symlink -> refused"
mkdir -p "$WORK/stage11"
ln -s "$WORK/stage1/1.2.3" "$WORK/stage11/5.0.0"
entry_scripts "$WORK/stage11"
! run "$OPS/publish-computer.sh" "$WORK/stage11" && [ "$(latest)" = "$final" ] && ok "refused" || bad "symlinked version dir must refuse"

if command -v shellcheck >/dev/null 2>&1; then
echo "T12 shellcheck-failing install.sh -> NOTHING published"
stage_version "$WORK/stage12" 6.0.0
printf '#!/bin/sh\nif [ $1 ]; then echo "$((1+))"\nfi\n' > "$WORK/stage12/install.sh"
printf 'x\n' > "$WORK/stage12/install.ps1"
before_root=$(ls -A "$WORK/root")
! run "$OPS/publish-computer.sh" "$WORK/stage12" \
  && [ "$(latest)" = "$final" ] \
  && [ "$before_root" = "$(ls -A "$WORK/root")" ] \
  && ok "version dir, entries and latest all untouched" || bad "shellcheck failure must publish nothing"
else
echo "T12 skipped (no shellcheck on this host)"
fi

echo "T13 already-published dest is a symlink -> refused"
mkdir -p "$WORK/root2/real" && stage_version "$WORK/stage13" 7.0.0 >/dev/null 2>&1
sed "s|RAFT_COMPUTER_WEB_ROOT=.*|RAFT_COMPUTER_WEB_ROOT=$WORK/root2|" "$WORK/env.local" > "$WORK/env.root2"
ln -s "$WORK/root2/real" "$WORK/root2/7.0.0"
entry_scripts "$WORK/stage13"
out=$(RAFT_OPS_ENV=$WORK/env.root2 "$OPS/publish-computer.sh" "$WORK/stage13" 2>&1) && bad "symlinked dest must refuse" || true
case "$out" in *"not a real directory"*) ok "refused" ;; *) bad "unexpected: $out" ;; esac

echo
echo "passed=$PASS failed=$FAIL"
[ $FAIL -eq 0 ]
