#!/usr/bin/env bash
# Publish a self-hosted Computer release into $RAFT_COMPUTER_WEB_ROOT (nginx
# serves it at /computer/). Contract: publish the version directory and all
# its files, verify them complete, then atomically switch the root latest
# manifest LAST. Everything is validated BEFORE any live change; a failed or
# corrupted publish never moves the current latest pointer.
#
# Usage: publish-computer.sh <staging-dir>
#
# <staging-dir> mirrors the web root layout:
#   <staging-dir>/<version>/manifest.json   per-version manifest (see below)
#   <staging-dir>/<version>/...             binaries and sidecars listed in that manifest
#   <staging-dir>/install.sh                entry script (optional on republish;
#   <staging-dir>/install.ps1               both REQUIRED on the first publish)
#
# Manifest format (packages/computer/scripts/native/produce-manifest.mjs):
#   {"version": "<semver>", "targets": {"<t>": {"file","sha256","size","gz"?}},
#    "photonWasm": {"file","sha256","size"}}
# The `size` field is required (NOT size_bytes — that is the Hands API field).
#
# Rules enforced (review #127):
#   - version dir must be valid SemVer and match the manifest's version field
#   - every referenced file is verified by sha256 AND size; missing or invalid
#     verification fields are refused, never skipped (gzip sidecars included)
#   - no symlinks or special files anywhere in the version dir or entry scripts
#   - the published copy is re-verified by hash after copying, before promote
#   - same version + different content -> refused; identical -> idempotent
#   - first publish must provide BOTH entry scripts; later ones may reuse them
#   - the whole publish runs under an exclusive lock (concurrent publishes
#     serialize; readers always see a complete, verified manifest)
set -eu
source "$(dirname "$0")/lib.sh"

STAGING=${1:?usage: publish-computer.sh <staging-dir> (see header comment)}
[ -d "$STAGING" ] || die "staging dir not found: $STAGING"
STAGING=$(cd "$STAGING" && pwd)
ROOT=${RAFT_COMPUTER_WEB_ROOT:-/srv/raft-computer}
mkdir -p "$ROOT"

# Serialize the entire publish: validation-to-promote must be one critical
# section or two runs can race on the version-dir rename / pointer flip.
LOCK=$RAFT_OPS_HOME/state/publish-computer.lock
exec 9>"$LOCK"
flock 9 || die "another publish-computer.sh is already running"

# --- validate the staging release against its own manifest ---------------------------
# Shared by the staging dir and the copied snapshot (hash-verify the copy, not
# just diff the still-mutable source). Exits non-zero on any problem.
verify_release() {  # verify_release <dir> <expected-version> <what>
  python3 - "$1" "$2" "$3" <<'PY'
import hashlib, json, os, re, stat, sys

vdir, expected_version, what = sys.argv[1], sys.argv[2], sys.argv[3]

def fail(msg):
    print(f"{what}: {msg}"); sys.exit(1)

# No symlinks or special files anywhere in the version dir (including the
# manifest itself): lstat so a link is rejected as a link, not followed.
for name in os.listdir(vdir):
    mode = os.lstat(os.path.join(vdir, name)).st_mode
    if not stat.S_ISREG(mode):
        fail(f"{name} is not a regular file (symlinks/special files are refused)")

try:
    manifest = json.load(open(os.path.join(vdir, "manifest.json")))
except Exception as e:
    fail(f"manifest.json unreadable: {e}")

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
version = manifest.get("version")
if not isinstance(version, str) or not SEMVER.match(version):
    fail(f"manifest version must be SemVer, got {version!r}")
if version != expected_version:
    fail(f"manifest version {version!r} != expected {expected_version!r}")

SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")
referenced = []
def want(entry, label):
    rel = entry.get("file"); sha = entry.get("sha256"); size = entry.get("size")
    if not isinstance(rel, str) or not rel:
        fail(f"{label}: missing file")
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        fail(f"{label}: sha256 must be a 64-hex string (missing/invalid verification data is refused, not skipped)")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        fail(f"{label}: size must be a positive integer")
    if "/" in rel or rel.startswith("."):
        fail(f"{label}: refusing path outside the version dir: {rel}")
    path = os.path.join(vdir, rel)
    if not os.path.isfile(path):
        fail(f"{label}: missing file {rel}")
    data = open(path, "rb").read()
    if hashlib.sha256(data).hexdigest() != sha.lower():
        fail(f"{label}: sha256 mismatch for {rel}")
    if len(data) != size:
        fail(f"{label}: size mismatch for {rel} (manifest {size}, actual {len(data)})")
    referenced.append(rel)

targets = manifest.get("targets")
if not isinstance(targets, dict) or not targets:
    fail("manifest has no targets object")
for target, entry in sorted(targets.items()):
    if not isinstance(entry, dict):
        fail(f"target {target}: not an object")
    want(entry, f"target {target}")
    gz = entry.get("gz")
    if isinstance(gz, dict) and gz.get("file"):
        want(gz, f"target {target} gz")

photon = manifest.get("photonWasm")
if not isinstance(photon, dict):
    fail("manifest missing photonWasm entry")
want(photon, "photonWasm")

extra = set(os.listdir(vdir)) - set(referenced) - {"manifest.json"}
if extra:
    fail(f"unreferenced files in version dir: {', '.join(sorted(extra))}")
print(f"{what}: verified {len(referenced)} artifact(s) for {version}")
PY
}

# --- collect the single version dir ---------------------------------------------------
versions=()
for f in "$STAGING"/*/; do
  f=${f%/}
  [ -e "$f" ] || continue
  # The version dir itself must be a real directory, not a link: -d follows
  # symlinks, so check -L first.
  [ -L "$f" ] && die "staging entry $(basename "$f") is a symbolic link (refused)"
  [ -d "$f" ] || continue
  case "$(basename "$f")" in
    [0-9]*) versions+=("$(basename "$f")") ;;
  esac
done
[ "${#versions[@]}" -eq 1 ] || die "staging must contain exactly one <version>/ dir (found: ${versions[*]:-none})"
VERSION=${versions[0]}
VDIR=$STAGING/$VERSION

verify_release "$VDIR" "$VERSION" "staging" || die "staging validation failed for $VERSION (nothing published)"

# --- entry scripts: validate BEFORE any live change -----------------------------------
# First publish must carry BOTH entry scripts; later publishes may omit them
# (the confirmed published entries are reused).
have_sh=0; have_ps1=0
[ -f "$ROOT/install.sh" ] && have_sh=1
[ -f "$ROOT/install.ps1" ] && have_ps1=1
stage_sh=0; stage_ps1=0
[ -f "$STAGING/install.sh" ] && stage_sh=1
[ -f "$STAGING/install.ps1" ] && stage_ps1=1
[ $((have_sh || stage_sh)) -eq 1 ] || die "first publish must provide install.sh"
[ $((have_ps1 || stage_ps1)) -eq 1 ] || die "first publish must provide install.ps1"
python3 - "$STAGING" <<'PY' || die "entry script validation failed (nothing published)"
import os, stat, sys
staging = sys.argv[1]
for name in ("install.sh", "install.ps1"):
    path = os.path.join(staging, name)
    if not os.path.exists(path):
        continue
    if not stat.S_ISREG(os.lstat(path).st_mode):
        print(f"{name}: not a regular file (symlinks/special files are refused)"); sys.exit(1)
    if os.path.getsize(path) == 0:
        print(f"{name}: empty (refused)"); sys.exit(1)
PY

trap 'rm -f "$ROOT/.manifest.json.flip.$$"; rm -rf "$ROOT/.publish-$VERSION.$$"' EXIT

# --- build controlled snapshots of EVERYTHING that will be promoted --------------------
# All validation (including entry-script shellcheck) must finish before any
# live change, and it must validate the exact bytes that get promoted — so
# promote snapshots, never the still-mutable staging sources.
SNAP=$ROOT/.publish-$VERSION.$$
rm -rf "$SNAP"; mkdir -p "$SNAP"
cp -R "$VDIR" "$SNAP/version"
[ ! -L "$SNAP/version" ] && [ -d "$SNAP/version" ] || die "version snapshot is not a real directory (symlinks refused)"
# Hash-verify the isolated snapshot, not the still-mutable source (TOCTOU).
verify_release "$SNAP/version" "$VERSION" "snapshot" || die "snapshot verification failed for $VERSION (nothing published)"
for script in install.sh install.ps1; do
  [ -f "$STAGING/$script" ] || continue
  cp "$STAGING/$script" "$SNAP/$script"
  chmod a-w "$SNAP/$script"
done
# shellcheck the exact snapshot copy that would go live (best effort: only
# when shellcheck is installed on this host).
if [ -f "$SNAP/install.sh" ] && command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$SNAP/install.sh" || die "install.sh failed shellcheck (nothing published: version dir, entries and latest all untouched)"
fi

# --- publish the version dir: identical -> no-op, divergent -> refuse ------------------
dest=$ROOT/$VERSION
if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
  die "$dest exists but is not a real directory (symlinks/special files refused)"
elif [ -d "$dest" ]; then
  if [ "$VERSION" = "$(python3 -c "import json;print(json.load(open('$dest/manifest.json'))['version'])" 2>/dev/null)" ] \
     && diff -r --no-dereference "$SNAP/version" "$dest" >/dev/null 2>&1; then
    log "version $VERSION already published with identical content (idempotent)"
  else
    die "version $VERSION already published with DIFFERENT content; version dirs are immutable — bump the version instead"
  fi
else
  chmod -R a-w "$SNAP/version"
  # -T: never nest the snapshot inside a concurrently-created dest (same
  # convention as switch_web in lib.sh).
  mv -T "$SNAP/version" "$dest"
  log "published immutable version dir $dest"
fi

# --- entry scripts: promote the validated snapshot copies ------------------------------
for script in install.sh install.ps1; do
  [ -f "$SNAP/$script" ] || continue
  dst=$ROOT/$script
  if [ -f "$dst" ] && cmp -s "$SNAP/$script" "$dst"; then
    log "$script unchanged"
  else
    mv -f "$SNAP/$script" "$dst"
    log "$script updated (sha256 $(sha256sum "$dst" 2>/dev/null | cut -c1-12 || shasum -a 256 "$dst" | cut -c1-12))"
  fi
done

# --- flip the latest pointer LAST ------------------------------------------------------
python3 - "$ROOT" "$VERSION" "$$" <<'PY' || die "latest pointer flip failed (version dir remains published)"
import json, os, sys
root, version, pid = sys.argv[1], sys.argv[2], sys.argv[3]
tmp = os.path.join(root, f".manifest.json.flip.{pid}")
with open(tmp, "w") as f:
    json.dump({"version": version}, f)
    f.write("\n")
json.load(open(tmp))  # parse it back before it becomes the pointer
os.replace(tmp, os.path.join(root, "manifest.json"))
print(f"latest pointer -> {version}")
PY

# --- read back ------------------------------------------------------------------------
python3 -c "import json;print('latest is now', json.load(open('$ROOT/manifest.json'))['version'])"
log "publish complete: /computer/ serves $VERSION"
