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
#   --max-parallel <n>    run n jobs at once (default 1; needs RAM for n copies of the model's context)
#
# Idempotent: re-running updates the bundle, re-registers the node and reloads the service. A failed
# download or unpack leaves the previous installation exactly as it was.
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

usage() {
  cat <<'USAGE'
Mesh node installer

  curl -fsSL https://<web-host>/install-node.sh | sh -s -- --link <code> --gateway https://<gateway-host>

  --link <code>        link code from the web app (Run a node -> "Link a Mac")      [MESH_LINK_CODE]
  --wallet <addr>      legacy unsigned registration (dev gateways only)              [MESH_WALLET]
  --gateway <url>      gateway URL                                                   [GATEWAY_URL]
  --web <origin>       web app origin (fallback download source)                    [MESH_WEB_URL]
  --from-local <path>  install a local mesh-node.js build
  --bundle-url <url>   explicit mesh-node.js URL                                     [MESH_BUNDLE_URL]
  --no-service         do not install the launchd background service
  --with-70b           also pull llama3.1:70b (64 GB+ Macs)
  --max-parallel <n>   run n jobs at once (default 1)
USAGE
}

# Temp files are tracked so any exit (error, Ctrl-C) removes partial downloads and never leaves a
# half-written file where the real one goes.
TMP_FILES=""
cleanup() { for f in $TMP_FILES; do rm -rf "$f"; done; }
trap cleanup EXIT INT TERM
track() { TMP_FILES="$TMP_FILES $1"; }

# `--flag value` must have a value; `set -u` would otherwise die with an unhelpful "parameter not set".
need_value() { [ $# -ge 2 ] && [ -n "$2" ] || die "flag $1 needs a value (see --help)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --link) need_value "$@"; LINK="$2"; shift 2 ;;
    --link=*) LINK="${1#*=}"; shift ;;
    --wallet) need_value "$@"; WALLET="$2"; shift 2 ;;
    --wallet=*) WALLET="${1#*=}"; shift ;;
    --gateway) need_value "$@"; GATEWAY="$2"; shift 2 ;;
    --gateway=*) GATEWAY="${1#*=}"; shift ;;
    --web) need_value "$@"; WEB="$2"; shift 2 ;;
    --web=*) WEB="${1#*=}"; shift ;;
    --from-local) need_value "$@"; FROM_LOCAL="$2"; shift 2 ;;
    --from-local=*) FROM_LOCAL="${1#*=}"; shift ;;
    --bundle-url) need_value "$@"; BUNDLE_URL="$2"; shift 2 ;;
    --bundle-url=*) BUNDLE_URL="${1#*=}"; shift ;;
    --no-service) SERVICE=0; shift ;;
    --with-70b) EXTRA_SETUP="$EXTRA_SETUP --with-70b"; shift ;;
    --max-parallel) need_value "$@"; EXTRA_SETUP="$EXTRA_SETUP --max-parallel $2"; shift 2 ;;
    --max-parallel=*) EXTRA_SETUP="$EXTRA_SETUP --max-parallel ${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (run with --help to see the options)" ;;
  esac
done

GATEWAY="${GATEWAY%/}"
case "$GATEWAY" in
  http://*|https://*) ;;
  *) die "--gateway must be a URL starting with http:// or https:// (got: $GATEWAY)" ;;
esac
if [ -z "$LINK" ] && [ -z "$WALLET" ]; then
  die "--link <code> is required: open the Mesh app, Run a node -> \"Link a Mac\", and paste the code (or --wallet <addr> on a gateway that allows unsigned registration)"
fi
case "$MESH_HOME" in
  /*) ;;
  *) die "MESH_HOME must be an absolute path (got: $MESH_HOME)" ;;
esac

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

# ---- tools ----------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  DL=curl
elif command -v wget >/dev/null 2>&1; then
  DL=wget
else
  die "this installer needs curl (or wget) to download files. On macOS curl is built in; check your PATH."
fi
# url dest -> non-zero on failure; the destination is removed on failure so no partial file survives.
download() {
  if [ "$DL" = curl ]; then
    curl -fsSL --retry 2 --connect-timeout 20 "$1" -o "$2" || { rm -f "$2"; return 1; }
  else
    wget -q --tries=3 --timeout=20 -O "$2" "$1" || { rm -f "$2"; return 1; }
  fi
}

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
  major="$(node_major "$1")"; [ -n "$major" ] && [ "$major" -ge 18 ] 2>/dev/null || return 1
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
    warn "found $existing but it is $(node_arch "$existing" || echo unknown)/v$(node_major "$existing" || echo '?') - not a native Apple Silicon Node 18+. Installing a private native copy for Mesh."
  fi
  NODE_VER="${MESH_NODE_VERSION:-v20.18.0}"
  NODE_TARBALL="node-$NODE_VER-darwin-arm64.tar.gz"
  say ".. downloading Node $NODE_VER (darwin-arm64) into $MESH_HOME/node"
  mkdir -p "$MESH_HOME"
  NODE_TGZ="$MESH_HOME/.node.tgz.$$"
  NODE_SUMS="$MESH_HOME/.node.sha256.$$"
  NODE_NEW="$MESH_HOME/.node.new.$$"
  track "$NODE_TGZ"; track "$NODE_SUMS"; track "$NODE_NEW"
  download "https://nodejs.org/dist/$NODE_VER/$NODE_TARBALL" "$NODE_TGZ" || die "could not download Node from nodejs.org (check your internet connection and try again; nothing was changed)"
  # Verify against nodejs.org's published checksums when we can; a damaged download is refused.
  if download "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" "$NODE_SUMS" && command -v shasum >/dev/null 2>&1; then
    expected="$(grep " $NODE_TARBALL\$" "$NODE_SUMS" | cut -d' ' -f1)"
    actual="$(shasum -a 256 "$NODE_TGZ" | cut -d' ' -f1)"
    if [ -z "$expected" ]; then
      warn "no checksum published for $NODE_TARBALL; continuing unverified"
    elif [ "$expected" != "$actual" ]; then
      die "the Node download is corrupt (sha256 mismatch). Nothing was changed; please re-run."
    else
      ok "Node download verified (sha256)"
    fi
  else
    warn "could not fetch nodejs.org checksums; continuing unverified"
  fi
  # Unpack beside the final location, then swap, so an interrupted unpack cannot destroy a working Node.
  mkdir -p "$NODE_NEW"
  tar -xzf "$NODE_TGZ" -C "$NODE_NEW" --strip-components=1 || die "could not unpack Node (nothing was changed)"
  node_ok "$NODE_NEW/bin/node" || die "the downloaded Node did not run; please report this (nothing was changed)"
  rm -rf "$MESH_HOME/node"
  mv "$NODE_NEW" "$MESH_HOME/node"
  rm -f "$NODE_TGZ" "$NODE_SUMS"
  NODE_BIN="$MESH_HOME/node/bin/node"
fi
if [ -z "$NODE_BIN" ] && [ "$OS" = "Linux" ]; then
  die "Node 18+ not found. Install it from https://nodejs.org and re-run."
fi
ok "node $("$NODE_BIN" -v) ($(node_arch "$NODE_BIN")) at $NODE_BIN"

# ---- fetch mesh-node.js ----------------------------------------------------
mkdir -p "$BIN_DIR" "$MESH_HOME/logs"
chmod 700 "$MESH_HOME"
# .mjs so the smoke run below loads the (ESM) bundle correctly whatever the directory's package type.
TMP="$BIN_DIR/.mesh-node.tmp.$$.mjs"
track "$TMP"
rm -f "$TMP"

looks_like_bundle() { # file -> 0 when the first bytes are JS, not an HTML error page
  head -c 64 "$1" | grep -q -e '^#!/usr/bin/env node' -e '^//' -e '^import' -e '^"use strict"'
}
fetch() { # url -> $TMP ; non-zero on failure or on a non-JS body (e.g. an HTML 404 page)
  download "$1" "$TMP" || return 1
  looks_like_bundle "$TMP" || { rm -f "$TMP"; return 1; }
}

SOURCE=""
if [ -n "$FROM_LOCAL" ]; then
  [ -f "$FROM_LOCAL" ] || die "--from-local: $FROM_LOCAL does not exist"
  looks_like_bundle "$FROM_LOCAL" || die "--from-local: $FROM_LOCAL does not look like mesh-node.js"
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
  say "Could not download mesh-node.js. Nothing was changed. Options:" >&2
  say "  - check your internet connection and that $GATEWAY is the right gateway address" >&2
  say "  - pass --web https://<web-host>   (the app serves /mesh-node.js)" >&2
  say "  - pass --bundle-url <url>         (any URL hosting mesh-node.js)" >&2
  say "  - build it: pnpm --filter @mesh/node-agent build, then re-run with --from-local apps/node-agent/dist/mesh-node.js" >&2
  exit 1
fi
# The bundle must at least start before it replaces the one in place (a truncated download would otherwise
# be installed and crash-loop under launchd).
"$NODE_BIN" "$TMP" --version >/dev/null 2>&1 || die "the downloaded mesh-node.js does not run with $NODE_BIN (nothing was changed; try again or pass --bundle-url)"
chmod 755 "$TMP"
mv -f "$TMP" "$BIN_DIR/mesh-node.js"   # atomic on the same filesystem
ok "installed $BIN_DIR/mesh-node.js $("$NODE_BIN" "$BIN_DIR/mesh-node.js" --version 2>/dev/null || true) (from $SOURCE)"

# ---- wrapper ---------------------------------------------------------------
WRAPPER_TMP="$BIN_DIR/.mesh-node.tmp.$$"
track "$WRAPPER_TMP"
cat > "$WRAPPER_TMP" <<EOF
#!/bin/sh
# mesh-node wrapper (written by install-node.sh)
export MESH_HOME="\${MESH_HOME:-$MESH_HOME}"
exec "$NODE_BIN" "$BIN_DIR/mesh-node.js" "\$@"
EOF
chmod 755 "$WRAPPER_TMP"
mv -f "$WRAPPER_TMP" "$BIN_DIR/mesh-node"
ok "wrapper $BIN_DIR/mesh-node"

# PATH hint (idempotent): add ~/.mesh/bin to the user's shell rc if it is not there
PATH_HINT=""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if ! grep -qF "$BIN_DIR" "$rc" 2>/dev/null; then
        # shellcheck disable=SC2016  # the literal $PATH belongs in the rc file
        printf '\n# mesh node\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
        ok "added $BIN_DIR to PATH in $rc"
      fi
      PATH_HINT="open a new Terminal window (or run: export PATH=\"$BIN_DIR:\$PATH\") to use 'mesh-node' directly"
      break
    done
    [ -n "$PATH_HINT" ] || PATH_HINT="add $BIN_DIR to your PATH to use 'mesh-node' directly"
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

SERVICE_MSG=""
if [ "$SERVICE" = 1 ] && [ "$OS" = Darwin ]; then
  MESH_HOME="$MESH_HOME" "$BIN_DIR/mesh-node" service install
  SERVICE_MSG="It runs in the background, starts at login and restarts itself if it crashes."
elif [ "$SERVICE" = 1 ]; then
  warn "skipping service install on $OS; start the node with: $BIN_DIR/mesh-node start"
  SERVICE_MSG="Start it with: $BIN_DIR/mesh-node start"
else
  SERVICE_MSG="Start it with: $BIN_DIR/mesh-node start   (or install the background service: $BIN_DIR/mesh-node service install)"
fi

say ""
say "Done. Your Mesh node is set up."
if [ -n "$WALLET" ]; then
  say "  Earnings go to $WALLET."
else
  say "  Earnings go to the wallet that created the link code (see: mesh-node status)."
fi
say "  $SERVICE_MSG"
if [ -n "$WEB" ]; then
  say "  dashboard   ${WEB%/}/app/node"
else
  say "  dashboard   open the Mesh app with this wallet and pick the Node tab"
fi
say "  status      $BIN_DIR/mesh-node status"
say "  logs        $BIN_DIR/mesh-node logs"
say "  pause       $BIN_DIR/mesh-node pause   (resume with: mesh-node resume)"
say "  update      $BIN_DIR/mesh-node update  (or re-run this installer)"
if [ -n "$PATH_HINT" ]; then say "  note        $PATH_HINT"; fi
say ""
