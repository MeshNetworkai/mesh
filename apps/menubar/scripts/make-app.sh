#!/bin/sh
# Builds MeshNode.app from the Swift package (no Xcode project needed).
#
#   scripts/make-app.sh                      -> build/MeshNode.app (ad-hoc signed)
#   CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" scripts/make-app.sh
#   VERSION=0.2.0 BUILD=42 scripts/make-app.sh
#   ARCHS="arm64 x86_64" scripts/make-app.sh  -> universal binary (default: arm64 only)
#
# Env: VERSION (default from git tag or 0.1.0), BUILD (default: commit count or 1), BUNDLE_ID
# (default xyz.mesh.menubar), CODESIGN_IDENTITY (default "-" = ad-hoc), ARCHS, OUT (default build).
set -eu

cd "$(dirname "$0")/.."

APP_NAME="MeshNode"
BUNDLE_ID="${BUNDLE_ID:-xyz.mesh.menubar}"
OUT="${OUT:-build}"
ARCHS="${ARCHS:-arm64}"
IDENTITY="${CODESIGN_IDENTITY:--}"

VERSION="${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)}"
VERSION="${VERSION:-0.1.0}"
BUILD="${BUILD:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"

say() { printf '%s\n' "$*"; }

# ---- build ----------------------------------------------------------------
say ".. swift build -c release (${ARCHS})"
ARCH_FLAGS=""
for a in $ARCHS; do ARCH_FLAGS="$ARCH_FLAGS --arch $a"; done
# shellcheck disable=SC2086
swift build -c release $ARCH_FLAGS

# With --arch the products land in .build/apple/Products/Release; without, in .build/release.
BIN=""
for cand in ".build/apple/Products/Release/$APP_NAME" ".build/release/$APP_NAME" "$(swift build -c release $ARCH_FLAGS --show-bin-path 2>/dev/null)/$APP_NAME"; do
  if [ -x "$cand" ]; then BIN="$cand"; break; fi
done
[ -n "$BIN" ] || { say "xx built binary not found"; exit 1; }
say "ok binary $BIN"

# ---- bundle ---------------------------------------------------------------
APP="$OUT/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"
chmod 755 "$APP/Contents/MacOS/$APP_NAME"

sed -e "s|__BUNDLE_ID__|$BUNDLE_ID|g" \
    -e "s|__VERSION__|$VERSION|g" \
    -e "s|__BUILD__|$BUILD|g" \
    Resources/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ -f Resources/AppIcon.icns ]; then
  cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
else
  # No icon yet: drop the key so Finder does not warn about a missing file.
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconFile" "$APP/Contents/Info.plist" 2>/dev/null || true
  say "!! Resources/AppIcon.icns missing; bundle has the generic icon (see docs/MENUBAR.md)"
fi

# ---- sign -----------------------------------------------------------------
if [ "$IDENTITY" = "-" ]; then
  say ".. codesign (ad-hoc; fine for local use, not for distribution)"
  codesign --force --sign - --entitlements Resources/MeshNode.entitlements "$APP"
else
  say ".. codesign with hardened runtime: $IDENTITY"
  codesign --force --deep --options runtime --timestamp \
    --entitlements Resources/MeshNode.entitlements \
    --sign "$IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
fi

say "ok $APP  (version $VERSION build $BUILD, $BUNDLE_ID)"
say "   open $APP"
