#!/bin/sh
# Rewrites url (carries the version) and sha256 in homebrew-tap/Formula/mesh-node.rb for a release.
#
#   scripts/release/update-formula.sh <version> <tarball-url> <sha256> [formula-path]
#
# Used by .github/workflows/release.yml after the tarball is built; the result is committed to this
# repo and pushed to the mesh-network/homebrew-tap repository (docs/DISTRIBUTION.md).
set -eu
VERSION="${1:?version}"; VERSION="${VERSION#v}"
URL="${2:?tarball url}"
SHA="${3:?sha256}"
FORMULA="${4:-$(cd "$(dirname "$0")/../.." && pwd)/homebrew-tap/Formula/mesh-node.rb}"
[ -f "$FORMULA" ] || { echo "xx $FORMULA not found" >&2; exit 1; }
echo "$SHA" | grep -Eq '^[0-9a-f]{64}$' || { echo "xx sha256 must be 64 hex chars" >&2; exit 1; }
tmp="$FORMULA.tmp"
sed -e "s|^  url \".*\"$|  url \"$URL\"|" \
    -e "s|^  version \".*\"$|  version \"$VERSION\"|" \
    -e "s|^  sha256 \".*\"$|  sha256 \"$SHA\"|" \
    "$FORMULA" > "$tmp"
mv "$tmp" "$FORMULA"
grep -E '^  (url|version|sha256) ' "$FORMULA"
