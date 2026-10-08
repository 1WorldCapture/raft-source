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

# Prebuild rewrites the android/ios npm scripts in package.json. Copy the file
# first and put that copy back on success or failure, so uncommitted edits survive.
pkg="$(pwd)/package.json"
backup="$(mktemp)"
cp "$pkg" "$backup"
restore_pkg() {
  exit_status=$?
  trap - EXIT
  if [ -n "${backup:-}" ] && [ -f "$backup" ]; then
    cp "$backup" "$pkg" || exit_status=1
    rm -f "$backup"
  fi
  exit "$exit_status"
}
trap restore_pkg EXIT

npx expo prebuild --platform android --clean --no-install
cd android
./gradlew assembleRelease

echo "APK: $(pwd)/app/build/outputs/apk/release/app-release.apk"
