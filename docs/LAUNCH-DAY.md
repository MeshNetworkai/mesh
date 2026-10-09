# Launch day

Two parts. Part 1 is one command on Oliver's Mac and deploys our fee vault. Part 2 is the Pons launch
and a paste into the admin panel. Nobody hands anyone a private key at any point.

## Who holds what

| Role | Wallet | Can do | Where the key lives |
| --- | --- | --- | --- |
| Owner | Oliver's wallet or multisig | set addresses, routes, shares, pause, rescue | Oliver's wallet |
| Treasury | same as owner (or a multisig) | receives the treasury share of every sweep | Oliver's wallet |
| Sweeper | fresh wallet made by the script | `pull()` + `sweep()` only — fees along the fixed path escrow → vault → credit pool / treasury; cannot change addresses or move funds anywhere else | `~/Documents/mesh-keys/launch/sweeper.json` on the Mac and `MESH_EVM_PRIVATE_KEY` in `/opt/mesh/.env` on the server |
| Credit pool | fresh wallet made by the script | holds the holder share in USDG (the reserve); the gateway only reads its balance | `~/Documents/mesh-keys/launch/credit-pool.json` on the Mac — back it up |
| Deployer | any wallet with ~$2 of ETH | pays gas once; no role afterwards | typed hidden into forge, never stored |

## Part 1 — deploy the vault (Mac, ~10 minutes)

```sh
bash ~/Documents/mesh/scripts/chain/launch-day.sh --dry-run   # checks everything, sends nothing
bash ~/Documents/mesh/scripts/chain/launch-day.sh             # deploys
```

The script installs Foundry if needed, builds the contracts, creates the sweeper and credit-pool
wallets, asks for the owner address, verifies the Pons escrow and USDG on chain, optionally wires the
ETH→USDG route (Uniswap v3 SwapRouter02 — it refuses an address that does not report WETH9 and a
WETH/USDG pool), deploys, writes `config/deploy.robinhood.json` and commits. Then it offers to put the
sweeper key on the server over ssh, read from the file.

Addresses it uses (Robinhood Chain mainnet, chain id 4663, from docs.robinhood.com/chain/contracts):
WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`,
Pons fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`, NVDA stock token
`0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (the launch pairs against NVDA, so Pons pays creator fees in NVDA;
the vault lists it as a quote asset and swaps NVDA → USDG through the v3 pool `0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3`,
about $3M of liquidity on 8 Oct). `MESH_QUOTE=eth` switches to an ETH-paired launch. For an NVDA launch the
SwapRouter02 route is required at deploy time, not optional.

After it finishes:

1. **Accept ownership** from the owner wallet: Blockscout → the vault → Contract → Write →
   `acceptOwnership`. (Ownable2Step: until this is signed the deployer is still the owner.)
2. **Fund the sweeper** with ~0.02 ETH for a few hundred sweeps of gas.
3. `cd ~/Documents/mesh && git push`.

### Setting or changing the swap route later (owner wallet)

If the route was skipped, fees wait in the vault (nothing is lost, nothing is minted) and holders get
no credits until a route exists. From the owner wallet, Blockscout → vault → Write →
`setRoute(asset=0x0000000000000000000000000000000000000000, kind=1 (V3Single), router=<SwapRouter02>, poolFee=500, data=0x)`,
or with cast: `cast send <vault> "setRoute(address,uint8,address,uint24,bytes)" 0x000…0 1 <router> 500 0x --ledger --rpc-url https://rpc.mainnet.chain.robinhood.com`.

## Part 2 — Pons, then the admin panel

1. Launch $MESH on Pons. **Quote asset: NVDA** (the Robinhood NVIDIA stock token). The one setting that
   matters to us: **creator-fee recipient = the vault address** the script printed. Pons' creator-fee rate is what the site calls
   "the 1.5% fee" — if the form shows a different rate, tell Claude and `tradeFeeBps` follows it.
   (Set after the fact with `transferCreatorFeeRecipient(token, vault)` from the launch wallet if Pons
   only allows it post-launch.)
2. From the launch: the **token address**, the **bonding-curve address** and the **launch block**.
3. On the Mac (the admin API is only reachable on the server itself — Caddy answers 404 for `/admin/*`
   from the internet — so this replaces the Admin → Token page):

   ```sh
   bash ~/Documents/mesh/scripts/chain/go-live.sh <token> <bonding-curve> <launch block>
   ```

   It saves the token, launch block and curve exclusion in the gateway, runs the on-chain **Check** and
   prints every item (the NVDA price-source warning is expected), then asks before switching
   `MESH_ADAPTER=evm` and recreating the gateway container. When `/health` reports `evm (pons)` the gateway
   is on the real token; the next top-of-the-hour epoch sweeps real fees. Check Admin → overview or
   `/stats` an hour later.

## If something goes wrong

- Sweep reverts: usually no route or no pool liquidity. The epoch itself still runs; the asset whose
  swap failed stays in the vault, the gateway logs `sweep_skipped` for it and the `failed_sweep` alert
  fires (Telegram, Admin → overview). Set the route (above) and the next epoch catches up.
- Sweeper out of gas: send it ETH. The epoch retries next hour.
- Wrong fee recipient on Pons: fees accrue in the Pons escrow for whoever is set; fix with
  `transferCreatorFeeRecipient` from the launch wallet, then the vault's `pull()` claims them.
- Lost sweeper key: owner calls `setSweeper(newAddress)`; put the new key on the server. Nothing else
  changes.


## Known gap for an NVDA launch

The adapter prices ETH and USDG only, so until a price source for NVDA is added:

- The admin panel's "pending fees" figure shows — for NVDA.
- NVDA fees are swapped **without a slippage floor** (`minOut` 0): there is no price to derive one
  from. The gateway credits the actual USDG the swap returned, so credits and the reserve always
  match; what a bad fill would cost is that hour's fees fetching fewer dollars. With about $3M in the
  NVDA/USDG pool and an hourly sweep the price impact is small. Admin → Token → **Check** shows this
  as a warning (`quoteToken.price.<address>`); it is expected and does not block the flip.

ETH fees (an ETH-paired launch, `MESH_QUOTE=eth`) are different: they wait for a fresh ETH price and are
swapped with a 1 % floor (`priceFeed`, `slippageBps`).
