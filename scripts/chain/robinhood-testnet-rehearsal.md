# Robinhood Chain testnet rehearsal (Pons fee path)

Goal: prove the mainnet shape — Pons escrow → `PonsFeeVault.pull()` → sweep → credit pool +
treasury → gateway epoch — on Robinhood Chain **testnet** (chainId 46630) before the dev launches on Pons.
Pons itself is not deployed on the testnet, so a `MockPonsEscrow` with the same selectors stands in for
the Fee Escrow, and a plain `MockERC20` "MESH-test" stands in for the Pons-minted token. The vault and
the adapter are the real ones.

One difference from mainnet is deliberate: the rehearsal sweeps in `raw` mode (`sweepRaw()`, ETH valued
at a fixed price) because the testnet has no stablecoin route. Mainnet runs `sweepMode: "swap"` from the
first sweep (`config/deploy.robinhood.json`), so fees settle in the stablecoin and the credit pool holds
dollars; `raw` exists for this rehearsal only (`docs/PRICING.md` §5).

Script: `scripts/chain/robinhood-testnet-rehearsal.ts` (≈ 10 transactions, well under 0.01 testnet ETH).

## 0. Before anything: confirm the Pons escrow selectors (mainnet, read-only, free)

`IPonsFeeEscrow` was written from the Pons v2 docs, not from a published ABI. On Blockscout
(`https://robinhoodchain.blockscout.com/address/0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`) open the
"Contract" tab and confirm these functions exist with these exact signatures:

| Function | Selector we use |
| --- | --- |
| `balanceOf(address)` | `0x70a08231` |
| `balanceOfToken(address,address)` | `0xf59e38b7` |
| `claim()` | `0x4e71d92d` |
| `claimToken(address)` | `0x32f289cf` |
| `transferCreatorFeeRecipient(address,address)` | `0x2931861b` |

If a name differs, change `contracts/evm/src/interfaces/IPonsFeeEscrow.sol` + `packages/chain-adapter/src/evm/abi.ts`
(`ponsEscrowAbi`) and redeploy the vault — nothing else depends on them.

## 1. Prerequisites

```sh
pnpm install
cd contracts/evm && FOUNDRY_SOLC=tools/solc-js-wrapper.mjs forge build && cd ../..   # artifacts in contracts/evm/out
export MESH_EVM_PRIVATE_KEY=0x<throwaway key>     # funded with testnet ETH from the Robinhood testnet faucet
```

Testnet facts (from the chain docs; the script checks `eth_chainId` and refuses mainnet 4663):
chainId **46630**, RPC `https://rpc.testnet.chain.robinhood.com`, explorer
`https://explorer.testnet.chain.robinhood.com`. Override with `--rpc-url` / `--chain-id` if they moved.

## 2. Run

```sh
pnpm --filter @mesh/chain-adapter evm:rehearsal -- --dry-run   # RPC + key + artifacts only
pnpm --filter @mesh/chain-adapter evm:rehearsal --             # the real thing
```

What it does, in order (each step prints explorer links):

1. **Deploy** `MockPonsEscrow`, `MockERC20 "MESH-test"` (1 B supply to the deployer = the "bonding curve"),
   `PonsFeeVault` (owner = sweeper = deployer; fresh `creditPool` + `treasury` addresses; `holderShareBps`
   5000; no stable → raw mode). Registers the vault as the escrow's `creatorFeeRecipient` for the token.
2. **Holders**: curve → alice 10,000 MESH-test; alice → creditPool 1,000 (so a transfer-out and an excluded
   recipient are both in the window).
3. **Fee accrual**: `escrow.accrue{value: 0.001 ETH}(vault)` — what Pons does on every trade.
4. **One `collectFees()`** with `PonsEvmAdapter` (sweepMode `raw`, fixed ETH price $3,000): `pull()` claims
   the ETH, `sweepRaw(ETH)` splits 0.0005 / 0.0005 to creditPool / treasury, the adapter reports `$3.00`.
   Prints balances before/after and `pendingFeesUsd` going 3 → 0.
5. **Holder balances** over the last 10 minutes: alice appears time-weighted, curve / vault / creditPool /
   treasury do not.
6. **Check report** — the same `checkPonsConfig` the admin panel runs; expect `ok=true` with three
   `warn` lines, all of them the rehearsal's shortcuts: `feeVault.stable` (the vault has no stablecoin
   set), `priceFeed` (fixed price, no Chainlink feed) and `sweepMode` (`raw`: the holder share reaches
   the credit pool as ETH). None of the three may appear on mainnet.
7. Writes the addresses into `config/deploy.robinhood-testnet.json` (skip with `--no-write`).

Expected output shape (from a local anvil run with the same script):

```
4. adapter: one collectFees() in raw mode (fixed ETH price $3000)
  pendingFeesUsd before: $3
  collectFees → $3  tx 0x…
    ETH: gross 0.001 → holder 0.0005 / treasury 0.0005 (raw) $3
  creditPool 0x… balance 0.0005 ETH
  treasury   0x… balance 0.0005 ETH
  pendingFeesUsd after: $0
5. holder balances (last 10 minutes, time-weighted)
  0x…alice  403.3333 MESH-test  holdSince 1791219075
6. check report
  ok   token.erc20   Mesh test (MESH-test), 18 decimals, supply 1000000000
  …
  ok=true
```

## 3. Then: the gateway against the rehearsal

```sh
MESH_ADAPTER=evm MESH_DEPLOY_NETWORK=robinhood-testnet MESH_EVM_PRIVATE_KEY=0x<same key> pnpm dev:gateway
curl -s localhost:8787/health | jq .adapter        # "evm (pons)"
# accrue more test fees (cast, same key), then:
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" localhost:8787/admin/run-epoch | jq '{status, feesUsd, holders: .eligibleHolders}'
```

Or paste the printed addresses into **Admin → Token** instead of using the JSON the script wrote, press
**Check on chain**, and confirm the same report appears in the UI — that is exactly the mainnet motion.

The run-epoch response also carries `housekeeping` (credit expiry and the reserve reading). Against the
rehearsal `curl -s localhost:8787/report | jq .totals.reserve` shows `source: "chain"`, `heldUsd: 0`,
the pool's ETH under `otherUsd` and the note `no settlement stablecoin configured`: only the stablecoin
counts as held reserve, so once credits have been distributed `short` is `true` and the
`reserve_short` alert fires (in the log, unless Telegram is configured). That is the expected picture
of a raw sweep and the reason mainnet does not run one.

## 4. What this does NOT rehearse

- The real Pons escrow's selectors (step 0 covers that by inspection) and its event shapes.
- A `swap` route, which is what mainnet runs: the testnet has no USDG/USDC pool we know of. The swap path is
  covered by the Foundry tests (`PonsFeeVault.t.sol`: V3Single, V3Path, Adapter routes against
  `MockSwapRouter`) and the anvil test (`packages/chain-adapter/test/pons.anvil.test.ts`). Mainnet does not
  start in `raw` mode: `config/deploy.robinhood.json` ships `sweepMode: "swap"`, so the stablecoin and the
  route have to be on the vault (`setStable` + `setRoute`) and `stable` in the config before the first
  sweep (`docs/RUNBOOK.md` §6). Without them `sweep()` reverts and the fees wait in the vault.
- Chainlink pricing: no feed on the testnet, so `fixedEthUsd` is used. On mainnet a feed is configured and
  is then the only price source: `fixedEthUsd` / `MESH_FIXED_ETH_USD` applies only when no feed is
  configured at all, and a stale or unreadable feed leaves ETH fees unswept until it is fresh
  (`docs/RUNBOOK.md` §11h). The stale-feed cases are covered offline in
  `packages/chain-adapter/test/pons.test.ts`.
- A covered reserve: see above; the rehearsal's pool holds ETH, which the reserve report does not count.
