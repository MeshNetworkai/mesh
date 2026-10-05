#!/bin/sh
# Builds the Homebrew / manual-install tarball for the node agent and prints its SHA-256.
#
#   scripts/release/make-tarball.sh                       -> dist/release/mesh-node-<version>-darwin-arm64.tar.gz (+ .sha256)
#   VERSION=0.2.0 OUT=dist/release scripts/release/make-tarball.sh
#   SKIP_BUILD=1 scripts/release/make-tarball.sh          -> reuse apps/node-agent/dist/mesh-node.js as is
#
# Tarball layout (one top-level directory, what the formula and install helper expect):
#   mesh-node-<version>/
#     libexec/mesh-node.js   esbuild bundle (needs node >= 18, no node_modules)
#     bin/mesh-node          sh wrapper: resolves node, sets MESH_INSTALL_CHANNEL, execs the bundle
#     install.sh             manual install helper: copies both into ~/.mesh/bin and adds it to PATH
#     README.md              short usage
#     LICENSE                if the repo has one
#
# The bundle is pure JavaScript, so the archive is architecture-independent in practice; it is named
# darwin-arm64 because Apple Silicon is the only platform the node is supported on today.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

say()  { printf '%s\n' "$*"; }
die()  { printf 'xx %s\n' "$*" >&2; exit 1; }

PKG_VERSION="$(node -p "require('./apps/node-agent/package.json').version")"
VERSION="${VERSION:-${GITHUB_REF_NAME:-}}"
VERSION="${VERSION#v}"
VERSION="${VERSION:-$PKG_VERSION}"
OUT="${OUT:-dist/release}"
NAME="mesh-node-$VERSION-darwin-arm64"
STAGE="$OUT/stage/mesh-node-$VERSION"
TARBALL="$OUT/$NAME.tar.gz"

# ---- build ----------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  say ".. building apps/node-agent (version $VERSION)"
  # Stamp the release version into the bundle without editing package.json in the tree.
  (cd apps/node-agent && MESH_BUILD_VERSION="$VERSION" node build.mjs)
fi
BUNDLE="apps/node-agent/dist/mesh-node.js"
[ -f "$BUNDLE" ] || die "$BUNDLE missing (pnpm --filter node-agent build)"
head -c 20 "$BUNDLE" | grep -q '^#!/usr/bin/env node' || die "$BUNDLE does not start with the node shebang"

# ---- stage ----------------------------------------------------------------
rm -rf "$OUT/stage"
mkdir -p "$STAGE/libexec" "$STAGE/bin" "$OUT"
cp "$BUNDLE" "$STAGE/libexec/mesh-node.js"
chmod 755 "$STAGE/libexec/mesh-node.js"

# Wrapper: finds a Node >= 18 (Homebrew's node, ~/.mesh/node from install-node.sh, or PATH).
cat > "$STAGE/bin/mesh-node" <<'EOF'
#!/bin/sh
# mesh-node wrapper (from the release tarball). The bundle next to this file needs Node 18+.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bundle="$here/../libexec/mesh-node.js"
export MESH_HOME="${MESH_HOME:-$HOME/.mesh}"
# Homebrew: brew installs the wrapper into bin/ and the bundle into libexec/ under the Cellar;
# `mesh-node update` then defers to `brew upgrade` instead of writing into the Cellar.
case "$here" in */Cellar/*|*/homebrew/*) export MESH_INSTALL_CHANNEL="${MESH_INSTALL_CHANNEL:-brew}" ;; esac
for cand in "${MESH_NODE_BIN:-}" "$MESH_HOME/node/bin/node" /opt/homebrew/opt/node/bin/node /opt/homebrew/opt/node@20/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  major="$("$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 18 ] 2>/dev/null; then exec "$cand" "$bundle" "$@"; fi
done
echo "mesh-node: Node 18+ not found. Install it (brew install node) or set MESH_NODE_BIN=/path/to/node" >&2
exit 1
EOF
chmod 755 "$STAGE/bin/mesh-node"

# Manual install helper for people who download the tarball directly.
cat > "$STAGE/install.sh" <<'EOF'
#!/bin/sh
# Installs this tarball's mesh-node into ~/.mesh/bin (no sudo). Then: mesh-node setup --link <code>
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
MESH_HOME="${MESH_HOME:-$HOME/.mesh}"
BIN_DIR="$MESH_HOME/bin"
mkdir -p "$BIN_DIR" "$MESH_HOME/logs"
chmod 700 "$MESH_HOME"
cp "$here/libexec/mesh-node.js" "$BIN_DIR/mesh-node.js.tmp" && mv "$BIN_DIR/mesh-node.js.tmp" "$BIN_DIR/mesh-node.js"
chmod 755 "$BIN_DIR/mesh-node.js"
# The installed wrapper points at ~/.mesh/bin/mesh-node.js (same layout as install-node.sh).
sed "s#\$here/../libexec/mesh-node.js#$BIN_DIR/mesh-node.js#" "$here/bin/mesh-node" > "$BIN_DIR/mesh-node"
chmod 755 "$BIN_DIR/mesh-node"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
       [ -f "$rc" ] || continue
       grep -qF "$BIN_DIR" "$rc" 2>/dev/null || printf '\n# mesh node\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
       break
     done ;;
esac
echo "ok installed $BIN_DIR/mesh-node ($("$BIN_DIR/mesh-node" --version 2>/dev/null || echo 'needs Node 18+'))"
echo "   next: mesh-node setup --link <code> --gateway https://<gateway-host>   (code from the web app: Run a node -> Link a Mac)"
echo "         mesh-node service install"
EOF
chmod 755 "$STAGE/install.sh"

cat > "$STAGE/README.md" <<EOF
# mesh-node $VERSION (darwin-arm64)

Run a Mesh inference node on an Apple Silicon Mac. Needs Node 18+ and Ollama.

    ./install.sh                                   # copies into ~/.mesh/bin, adds it to PATH
    mesh-node setup --link <code> --gateway <url>  # code from the web app: Run a node -> Link a Mac
    mesh-node service install                      # background service (launchd), starts at login
    mesh-node status | pause | resume | logs | update

Homebrew users: brew install meshnetworkai/tap/mesh-node (brew upgrade for new versions).
Docs: docs/DISTRIBUTION.md and apps/node-agent/README.md in the repository.
EOF
[ -f LICENSE ] && cp LICENSE "$STAGE/LICENSE"

# ---- pack -----------------------------------------------------------------
rm -f "$TARBALL" "$TARBALL.sha256"
# Deterministic-ish: fixed owner, sorted entries where tar supports it.
if tar --version 2>/dev/null | grep -q GNU; then
  tar -C "$OUT/stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 00:00Z' -czf "$TARBALL" "mesh-node-$VERSION"
else
  (cd "$OUT/stage" && COPYFILE_DISABLE=1 tar -czf "../$NAME.tar.gz" "mesh-node-$VERSION")
fi
rm -rf "$OUT/stage"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
SHA="$(sha256_of "$TARBALL")"
printf '%s  %s\n' "$SHA" "$NAME.tar.gz" > "$TARBALL.sha256"
BUNDLE_SHA="$(sha256_of "$BUNDLE")"
printf '%s  mesh-node.js\n' "$BUNDLE_SHA" > "$OUT/mesh-node.js.sha256"
cp "$BUNDLE" "$OUT/mesh-node.js"

say "ok $TARBALL"
say "   tarball sha256  $SHA"
say "   bundle  sha256  $BUNDLE_SHA   ($OUT/mesh-node.js)"
# Machine-readable for CI: `eval "$(... | grep '^MESH_')"`.
say "MESH_VERSION=$VERSION"
say "MESH_TARBALL=$TARBALL"
say "MESH_TARBALL_SHA256=$SHA"
say "MESH_BUNDLE=$OUT/mesh-node.js"
say "MESH_BUNDLE_SHA256=$BUNDLE_SHA"
