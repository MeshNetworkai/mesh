#!/bin/sh
# Wraps build/MeshNode.app in a DMG with an Applications shortcut and writes a .sha256 next to it.
# Signing and notarisation are optional (env): the default output is an UNSIGNED beta build that users
# open through System Settings > Privacy & Security > Open Anyway (docs/MENUBAR.md, docs/DISTRIBUTION.md).
#
#   scripts/make-dmg.sh                                   -> build/MeshNode-<version>-<arch>.dmg + .sha256
#   CODESIGN_IDENTITY="Developer ID Application: ..." scripts/make-dmg.sh   -> signed DMG
#   NOTARY_PROFILE=mesh-notary scripts/make-dmg.sh        -> also notarise + staple
#   ARCH=arm64 (default; matches make-app.sh ARCHS; use "universal" for ARCHS="arm64 x86_64")
#
# NOTARY_PROFILE is a keychain profile created once with:
#   xcrun notarytool store-credentials mesh-notary --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
set -eu

cd "$(dirname "$0")/.."

APP_NAME="MeshNode"
OUT="${OUT:-build}"
APP="$OUT/$APP_NAME.app"
[ -d "$APP" ] || { echo "xx $APP not found; run make app first" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCH="${ARCH:-}"
if [ -z "$ARCH" ]; then
  case "${ARCHS:-arm64}" in *arm64*x86_64*|*x86_64*arm64*) ARCH=universal ;; *x86_64*) ARCH=x86_64 ;; *) ARCH=arm64 ;; esac
fi
DMG="$OUT/$APP_NAME-$VERSION-$ARCH.dmg"
STAGE="$OUT/dmg-stage"

rm -rf "$STAGE" "$DMG" "$DMG.sha256"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo ".. hdiutil create $DMG"
hdiutil create -volname "Mesh Node" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$DMG" >/dev/null
rm -rf "$STAGE"

if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
  echo ".. codesign dmg"
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
else
  echo "!! unsigned DMG (no CODESIGN_IDENTITY): macOS will say it cannot verify the developer; users open it via"
  echo "   System Settings > Privacy & Security > Open Anyway. See docs/MENUBAR.md section 3."
fi

if [ -n "${NOTARY_PROFILE:-}" ]; then
  echo ".. notarytool submit (this waits for Apple; usually 1-5 minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  echo ".. stapler"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  # Gatekeeper dry run: what a user's Mac will say on first open.
  spctl --assess --type open --context context:primary-signature -v "$DMG" || true
fi

# Checksum file: `<sha256>  <filename>` (shasum -c compatible); the release workflow puts the same hash in latest.json.
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "ok $DMG"
echo "   sha256 $(cut -d' ' -f1 "$DMG.sha256")  ($DMG.sha256)"
