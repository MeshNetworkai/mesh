# @mesh/chain-adapter

One interface, three implementations, plus `PonsEvmAdapter`, the `EvmAdapter` subclass the Robinhood
Chain launch runs on. The gateway never knows which chain it is on:

```ts
interface ChainAdapter {
  chain: 'solana' | 'evm';
  getHolderBalances({ from, to }): Promise<HolderBalance[]>; // time-weighted, token units, optional holdSinceTs
  collectFees(): Promise<{ amountUsd: number; txId: string }>;
  transferTokens(to, amount): Promise<string>;
  verifyWalletSignature(wallet, message, signature): boolean;
}
```

| Adapter | Fee source | Holder balances | Price / USD | Signer |
| --- | --- | --- | --- | --- |
| `MockAdapter` | `pushFees()` | static map | — | mock |
| `SolanaAdapter` | Token-2022 **TransferFee** withheld amounts → `withdrawWithheldTokensFromAccounts` (batched) + `…FromMint` | Helius DAS `getTokenAccounts` snapshot + Helius enhanced transactions replay; fallback `getProgramAccounts` + snapshot average | Jupiter swap of the holder share → USDC (realized) | `MESH_SOLANA_KEYPAIR` (withdraw-withheld authority, treasury) |
| `EvmAdapter` | `MeshToken` fee → `FeeVault.sweep()` | `Transfer` log replay in `eth_getLogs` chunks, incremental state, full-history `holdSinceTs` | Uniswap v3 `exactInputSingle` of the holder share → USDC (realized); `Swapper` is pluggable (0x, 1inch) | `MESH_EVM_PRIVATE_KEY` (FeeVault owner, treasury or treasury-approved) |
| `PonsEvmAdapter` (`feeSource: "pons"`) | Pons Fee Escrow → `PonsFeeVault.pull()` → `sweep(asset, minOut)` per fee asset (`sweepMode: "swap"`), or `sweepRaw(asset)` (`"raw"`, testnet rehearsal only) | same indexer as `EvmAdapter`, also excluding the Pons contracts and `creditPool` | stablecoin the swap returned (swap); Chainlink ETH/USD sets the slippage floor and values raw sweeps | `MESH_EVM_PRIVATE_KEY` (the vault's `sweeper`) |

`createAdapter(config, opts)` picks by `config.chain`, reads `config/deploy.<network>.json` for public
addresses and env for secrets. Both live adapters also implement `ChainAdapterExtras`
(`pendingFeesUsd()`, `treasuryBalance()`) and expose `sweep(): SweepDetail` with the full breakdown
(`lastSweep` after each `collectFees()`); `hasExtras(adapter)` narrows. `PonsEvmAdapter` also
implements `ChainAdapterReserve` (`reserve(): ReserveReading`); `hasReserve(adapter)` narrows, and the
mock adapter has no reserve to read.

## Pons sweeps: settlement, pricing and the reserve (`src/pons.ts`)

**Sweep mode.** `sweepMode: "swap"` is the default and what `config/deploy.robinhood.json` ships: after
`pull()` the adapter calls `PonsFeeVault.sweep(asset, minOut)` for each fee asset, the vault swaps it to
the stablecoin through its route and splits the proceeds on chain, `holderShareBps` to `creditPool` and
the rest to `treasury`. The sweep is valued at the stablecoin received. `minOut` is the expected USD
value less `slippageBps` (default 100), in stablecoin units; the swap reverts rather than settle below
it. `sweepMode: "raw"` calls `sweepRaw(asset)` (no swap, the asset itself is split and valued off
chain); the pool then holds ETH against credits fixed in USD, so it is for the testnet rehearsal and
`config/deploy.robinhood-testnet.json` only. The contract still exposes both functions; which one is
called is decided here, from the deploy config.

**Price.** `ethUsd()` returns `{ price, source: 'chainlink' | 'fixed' | 'none', stale?, warning? }`:

| Configured | Result |
| --- | --- |
| `priceFeed`, answer no older than `priceMaxAgeSec` (default 3600 s) | the feed's answer, `source: 'chainlink'` |
| `priceFeed`, answer older than that | no price, `source: 'none'`, `stale: true` |
| `priceFeed`, read fails or the answer is not positive | no price, `source: 'none'` |
| no `priceFeed`, `fixedEthUsd` (deploy json) or `MESH_FIXED_ETH_USD` | the fixed number, `source: 'fixed'` |
| neither | no price, `source: 'none'` |

A configured feed is the only price source: `fixedEthUsd` never stands in for a feed that is stale or
down. `sweep()` leaves any asset it cannot price unswept and adds a warning to `lastSweep.warnings`
(`no fresh price for <asset>: <amount> left unswept, no credits minted for it this epoch`). The asset
stays in the Pons escrow, or in the vault if a `pull()` for another asset already claimed it, and a
later sweep picks it up. The stablecoin itself needs no price and is swept regardless.
`pendingFeesUsd()` returns `null` while a pending asset has no price.

**Reserve.** `reserve()` reads the `creditPool` wallet: `{ wallet, stable, stableUsd, otherUnits,
otherUsd }`. `stableUsd` is its balance of the settlement stablecoin at $1; `otherUnits` / `otherUsd`
is ETH found next to it (left from a raw sweep, or gas money), valued at the current price, with
`otherUsd: null` when there is no price. It throws `NotWiredError` when `creditPool` is not
configured. The gateway calls it once per epoch and counts only the stablecoin as held reserve
(`apps/gateway/src/reserve-report.ts`, `docs/PRICING.md` §5).

**Check.** `checkPonsConfig()` (`src/pons-check.ts`, behind Admin → Token → Check on chain) warns when
`sweepMode` is `raw`, when the vault has no stablecoin set, and when no Chainlink feed is configured.
It does not read the vault's route or the age of the feed's answer.

The deploy json for this path is `config/deploy.robinhood.json` (committed template, every field
commented): besides the `EvmAdapter` fields it carries `feeSource: "pons"`, the Pons contract
addresses, `feeVault`, `creditPool`, `quoteTokens`, `stable`, `stableDecimals`, `sweepMode`, `priceFeed`,
`fixedEthUsd` and `slippageBps`.

## How a sweep is valued (`SolanaAdapter`, `EvmAdapter`)

Both adapters: `total = fees pulled` → `holderShare = total × holderShareBps / 10000` is swapped to
USDC, the rest is forwarded to the treasury **in MESH**. `amountUsd = total × (usdcReceived / holderShare)`,
i.e. the whole sweep is valued at the price the holder share actually realized. The gateway then
splits `amountUsd` with the same `holderShareBps`, so the holder pool in the ledger equals the USDC
actually in the sweeper wallet. With `MESH_DRY_RUN=1` nothing is sent and the quote is used.

## Time-weighting

`timeWeightedBalances()` (`src/timeweight.ts`) is shared: start balances + in-window transfer events →
Σ balance·dt / window. `holdSinceTs` is set when a balance goes 0 → >0 and **reset to the transfer
time on any transfer out** (matches `HolderBalance` in `types.ts` and the gateway's `holder_age` cache).

- **EVM** has full history (every `Transfer` since `deployBlock`), so `holdSinceTs` is always present.
  State (`balances`, `holdSince`, last block) lives in an `EvmStateStore` (in-memory by default; pass a
  file/DB-backed one so a restart does not rescan from `deployBlock`). Block timestamps: exact for up to
  `maxExactTimestampBlocks` (300) distinct window blocks, interpolated otherwise.
- **Solana** sees only what Helius returns for the window (plus `MESH_HOLD_SINCE_LOOKBACK_SEC` before
  it), so `holdSinceTs` is present only when derivable; otherwise undefined and the gateway's
  first-seen cache applies. Without `MESH_HELIUS_API_KEY` the fallback averages the previous run's
  snapshot (if taken within half a window of `from`) with the current one.

Excluded from holder balances: `excludeWallets` from the deploy json (pool vault owners, lock, programs),
the treasury, the fee vault / sweeper and the token itself.

## `config/deploy.<network>.json`

Written by `scripts/chain/solana-create-mint.ts` / `scripts/chain/evm-deploy.ts`; `network` defaults to
`MESH_DEPLOY_NETWORK`, then `devnet` (solana) / `base-sepolia` (evm).

```jsonc
// Solana
{
  "chain": "solana",
  "network": "mainnet-beta",            // devnet | mainnet-beta
  "mint": "…",                          // Token-2022 mint with TransferFee
  "decimals": 6,
  "treasury": "…",                      // wallet; ATA derived. Defaults to the signer
  "usdcMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "excludeWallets": ["<raydium vault authority>", "<team lock>"],
  "jupiterBaseUrl": "https://lite-api.jup.ag/swap/v1",   // optional
  "heliusApiBaseUrl": "https://api.helius.xyz",          // optional
  "slippageBps": 100,                                     // optional
  "transferFeeBps": 150                                   // informative
}
// EVM
{
  "chain": "evm",
  "network": "base",                    // base-sepolia | base | robinhood | anvil
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org", // default when MESH_EVM_RPC_URL is unset
  "token": "0x…", "feeVault": "0x…", "teamLock": "0x…", "treasury": "0x…",
  "deployBlock": 12345678,              // Transfer scan starts here
  "decimals": 18,
  "usdc": "0x…", "swapRouter": "0x…", "quoter": "0x…", "poolFee": 3000,
  "excludeWallets": ["0x<uniswap pool>", "0x<team lock>"],
  "logChunkBlocks": 5000, "slippageBps": 100
}
```

Known chain defaults (`KNOWN_CHAINS` in `src/evm.ts`): Base (8453) and Base Sepolia (84532) carry the
USDC / SwapRouter02 / QuoterV2 addresses — **verify them against docs.uniswap.org before mainnet**.
Robinhood Chain (4663) has no hard-coded RPC/USDC/router; set them in the deploy json.

## Env

| Var | Used by |
| --- | --- |
| `MESH_DEPLOY_NETWORK` | which `deploy.<network>.json` |
| `MESH_DRY_RUN=1` | build + quote, send nothing |
| `MESH_SOLANA_RPC_URL` | Solana RPC (Helius recommended; DAS needed for fast snapshots) |
| `MESH_HELIUS_API_KEY` | enhanced transactions (time-weighting); also builds the RPC URL when the above is unset |
| `MESH_SOLANA_KEYPAIR` | base58 secret, JSON byte array, or path to a keygen json |
| `MESH_JUPITER_BASE_URL`, `MESH_JUPITER_API_KEY` | paid Jupiter tier |
| `MESH_HOLD_SINCE_LOOKBACK_SEC` | extra history scanned for `holdSinceTs` (Solana) |
| `MESH_EVM_RPC_URL`, `MESH_EVM_CHAIN_ID` | override deploy json |
| `MESH_EVM_PRIVATE_KEY` | sweeper key |
| `MESH_FIXED_ETH_USD` | ETH/USD for `PonsEvmAdapter` when no `priceFeed` is configured (overrides `fixedEthUsd` in the deploy json); ignored whenever a feed is configured, even a stale one |

## Scripts (`scripts/chain/`)

```sh
pnpm --filter @mesh/chain-adapter solana:create-mint -- --cluster devnet [--dry-run]   # Token-2022 mint + fee ext, writes deploy json
pnpm --filter @mesh/chain-adapter solana:smoke                                         # devnet: mint → transfer → harvest (skips when airdrop/RPC unavailable)
pnpm --filter @mesh/chain-adapter evm:deploy -- --network base-sepolia [--broadcast]   # forge script Deploy.s.sol, writes deploy json
bash scripts/chain/evm-setup.sh                                                        # forge/anvil from npm when foundryup is blocked
```

`scripts/chain/solana-seed-pool.md` covers Raydium/Meteora pool creation and the Jupiter API.

## Tests

```sh
pnpm --filter @mesh/chain-adapter test        # 8 files, 72 tests offline (recorded RPC/Helius/Jupiter fixtures + a fake EVM client); 11 more skip without a local anvil
pnpm --filter @mesh/chain-adapter typecheck
cd contracts/evm && FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge test -vv    # 17 Solidity tests
```

`test/evm.anvil.test.ts` and `test/pons.anvil.test.ts` run the real contracts on a local anvil (found
on `PATH`, `~/.foundry/bin` or `ANVIL_PATH`) with `contracts/evm/out` artifacts; they skip themselves
when either is missing. `test/pons.test.ts` covers the price rules above (a stale or unreadable feed
yields no price even with `fixedEthUsd` set; a stale feed skips the ETH but still sweeps the
stablecoin) and the reserve read.
