#!/bin/sh
# Build a local release APK. Does not use EAS.
# Secrets stay in RAFT_ANDROID_KEYSTORE_PROPERTIES (mode 600, outside the repo).
set -eu

cd "$(dirname "$0")/.."

if [ -z "${EXPO_PUBLIC_RAFT_SERVER_URL:-}" ]; then
  echo "Set EXPO_PUBLIC_RAFT_SERVER_URL to the server origin, with no path." >&2
  exit 1
fi

props="${RAFT_ANDROID_KEYSTORE_PROPERTIES:-}"
if [ -z "$props" ] || [ ! -f "$props" ]; then
  echo "Set RAFT_ANDROID_KEYSTORE_PROPERTIES to the absolute path of a mode 600 properties file." >&2
  exit 1
fi
case "$props" in
  /*) ;;
  *) echo "RAFT_ANDROID_KEYSTORE_PROPERTIES must be an absolute path." >&2; exit 1 ;;
esac

mode=$(stat -f %Lp "$props" 2>/dev/null || stat -c %a "$props")
if [ "$mode" != "600" ]; then
  echo "Refusing to read $props because it is mode $mode, not 600." >&2
  exit 1
fi

npx expo prebuild --platform android --clean --no-install
# Prebuild rewrites the android/ios npm scripts. The release build does not
# want that change, so put package.json back when this is a git checkout.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git checkout -- package.json
fi
cd android
./gradlew assembleRelease

echo "APK: $(pwd)/app/build/outputs/apk/release/app-release.apk"
