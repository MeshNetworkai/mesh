#!/usr/bin/env bash
# Mesh launch day, part 1 of 2: deploy our PonsFeeVault on Robinhood Chain from your own Mac.
#
#   bash ~/Documents/mesh/scripts/chain/launch-day.sh            # the real thing
#   bash ~/Documents/mesh/scripts/chain/launch-day.sh --dry-run  # everything except the transaction
#
# What it does, in order (each step says what it is doing and stops on the first problem):
#   1. installs Foundry (forge + cast) if missing, builds the contracts
#   2. creates two fresh wallets in ~/Documents/mesh-keys/launch/: the SWEEPER (the gateway's hot
#      wallet, may only move fees along the fixed path) and the CREDIT POOL (holds the holder share;
#      nobody spends from it). Back that folder up. Nothing in it is ever printed.
#   3. asks for the OWNER address (your wallet or multisig: owns the vault and receives the treasury share)
#   4. optionally wires the ETH→USDG swap route (Uniswap v3 SwapRouter02) after verifying it on chain
#   5. deploys the vault — forge asks for the DEPLOYER private key itself, hidden, in this Terminal;
#      the deployer only pays gas (~$1 of ETH on Robinhood Chain) and holds no role afterwards
#   6. writes the addresses into config/deploy.robinhood.json + contracts/evm/deployments/, commits
#   7. offers to put the sweeper key on the server over ssh (read from the file, never shown)
#
# Afterwards (part 2, on the website): launch on Pons with the vault as creator-fee recipient, then
# Admin → Token: paste the token address, curve and launch block, Check, Flip.
set -euo pipefail
TMP="$(mktemp -d)"

CHAIN_ID=4663
RPC="${MESH_EVM_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
EXPLORER="https://robinhoodchain.blockscout.com"
WETH="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"      # docs.robinhood.com/chain/contracts
USDG="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"      # docs.robinhood.com/chain/contracts
PONS_ESCROW="0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"
NVDA="0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"      # NVIDIA Robinhood stock token (the launch pairs against it)
QUOTE="${MESH_QUOTE:-nvda}"                               # nvda | eth: the asset Pons pays creator fees in
HOLDER_BPS="${MESH_HOLDER_BPS:-5000}"
POOL_FEE="${MESH_POOL_FEE:-500}"
VPS_HOST="${MESH_VPS_HOST:-80.78.27.94}"
VPS_KEY="${MESH_VPS_KEY:-$HOME/Documents/mesh-keys/mesh_deploy}"

DRY=false
for a in "$@"; do case "$a" in --dry-run) DRY=true ;; -h|--help) sed -n '2,22p' "$0"; exit 0 ;; esac; done

here="$(cd "$(dirname "$0")/../.." && pwd)"
KEYS="$HOME/Documents/mesh-keys/launch"
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }
ask() { local v; read -r -p "  $1 " v </dev/tty; printf '%s' "$v"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }

[[ "$(uname)" == "Darwin" ]] || warn "written for macOS; continuing anyway"

# ---- 1. tools ------------------------------------------------------------------------------------
bold "1/7 Tools"
export PATH="$HOME/.foundry/bin:$PATH"
if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
  echo "  installing Foundry (forge + cast) into ~/.foundry/bin"
  curl -fsSL https://foundry.paradigm.xyz | bash >/dev/null 2>&1 || die "could not download the Foundry installer"
  "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1 || die "foundryup failed"
fi
ok "forge $(forge --version 2>/dev/null | head -1 | awk '{print $2}')"

cd "$here/contracts/evm"
if [[ ! -d node_modules/@openzeppelin/contracts ]]; then
  echo "  fetching OpenZeppelin contracts"
  if command -v npm >/dev/null 2>&1; then npm install --no-fund --no-audit --silent >/dev/null 2>&1 || die "npm install failed"
  else mkdir -p node_modules/@openzeppelin && git clone -q --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts node_modules/@openzeppelin/contracts || die "could not fetch OpenZeppelin"; fi
fi
[[ -d lib/forge-std/src ]] || git clone -q --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std || die "could not fetch forge-std"
echo "  building contracts"
forge build >/dev/null 2>&1 || { forge build 2>&1 | tail -20; die "forge build failed"; }
ok "contracts built"

# ---- chain check ---------------------------------------------------------------------------------
bold "Chain"
cid="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
[[ "$cid" == "$CHAIN_ID" ]] || die "RPC $RPC answered chain id '${cid:-none}', expected $CHAIN_ID (Robinhood Chain)"
ok "Robinhood Chain ($CHAIN_ID) via $RPC"
[[ "$(cast code "$PONS_ESCROW" --rpc-url "$RPC" 2>/dev/null | wc -c)" -gt 4 ]] || die "no contract at the Pons escrow $PONS_ESCROW — check config/deploy.robinhood.json ponsEscrow"
[[ "$(cast code "$USDG" --rpc-url "$RPC" 2>/dev/null | wc -c)" -gt 4 ]] || die "no contract at USDG $USDG"
ok "Pons escrow and USDG exist on chain"

# ---- 2. wallets ----------------------------------------------------------------------------------
bold "2/7 Sweeper and credit-pool wallets"
mkdir -p "$KEYS" && chmod 700 "$KEYS"
newkey() { # file label → address (creates the file once; never prints the key)
  local f="$KEYS/$1.json"
  if [[ ! -f "$f" ]]; then cast wallet new --json > "$f" && chmod 600 "$f"; fi
  perl -0ne 'print $1 if /"address"\s*:\s*"(0x[0-9a-fA-F]{40})"/' "$f"
}
SWEEPER="$(newkey sweeper)"; [[ -n "$SWEEPER" ]] || die "could not create the sweeper wallet"
CREDIT_POOL="$(newkey credit-pool)"; [[ -n "$CREDIT_POOL" ]] || die "could not create the credit-pool wallet"
ok "sweeper      $SWEEPER   (key in $KEYS/sweeper.json)"
ok "credit pool  $CREDIT_POOL   (key in $KEYS/credit-pool.json)"
echo "  Back up $KEYS now (Time Machine, a password manager). The credit-pool key is the reserve."

# ---- 3. owner / treasury -------------------------------------------------------------------------
bold "3/7 Owner and treasury"
echo "  The OWNER wallet controls the vault (addresses, routes, pause) and receives the treasury share."
echo "  Use your multisig or your own hardware wallet address — never the server, never the sweeper."
OWNER="${MESH_OWNER:-}"
while ! is_addr "$OWNER"; do OWNER="$(ask 'Owner / treasury address (0x…):')"; done
OWNER="$(cast to-check-sum-address "$OWNER")"
TREASURY="${MESH_TREASURY:-$OWNER}"
ok "owner + treasury $OWNER"

# ---- 4. swap route -------------------------------------------------------------------------------
bold "4/7 Quote asset and USDG route"
case "$QUOTE" in
  nvda) QUOTE_TOKENS="$NVDA"; echo "  Launch pairs against NVDA: Pons pays creator fees in NVDA tokens. The vault claims them and swaps"; echo "  NVDA -> USDG on Uniswap v3 (pool 0xd4EB...14a3, about 3M USD of liquidity)." ;;
  eth)  QUOTE_TOKENS=""; echo "  Launch pairs against ETH: creator fees arrive as ETH and swap ETH -> USDG." ;;
  *) die "MESH_QUOTE must be nvda or eth" ;;
esac
[[ -z "$QUOTE_TOKENS" || "$(cast code "$NVDA" --rpc-url "$RPC" 2>/dev/null | wc -c)" -gt 4 ]] || die "no contract at NVDA $NVDA"
echo "  Fees swap to USDG through Uniswap v3 SwapRouter02 if one is wired. Without it, fees wait in the vault"
echo "  (nothing is lost) until the owner sets a route — but holders get no credits meanwhile."
QUOTE_FEES=""
ROUTER="${MESH_SWAP_ROUTER:-}"
if [[ -z "$ROUTER" ]]; then
  echo "  Find SwapRouter02 on $EXPLORER (search: SwapRouter02; it starts 0xcaf6… and ends …5cb2 per Uniswap's playbook)."
  ROUTER="$(ask 'SwapRouter02 address (Enter to skip for now):')"
fi
if [[ -n "$ROUTER" ]]; then
  is_addr "$ROUTER" || die "that is not an address"
  w9="$(cast call "$ROUTER" 'WETH9()(address)' --rpc-url "$RPC" 2>/dev/null || true)"
  [[ "$(echo "$w9" | tr A-Z a-z)" == "$(echo "$WETH" | tr A-Z a-z)" ]] || die "router $ROUTER does not report WETH9 = $WETH; wrong contract"
  fac="$(cast call "$ROUTER" 'factory()(address)' --rpc-url "$RPC" 2>/dev/null || true)"
  pool="$(cast call "$fac" 'getPool(address,address,uint24)(address)' "$WETH" "$USDG" "$POOL_FEE" --rpc-url "$RPC" 2>/dev/null || true)"
  if [[ -z "$pool" || "$pool" == "0x0000000000000000000000000000000000000000" ]]; then
    for f in 3000 10000 100; do
      p="$(cast call "$fac" 'getPool(address,address,uint24)(address)' "$WETH" "$USDG" "$f" --rpc-url "$RPC" 2>/dev/null || true)"
      if [[ -n "$p" && "$p" != "0x0000000000000000000000000000000000000000" ]]; then POOL_FEE="$f"; pool="$p"; break; fi
    done
  fi
  [[ -n "$pool" && "$pool" != "0x0000000000000000000000000000000000000000" ]] || die "no WETH/USDG v3 pool found through $ROUTER at fee 500/3000/10000/100 — skip the route (Enter) and set it later"
  ok "route: SwapRouter02 $ROUTER, WETH/USDG pool $pool (fee $POOL_FEE)"
  if [[ -n "$QUOTE_TOKENS" ]]; then
    # Several NVDA/USDG pools exist at different fee tiers; NVDA swaps have no slippage floor, so pick
    # the one with the most in-range liquidity (pool.liquidity()), not the first one found.
    qf=""; qpool=""; qliq=0
    for f in 100 500 3000 10000; do
      p="$(cast call "$fac" 'getPool(address,address,uint24)(address)' "$NVDA" "$USDG" "$f" --rpc-url "$RPC" 2>/dev/null || true)"
      [[ -n "$p" && "$p" != "0x0000000000000000000000000000000000000000" ]] || continue
      liq="$(cast call "$p" 'liquidity()(uint128)' --rpc-url "$RPC" 2>/dev/null | awk '{print $1}' || true)"
      liq="${liq:-0}"
      echo "  NVDA/USDG pool $p (fee $f): liquidity $liq"
      if (( $(echo "$liq > $qliq" | bc) )); then qf="$f"; qpool="$p"; qliq="$liq"; fi
    done
    [[ -n "$qf" ]] || die "no NVDA/USDG v3 pool found through $ROUTER — the launch cannot sweep NVDA fees; stop and tell Claude"
    (( $(echo "$qliq > 0" | bc) )) || die "every NVDA/USDG pool reports zero liquidity — stop and tell Claude"
    ok "route: NVDA/USDG pool $qpool (fee $qf, deepest)"
    QUOTE_FEES="$qf"
  fi
else
  [[ -z "$QUOTE_TOKENS" ]] || die "an NVDA-paired launch needs the SwapRouter02 route now: without it NVDA fees cannot become USDG credits"
  warn "no route: the vault starts without a swap path; set one before the first sweep (docs/LAUNCH-DAY.md)"
fi

# ---- 5. deploy -----------------------------------------------------------------------------------
bold "5/7 Deploy PonsFeeVault"
cat <<EOF
  owner/treasury  $OWNER
  sweeper         $SWEEPER
  credit pool     $CREDIT_POOL
  escrow          $PONS_ESCROW
  stable          USDG $USDG
  weth            $WETH
  holder share    $HOLDER_BPS bps
  quote asset     ${QUOTE_TOKENS:-ETH only}
  route           ${ROUTER:-none}
EOF
export MESH_QUOTE_TOKENS="$QUOTE_TOKENS" MESH_QUOTE_POOL_FEES="${QUOTE_FEES:-}"
export MESH_OWNER="$OWNER" MESH_SWEEPER="$SWEEPER" MESH_CREDIT_POOL="$CREDIT_POOL" MESH_TREASURY="$TREASURY"
export MESH_STABLE="$USDG" MESH_WETH="$WETH" MESH_HOLDER_BPS="$HOLDER_BPS" MESH_PONS_ESCROW="$PONS_ESCROW" MESH_POOL_FEE="$POOL_FEE"
[[ -n "$ROUTER" ]] && export MESH_SWAP_ROUTER="$ROUTER"
if $DRY; then
  forge script script/DeployPonsFeeVault.s.sol --rpc-url "$RPC" >/dev/null 2>&1 && ok "dry run: simulation passed, nothing sent" || die "simulation failed"
  echo; echo "  Dry run complete. Run again without --dry-run to deploy."; exit 0
fi
echo
echo "  forge will now ask for the DEPLOYER private key (typed hidden, used once, not stored)."
echo "  It only pays gas. Any wallet with ~\$2 of ETH on Robinhood Chain works, including a throwaway you"
echo "  fund for this. (Hardware wallet: re-run with MESH_SIGNER='--ledger'.)"
[[ "$(ask 'Deploy now? (yes/no):')" == "yes" ]] || die "stopped before deploying"
SIGNER="${MESH_SIGNER:---interactive}"
OUT="deployments/pons-$CHAIN_ID.json"
rm -f "$OUT"   # never read a stale file (e.g. from a dry run) as this deploy's result
set +e
forge script script/DeployPonsFeeVault.s.sol --rpc-url "$RPC" --broadcast $SIGNER -vv 2>&1 | tee "$TMP/forge.log" | grep -E "PonsFeeVault|owner|sweeper|escrow|Error|error|revert" | head -20
FORGE_RC=${PIPESTATUS[0]}
set -e
[[ "$FORGE_RC" -eq 0 ]] || die "forge failed (exit $FORGE_RC) — nothing was deployed if the error came from the simulation; full log: $TMP/forge.log"
[[ -f "$OUT" ]] || die "deploy did not write $OUT — read the forge output above"
VAULT="$(perl -0ne 'print $1 if /"feeVault"\s*:\s*"(0x[0-9a-fA-F]{40})"/' "$OUT")"
BLOCK="$(perl -0ne 'print $1 if /"deployBlock"\s*:\s*"?(\d+)"?/' "$OUT")"
is_addr "$VAULT" || die "no vault address in $OUT"
ok "PonsFeeVault $VAULT   $EXPLORER/address/$VAULT"

# ---- 6. config + commit --------------------------------------------------------------------------
bold "6/7 Config"
CFG="$here/config/deploy.robinhood.json"
setk() { perl -0pi -e "s/(\"$1\"\s*:\s*)null/\$1\"$2\"/" "$CFG"; }
setk feeVault "$VAULT"; setk creditPool "$CREDIT_POOL"; setk treasury "$TREASURY"; setk stable "$USDG"
[[ -n "$ROUTER" ]] && setk swapRouter "$ROUTER"
# ${1} not $1: in perl "$1[" reads as an array element and the whole key vanished (launch night, commit 4a884ec).
if [[ -n "$QUOTE_TOKENS" ]]; then perl -0pi -e 's/("quoteTokens"\s*:\s*)\[[^\]]*\]/${1}["0x0000000000000000000000000000000000000000", "'"$QUOTE_TOKENS"'"]/' "$CFG"; fi
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$CFG" 2>/dev/null || node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CFG" || die "$CFG is no longer valid JSON — do not push; tell Claude"
grep -q "\"feeVault\": \"$VAULT\"" "$CFG" || warn "could not write feeVault into $CFG — paste it in Admin → Token instead"
cd "$here" && git add config/deploy.robinhood.json contracts/evm/deployments/ && git -c user.name="Mesh" -c user.email="dev@mesh-network.ai" commit -q -m "launch: PonsFeeVault $VAULT on Robinhood Chain; credit pool, treasury, USDG and route in deploy.robinhood.json" && ok "committed (push when ready: git push)"

# ---- 7. server -----------------------------------------------------------------------------------
bold "7/7 Sweeper key on the server"
echo "  The gateway signs pull()/sweep() with the sweeper key. It goes into /opt/mesh/.env over ssh, read"
echo "  straight from $KEYS/sweeper.json; it is not shown here."
if [[ -f "$VPS_KEY" && "$(ask "Put it on the server now? (yes/no):")" == "yes" ]]; then
  PK="$(perl -0ne 'print $1 if /"private_key"\s*:\s*"(0x[0-9a-fA-F]{64})"/' "$KEYS/sweeper.json")"
  [[ -n "$PK" ]] || die "could not read the sweeper key"
  ssh -i "$VPS_KEY" "mesh@$VPS_HOST" "grep -q '^MESH_EVM_PRIVATE_KEY=' /opt/mesh/.env && sed -i 's|^MESH_EVM_PRIVATE_KEY=.*|MESH_EVM_PRIVATE_KEY=$PK|' /opt/mesh/.env || printf 'MESH_EVM_PRIVATE_KEY=%s\n' '$PK' >> /opt/mesh/.env; grep -q '^MESH_EVM_RPC_URL=' /opt/mesh/.env || printf 'MESH_EVM_RPC_URL=%s\n' '$RPC' >> /opt/mesh/.env; /opt/mesh/deploy.sh restart" \
    && ok "server has the sweeper key and was restarted" || warn "ssh failed — run part 7 again later"
  unset PK
else
  warn "skipped; run again later or do it by hand (docs/LAUNCH-DAY.md §3)"
fi

bold "Done. Next:"
cat <<EOF
  1. Accept ownership from the OWNER wallet ($OWNER): on $EXPLORER/address/$VAULT
     open Contract → Write → acceptOwnership and sign. Until then the deployer is still the owner.
  2. Send ~0.02 ETH on Robinhood Chain to the sweeper for gas:   $SWEEPER
  3. Launch on Pons. Creator-fee recipient = the vault:            $VAULT
  4. After the launch, Admin → Token on mesh-network.ai: paste the token address, the curve address
     and the launch block, press Check, then Flip. (Or send those three to me.)
  5. git push, so the committed config reaches GitHub.
EOF
