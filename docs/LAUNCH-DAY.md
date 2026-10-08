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
Pons fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`.

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

1. Launch $MESH on Pons. The one setting that matters to us: **creator-fee recipient = the vault address**
   the script printed. Keep ETH as the quote asset. Pons' creator-fee rate is what the site calls
   "the 1.5% fee" — if the form shows a different rate, tell Claude and `tradeFeeBps` follows it.
   (Set after the fact with `transferCreatorFeeRecipient(token, vault)` from the launch wallet if Pons
   only allows it post-launch.)
2. From the launch: the **token address**, the **bonding-curve address** and the **launch block**.
3. mesh-network.ai → Admin → Token: paste those three (the vault, pool, treasury, USDG and route are
   pre-filled from the config), add the curve to **excluded wallets**, press **Check** — it reads the
   chain and reports what is wired — then **Flip**. The gateway leaves the test feed; the next hourly
   epoch sweeps real fees. Check the stats page an hour later.

## If something goes wrong

- Sweep reverts, epoch recorded as failed: usually no route or no pool liquidity. Fees stay in the
  vault. Set the route (above) and the next epoch catches up.
- Sweeper out of gas: send it ETH. The epoch retries next hour.
- Wrong fee recipient on Pons: fees accrue in the Pons escrow for whoever is set; fix with
  `transferCreatorFeeRecipient` from the launch wallet, then the vault's `pull()` claims them.
- Lost sweeper key: owner calls `setSweeper(newAddress)`; put the new key on the server. Nothing else
  changes.
