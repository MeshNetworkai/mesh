# Pricing: the catalogue, the markup, the two engines, the reserve, expiry and direct sales

How Mesh prices a request, what a credit is backed by, when it lapses, how it can be bought, and how
holders earn from usage as well as from trading fees. Everything here is driven by
`config/tokenomics.json` (`requestPricing`, `nodeRewards`, `usageShare`, `guest`, `reserve`,
`creditExpiry`, `directSales`), `config/deploy.<network>.json` (`sweepMode`, `stable`, `priceFeed`,
`creditPool`), `config/model-prices.json` (the catalogue and its list prices) and
`config/model-policy.json` (which models Mesh nodes serve). The code paths are
`apps/gateway/src/catalogue.ts` (GET /v1/models), `routes/v1.ts` + `relay.ts` (billing),
`usage-share.ts` (engine 2), `reserve-report.ts` (§5), `expiry.ts` (§6), `direct-sales.ts` +
`routes/credits.ts` (§7) and `jobs/housekeeping.ts` (the hourly chores behind §5 and §6).

## 1. The catalogue

`GET /v1/models` returns the curated catalogue, not only what Mesh nodes run. It keeps the OpenAI
shape (`object: "list"`, `data[].id / object / created / owned_by`) and adds, per model:

| field | meaning |
| --- | --- |
| `displayName`, `vendor`, `tier` | `frontier` (strongest closed models), `fast` (cheap closed models), `open` (open weights) |
| `served` | `network` (Mesh nodes only), `upstream` (OpenRouter only), `both` (nodes first, upstream fallback) |
| `listPrice` | OpenRouter list, USD per 1M prompt / completion tokens |
| `meshPrice` | what Mesh bills: the flat network price per 1M tokens on a node, else list plus the upstream markup (list × 1.06 as shipped) or minus a configured discount |
| `privacy` | `network` (prompt processed on a Mac in the network) or `upstream_zdr` (OpenRouter, zero-data-retention providers only) |
| `online` | nodes advertising the model's Ollama tag right now |
| `guestAllowed` | a homepage guest may pick it (network models + `guest.allowedTiers`, default `open` + `fast`) |

The endpoint works without a key (the web picker and guest chat read it); a bearer that is present
must be a valid key; `?guest=1` narrows it to the guest set. A top-level `pricing` object repeats
the knobs: `networkPricePerMTokens`, `upstreamDiscountBps`, `upstreamMarkupBps`, `guestTiers`.

### Shipped catalogue (OpenRouter list, USD per 1M tokens)

Prices are refreshed from `GET https://openrouter.ai/api/v1/models` by
`node scripts/refresh-model-prices.mjs` (offline-safe: a failed fetch exits 1 and leaves the file
alone; `--dry-run` prints the diff). The file records `_refreshedAt`.

| model | tier | prompt | completion | served |
| --- | --- | ---: | ---: | --- |
| anthropic/claude-sonnet-4.5 | frontier | 3.00 | 15.00 | upstream |
| anthropic/claude-opus-4.1 | frontier | 15.00 | 75.00 | upstream |
| openai/gpt-5 | frontier | 1.25 | 10.00 | upstream |
| openai/gpt-4.1 | frontier | 2.00 | 8.00 | upstream |
| google/gemini-2.5-pro | frontier | 1.25 | 10.00 | upstream |
| x-ai/grok-4 | frontier | 3.00 | 15.00 | upstream |
| mistralai/mistral-large | frontier | 2.00 | 6.00 | upstream |
| anthropic/claude-3.5-haiku | fast | 0.80 | 4.00 | upstream |
| openai/gpt-5-mini | fast | 0.25 | 2.00 | upstream |
| google/gemini-2.5-flash | fast | 0.30 | 2.50 | upstream |
| deepseek/deepseek-chat-v3.1 | open | 0.20 | 0.80 | upstream |
| deepseek/deepseek-r1 | open | 0.40 | 2.00 | upstream |
| moonshotai/kimi-k2 | open | 0.14 | 2.49 | upstream |
| meta-llama/llama-3.3-70b-instruct | open | 0.10 | 0.32 | upstream |
| qwen/qwen-2.5-72b-instruct | open | 0.12 | 0.39 | upstream |
| meta-llama/llama-3.1-8b-instruct (`llama-3.1-8b`) | open | 0.05 | 0.08 | both |
| qwen/qwen-2.5-7b-instruct (`qwen-2.5-7b`) | open | 0.04 | 0.10 | both |
| `qwen-2.5-14b` (network only; what 32 GB+ Macs pull) | open | 0.06 | 0.18 | network |
| `llama-3.1-70b` (network only; `--with-70b` on 64 GB Macs) | open | 0.10 | 0.32 | network |

These are list prices. Upstream-served models bill list plus the markup (§2). Network models bill
the flat network price instead: **$0.08 per 1M total tokens** (`networkPricePerMTokens`), for any
model a node serves.

## 2. How a request is billed

Credits are USD. A request is billed in micro-USD and debited from the wallet's `credits_ledger`.

| served by | the user pays | it costs Mesh | margin |
| --- | --- | --- | --- |
| a Mesh node | `tokens × networkPricePerMTokens` ($0.08/M) | the node reward: `tokens × nodeRewards.usdPerMTokens` ($0.06/M) × the node's stake multiplier, never more than `nodeRewards.maxShareOfPriceBps` (90 %) of the price, so $0.072/M at most | $0.02/M for an unstaked node, $0.008/M at the ceiling; shared by engine 2 (§3) |
| the upstream | `list × (1 + upstreamMarkupBps/10000)`: list × 1.06 | `list × (1 + upstreamFeeBps/10000)`: list × 1.055. `list` is what OpenRouter charged for the request (`usage.cost`; fallback: `model-prices.json`); the 5.5 % is what OpenRouter charges Mesh on top of list when Mesh buys its credits | 0.5 % of list; shared by engine 2 (§3) |

Shipped values: `upstreamMarkupBps: 600`, `upstreamFeeBps: 550`, `upstreamDiscountBps: 0`,
`networkPricePerMTokens: 0.08`. `upstreamMarkupBps` and `upstreamDiscountBps` are exclusive: the
config refuses both non-zero. The legacy `markupBps` key is still read and folded into
`upstreamMarkupBps`. `upstreamFeeBps` is not a price the user sees; it tells the gateway what an
upstream request really costs, so that a markup which only covers the fee is not counted as margin.

Frontier models are therefore not sold at list. Per request, 1,000 prompt tokens and 500 completion
tokens:

| model | OpenRouter list | Mesh bills (list × 1.06) |
| --- | ---: | ---: |
| Claude Sonnet 4.5 | $0.01050 | $0.01113 |
| GPT-5 | $0.00625 | $0.006625 |
| Gemini 2.5 Flash | $0.00155 | $0.001643 |

What the reply reports: `usage.cost` is always what the wallet was charged. A node-served reply
carries it with `mesh.listCostUsd` and `mesh.savedUsd`. For an upstream-served reply the upstream's
own `usage.cost` is the list cost, so when a markup or a discount is set and the caller pays, the
gateway rewrites `usage.cost` to the amount charged and reports the upstream's figure as
`mesh.listCostUsd` (`relay.ts`, `reprice`): in the non-streamed body, in the stream's usage chunk and
in the final `mesh` chunk. With the shipped 6 % markup a $0.001 mock reply shows
`usage.cost: 0.00106` and `mesh.listCostUsd: 0.001`. At list (no markup, no discount), and for
treasury-paid guests, the upstream's reply is passed through untouched. Non-streamed replies also
carry the charge in the `x-mesh-cost-usd` header. `requests_log` keeps `cost_usd_micros`, `list_cost_usd_micros` and `saved_usd_micros`
for both legs; `saved` is `max(0, list − billed)`, so under a markup it is zero on the upstream leg
and only network-served requests show savings in `GET /me` and `GET /stats`.

### Changing the markup, or setting a discount

The markup has to stay above `upstreamFeeBps`, or every frontier request is a loss
(`apps/gateway/test/catalogue.test.ts` asserts it for the shipped config). A discount is still a
config option, for an operator who wants to undercut OpenRouter and pay for it: it is a
treasury-funded loss of the discount **plus** the 5.5 % fee on every list dollar.

```jsonc
// config/tokenomics.json: 20 % below OpenRouter list, paid for by the treasury
"requestPricing": {
  "mode": "passthrough",
  "upstreamMarkupBps": 0,
  "upstreamDiscountBps": 2000,
  "upstreamFeeBps": 550,
  "networkPricePerMTokens": 0.08,
  "showSavings": true
}
```

Restart the gateway (config is read at boot). `GET /v1/models` immediately reports the discounted
`meshPrice`, the web picker shows "20 % below list" on every upstream row, and `GET /stats` carries
`upstreamDiscountBps`.

What each setting does, per **$1,000 of OpenRouter list usage** routed upstream:

| setting | user pays | costs Mesh | margin, or loss the treasury funds | Claude Sonnet 4.5, 1k in + 500 out | GPT-5, 1k in + 500 out | Gemini 2.5 Flash, 1k in + 500 out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| markup 6 % (shipped) | $1,060 | $1,055 | +$5 | $0.01113 | $0.006625 | $0.001643 |
| none (list) | $1,000 | $1,055 | −$55 | $0.01050 | $0.00625 | $0.00155 |
| discount 10 % | $900 | $1,055 | −$155 | $0.00945 | $0.00563 | $0.00140 |
| discount 20 % | $800 | $1,055 | −$255 | $0.00840 | $0.00500 | $0.00124 |
| discount 30 % | $700 | $1,055 | −$355 | $0.00735 | $0.00438 | $0.00109 |
| discount 40 % | $600 | $1,055 | −$455 | $0.00630 | $0.00375 | $0.00093 |

At the shipped markup the $5 margin splits $1.50 to holders and $3.50 to the treasury (§3). A loss
is not booked per request (a non-positive margin writes nothing, §3); the treasury pays it when the
upstream is topped up. Keep any such loss under the treasury share of fees (`treasuryShareBps`,
50 % of a 1.5 % trade fee) over a rolling week; `GET /report` (`totals.treasury`, `byWeek`) is the
dashboard for that.

The network leg cannot run at a loss while `maxShareOfPriceBps` is below 10000: a node is never paid
more than 90 % of what the user was billed, so lowering the network price below the base reward
lowers what nodes earn instead of opening a gap (at $0.02/M the node is held at $0.018/M and the job
still leaves $0.002/M).

Rule of thumb: any discount makes a credit dollar buy more than a dollar of OpenRouter list usage
while costing Mesh $1.055 per list dollar, which invites arbitrage through the credit marketplace.

## 3. The two engines

Holders get paid two ways. Both land in the same hourly epoch (`jobs/distribute.ts`), both are
pro-rata on time-weighted balance (× holding-age multiplier when enabled).

### Engine 1: trading fees (always on)

`tradeFeeBps` (1.5 %) of every trade is swept each epoch and settled in a stablecoin on chain (§5).
`holderShareBps` (50 %) lands in the credit-pool wallet and becomes inference credits at
`creditUsdPerFeeUsd` (1:1); `treasuryShareBps` (50 %) goes to the treasury, whose ledger carries the
node reward accruals, guest chat and ops.

Worked hour: $100,000 traded → $1,500 fees → $750 of credits to holders, backed by $750 of
stablecoin in the credit pool, and $750 to the treasury.

### Engine 2: usage-revenue share (on from launch)

```jsonc
// config/tokenomics.json
"usageShare": {
  "enabled": true,
  "holderBps": 3000,
  "treasuryBps": 7000,
  "sources": { "network": true, "upstream": true, "marketplaceFee": true }
}
```

When a **paid** request is recorded (`relay.ts`, both legs; guests never count because nobody paid),
the gateway computes the margin Mesh made on it:

| source | margin |
| --- | --- |
| network | `user price − node reward` (the reward after the stake multiplier and the ceiling, i.e. what the node really earned) |
| upstream | `billed − upstream cost` = `list × (upstreamMarkupBps − upstreamFeeBps) / 10000`: 0.5 % of list as shipped. A discount, or a markup at or below the fee, makes it zero or negative |

If `usageShare.enabled` and the margin is positive, `holderBps` of it is written to
`pool_extra_micros` with `source = 'usage'`, the very same hook the credit marketplace uses for its
fee share, and the next epoch pays it out with the fee credits. The remaining `treasuryBps` stays
with the treasury. A negative or zero margin writes nothing. Every contribution is logged in
`usage_share_log` (billed, cost, margin, holder cut, treasury cut, source) so the split is
auditable; `holderBps + treasuryBps` must equal 10000.

`sources.network` / `sources.upstream` switch each leg off. The marketplace fee's holder share
(`marketplace.feeToHoldersBps`) is always paid to the pool by `market.ts`; `sources.marketplaceFee`
only decides whether it is **counted** in the usage-share report. That was the simpler choice and it
is how it ships.

**Why the network price is $0.08, and why nodes stop at 90 % of it.** Engine 2 needs a margin to
share. The network price ($0.08/M) sits above the base node reward ($0.06/M, 75 % of the price), and
`nodeRewards.maxShareOfPriceBps` (9000) keeps a margin when a stake multiplier applies: a job never
pays its node more than 90 % of what the user was billed for it, `floor(price × 0.9)` in micro-USD,
which is $0.072/M at the shipped price. That 10 % also pays for spot-check re-runs. On the upstream
leg the 6 % markup clears the 5.5 % OpenRouter charges Mesh, leaving 0.5 % of list. The shipped
combination is:

```jsonc
"requestPricing": { "mode": "passthrough", "upstreamMarkupBps": 600, "upstreamDiscountBps": 0, "upstreamFeeBps": 550, "networkPricePerMTokens": 0.08, "showSavings": true },
"nodeRewards":    { "usdPerMTokens": 0.06, "maxShareOfPriceBps": 9000 },
"usageShare":     { "enabled": true, "holderBps": 3000, "treasuryBps": 7000, "sources": { "network": true, "upstream": true, "marketplaceFee": true } }
```

Worked numbers at those values, per 1M network tokens (the user pays $0.08 in every row):

| node's stake tier | multiplier | reward before the ceiling | node earns | margin | to holders (30 %) | to the treasury (70 %) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 1.0× | $0.06 | $0.06 | $0.02 | $0.006 | $0.014 |
| silver | 1.5× | $0.09 | $0.072 | $0.008 | $0.0024 | $0.0056 |
| gold | 2.0× | $0.12 | $0.072 | $0.008 | $0.0024 | $0.0056 |

Silver and gold are both held at the ceiling, 1.2× the base rate in effect, so at the shipped prices
the two staked tiers differ from each other by routing priority and trusted status, not by pay
(`docs/STAKING.md`). `GET /stats` carries `nodeRewardMaxShareBps`.

A 1,500-token chat (1k in, 500 out) pays $0.000120. Served by an unstaked node, the node gets
$0.000090 and holders get $0.000009; served by a staked node, the node gets $0.000108 and holders
get $0.000003.

**How much this is.** 10B network tokens a month is 10,000 M tokens: at $0.006/M that is **$60** to
holders and $140 to the treasury (less if staked nodes serve them: $24 and $56 at the ceiling).
$60,000 a month to holders would take 10 trillion tokens. On the upstream leg, $1,000 of list usage
is billed $1,060 against a cost of $1,055: a $5 margin, $1.50 to holders and $3.50 to the treasury;
$100,000 of monthly list usage is $150 to holders. The usage share is small at these volumes. What
carries the economics is trading fees (engine 1) and direct credit sales (§7); the usage share is
there so that holders are paid from real usage as it grows, not as a headline number.

Note what the flat price does to the savings line: Qwen 2.5 14B (list $0.06 / $0.18) and Llama 3.1
70B ($0.10 / $0.32) are still well below list on the network, but Llama 3.1 8B (list $0.05 / $0.08)
is at or slightly above OpenRouter for prompt tokens — `savedUsd` clamps at zero, so the pitch for
the 8B model is privacy (the request never leaves the Mac network), not price.

Where to see it: `GET /report` → `totals.usageShare { enabled, holderBps, treasuryBps, marginUsd,
toHoldersUsd, toTreasuryUsd, requests, bySource { network, upstream, marketplaceFee } }` and
`GET /stats` → `usageShareToHolders24hUsd`, `usageShareEnabled`, `upstreamMarkupBps`,
`upstreamFeeBps`, `nodeRewardMaxShareBps`.

## 4. Guests

Homepage guests (`POST /v1/guest/chat`) pick from the network models plus `guest.allowedTiers`
(default `["open", "fast"]`); a frontier model returns `403 model_not_allowed_for_guests` and does
not spend a free message. The treasury pays for guest traffic and it never feeds engine 2. A guest
message the upstream served is booked at what it really cost: list plus `upstreamFeeBps` (a
`guest_chat` treasury row; a $0.001 message is booked as $0.001055).

## 5. The credit reserve

Credits are US dollars, so what stands behind them is held in dollars and published.

### Fees settle in a stablecoin

`config/deploy.robinhood.json` ships `sweepMode: "swap"`. Each epoch the gateway's sweeper calls
`PonsFeeVault.pull()` and then `sweep(asset, minOut)` per fee asset: the vault swaps the asset to
the configured stablecoin (`stable`, USDG / USDC on Robinhood Chain) through its route and splits
the proceeds on chain, `holderShareBps` (50 %) to the credit-pool wallet (`creditPool`) and the rest
to the treasury wallet. The epoch's fees are the stablecoin the swap returned, and the holder half
mints credits at `creditUsdPerFeeUsd` (1.0), so a credit minted from fees has a dollar of stablecoin
behind it in the credit-pool wallet. That wallet is separate from the treasury.

`sweepMode: "raw"` (`sweepRaw()`: no swap, the asset itself is split and valued off chain) remains
for the testnet rehearsal only (`config/deploy.robinhood-testnet.json`), because the pool would then
hold ETH against credits that are fixed in dollars. `contracts/evm/src/PonsFeeVault.sol` was not
changed: `sweepRaw()` still exists on chain. Swap-only is a policy of the gateway (the deploy config
and `PonsEvmAdapter` decide which function the sweeper calls), and the admin Check
(`packages/chain-adapter/src/pons-check.ts`) warns when `sweepMode` is `raw`.

With `sweepMode: "swap"` the stablecoin, the swap route on the vault and the price feed have to be
set before the first live sweep (`docs/RUNBOOK.md` §6). Without a stablecoin on the vault `sweep()`
reverts: the epoch fails, nothing is minted and the fees wait.

### A stale price feed never mints credits

The ETH/USD price sets the slippage floor of each swap: `minOut` is the expected dollar value less
`slippageBps` (100 = 1 %), and the swap reverts rather than settle below it.
`PonsEvmAdapter.ethUsd()` takes that price from the Chainlink aggregator in `priceFeed`, and when a
feed is configured it is the only source: an answer older than `priceMaxAgeSec` (default 3600 s), or
a read that fails, yields no price. `fixedEthUsd` (or `MESH_FIXED_ETH_USD`) is used only when no
feed is configured at all; it never stands in for a stale one.

`sweep()` leaves any asset it cannot price unswept. The asset stays in the Pons escrow (or in the
vault, if a `pull()` already claimed it), no credits are minted for it, and a later epoch sweeps it
once the feed is fresh, so those fees reach the holders of that later hour. Stablecoin fees need no
price and are swept regardless. Nothing is lost; it is delayed. It is not silent either: the chores
after the epoch (`jobs/housekeeping.ts`) log each asset left behind as `sweep_skipped`, and the
`failed_sweep` alert fires on it.

### The published number

After every epoch (`jobs/housekeeping.ts`) the gateway reads the credit-pool wallet
(`PonsEvmAdapter.reserve()`), stores the reading in `reserve_snapshots` (migration 19) and publishes
the latest one next to what is owed in credits, on `GET /report → totals.reserve` and
`GET /stats → reserve`:

| field | meaning |
| --- | --- |
| `source` | `chain`: read from the pool wallet. `mock`: the token is not live, fees are a test feed and nothing is held. `unavailable`: the read failed (logged as `reserve_read_failed`) |
| `asset` | address of the settlement stablecoin |
| `heldUsd` | stablecoin in the pool wallet at the reading, at $1. Only the stablecoin counts as held |
| `otherUsd` | ETH found in the same wallet, valued at the reading (null when it could not be priced). Reported, not counted |
| `creditsSpendableUsd` | every credit a wallet could spend now (the sum of `credits_ledger`) |
| `creditsInEscrowUsd` | credit escrowed in open marketplace listings: owed to a buyer, or back to the seller |
| `requiredUsd` | `creditsSpendableUsd + creditsInEscrowUsd` |
| `coverage` | `heldUsd ÷ requiredUsd`; null when nothing is owed or there is no reading |
| `surplusUsd` | `heldUsd − requiredUsd`; negative when the reserve is short |
| `short` | true when coverage is below `minCoverageBps` |
| `minCoverageBps` | `reserve.minCoverageBps`, 10000 as shipped: every credit covered |
| `note`, `asOf` | a remark on the reading (for example ETH in the wallet, not counted) and when it was taken (unix seconds) |

```jsonc
// config/tokenomics.json
"reserve": { "minCoverageBps": 10000 }
```

Example: the pool holds $100 of stablecoin, wallets hold $50 of spendable credit and $30 sits in
open listings. `requiredUsd` is $80, `coverage` 1.25, `surplusUsd` $20, `short` false. If the pool
held $50 instead, coverage would be 0.625, the surplus −$30 and `short` true. A short reading raises
the `reserve_short` alert (`apps/gateway/src/alerts.ts`).

Before the token launch the adapter is the mock: `source` is `mock`, `heldUsd`, `coverage` and
`short` are null, and the alert stays silent. The beta's credits are not backed by a reserve.

### What moves the two sides

- A sweep adds stablecoin to the pool and the epoch mints the same amount of credit to the eligible
  holders. An hour with no eligible holder mints nothing, and its holder share sits in the pool as
  surplus.
- A credit that is spent, or that lapses (§6), lowers `requiredUsd`; the stablecoin that backed it
  shows up as surplus. Only `surplusUsd` may be moved from the pool to the treasury.
- Credit that does not come from a sweep raises `requiredUsd` without anything arriving in the pool
  wallet on its own: direct sales (§7), starter credits, admin grants, and the usage and marketplace
  shares that join the hourly pool. The gateway reads the pool wallet; it does not move money into
  it. The operator funds the pool for those (`docs/RUNBOOK.md` §11g).

## 6. Credit expiry

```jsonc
// config/tokenomics.json
"creditExpiry": { "enabled": true, "days": 90 }
```

Every credit lapses 90 days after it landed in the wallet, whatever its source: an hourly
distribution, a starter grant, a marketplace purchase, a direct purchase (§7) or a positive admin
adjustment. The rules (`apps/gateway/src/expiry.ts`):

- **Oldest first.** Whatever leaves the balance comes off the oldest credit first, so only what is
  left of a grant on its 90th day lapses. $10 lands on day 0, $4 is spent on day 10, $5 is bought on
  the marketplace on day 50: on day 90 the remaining $6 lapses and the $5 is good until day 140.
- **A listing does not stop the clock.** Credit refunded from a cancelled or expired listing comes
  back with its original date; if that date has passed, it lapses at the next check. Credit that is
  sold starts a fresh 90 days in the buyer's wallet.
- **A request in flight keeps its credit.** Credit a running request has reserved (`reserve.ts`) is
  not expired under it.
- **One row per lapse.** The ledger has no lots; the amount is derived from sums (grants older than
  the cutoff minus everything consumed since), which is exact because every credit has the same
  lifetime. It is debited with one `expiry` row in `credits_ledger`.

When it runs: for every wallet after each epoch (`jobs/housekeeping.ts`, also on
`POST /admin/run-epoch`), and lazily for one wallet on `POST /v1/chat/completions`, `GET /me`,
`GET /me/market` and `POST /market/listings`, so lapsed credit cannot be spent or listed between
sweeps.

Where to see it:

- `GET /me → expiry { enabled, days, next: { usd, at } | null, within7dUsd, within30dUsd }`: the next
  credit to lapse and how much of the balance is inside its last 7 and 30 days.
- `GET /report → totals.creditExpiry { enabled, days, expiredUsd, wallets, last30dUsd }`.
- `GET /stats → creditExpiryDays` (null when expiry is off); the same field is on
  `GET /market/config` and `GET /credits/config`.

Lapsed credit lowers `requiredUsd` (§5), so the stablecoin that backed it shows up as reserve
surplus.

## 7. Buying credits directly

```jsonc
// config/tokenomics.json
"directSales": { "enabled": true, "minUsd": 1, "maxUsd": 10000 }
```

A wallet can buy credits from Mesh at face value: $1 from its prepaid USD balance buys $1 of credit.
It needs no token and no seller on the marketplace. In the web app it is on the Market page
(`/app/market`).

- `GET /credits/config` (public) → `{ enabled, pricePerUsd, minUsd, maxUsd, settlement, deposits,
  creditExpiryDays, soldUsd, purchases }`. `pricePerUsd` is always 1; `settlement` is `prepaid`.
- `POST /me/credits/buy { amountUsd }` (session) → `201 { id, creditsUsd, paidUsd, created_at,
  expires_at, creditBalanceUsd, prepaidBalanceUsd }`.
- Errors: `402 insufficient_prepaid`, `400 below_minimum` (under `minUsd`), `400 above_maximum`
  (over `maxUsd`), `404` on both routes when `directSales.enabled` is false.
- One transaction (`direct-sales.ts`): the prepaid balance pays (`prepaid_ledger` kind
  `credit_purchase`) and the credit lands (`credits_ledger` kind `purchase`); both rows share the
  ref `purchase:<id>`.

The prepaid balance is the one the marketplace settles in (`docs/MARKETPLACE.md`). During the beta
the team tops it up after an off-chain payment (`POST /admin/prepaid`); self-serve stablecoin
deposits open once `marketplace.deposits.receiver` and `tokens` are set (both empty as shipped).

Bought credit is ordinary credit: it can be spent on any model, listed on the marketplace, and it
lapses 90 days after the purchase (`expires_at`).

On the books, the payment backs the credit 1:1 in the reserve; it is not treasury income. Mesh earns
its normal margin when the credit is spent (§2). This is the revenue that does not depend on the
token trading: usage can grow past what fees mint. The stablecoin arrives where the prepaid balance
was funded (the deposit receiver), not in the credit-pool wallet, so the operator moves it there to
keep the reserve covered (`docs/RUNBOOK.md` §11g).

Where to see it: `GET /report → totals.directSales { enabled, soldUsd, purchases, wallets,
last30dUsd }` and `GET /stats → directSalesEnabled`.

## 8. Website copy

> **Trading fees become AI credits, every hour: open models on Macs, frontier models through one key.**
> Hold 1,000 $MESH and AI credits land in your wallet every hour, paid from the 1.5 % trading fee.
> The holder half of every fee is swapped to a stablecoin and held in a published reserve, next to
> the credits it backs. Spend credits on Llama and Qwen served by a network of Macs for a flat $0.08
> per million tokens, or on Claude, GPT-5, Gemini, Grok and DeepSeek at list price plus 6 %, routed
> only to zero-data-retention providers. Credits last 90 days. Sell the ones you will not use, or
> buy more at face value without holding the token. A share of the margin on every paid request
> joins the next hour's pool.

Rules for this copy: never "at list", "below list" or "price-matched" for frontier models (it is
list plus 6 %, `requestPricing.upstreamMarkupBps`); never "credits do not expire"; starter credits
are for holders and cannot be sold. Before the token launch `totals.reserve.source` is `mock` and
nothing is held, so the reserve sentence describes how it works after launch and no coverage figure
is printed until `source` is `chain`.
