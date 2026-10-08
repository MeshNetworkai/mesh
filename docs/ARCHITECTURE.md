# Mesh architecture

How the pieces fit, what a request and an epoch go through, what is stored where, and what has to
change to run more than one gateway. Companion documents: `docs/NODE_PROTOCOL.md` (gateway ⇄ node
wire contract), `docs/SECURITY.md`, `docs/RUNBOOK.md` (deploying), `docs/LOADTEST.md` (measured
limits), `CONTRIBUTING.md` (working in the repo).

## 1. Components

```
                         pnpm workspace (packages/*, apps/*)
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │                                                                                           │
 │   packages/config          packages/chain-adapter          packages/design-tokens        │
 │   zod schemas + loaders    ChainAdapter interface          tokens.css (web only)          │
 │   tokenomics.json          Mock | Solana | EVM                                            │
 │   model-policy.json        getHolderBalances · collectFees                                │
 │   model-prices.json        verifyWalletSignature · getStakes?                             │
 │   deploy.<network>.json    time-weighting (timeweight.ts)                                 │
 │          │                          │                                                     │
 │          ▼                          ▼                                                     │
 │   ┌─────────────────────────────────────────────────────────┐                             │
 │   │ apps/gateway  (Fastify 5, Node 20, better-sqlite3)      │   ┌──────────────────────┐  │
 │   │                                                         │   │ apps/web (Vite+React)│  │
 │   │  routes/auth    nonce → wallet signature → JWT (7d)     │◄──│ Landing · Docs ·     │  │
 │   │  routes/keys    mesh_sk_… API keys (sha256 stored)      │   │ Report · Admin ·     │  │
 │   │  routes/v1      OpenAI-compatible chat + models         │   │ /app: Overview, Keys,│  │
 │   │  routes/nodes   register · heartbeat · jobs (long-poll) │   │ Chat, Network, Node  │  │
 │   │  routes/stats   /health /stats /epochs                  │   └──────────────────────┘  │
 │   │  routes/report  /report, /report/weekly/:isoWeek        │                             │
 │   │  routes/me, credits  /me, /me/nodes, /me/credits/buy    │   ┌──────────────────────┐  │
 │   │  routes/admin   run-epoch · fake-fees · credits · audit │   │ apps/node-agent      │  │
 │   │  jobs/distribute   hourly epoch, then housekeeping      │   │ mesh-node CLI (Mac)  │  │
 │   │  network.ts        JobBroker + JobRelay (in-memory)     │◄──│ register · heartbeat │  │
 │   │  routing.ts        decideRoute · reputation             │   │ long-poll jobs       │  │
 │   │  upstream.ts       OpenRouter | Mock upstream           │──►│ Ollama :11434        │  │
 │   │  alerts.ts         AlertMonitor (log | Telegram)        │   └──────────────────────┘  │
 │   │  db.ts             SQLite, append-only migrations       │                             │
 │   └───────────┬───────────────────────────┬─────────────────┘                             │
 │               │                           │                                               │
 │               ▼                           ▼                                               │
 │        data/mesh.db (WAL)          https://openrouter.ai/api/v1  (or offline mock)        │
 │                                                                                           │
 │   contracts/evm (Foundry): MeshToken · FeeVault · TeamLock  → read by the EVM adapter     │
 └───────────────────────────────────────────────────────────────────────────────────────────┘

   external:  DEX pool / fee vault (Solana or EVM) ── fees ──►  adapter.collectFees()
              wallets (Phantom, Solflare, MetaMask, Rabby) ── sign ──► /auth, /nodes/link
```

| Component | Lives in | Runtime | Talks to |
| --- | --- | --- | --- |
| Gateway | `apps/gateway` | one Node process, Fastify, SQLite file | chain RPC (via adapter), OpenRouter, nodes (inbound), browsers (inbound) |
| Web app | `apps/web` | static files (Vite build) served by any host | gateway over HTTPS (`VITE_API_URL`), wallets in the browser |
| Node agent | `apps/node-agent` | single-file CLI (`dist/mesh-node.js`, esbuild) on a Mac | gateway (outbound only), local Ollama |
| Chain adapter | `packages/chain-adapter` | library used by the gateway and the `scripts/chain/*` tools | Solana RPC/Helius/Jupiter, EVM RPC |
| Config | `packages/config` | library; loads and validates `config/*.json` | nothing |
| Contracts | `contracts/evm` | Foundry project | deployed to Base / Robinhood chain; addresses land in `config/deploy.<network>.json` |

Nodes never accept inbound connections; everything is node → gateway. The web app has no
backend of its own.

### 1a. Modules added for the open beta (October)

The diagram above is the core. The modules below sit beside it in `apps/gateway/src`, each with its
own doc; they hook into the request and epoch lifecycles described below.

| Module | Files | What it does | Hooks into | Doc |
| --- | --- | --- | --- | --- |
| **Catalogue** | `catalogue.ts`, `config/model-prices.json` (curated list + OpenRouter list prices, refreshed by `scripts/refresh-model-prices.mjs`), `config/model-policy.json` | `GET /v1/models`: network models (Ollama tag, short alias, `online` count) plus frontier / fast / open upstream rows, each with `listPrice`, `meshPrice` (flat network price on a node; upstream it is list plus `requestPricing.upstreamMarkupBps`, list × 1.06 as shipped, or list minus `upstreamDiscountBps` when a discount is configured), `privacy`, `guestAllowed`; works without a key; `?guest=1` | `routes/v1.ts` bills with `upstreamBilledMicros()`, the same rule `meshPricePerM()` applies to the catalogue; the web picker and guest chat read it | `docs/PRICING.md` §1–2 |
| **Marketplace** | `market.ts` (mechanics), `routes/market.ts` (API), tables `market_listings`, `market_fills`, `prepaid_ledger`, `withdrawal_requests`, `pool_extra_micros` (migration 14) | List credit at 0–70 % off (escrow row in `credits_ledger`; unused starter credit is refused, `402 non_transferable`), fill any part from a prepaid USD balance, cancel / expire (sweep every minute), withdraw; 2.5 % fee: half to `pool_extra_micros`, half to `treasury_ledger` (`market_fee`) | the next epoch (§3) adds pending `pool_extra_micros` to the holder pool and stamps the rows; `/report` → `totals.marketplace`; admin `POST /admin/prepaid` is the beta settlement | `docs/MARKETPLACE.md` |
| **Usage share (engine 2)** | `usage-share.ts`, table `usage_share_log`, config `usageShare` | When a **paid** request is recorded (both legs), compute the margin (network: price − node reward; upstream: billed − upstream cost, the cost being list plus `requestPricing.upstreamFeeBps`); if `enabled` and positive, write `holderBps` of it to `pool_extra_micros` with `source = 'usage'`, log the split. Guests never count. On as shipped: the network leg leaves $0.008–$0.02 per million tokens (the node reward is held at `nodeRewards.maxShareOfPriceBps`, 90 % of the price), the upstream leg 0.5 % of list (6 % markup over a 5.5 % upstream fee) | `relay.ts` after billing; the epoch pays it out with fee credits; `/stats` → `usageShareEnabled`, `usageShareToHolders24hUsd`; `/report` → `totals.usageShare` | `docs/PRICING.md` §3 |
| **Starter credits** | `starter.ts`, tables `starter_grants`, `starter_settings` (migration 16), config `starterCredits` | On a successful `POST /auth/verify` by a wallet that holds at least `minHoldTokens` (`requireMinHold: true`), credit `amountUsd` (ledger kind `starter`), once per wallet, `maxWallets` total, 3 per peppered IP hash per day; runtime pause via `POST /admin/starter/toggle`. With `transferable: false` the unused part of the grant cannot be listed on the marketplace (`expiry.ts → nonTransferableMicros`) | `routes/auth.ts`; `routes/market.ts` (listing check); `/stats` → `starterGrants`, `starterRequiresHold`, `starterTransferable`; `/me` → `nonTransferableUsd`; admin page | `docs/SWITCHING.md` |
| **Guest chat** | `routes/guest.ts`, config `guest` | `POST /v1/guest/chat` and `GET /v1/guest/quota`: a few free messages a day per IP, network + `allowedTiers` models only, no wallet; the treasury pays (an upstream-served message is booked at list plus `upstreamFeeBps`) and it never feeds engine 2 | `routing.ts`, `upstream.ts`; cost shown on `/report` | `docs/PRICING.md` §4 |
| **Credit expiry** | `expiry.ts`, config `creditExpiry`, ledger kind `expiry` (migration 19) | Every credit lapses `days` (90) after it landed, whatever its source; the oldest credit is consumed first; `market_refund` keeps its original date. Derived from sums over `credits_ledger` (no lots) and debited with one `expiry` row | `jobs/housekeeping.ts` after every epoch (`expireAll`); lazily per wallet in `routes/v1.ts` (chat), `routes/me.ts`, `routes/market.ts` (`GET /me/market`, `POST /market/listings`); `/me` → `expiry`; `/report` → `totals.creditExpiry`; `/stats` → `creditExpiryDays` | `docs/PRICING.md` §6 |
| **Direct sales** | `direct-sales.ts`, `routes/credits.ts`, config `directSales`, ledger kinds `purchase` (credits) and `credit_purchase` (prepaid) (migration 19) | `GET /credits/config` (public) and `POST /me/credits/buy {amountUsd}` (session): $1 of prepaid balance buys $1 of credit, in one transaction, within `minUsd`–`maxUsd`; 404 when disabled | the marketplace's `prepaid_ledger` (same balance, same top-ups and deposits); `/report` → `totals.directSales`; `/stats` → `directSalesEnabled` | `docs/PRICING.md` §7 |
| **Credit reserve** | `reserve-report.ts` (named apart from `reserve.ts`, which holds credit for requests in flight), table `reserve_snapshots` (migration 19), config `reserve`, `PonsEvmAdapter.reserve()` | Once per epoch read the credit-pool wallet: its stablecoin is the held reserve, ETH next to it is recorded and not counted; publish held against credits owed (spendable + escrowed in open listings) with `coverage`, `surplusUsd` and `short`. Mock adapter: one `mock` row, nothing held. A failed read is stored as `unavailable` and logged (`reserve_read_failed`), never thrown | `jobs/housekeeping.ts`; `/report` → `totals.reserve`; `/stats` → `reserve`; `alerts.ts` → `reserve_short` | `docs/PRICING.md` §5 |
| **Housekeeping job** | `jobs/housekeeping.ts` | `runHousekeeping`: `logSweepWarnings` (a sweep that left fees unswept for want of a fresh price is written to `errors_log` as `sweep_skipped`, which raises the `failed_sweep` alert), then `expireAll` (credit expiry), then `snapshotReserve` (reserve reading). Safe to run at any time | `index.ts` cron after every epoch, whether or not the sweep went through (a failure is logged as `housekeeping_failed`); `POST /admin/run-epoch` returns it as `housekeeping` | `docs/PRICING.md` §5–6 |
| **Verification** | `verification.ts`, table `verifications`, config `verification` | Re-run `sampleRate` of network jobs on a second node from the same anonymised payload under the same tier, compare in memory, penalise mismatches, quarantine repeat offenders; neither output stored | `routing.ts` (quarantined nodes excluded), node rewards (mismatch forfeits the reward), admin clear | `docs/NODE_PROTOCOL.md` §10, `docs/PRIVACY.md` §3 |
| **Privacy tiers** | `routing.ts` (tier resolution), `network.ts` (`sanitizeMessages`, trusted-only claims), `routes/nodes.ts` (pledge) | `trusted` (own nodes, allowlist, gold stake + pledge; falls back to the ZDR upstream, never another node), `network`, `upstream_zdr`; header > body > key default > config | every `/v1` request | `docs/PRIVACY.md` |

Everything a holder is paid lands through one door: the hourly epoch. Trading fees are the pool's
base; `pool_extra_micros` (marketplace fee share, usage share) is added to it before the pro-rata
split, and both are reported separately on `/report` so the two engines can be audited apart.
Credit also enters a wallet outside the epoch: bought on the marketplace (`market_buy`), bought from
Mesh at face value (`purchase`), or granted (`starter`, `adjustment`). Whatever its door, it lapses
after `creditExpiry.days`.

## 2. Request lifecycle: holder → gateway → node (or OpenRouter)

### 2a. Getting a key (once)

```
browser                      gateway                                  SQLite
  │ POST /auth/nonce {wallet} ──►│ NonceStore.issue (5 min, single use) ──► auth_nonces
  │◄── {message: SIWE-style} ────│
  │ wallet.signMessage(message)  │
  │ POST /auth/verify ──────────►│ adapter.verifyWalletSignature (ed25519 | EIP-191)
  │◄── {token: JWT 7d} ──────────│ ensureWallet ───────────────────────► wallets
  │ POST /keys (Bearer JWT) ────►│ createApiKey: random mesh_sk_…, sha256 ─► api_keys
  │◄── {key} (shown once) ───────│
```

### 2b. One chat completion

```
client (OpenAI SDK)            gateway (routes/v1.ts)                            node / upstream
  │ POST /v1/chat/completions ──►│ 1 rate limit (V1_RATE_LIMIT per key)
  │   Bearer mesh_sk_…           │ 2 lookupApiKey → api_keys row (401 if none)
  │   {model, messages, stream}  │ 3 isModelAllowed(model-policy) → 403 model_not_allowed
  │                              │ 4 keySpendExhausted → 429 key_spend_limit_reached
  │                              │ 5 expireWallet (credit past creditExpiry.days lapses first), then
  │                              │   balanceMicros(wallet) ≤ 0 → 402 insufficient_quota
  │                              │ 6 decideRoute(model):
  │                              │     preferNetwork? networkTagFor(model)? an online, idle,
  │                              │     reputable node advertising the tag? → 'node' else 'openrouter'
  │                              │
  │                              │ ── node path ──────────────────────────────────────────────
  │                              │ 7 broker.create(job: queued, deadline = now+jobTimeoutMs)
  │                              │   → jobs row; hands it to a long-polling node if one waits
  │                              │                                        GET /nodes/:id/jobs/next
  │                              │ 8 tryClaim: UPDATE jobs … WHERE status='queued' (atomic)  ◄──┤
  │                              │   nodes.busy = 1                        200 {jobId, messages}─►│ node
  │                              │ 9 relay.next(): first chunk within firstTokenTimeoutMs (8 s),  │ runs
  │◄── SSE chunk {delta} ────────│   then each chunk within stallTimeoutMs (6 s)                  │ Ollama
  │   x-mesh-route: node:<id>    │                              POST …/jobs/:jobId/chunk {seq,δ} ◄┤
  │        …                     │                              POST …/jobs/:jobId/done {tokens}  ◄┤
  │◄── final chunk {usage, mesh} │10 price = tokens × networkPricePerMTokens ($0.08/M)
  │◄── data: [DONE]              │   reward = tokens × nodeRewards.usdPerMTokens ($0.06/M) × stake multiplier,
  │                              │   never above maxShareOfPriceBps (90 %) of price; 0 if self-served
  │                              │   one transaction: requests_log, credits_ledger(usage, −price),
  │                              │   api_keys.spent, node_rewards(+reward), treasury_ledger(−reward)
  │                              │   nodes.busy = 0, relay released
  │                              │
  │                              │   failure before any output (unclaimed / first_token_timeout /
  │                              │   node fail): re-queue once excluding that node, else ↓
  │                              │ ── upstream path (or fallback, x-mesh-fallback: <reason>) ──
  │                              │11 upstream.chat(body) → OpenRouter (usage.include = true)
  │◄── SSE passthrough ──────────│   SseUsageScanner reads the final usage/cost chunk; with a markup or
  │   usage.cost = charged       │   discount and a paying caller the usage chunk is repriced on the way
  │   mesh.listCostUsd = list    │   through (usage.cost → billed, mesh.listCostUsd → list); else untouched
  │                              │12 list = usage.cost (or model-prices.json); billed = list × (1 + upstreamMarkupBps)
  │                              │   requests_log + credits_ledger(usage) + api_keys.spent
  │                              │   usage share: margin = billed − list × (1 + upstreamFeeBps)
  │                              │   upstream error / timeout → 502, nothing charged
```

Rules that fall out of this: money is only moved in step 10/12, inside one SQLite transaction;
a failure before output costs nothing and is retried once then falls back; after partial output
there is no fallback (the error is surfaced in-stream as `node_stream_failed`, not charged).

### 2c. Node side (apps/node-agent)

`mesh-node setup --link <code>` → `POST /nodes/register {linkCode, chip, ramGb, models}` →
`~/.mesh/config.json` holds `{nodeId, nodeToken, wallet}`. `mesh-node start` runs the loop in
`loop.ts`: heartbeat every 20 s, long-poll `GET /nodes/:id/jobs/next?wait=25000`, on a job call
Ollama `/api/chat` streaming and forward deltas as ordered `{seq, delta}` chunks (coalesced every
~40 ms / 2 KB, one POST in flight), then `done` with Ollama's token counts. A `409
job_not_running` on any chunk means the gateway gave up (client gone or timeout): stop generating.

## 3. Hourly epoch lifecycle (jobs/distribute.ts)

`EPOCH_CRON` (default `0 * * * *`) fires `runEpoch(ctx)`; `POST /admin/run-epoch {epochStart?}`
runs or replays the same function. Epochs are keyed by `epoch_start` (unix seconds, aligned to
`epochSeconds` = 3600); the cron run always processes the *previous* full hour
(`previousEpochStart`).

```
   cron tick (top of hour H)                        processes epoch [H-1h, H)
         │
         ▼
 1 getEpoch(epochStart) exists? ──yes──► status 'skipped' (idempotent; nothing written)
         │ no
 2 fees = adapter.collectFees()                 Mock: pendingFees pushed via /admin/fake-fees
         │                                      Solana/EVM: sweep vault → swap → USD value, txId
 3 split  holderPool = fees × holderShareBps (50 %) × creditUsdPerFeeUsd
          treasury   = fees − holderPool
 4 balances = adapter.getHolderBalances({from, to})   time-weighted over the hour
          eligible  = balance ≥ minHoldTokens (1000 MESH), sorted by wallet
 5 holding-age multipliers (distribution.holdingAge; off by default → all 1.0)
          hold-since from the adapter, else the gateway's holder_age cache
 6 shares = splitProRata(holderPool, balance × multiplier)   integer micro-USD, remainder deterministic
 6b pool += pending pool_extra_micros (marketplace fee share, usage share when enabled);
          those rows are stamped with epoch_start so nothing is paid twice (docs/MARKETPLACE.md)
 7 one transaction:
          credits_ledger  (kind 'distribution', ref 'epoch:<start>')   one row per holder
          treasury_ledger (kind 'fee_share', ref 'epoch:<start>')
          epochs          (status 'complete' | 'empty')
          UNIQUE(wallet, ref) on distributions makes a re-run a no-op even under a race
 8 on throw: errors_log code 'epoch_failed' → alerts.ts raises failed_sweep; the next tick
          retries the same epochStart because no epochs row was written
 9 housekeeping (jobs/housekeeping.ts), after the epoch whether it completed or threw:
          logSweepWarnings errors_log code 'sweep_skipped' when the sweep left fees unswept (no fresh price)
                          → alerts.ts raises failed_sweep
          expireAll       credits_ledger (kind 'expiry') for credit older than creditExpiry.days
          snapshotReserve reserve_snapshots row from the credit-pool wallet (mock adapter: one 'mock' row)
```

Credits are not pooled: a wallet's balance is `SUM(delta_usd_micros)` over its `credits_ledger` rows
(distribution + starter + adjustment + market_buy + market_refund + purchase − usage − market_escrow
− expiry). Each credit lapses `creditExpiry.days` (90) after it landed, oldest first
(`docs/PRICING.md` §6). Nothing on-chain happens for the holder; the fee sweep is the only
transaction.

### 3a. Fee source: Robinhood Chain via Pons (`PonsEvmAdapter`)

The decided launch (the internal docs repo) does not use a transfer fee of ours. The token is minted by the
Pons factory on Robinhood Chain; Pons charges the trading fee on the bonding curve and, after graduation,
through its Uniswap v4 hook, and credits the creator's share to its **Fee Escrow**
(`0xd3AF…Ac9e`) as a balance for `creatorFeeRecipient`. That recipient is our **`PonsFeeVault`**
(`contracts/evm/src/PonsFeeVault.sol`).

```
trade on Pons curve / v4 pool
   └─ Pons hook: feeBps (1%, 70% to creator) + creatorTaxBps (80, 100% to creator)
        └─ Fee Escrow: balanceOf(PonsFeeVault) += creator fee (ETH)        ← accrues between epochs
epoch (jobs/distribute.ts → adapter.collectFees())
   1. read escrow.balanceOf(vault) (+ balanceOfToken for each quote token) and the vault's held balances
   2. price: Chainlink ETH/USD (priceFeed); stale (> priceMaxAgeSec, 3600 s) or unreadable → no price; fixedEthUsd only when no feed is configured.
             an asset without a price is left unswept this epoch (in the escrow or the vault), no credits minted for it; a later epoch sweeps it
   3. PonsFeeVault.pull()            sweeper tx: escrow.claim() / claimToken(q) → vault
   4. per asset: PonsFeeVault.sweep(asset, minOut)   swap → stable via route, split holderShareBps → creditPool, rest → treasury   (sweepMode "swap": production)
                                                     minOut = expected USD × (1 − slippageBps); the swap reverts rather than settle below it
             or  PonsFeeVault.sweepRaw(asset)        no swap, same split in the asset                                             (sweepMode "raw": testnet rehearsal only)
   5. value in USD: stable received (swap) or amount × ETH/USD (raw) → feesUsdMicros
   6. holder balances: same Transfer-log indexer as EvmAdapter, excluding Pons escrow/factory/hook/locker/buyback vault, curve, pool, creditPool, vault, treasury, sweeper
after the epoch (jobs/housekeeping.ts → adapter.reserve())
   7. read creditPool: stable balance = held reserve, ETH balance reported apart → reserve_snapshots → GET /report totals.reserve
```

`config/deploy.robinhood.json` ships `sweepMode: "swap"`, so the holder share reaches `creditPool` in
the stablecoin and backs the USD credits it mints 1:1; that wallet is the credit reserve and is kept
apart from the treasury (`docs/PRICING.md` §5). `raw` is left for the testnet rehearsal
(`config/deploy.robinhood-testnet.json`). The contract itself was not changed: `sweepRaw()` still
exists on chain and the sweeper role may call it; swap-only is enforced by the gateway's config and
adapter, and **Check on chain** warns when `sweepMode` is `raw`.

Roles on the vault: `owner` (multisig; Ownable2Step) sets recipients, shares, routes, pause; `sweeper`
(gateway hot wallet, `MESH_EVM_PRIVATE_KEY`) can only drive `pull / sweep / sweepRaw`. Funds can only
land in `creditPool` or `treasury` (plus the owner's `rescue`). Routes: `V3Single` / `V3Path` (Uniswap v3
SwapRouter02, ETH wrapped by the router) or `Adapter` (a one-function `IMeshSwapAdapter` for the v4
universal router or an aggregator).

Configuration surface: `config/deploy.robinhood.json` is a committed template (Pons addresses prefilled,
token/feeVault null). The founder pastes the launched addresses in **Admin → Token** (routes/chain.ts);
they are stored in `chain_settings` (migration 17, every change also an `admin_actions` row) and applied
over the JSON at adapter construction (`chain-settings.ts → resolveAdapter`). With `MESH_ADAPTER=evm` but
no token/feeVault yet the gateway runs the MockAdapter and `/health` reports
`adapter: "mock (waiting for token)"`; once both are set a restart brings up `PonsEvmAdapter`
(`"evm (pons)"`). **Check on chain** (`POST /admin/chain/check` → `checkPonsConfig`) verifies the RPC chain
id, that `token` is an ERC-20, the escrow balance for the vault, the vault's owner/sweeper/recipients and
the exclusion list before the flip.

The previous fee source (MeshToken transfer fee → `FeeVault`, `EvmAdapter`) stays as the fallback behind
`feeSource: "meshToken"`; both adapters share the indexer, the signature verifier and the gateway contract.

## 4. Data model (SQLite, `apps/gateway/src/db.ts`)

Migrations are an append-only array; each `{id, sql}` runs once inside a transaction and is
recorded in `schema_migrations`. All money columns are **integer micro-USD** (`*_usd_micros`);
all `*_at`/`ts` columns are unix seconds and `*_ms` are unix milliseconds.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `wallets` | every wallet that signed in or received credits | `wallet` PK, `chain`, `created_at`, `last_login` |
| `api_keys` | holder API keys | `key_hash` (sha256, unique), `key_prefix`, `wallet`, `name`, `spend_limit_usd_micros`, `spent_usd_micros`, `revoked` |
| `credits_ledger` | the holder balance, append-only | `wallet`, `delta_usd_micros`, `kind` ∈ distribution/usage/adjustment/starter/market_escrow/market_buy/market_refund/purchase/expiry (the last two since migration 19), `ref`; unique `(wallet, ref)` for distributions |
| `market_listings`, `market_fills` | credit marketplace book and trades | listing: `seller_wallet`, `amount_micros`, `remaining_micros`, `discount_bps`, `price_micros_per_usd`, `status` ∈ open/filled/cancelled/expired, `expires_at`; fill: `listing_id`, `buyer_wallet`, `credits_micros`, `paid_micros`, `fee_micros`, `fee_to_holders_micros`, `fee_to_treasury_micros`, `settlement` ∈ prepaid/external |
| `prepaid_ledger`, `withdrawal_requests` | marketplace and direct-sale settlement (USD, off-chain during the beta) | `wallet`, `delta_micros`, `kind` ∈ topup/market_buy/market_sale/withdrawal/withdrawal_refund/adjustment/credit_purchase (the last since migration 19), `ref`; withdrawal `amount_micros`, `status` ∈ pending/paid, `tx_ref` |
| `reserve_snapshots` | what the credit-pool wallet held each time the gateway read it, once per epoch (migration 19) | `source` ∈ chain/mock/unavailable, `asset` (stablecoin address), `held_usd_micros` (NULL when there is nothing to read), `stable_usd_micros`, `other_usd_micros` (ETH, not counted), `note`, `created_at` |
| `pool_extra_micros` | money owed to the next holder pool from the marketplace fee and engine 2 | `source`, `usd_micros`, `ref` (unique), `epoch_start` (null until an epoch pays it) |
| `usage_share_log` | audit of engine 2 per paid request | `source` ∈ network/upstream, `ref`, `wallet`, `model`, `billed_micros`, `cost_micros`, `margin_micros`, `holder_micros`, `treasury_micros` |
| `starter_grants`, `starter_settings` | starter credits granted at sign-in to wallets that hold `minHoldTokens` | `wallet` PK, `amount_micros`, `granted_at`, `ip_hash`; runtime enabled override as a key/value row |
| `chain_settings` | Admin → Token overrides of `config/deploy.<network>.json` (migration 17) | `key` PK (token, feeVault, creditPool, treasury, stable, swapRouter, priceFeed, deployBlock, excludeWallets), JSON `value`, `updated_at`, `updated_by`; history in `admin_actions` (`chain-settings`) |
| `verifications` | spot checks of node answers | `job_id`, `check_job_id`, `primary_node`, `check_node`, `score`, `verdict` ∈ ok/suspect/mismatch/inconclusive, `reasons`, token counts; no output text |
| `epochs` | one row per processed hour | `epoch_start` PK, `epoch_end`, `fees_usd_micros`, `holder_pool_usd_micros`, `treasury_usd_micros`, `eligible_holders`, `fee_tx_id`, `status` ∈ complete/empty/failed |
| `requests_log` | one row per billed/served `/v1` call | `api_key_id`, `wallet`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd_micros`, `list_cost_usd_micros`, `saved_usd_micros`, `upstream` (`openrouter` / `mock` / `node:<id>`), `latency_ms`, `stream` |
| `nodes` | node registry | `node_id` PK, `wallet`, `models` (JSON array of Ollama tags), `ram_gb`, `chip`, `busy`, `last_seen`, `token_hash`, `agent_version`, `load_avg` |
| `heartbeats` | 48 h of heartbeats, drives `uptimePct24h` | `node_id`, `ts`, `busy` |
| `jobs` | network job queue + history | `job_id` PK, `model`, `tag`, `wallet`, `api_key_id`, `status` ∈ queued/running/done/failed/fallback, `payload` (JSON), `max_tokens`, `deadline_ms`, `node_id`, `exclude_node_id`, `parent_job_id`, `attempt`, token counts, `error`, `node_fault`, `created_ms`/`claimed_ms`/`first_chunk_ms`/`finished_ms` |
| `node_rewards` | what nodes earned, append-only | `wallet`, `node_id`, `job_id` (unique), `kind` ∈ node_reward/payout, `tokens`, `usd_micros` |
| `treasury_ledger` | treasury view for `/report` | `kind` ∈ fee_share/node_reward_accrual/buyback/ops/other/guest_chat/market_fee, `usd_micros`, `ref` (unique per kind) |
| `holder_age` | hold-since cache for holding-age weighting | `wallet` PK, `hold_since`, `last_balance` |
| `auth_nonces` | sign-in and node-registration challenges | `nonce` PK, `wallet`, `domain` (`<AUTH_DOMAIN>` or `<AUTH_DOMAIN>#node-register`), `expires_at`, `used_at` |
| `node_link_codes` | one-time codes from `POST /nodes/link` | `code_hash` PK, `wallet`, `chain`, `expires_at`, `used_at`, `used_node_id` |
| `admin_actions` | audit trail of every `/admin/*` call | `action`, `payload` (JSON) |
| `errors_log` | 5xx and upstream failures | `route`, `status`, `code`, `message` |
| `schema_migrations` | applied migration ids | `id`, `applied_at` |

Derived, not stored: wallet balance (`SUM` over `credits_ledger`), credit due to lapse and unused
starter credit (sums over the same ledger, `expiry.ts`), reserve coverage (latest `reserve_snapshots`
row against the ledger and open listings), node reputation (last 100 scored `jobs` rows per node),
`/stats` series (hourly buckets over `epochs`, `credits_ledger`, `requests_log`; cached
`STATS_CACHE_MS`).

Migration 19 rebuilds `credits_ledger` and `prepaid_ledger` in place to widen their `kind` CHECK
(SQLite cannot alter a CHECK; same pattern as migration 14) and creates `reserve_snapshots`.

Hot state that is **not** in SQLite: `JobBroker.relays` (per-job event queues carrying chunks from
the node's POSTs to the waiting client handler) and `JobBroker.waiters` (nodes parked in a
long-poll). Both are plain in-memory maps in the gateway process; see §8.

## 5. Config surface (`config/*.json`, validated by `packages/config`)

| File | What it controls | Read when |
| --- | --- | --- |
| `tokenomics.json` | token name/ticker/chain (the chain value is a default; the team decides on launch day), `tradeFeeBps`, `holderShareBps`/`treasuryShareBps`, `minHoldTokens`, `epochSeconds`, `creditUsdPerFeeUsd`, `requestPricing` {`upstreamMarkupBps` \| `upstreamDiscountBps` (one non-zero at most), `upstreamFeeBps`, `networkPricePerMTokens`, `showSavings`}, `nodeRewards` {`usdPerMTokens`, `maxShareOfPriceBps`}, `usageShare` {`enabled`, `holderBps`, `treasuryBps`, `sources`}, `marketplace` {`enabled`, `feeBps`, `feeToHoldersBps`, `minListingUsd`, `maxDiscountBps`, `listingTtlHours`, `deposits`}, `starterCredits` {`enabled`, `amountUsd`, `maxWallets`, `requireMinHold`, `transferable`}, `creditExpiry` {`enabled`, `days`}, `directSales` {`enabled`, `minUsd`, `maxUsd`}, `reserve.minCoverageBps`, `guest`, `beta`, `privacy`, `verification`, `points`, `stakeTiers`, `distribution.holdingAge`, `geoBlock` (ISO country codes, empty = none), `routing` {`preferNetwork`, `firstTokenTimeoutMs`, `stallTimeoutMs`, `jobTimeoutMs`, `defaultMaxTokens`, `minSuccessRate`, `reputationMinJobs`, queue settings}, `nodes` {`requireSignature`, `maxPerWallet`}, `meta` | gateway start (`createContext`); tests inject their own; the web app bundles the same file for every number it prints |
| `model-policy.json` | `allow` / `deny` patterns (trailing `*`), `networkModels` {client name → Ollama tag} | gateway start |
| `model-prices.json` | the curated catalogue (`tier`, `vendor`, `displayName`) with OpenRouter list prices per 1M tokens: what `GET /v1/models` shows as `listPrice`, the fallback when the upstream does not report `usage.cost`, and the list price savings are measured against; refreshed by `node scripts/refresh-model-prices.mjs` | gateway start |
| `deploy.<network>.json` | addresses the live adapters need (token, fee vault, treasury, `deployBlock`, staking; for `feeSource: "pons"` also the Pons contracts, `creditPool`, `quoteTokens`, `stable`, `sweepMode` (`swap` in `deploy.robinhood.json`, `raw` in the testnet twin), `priceFeed`, `fixedEthUsd`, `slippageBps`). `deploy.robinhood.json` is a committed template whose nulls the Admin → Token panel fills (`chain_settings` wins) | adapter construction when `MESH_ADAPTER=chain|evm`; `tokenomics.deployNetwork` / `MESH_DEPLOY_NETWORK` picks the file |

Env overrides a handful of config values for dev/demo (`NODES_REQUIRE_SIGNATURE`,
`GEO_BLOCK_ENFORCE`); everything else about *economics* lives in JSON so it is diffable and
reviewed, and tests read the numbers from the same files rather than hard-coding them.

## 6. Environment variables

Gateway (`apps/gateway/src/env.ts`, zod-validated at boot; `.env.example` documents them). In
`NODE_ENV=production` the process refuses to start with default secrets, a `localhost`
`AUTH_DOMAIN` or `CORS_ORIGINS=*`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | listen address |
| `MESH_DB_PATH` | `./data/mesh.db` | SQLite file (`:memory:` in tests); directory is created |
| `MESH_ADAPTER` | `mock` | `mock` = in-memory holders/fees; `chain` (alias `evm`/`solana`) = live adapter for `tokenomics.json → chain`. An EVM config without `token` + `feeVault` keeps the mock and `/health` says `mock (waiting for token)` |
| `JWT_SECRET`, `JWT_SECRET_PREVIOUS` | dev default (refused in prod) | session signing; previous accepted for verification during rotation |
| `ADMIN_TOKEN` | `dev-admin-token` | `x-admin-token` for `/admin/*` |
| `ALLOW_DEV_LOGIN` | true outside production | enables `POST /admin/dev-login` |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | unset → mock upstream | real upstream |
| `UPSTREAM_TIMEOUT_MS` | `60000` | abort upstream calls; never charged |
| `EPOCH_CRON` | `0 * * * *` | distribution schedule; `off` disables |
| `V1_RATE_LIMIT` | `120` | requests/min per API key (or IP) on `/v1` |
| `AUTH_RATE_LIMIT` | `20` | requests/min per IP on `/auth/*` |
| `NODE_REGISTER_RATE_LIMIT` | `10` | registrations/hour per IP on `/nodes/register`, `/challenge`, `/link` |
| `NODES_REQUIRE_SIGNATURE` | config (`true`) | `false` = accept unsigned `{wallet}` registration (dev/demo/load test) |
| `CORS_ORIGINS` | any origin in dev; none in prod | comma-separated browser origins |
| `BODY_LIMIT_BYTES` | `2097152` | `/v1` body cap (other routes 16 KB) |
| `AUTH_DOMAIN`, `AUTH_URI` | `localhost:8787`, `https://<AUTH_DOMAIN>` | SIWE domain/URI in sign-in and registration messages |
| `STATS_CACHE_MS` | `10000` | `/stats`, `/report` cache; `0` disables |
| `GEO_BLOCK_ENFORCE` | on in production | enforce `tokenomics.geoBlock` on `/v1` and `/auth` |
| `LOG_LEVEL` | `info` | pino level (bearers and admin tokens are redacted) |
| `ALERTS_ENABLED`, `ALERT_CHECK_INTERVAL_MS` | `true`, `60000` | AlertMonitor |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset → log only | alert delivery |
| `ALERT_DB_MAX_MB`, `ALERT_DISK_MIN_FREE_PCT` | `1024`, `10` | alert thresholds |

Chain adapter (`MESH_ADAPTER=chain`; read by `packages/chain-adapter` and `scripts/chain/*`):
`MESH_DEPLOY_NETWORK`, `MESH_SOLANA_RPC_URL`, `MESH_SOLANA_KEYPAIR`, `MESH_HELIUS_API_KEY`,
`MESH_JUPITER_API_KEY`, `MESH_JUPITER_BASE_URL`, `MESH_EVM_RPC_URL`, `MESH_EVM_CHAIN_ID`,
`MESH_EVM_PRIVATE_KEY`, `MESH_FIXED_ETH_USD` (ETH/USD used only when no Chainlink feed is configured; it never stands in for a feed that is stale or unreadable), `MESH_HOLD_SINCE_LOOKBACK_SEC`, `MESH_DRY_RUN`. Foundry
(`contracts/evm/foundry.toml`): `BASE_SEPOLIA_RPC_URL`, `ROBINHOOD_RPC_URL`,
`ROBINHOOD_TESTNET_RPC_URL`, `BASESCAN_API_KEY`, `FOUNDRY_SOLC`.

Web (`apps/web`, Vite, must be `VITE_`-prefixed, baked in at build time): `VITE_API_URL`
(gateway base URL), `VITE_MOCK=1` (render with fake data, no gateway).

Node agent (`apps/node-agent/src/config.ts`): `GATEWAY_URL` (default `http://localhost:8787`),
`NODE_URL` / Ollama (default `http://127.0.0.1:11434`), `NODE_WALLET`, `NODE_MODELS`; normally
persisted in `~/.mesh/config.json` by `mesh-node setup`.

## 7. Ports

| Port | Who | Notes |
| --- | --- | --- |
| `8787` | gateway | the only port a deployment exposes; Caddy terminates TLS in front (`scripts/deploy-vps.md`), docker-compose binds `127.0.0.1:8787` |
| `5173` | web dev server (`pnpm dev`) | production is static files on any host/CDN |
| `11434` | Ollama on each Mac | loopback only; the agent talks to it, the gateway never does |
| `8790` / `5174` | gateway / web during Playwright e2e | `apps/web/playwright.config.ts` |
| `8799` | gateway during `scripts/demo.sh` | throwaway SQLite in a temp dir |
| `8798` | gateway during `scripts/loadtest/relay.mjs` | throwaway SQLite in a temp dir |
| `8545` | anvil (`pnpm --filter @mesh/chain-adapter test:anvil`) | local EVM |

## 8. What is single-instance today

Everything in the gateway assumes **exactly one process** per deployment:

1. **SQLite file** — one writer (WAL), synchronous `better-sqlite3` calls on the event loop. Fine
   for one process; a second process on another host cannot share it.
2. **`JobBroker` relays and waiters** — chunks POSTed by a node reach the client only if the
   client's request handler lives in the same process as the `relays` map. A node that registered
   through gateway A and polls gateway B would claim a job whose client waits on A.
3. **Epoch cron** — `node-cron` inside the process; two processes would both try to run the hour
   (the `UNIQUE(wallet, ref)` index and the `epochs` PK make the second a no-op, but it would still
   call `collectFees()` twice). The housekeeping that follows each epoch (credit expiry, reserve
   reading) runs in the same tick.
4. **Rate limiters** — `@fastify/rate-limit` in-memory store and the `fixedWindowLimiter` used by
   `/auth` and `/nodes/register`; per-process counters.
5. **`NonceStore`** is in SQLite (fine), but **`/stats` cache** and **AlertMonitor** state are
   per-process.
6. **`decideRoute` snapshot** — "idle node" is read from the `nodes.busy` column at request time;
   two processes racing are still safe (the claim is an atomic `UPDATE … WHERE status='queued'`),
   they would just both queue and one job would time out `unclaimed` and fall back.

This is deliberate for launch: one VPS, one container, one SQLite file, backed up by copying
`/data/mesh.db` (`docs/RUNBOOK.md`). `docs/LOADTEST.md` measures where that single process tops
out (~2,600–2,900 relayed tokens/s on 2 vCPUs, first token p50 19 ms).

## 9. How to scale later (in order)

1. **Vertical first.** The relay is CPU-bound on the event loop; 4–8 vCPUs and `LOG_LEVEL=warn`
   roughly scale the token ceiling with cores because SQLite reads and JSON parsing dominate.
   Address the per-request routing queries and per-heartbeat prune listed in `docs/LOADTEST.md`
   before anything structural.
2. **Split read traffic.** `/stats`, `/report`, `/epochs`, `/nodes` and the web app are
   cacheable; put them behind the CDN/Caddy cache with `STATS_CACHE_MS`-sized TTLs so public
   traffic never competes with `/v1` and node POSTs.
3. **Sticky jobs, many gateways.** Keep one SQLite-backed *control plane* (registration, auth,
   ledger, epochs) and run N *relay* processes. The cheapest route to "many gateways" that keeps
   the protocol intact: the `jobId` encodes the relay instance (or the node is told a per-job
   `relayUrl`), and the load balancer routes `/nodes/:id/jobs/:jobId/*` by that key. Nodes long-poll
   the instance they registered with. Chunks never need to cross processes.
4. **Shared broker when stickiness is not enough.** Replace `JobRelay` queues with a pub/sub
   (Redis Streams / NATS) keyed by `jobId`, and `waiters` with a shared queue per tag. `JobBroker`
   is the only module that has to change; its public surface (`create / pull / chunk / done /
   nodeFail / abandon / release`) stays.
5. **Move the ledger to Postgres** only when (3)–(4) exist: the schema is already integer-micro-USD
   and append-only, the migrations array ports directly, and the `UNIQUE(wallet, ref)` /
   `UNIQUE(job_id)` idempotency keys are what make multi-writer safe. Run the epoch job as a
   separate scheduled process (`EPOCH_CRON=off` on the API instances, `POST /admin/run-epoch` from
   a cron container) so exactly one sweep happens per hour.
6. **Rate limiting and nonces** move to the same Redis once there is more than one API instance;
   `fixedWindowLimiter` and `@fastify/rate-limit`'s store are both pluggable.
7. **Per-node concurrency.** Let nodes advertise `maxConcurrent` (Ollama `OLLAMA_NUM_PARALLEL`)
   and replace the boolean `busy` with a running-job count; together with queueing when all nodes
   are busy (`docs/LOADTEST.md` bottleneck 1) this is the largest win for the share of traffic the
   network serves.
