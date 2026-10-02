# Chain decision: Solana (Token-2022) vs EVM (Base / Robinhood Chain)

Both adapters are implemented and tested (`packages/chain-adapter`, 37 offline tests + 3 against a
local anvil; `contracts/evm`, 17 Foundry tests). Flipping `config/tokenomics.json → chain` and
dropping in the matching `config/deploy.<network>.json` is the whole switch. This page is what
each path costs on launch day and every hour after.

## Launch day

| | Solana | EVM (Base) | EVM (Robinhood Chain) |
| --- | --- | --- | --- |
| **Wallet** | one keypair: mint/fee authorities + treasury + sweeper (split later with `spl-token authorize`) | deployer key → becomes `owner` of MeshToken + FeeVault + sweeper; move to a Safe with `transferOwnership/acceptOwnership` | same; check Safe availability on the chain first |
| **Deploy** | `solana:create-mint` — 1 tx (~0.003 SOL rent + fee); metadata optional | `evm:deploy -- --broadcast` — 3 contracts, **3.73 M gas** total (measured on anvil) ≈ 0.004 ETH on Base at 1 gwei, realistically < $1 | same gas; price depends on the chain's fee market |
| **Fee enforcement** | by the Token-2022 program on **every** transfer, incl. wallet-to-wallet; no exempt list, cap per transfer (`maxFee`) | by `MeshToken._update` on non-exempt transfers; exempt list (pool, treasury, vault, lock, owner); owner can lower to 0–3 % or disable forever | same |
| **Liquidity** | Raydium CPMM or Meteora DAMM v2 (Token-2022 aware); 0.15 SOL pool fee; `scripts/chain/solana-seed-pool.md` | Uniswap v3 pool MESH/USDC (or Aerodrome); ~0.4 M gas to create + add; call `setFeeExempt(pool, true)` so swaps pay the fee only once | needs a live DEX with a USDC pool on the chain; confirm before choosing |
| **Indexing** | Helius API key (DAS + enhanced txs); free tier is enough for < 10k holders | any JSON-RPC that serves `eth_getLogs` in 5 k-block chunks; public RPC OK for < 1 k holders, Alchemy/QuickNode otherwise | an archive-ish RPC that serves `eth_getLogs`; public endpoint quality unknown |
| **Wall-clock** | ~1 h: mint, pool, Jupiter indexing (~10 min), dry-run sweep | ~1 h: deploy, verify, pool, exempt pool, dry-run sweep | + time to find/verify RPC, USDC and router addresses |
| **Testnet rehearsal** | devnet: `solana:smoke` (mint → transfer → harvest); **no Jupiter route on devnet**, so the swap leg is only rehearsed with `MESH_DRY_RUN=1` on mainnet | Base Sepolia: full rehearsal incl. Uniswap (USDC + router exist); or anvil with the mock router (automated test) | testnet id/RPC not confirmed from here; parameterised via `ROBINHOOD_TESTNET_*` |

## Every hour (sweep + balances)

Gas/fee figures are per epoch; sweeps with zero fees cost one read and no tx.

| | Solana | EVM (Base) |
| --- | --- | --- |
| **Fee pull** | 1 tx per 20 fee-bearing accounts (`withdrawWithheldTokensFromAccounts`) + mint withdraw; 5 k lamports base + priority (~10–50 k lamports) each. 1 000 active holders ≈ 50 txs ≈ 0.001–0.003 SOL | `FeeVault.sweep` ≈ 60 k gas (measured 109 k incl. test overhead) — flat regardless of holder count |
| **Swap** | 1 Jupiter v0 tx, ~0.0001–0.0005 SOL with auto priority fee | `approve` ≈ 46 k + `exactInputSingle` ≈ 130–180 k gas |
| **Treasury forward** | 1 `transferChecked` tx (~5 k lamports) — skipped when sweeper = treasury | `transfer` ≈ 50 k gas — skipped when sweeper = treasury |
| **Total per sweep** | ≈ 0.002–0.005 SOL ($0.3–1) at 1 k holders; grows with fee-bearing accounts | ≈ **300–350 k gas** ≈ $0.01–0.05 on Base (L2 exec + L1 data); flat |
| **Balances** | Helius: 1 DAS page per 1 000 accounts + enhanced-tx pages (100 txs each) back to window start; free tier 10 rps | `eth_getLogs` over new blocks only (incremental state), ~1 800 blocks/h on Base → 1 chunk; + ≤ 300 `getBlock` for exact timestamps |
| **Latency** | ~5–20 s | ~5–30 s (receipt waits) |

Per month at 24 sweeps/day: Solana ≈ 1.5–3.5 SOL; Base ≈ $10–40. Both negligible against the fee
volume that makes the product worth running.

## Risks and quirks

**Solana**
- *No exempt list.* The transfer fee also hits the sweeper's own swap input and the treasury forward
  (1.5 % of 50 % + 1.5 % of 50 % ≈ 1.5 % of the sweep "leaks" back into withheld balances and is
  harvested next epoch — not lost, just one epoch late). The same applies to LP adds and team moves.
  Mitigation: `maxFee` caps the absolute fee per transfer; large treasury moves can be done with the
  fee temporarily set to 0 by the config authority.
- *Withheld fees live in recipient accounts* (pool vaults, every holder ATA). Harvesting touches them
  all; with 10 k active accounts the hourly sweep is ~500 txs. Alternative: let anyone call
  `harvestWithheldTokensToMint` (permissionless, cheaper) and sweep only from the mint.
- *Jupiter dependency* for pricing; lite API rate limits (~1 rps). Paid tier removes that.
- *Helius dependency* for time-weighting; without it the fallback is a snapshot average (coarser
  but unbiased), and `holdSinceTs` is only known for wallets that moved inside the window.
- Token-2022 wallet/DEX support is good in 2026 but not universal (some CEX listings still refuse).

**EVM (Base)**
- Transfer-fee tokens break some routers/aggregators (fee-on-transfer paths) unless the pool is
  exempt; the exempt list fixes the common case but every new venue needs `setFeeExempt`.
- Owner key is powerful until moved to a multisig (fee up to 3 %, exempt list, vault sweep).
  `disableFeeForever` is the credible exit.
- `eth_getLogs` ranges on public RPCs are capped (10 k blocks); `logChunkBlocks` handles it, the
  first run after deploy scans from `deployBlock` — persist the `EvmStateStore` so restarts don't.
- Base sequencer downtime pauses sweeps; `runEpoch` throws and retries next tick, nothing is lost.

**EVM (Robinhood Chain)**
- Arbitrum-Orbit L2, mainnet id 4663. From this environment the public docs/RPC were unreachable, so
  USDC, DEX router, explorer and testnet id are **not** hard-coded; the adapter and deploy script
  take them from `config/deploy.robinhood.json` / env. Verify liquidity venues and Safe support
  before committing; otherwise the Base path is identical and proven.

## Recommendation

If the pitch is "Robinhood-native", deploy the EVM contracts there (they are chain-agnostic) but
rehearse on Base Sepolia first — same bytecode, same adapter. If the pitch is reach and meme-coin
liquidity, Solana wins on wallet share, but accept the Token-2022 fee-leak and harvest-cost quirks
above. Operationally the EVM path is simpler (flat gas, exempt list, one vault, full on-chain
history for holding age); the Solana path needs two SaaS keys (Helius, Jupiter) and a bigger SOL
float.

## What still needs a funded wallet (could not be done from this sandbox)

- Solana devnet smoke (`solana:smoke`): devnet RPC was blocked here (HTTP 403 from the egress proxy);
  the script airdrops with retries and skips gracefully when the faucet rate-limits.
- A Base Sepolia dry run of `evm:deploy -- --broadcast` and one `collectFees()` against the real
  Uniswap router (anvil + mock router is covered by the automated test).
- Mainnet: Jupiter route existence after pool seeding, and a `MESH_DRY_RUN=1` sweep before switching
  the gateway to `MESH_ADAPTER=chain`.
