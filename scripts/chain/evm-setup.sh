#!/usr/bin/env bash
# One-time setup for contracts/evm without network access to foundry.paradigm.xyz /
# binaries.soliditylang.org: forge+anvil+cast from npm (@foundry-rs/*), OpenZeppelin + solc-js from
# npm, forge-std via git. Afterwards:  cd contracts/evm && FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$here/contracts/evm"

if ! command -v forge >/dev/null 2>&1; then
  echo "forge not found; installing @foundry-rs/{forge,anvil,cast} from npm into ~/.foundry/bin"
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm init -y >/dev/null && npm i --no-fund --no-audit @foundry-rs/forge @foundry-rs/anvil @foundry-rs/cast >/dev/null)
  mkdir -p "$HOME/.foundry/bin"
  for t in forge anvil cast; do
    bin="$(find "$tmp/node_modules/@foundry-rs" -type f -name "$t" | head -1)"
    cp "$bin" "$HOME/.foundry/bin/$t" && chmod +x "$HOME/.foundry/bin/$t"
  done
  export PATH="$HOME/.foundry/bin:$PATH"
  echo 'add to your shell: export PATH="$HOME/.foundry/bin:$PATH"'
fi

npm install --no-fund --no-audit          # @openzeppelin/contracts + solc (solc-js)
[ -d lib/forge-std/src ] || git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
chmod +x tools/solc-js-wrapper.mjs
forge --version
echo "ok. run: FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test -vv   (drop FOUNDRY_SOLC when solc downloads work)"
