#!/bin/sh
# Publishes the Android companion as a GitHub release that installed apps offer as an update
# (android/README.md, "In-app updates"). Run on sky-server from a clean, pushed checkout:
#
#   scripts/release-android.sh ["release notes"]
#
# Builds android/ in a JDK 17 container with the cached SDK, signs it with the host debug key
# (~/.android/debug.keystore: the key every installed copy carries, so Android accepts the
# update), checks that certificate, and creates the release `android-v<versionName>` with the
# asset `infovore-<versionName>-<versionCode>.apk`. Also copies it to ~/apk-share when present.
# The signing key never leaves this machine. Notes default to the android/ commits since the
# previous release.
set -eu

EXPECTED_CERT=27679e8219ec059fbaafd1f691d5f1a129746723f73682ac008339667f4e7b62
SDK=${ANDROID_SDK_CACHE:-$HOME/.cache/infovore-android-sdk}
ANDROID_USER=${ANDROID_USER_DIR:-$HOME/.android}
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

fail() { echo "release-android: $*" >&2; exit 1; }

name=$(sed -n 's/.*versionName = "\([^"]*\)".*/\1/p' android/app/build.gradle.kts)
code=$(sed -n 's/.*versionCode = \([0-9]*\).*/\1/p' android/app/build.gradle.kts)
[ -n "$name" ] && [ -n "$code" ] || fail "cannot read versionName/versionCode"
tag="android-v$name"
asset="infovore-$name-$code.apk"

[ -z "$(git status --porcelain -- android)" ] || fail "android/ has uncommitted changes"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || fail "HEAD is not the pushed upstream; push first"
gh release view "$tag" >/dev/null 2>&1 && fail "$tag is already released; bump versionName and versionCode"
[ -f "$ANDROID_USER/debug.keystore" ] || fail "missing $ANDROID_USER/debug.keystore"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GRADLE_USER_HOME=/gradle -e ANDROID_HOME=/sdk \
  -e ANDROID_USER_HOME=/android-user -v "$ANDROID_USER:/android-user" \
  -v "$SDK:/sdk" -v "$HOME/.gradle:/gradle" -v "$repo:/repo" \
  -w /repo/android eclipse-temurin:17-jdk ./gradlew --no-daemon -q assembleDebug

apk="$repo/android/app/build/outputs/apk/debug/app-debug.apk"
build_tools=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)
cert=$(docker run --rm -v "$build_tools:/bt" -v "$(dirname "$apk"):/a" eclipse-temurin:17-jdk \
  /bt/apksigner verify --print-certs /a/app-debug.apk | sed -n 's/.*SHA-256 digest: //p' | head -1)
[ "$cert" = "$EXPECTED_CERT" ] || fail "APK signed with $cert, expected $EXPECTED_CERT; it would not install over the phone's copy"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cp "$apk" "$out/$asset"

if [ $# -gt 0 ]; then
  notes=$1
else
  previous=$(git tag --list 'android-v*' --sort=-creatordate | head -1)
  notes=$(git log --format='- %s' ${previous:+"$previous"..}HEAD -- android | head -20)
  [ -n "$notes" ] || notes="- Infovore Android $name"
fi

gh release create "$tag" "$out/$asset" --target "$(git rev-parse HEAD)" \
  --title "Infovore Android $name" --notes "$notes"
git fetch -q --tags origin

if [ -d "$HOME/apk-share" ]; then
  cp "$out/$asset" "$HOME/apk-share/infovore-$name-$(git rev-parse --short HEAD).apk"
fi
echo "released $tag ($asset, cert ok)"
