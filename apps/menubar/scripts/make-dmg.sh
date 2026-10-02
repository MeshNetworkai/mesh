#!/bin/sh
# Wraps build/MeshNode.app in a DMG with an Applications shortcut, then (optionally) notarises
# and staples it.
#
#   scripts/make-dmg.sh                                   -> build/MeshNode-<version>.dmg
#   NOTARY_PROFILE=mesh-notary scripts/make-dmg.sh        -> also notarise + staple
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
DMG="$OUT/$APP_NAME-$VERSION.dmg"
STAGE="$OUT/dmg-stage"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo ".. hdiutil create $DMG"
hdiutil create -volname "Mesh Node" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$DMG" >/dev/null
rm -rf "$STAGE"

if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
  echo ".. codesign dmg"
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
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

echo "ok $DMG"
