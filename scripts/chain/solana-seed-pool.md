# Seeding the $MESH pool on Solana (Token-2022 + TransferFee)

After `pnpm --filter @mesh/chain-adapter solana:create-mint -- --cluster mainnet-beta` has written
`config/deploy.mainnet-beta.json`, the mint has a 1.5 % transfer fee enforced by the Token-2022
program itself, so any DEX that supports Token-2022 collects it for us. Pick one of the two below;
both are indexed by Jupiter within minutes, which is what `collectFees()` swaps through.

## 0. Before the pool

- **Metadata**: `spl-token initialize-metadata <MINT> "Mesh" "MESH" <uri>` (needs the MetadataPointer
  extension; add it to `solana-create-mint.ts` `getMintLen([...])` if you want on-chain metadata) or
  register via Metaplex. Wallets and Jupiter show the ticker from this.
- **Decide who holds what** before liquidity: supply is minted to the deployer (= treasury) ATA. Move
  the team allocation to its lock/multisig now; every later transfer between non-exempt accounts
  pays the fee (Token-2022 has no exempt list, see "fee leakage" in the internal docs repo).
- Treasury wallet must stay funded with SOL for hourly sweeps (budget in the internal docs repo).

## 1a. Raydium CPMM (recommended: supports Token-2022 transfer-fee mints)

1. https://raydium.io/liquidity/create-pool/ → **Standard AMM (CPMM)**. Legacy AMM v4 and CLMM do
   *not* accept transfer-fee mints.
2. Base token: `MESH` mint (paste the address; Raydium warns about the fee extension, that is expected).
   Quote: `USDC` (or `SOL`; Jupiter routes either way, USDC gives the sweep a one-hop quote).
3. Initial price and amounts: this fixes launch FDV. The pool creation fee is 0.15 SOL.
4. After creation, copy from the pool page:
   - **Pool id** and the two **vault** addresses (the token accounts holding MESH/USDC).
   - The pool's **authority** (owner of the vaults; one shared PDA for all Raydium CPMM pools on
     mainnet — read it from the vault account's `owner` field in an explorer rather than from memory).
5. Add the vault *owner* (authority) to `excludeWallets` in `config/deploy.mainnet-beta.json`.
   `getHolderBalances` aggregates by owner, so excluding the authority excludes every Raydium vault.
6. Optional: lock/burn the LP tokens (Raydium "burn & earn") and publish the tx.

## 1b. Meteora DLMM / DAMM v2

1. https://app.meteora.ag/ → create pool → DAMM v2 (supports Token-2022 with transfer fee) or DLMM.
2. Same pairing advice as above; DLMM needs an active bin price and a bin step (25–100 for a new token).
3. Exclude the pool's vault owner (Meteora program authority / pool PDA) in `excludeWallets`.

## 2. Verify Jupiter sees the route

```sh
# quote 1,000 MESH → USDC (amount in base units, decimals from deploy json)
curl -s "https://lite-api.jup.ag/swap/v1/quote?inputMint=<MINT>&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=100" | jq '{outAmount, priceImpactPct, routePlan: [.routePlan[].swapInfo.label]}'
```

Notes on the API:
- `collectFees()` calls `GET /quote` then `POST /swap` with `{quoteResponse, userPublicKey, wrapAndUnwrapSol, dynamicComputeUnitLimit, prioritizationFeeLamports:"auto"}` and signs the returned
  `swapTransaction` (a v0 `VersionedTransaction`). This is the v6 shape; the lite host is free but
  rate-limited (~1 rps). For the paid tier set `jupiterBaseUrl: "https://api.jup.ag/swap/v1"` in the
  deploy json and `MESH_JUPITER_API_KEY` in env (sent as `x-api-key`).
- New pools appear in Jupiter routing automatically once they have liquidity (Raydium/Meteora are
  whitelisted AMMs); allow ~10 minutes. Until then `pendingFeesUsd()` returns `null` and a sweep
  throws → the gateway's `runEpoch` propagates the error and retries next tick.
- Transfer-fee mints: Jupiter quotes `outAmount` on the *post-fee* input. The adapter values the
  whole sweep at the realized USDC/MESH price from the holder-share swap.

## 3. Dry-run the first sweep

```sh
MESH_DRY_RUN=1 MESH_SOLANA_KEYPAIR=... MESH_HELIUS_API_KEY=... MESH_DEPLOY_NETWORK=mainnet-beta \
  node -e 'import("@mesh/chain-adapter").then(async m=>{const a=m.createAdapter({chain:"solana",holderShareBps:5000});console.log(await a.sweep())})'
```

The output lists `feeTokens`, `swappedTokens`, quoted `usdcReceived`, `priceUsd`, and
`txIds: []`. Then switch the gateway to `MESH_ADAPTER=chain` with `MESH_DRY_RUN` unset.

## 4. Lock the mint

```sh
spl-token authorize <MINT> mint --disable                       # no more minting
# keep: transfer-fee-config authority (to lower/disable fee) and withdraw-withheld authority (the sweeper)
spl-token authorize <MINT> transfer-fee-config <MULTISIG>        # optional: hand fee control to a multisig
```
