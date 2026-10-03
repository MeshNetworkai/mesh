#!/bin/sh
# Mesh node installer.
#   curl -fsSL https://<web-host>/install-node.sh | sh -s -- --link <code> --gateway https://<gateway-host>
#
# Flags
#   --link <code>         one-time link code from the web app (Run a node -> "Link a Mac"; your wallet signs
#                         there, this Mac never holds a key). Also: MESH_LINK_CODE. Required unless --wallet.
#   --wallet <addr>       legacy: register unsigned to this wallet (only on gateways with
#                         NODES_REQUIRE_SIGNATURE=false). Also: MESH_WALLET.
#   --gateway <url>       gateway URL (default: $GATEWAY_URL or http://localhost:8787)
#   --web <origin>        web app origin; used as a fallback source for mesh-node.js (<origin>/mesh-node.js)
#   --from-local <path>   install a local build of mesh-node.js instead of downloading
#   --bundle-url <url>    explicit URL of mesh-node.js (also: MESH_BUNDLE_URL)
#   --no-service          run setup but do not install the launchd agent
#   --with-70b            also pull llama3.1:70b on 64 GB+ machines
#
# Idempotent: re-running updates the bundle, re-registers the node and reloads the service.
set -eu

MESH_HOME="${MESH_HOME:-$HOME/.mesh}"
BIN_DIR="$MESH_HOME/bin"
WALLET="${MESH_WALLET:-}"
LINK="${MESH_LINK_CODE:-}"
GATEWAY="${GATEWAY_URL:-http://localhost:8787}"
WEB="${MESH_WEB_URL:-}"
FROM_LOCAL=""
BUNDLE_URL="${MESH_BUNDLE_URL:-}"
SERVICE=1
EXTRA_SETUP=""

say()  { printf '%s\n' "$*"; }
ok()   { printf 'ok %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die()  { printf 'xx %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --link) LINK="$2"; shift 2 ;;
    --link=*) LINK="${1#*=}"; shift ;;
    --wallet) WALLET="$2"; shift 2 ;;
    --wallet=*) WALLET="${1#*=}"; shift ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --gateway=*) GATEWAY="${1#*=}"; shift ;;
    --web) WEB="$2"; shift 2 ;;
    --web=*) WEB="${1#*=}"; shift ;;
    --from-local) FROM_LOCAL="$2"; shift 2 ;;
    --from-local=*) FROM_LOCAL="${1#*=}"; shift ;;
    --bundle-url) BUNDLE_URL="$2"; shift 2 ;;
    --bundle-url=*) BUNDLE_URL="${1#*=}"; shift ;;
    --no-service) SERVICE=0; shift ;;
    --with-70b) EXTRA_SETUP="$EXTRA_SETUP --with-70b"; shift ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

GATEWAY="${GATEWAY%/}"
if [ -z "$LINK" ] && [ -z "$WALLET" ]; then
  die "--link <code> is required: open the Mesh app, Run a node -> \"Link a Mac\", and paste the code (or --wallet <addr> on a gateway that allows unsigned registration)"
fi

say ""
say "Mesh node installer"
if [ -n "$LINK" ]; then
  say "  link     $LINK  (wallet signed in the browser)"
else
  say "  wallet   $WALLET  (legacy unsigned registration)"
fi
say "  gateway  $GATEWAY"
say "  home     $MESH_HOME"
say ""

# ---- platform -------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    if [ "$ARCH" != "arm64" ]; then
      die "Mesh nodes run on Apple Silicon Macs only (detected $ARCH). Intel Macs are not supported."
    fi
    # If this shell itself is running under Rosetta, every child inherits x86_64. Refuse early with the fix.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      die "This Terminal is running under Rosetta (Intel emulation). Quit Terminal, right-click it in Applications > Utilities, Get Info, untick 'Open using Rosetta', then re-run."
    fi
    ok "macOS on Apple Silicon"
    ;;
  Linux)
    warn "Linux detected: install proceeds, but 'service install' (launchd) is macOS-only. Run 'mesh-node start' under systemd or tmux."
    ;;
  *) die "unsupported OS: $OS (macOS Apple Silicon is the target)" ;;
esac

# ---- node >= 18, native arm64 only ------------------------------------------
# A Node built for Intel (installed before the Mac was upgraded, or via an x86 Homebrew in /usr/local)
# fails with "Bad CPU type in executable" or runs slowly under Rosetta. We only accept a native arm64 Node;
# if none exists we download the official Apple Silicon build into ~/.mesh/node (no sudo, no Homebrew needed).
node_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
node_arch()  { "$1" -p 'process.arch' 2>/dev/null; }
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major="$(node_major "$1")"; [ -n "$major" ] && [ "$major" -ge 18 ] || return 1
  if [ "$OS" = "Darwin" ]; then [ "$(node_arch "$1")" = "arm64" ] || return 1; fi
  return 0
}
NODE_BIN=""
for cand in "$MESH_HOME/node/bin/node" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /opt/homebrew/opt/node@20/bin/node /usr/local/bin/node; do
  if node_ok "$cand"; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ] && [ "$OS" = "Darwin" ]; then
  existing="$(command -v node 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    warn "found $existing but it is $(node_arch "$existing" || echo unknown)/v$(node_major "$existing" || echo ?) — not a native Apple Silicon Node 18+. Installing a private native copy for Mesh."
  fi
  NODE_VER="${MESH_NODE_VERSION:-v20.18.0}"
  say ".. downloading Node $NODE_VER (darwin-arm64) into $MESH_HOME/node"
  mkdir -p "$MESH_HOME"
  NODE_TGZ="$MESH_HOME/node.tgz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" -o "$NODE_TGZ" || die "could not download Node from nodejs.org"
  else
    die "need curl to download Node"
  fi
  rm -rf "$MESH_HOME/node" && mkdir -p "$MESH_HOME/node"
  tar -xzf "$NODE_TGZ" -C "$MESH_HOME/node" --strip-components=1 || die "could not unpack Node"
  rm -f "$NODE_TGZ"
  NODE_BIN="$MESH_HOME/node/bin/node"
  node_ok "$NODE_BIN" || die "downloaded Node did not run; please report this"
fi
if [ -z "$NODE_BIN" ] && [ "$OS" = "Linux" ]; then
  die "Node 18+ not found. Install it from https://nodejs.org and re-run."
fi
ok "node $("$NODE_BIN" -v) ($(node_arch "$NODE_BIN")) at $NODE_BIN"

# ---- fetch mesh-node.js ----------------------------------------------------
mkdir -p "$BIN_DIR" "$MESH_HOME/logs"
chmod 700 "$MESH_HOME"
TMP="$BIN_DIR/mesh-node.js.tmp"
rm -f "$TMP"

fetch() { # url -> $TMP ; returns non-zero on failure or on a non-JS body (e.g. an HTML 404 page)
  if command -v curl >/dev/null 2>&1; then
    curl -fsL "$1" -o "$TMP" 2>/dev/null || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP" "$1" 2>/dev/null || return 1
  else
    die "need curl or wget"
  fi
  head -c 64 "$TMP" | grep -q -e '^#!/usr/bin/env node' -e '^//' -e '^import' -e '^"use strict"' || { rm -f "$TMP"; return 1; }
}

SOURCE=""
if [ -n "$FROM_LOCAL" ]; then
  [ -f "$FROM_LOCAL" ] || die "--from-local: $FROM_LOCAL does not exist"
  cp "$FROM_LOCAL" "$TMP"
  SOURCE="$FROM_LOCAL"
else
  for url in \
    ${BUNDLE_URL:+"$BUNDLE_URL"} \
    "$GATEWAY/install/mesh-node.js" \
    ${WEB:+"${WEB%/}/mesh-node.js"}; do
    say ".. downloading $url"
    if fetch "$url"; then SOURCE="$url"; break; fi
    warn "not available: $url"
  done
fi
if [ -z "$SOURCE" ]; then
  say "" >&2
  say "Could not download mesh-node.js. Options:" >&2
  say "  - pass --web https://<web-host>   (the app serves /mesh-node.js)" >&2
  say "  - pass --bundle-url <url>         (any URL hosting mesh-node.js)" >&2
  say "  - build it: pnpm --filter node-agent build, then re-run with --from-local apps/node-agent/dist/mesh-node.js" >&2
  exit 1
fi
mv "$TMP" "$BIN_DIR/mesh-node.js"
chmod 755 "$BIN_DIR/mesh-node.js"
ok "installed $BIN_DIR/mesh-node.js (from $SOURCE)"

# ---- wrapper ---------------------------------------------------------------
cat > "$BIN_DIR/mesh-node" <<EOF
#!/bin/sh
# mesh-node wrapper (written by install-node.sh)
export MESH_HOME="\${MESH_HOME:-$MESH_HOME}"
exec "$NODE_BIN" "$BIN_DIR/mesh-node.js" "\$@"
EOF
chmod 755 "$BIN_DIR/mesh-node"
ok "wrapper $BIN_DIR/mesh-node"

# PATH hint (idempotent): add ~/.mesh/bin to the user's shell rc if it is not there
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if ! grep -qF "$BIN_DIR" "$rc" 2>/dev/null; then
        printf '\n# mesh node\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
        ok "added $BIN_DIR to PATH in $rc (open a new terminal to use 'mesh-node' directly)"
      fi
      break
    done
    ;;
esac

# ---- setup + service -------------------------------------------------------
say ""
if [ -n "$LINK" ]; then
  # shellcheck disable=SC2086
  MESH_HOME="$MESH_HOME" "$BIN_DIR/mesh-node" setup --link "$LINK" --gateway "$GATEWAY" $EXTRA_SETUP
else
  # shellcheck disable=SC2086
  MESH_HOME="$MESH_HOME" "$BIN_DIR/mesh-node" setup --wallet "$WALLET" --gateway "$GATEWAY" $EXTRA_SETUP
fi

if [ "$SERVICE" = 1 ] && [ "$OS" = Darwin ]; then
  MESH_HOME="$MESH_HOME" "$BIN_DIR/mesh-node" service install
elif [ "$SERVICE" = 1 ]; then
  warn "skipping service install on $OS; start the node with: $BIN_DIR/mesh-node start"
fi

say ""
if [ -n "$WALLET" ]; then
  say "Done. Your node is registered to $WALLET."
else
  say "Done. Your node is registered to the wallet that created the link code (see: mesh-node status)."
fi
if [ -n "$WEB" ]; then
  say "  dashboard   ${WEB%/}/app/node"
else
  say "  dashboard   open the Mesh app with this wallet and pick the Node tab"
fi
say "  status      $BIN_DIR/mesh-node status"
say "  logs        $BIN_DIR/mesh-node logs"
say "  pause       $BIN_DIR/mesh-node pause   (resume with: mesh-node resume)"
say ""
