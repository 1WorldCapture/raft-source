#!/bin/sh
# Guard: build artifacts must never enter the repo (two near-misses with
# dist-native, one real miss with dist-selfhost — PM review, PR #166;
# desktop release/ joined in task #12: ~1GB of dmg/zip per arch).
# Fails when the git index (the next commit) contains any known build-output path.
set -eu

PATTERNS="packages/computer/dist-native packages/daemon/dist-selfhost packages/daemon/dist packages/cli/dist apps/raft-desktop-electron/release"

# The INDEX is what the next commit will contain — the single source of
# truth for "is an artifact about to land". (Checking HEAD as well would
# block the very commit that removes a past mistake.)
tracked=$(git ls-files 2>/dev/null || true)

status=0
for path in $tracked; do
  for pattern in $PATTERNS; do
    case "$path" in
      "$pattern"/*)
        echo "check-no-build-artifacts: build artifact tracked: $path" >&2
        status=1
        ;;
    esac
  done
done
exit $status
