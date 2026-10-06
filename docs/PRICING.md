# Pricing: the frontier catalogue, the discount knob and the two engines

How Mesh prices a request, what the treasury funds, and how holders earn from usage as well as
from trading fees. Everything here is driven by `config/tokenomics.json` (`requestPricing`,
`nodeRewards`, `usageShare`, `guest`), `config/model-prices.json` (the catalogue and its list
prices) and `config/model-policy.json` (which models Mesh nodes serve). The code paths are
`apps/gateway/src/catalogue.ts` (GET /v1/models), `routes/v1.ts` + `relay.ts` (billing) and
`usage-share.ts` (engine 2).

## 1. The catalogue

`GET /v1/models` returns the curated catalogue, not only what Mesh nodes run. It keeps the OpenAI
shape (`object: "list"`, `data[].id / object / created / owned_by`) and adds, per model:

| field | meaning |
| --- | --- |
| `displayName`, `vendor`, `tier` | `frontier` (strongest closed models), `fast` (cheap closed models), `open` (open weights) |
| `served` | `network` (Mesh nodes only), `upstream` (OpenRouter only), `both` (nodes first, upstream fallback) |
| `listPrice` | OpenRouter list, USD per 1M prompt / completion tokens |
| `meshPrice` | what Mesh bills: the flat network price per 1M tokens on a node, else list ± the upstream markup/discount |
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

Network models bill the flat network price instead: **$0.08 per 1M total tokens** (`networkPricePerMTokens`),
for any model a node serves.

## 2. How a request is billed

Credits are USD. A request is billed in micro-USD and debited from the wallet's `credits_ledger`.

| served by | the user pays | it costs Mesh | treasury funds |
| --- | --- | --- | --- |
| a Mesh node | `tokens × networkPricePerMTokens` ($0.08/M) | the node reward, `tokens × nodeRewards.usdPerMTokens` ($0.06/M), accrued against the treasury | nothing — the $0.02/M **network margin** feeds engine 2 (§3) |
| the upstream | `list × (1 − upstreamDiscountBps/10000)` or `list × (1 + upstreamMarkupBps/10000)` | `list` (what OpenRouter charged, `usage.cost`; fallback: `model-prices.json`) | the **discount gap**: `list × discount` (a markup is margin instead) |

`upstreamMarkupBps` and `upstreamDiscountBps` are exclusive: the config refuses both non-zero. The
legacy `markupBps` key is still read and folded into `upstreamMarkupBps`. Shipped values:
`upstreamDiscountBps: 0`, `upstreamMarkupBps: 0`, `networkPricePerMTokens: 0.08`.

Every reply reports `usage.cost` (what was billed) and, on network-served replies, `mesh.listCostUsd`
and `mesh.savedUsd`. `requests_log` keeps `cost_usd_micros`, `list_cost_usd_micros` and
`saved_usd_micros` for both legs, so a discount shows up as savings in `GET /me` and `GET /stats`
exactly like the network does.

### Setting a 10–40 % upstream discount

Resellers who front OpenRouter at 5–40 % off list fund the gap from their own margin elsewhere. Mesh
funds it from the treasury share of trading fees, the same pot that pays the network gap. To turn it on:

```jsonc
// config/tokenomics.json
"requestPricing": {
  "mode": "passthrough",
  "upstreamMarkupBps": 0,
  "upstreamDiscountBps": 2000,      // 20 % below OpenRouter list
  "networkPricePerMTokens": 0.02,
  "showSavings": true
}
```

Restart the gateway (config is read at boot). `GET /v1/models` immediately reports the discounted
`meshPrice`, the web picker shows "20 % below list" on every upstream row, and `GET /stats` carries
`upstreamDiscountBps`.

What it costs, per **$1,000 of OpenRouter list usage** routed upstream (the treasury pays the gap
when the upstream invoice arrives; it is not booked per request):

| discount | user pays | treasury funds | Claude Sonnet 4.5, 1k in + 500 out | GPT-5, 1k in + 500 out | Gemini 2.5 Flash, 1k in + 500 out |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 % | $1,000 | $0 | $0.01050 | $0.00625 | $0.00155 |
| 10 % | $900 | $100 | $0.00945 | $0.00563 | $0.00140 |
| 20 % | $800 | $200 | $0.00840 | $0.00500 | $0.00124 |
| 30 % | $700 | $300 | $0.00735 | $0.00438 | $0.00109 |
| 40 % | $600 | $400 | $0.00630 | $0.00375 | $0.00093 |

The network leg carries no gap at the shipped $0.08/M (nodes get $0.06, the $0.02 margin is engine 2);
it only becomes a subsidy if the price is dropped below the node reward (at $0.02/M, $1,000 of spend
is 50M tokens, $3,000 of node rewards and a $2,000 gap). Keep the sum of any gaps under the treasury share of fees
(`treasuryShareBps`, 50 % of a 1.5 % trade fee) over a rolling week; `GET /report`
(`totals.treasury`, `byWeek`) is the dashboard for that.

Rules of thumb: a discount deeper than 40 % makes a $1 credit worth more than $1 of OpenRouter and
invites arbitrage through the credit marketplace; a markup only makes sense once network coverage
is high enough that most traffic never reaches the upstream.

## 3. The two engines

Holders get paid two ways. Both land in the same hourly epoch (`jobs/distribute.ts`), both are
pro-rata on time-weighted balance (× holding-age multiplier when enabled).

### Engine 1: trading fees (always on)

`tradeFeeBps` (1.5 %) of every trade is swept each epoch. `holderShareBps` (50 %) becomes inference
credits at `creditUsdPerFeeUsd` (1:1); `treasuryShareBps` (50 %) is booked to the treasury and pays
node rewards, the network gap, the discount gap, guest chat and ops.

Worked hour: $100,000 traded → $1,500 fees → $750 of credits to holders, $750 to the treasury.

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
| network | `user price − node reward` (× stake multiplier, i.e. what the node really earned) |
| upstream | `billed − upstream cost` = `list × markup` (a discount makes this negative) |

If `usageShare.enabled` and the margin is positive, `holderBps` of it is written to
`pool_extra_micros` with `source = 'usage'`, the very same hook the credit marketplace uses for its
fee share, and the next epoch pays it out with the fee credits. The remaining `treasuryBps` stays
with the treasury. A negative or zero margin writes nothing. Every contribution is logged in
`usage_share_log` (margin, holder cut, treasury cut, source) so the split is auditable; `holderBps +
treasuryBps` must equal 10000.

`sources.network` / `sources.upstream` switch each leg off. The marketplace fee's holder share
(`marketplace.feeToHoldersBps`) is always paid to the pool by `market.ts`; `sources.marketplaceFee`
only decides whether it is **counted** in the usage-share report. That was the simpler choice and it
is how it ships.

**Why the network price is $0.08.** Engine 2 needs a margin to share. Below the node reward ($0.06/M)
every network request runs at a loss and contributes nothing, and with no markup every upstream
request has a zero margin by design (price-matched to OpenRouter is the frontier hook). The shipped
combination is:

```jsonc
"requestPricing": { "mode": "passthrough", "upstreamMarkupBps": 0, "upstreamDiscountBps": 0, "networkPricePerMTokens": 0.08, "showSavings": true },
"nodeRewards":    { "usdPerMTokens": 0.06 },
"usageShare":     { "enabled": true, "holderBps": 3000, "treasuryBps": 7000, "sources": { "network": true, "upstream": true, "marketplaceFee": true } }
```

Worked numbers at those values, per 1M network tokens: user pays $0.08, node earns $0.06, margin
$0.02 → **$0.006 to holders, $0.014 to the treasury**. A 1,500-token chat (1k in, 500 out) pays
$0.000120, the node gets $0.000090, holders get $0.000009. At 10B network tokens a month that is
$60,000 to holders on top of fee credits. Note what the flat price does to the savings line: Qwen 2.5 14B
(list $0.06 / $0.18) and Llama 3.1 70B ($0.10 / $0.32) are still well below list on the network, but
Llama 3.1 8B (list $0.05 / $0.08) is now at or slightly above OpenRouter for prompt tokens — `savedUsd`
clamps at zero, so the pitch for the 8B model is privacy (the request never leaves the Mac network),
not price. Pair it with an upstream markup (not a discount) if the upstream leg should contribute too: `upstreamMarkupBps: 1000` on $100,000 of monthly upstream list usage is a
$10,000 margin → $3,000 to holders.

Where to see it: `GET /report` → `totals.usageShare { enabled, holderBps, treasuryBps, marginUsd,
toHoldersUsd, toTreasuryUsd, requests, bySource { network, upstream, marketplaceFee } }` and
`GET /stats` → `usageShareToHolders24hUsd`, `usageShareEnabled`.

## 4. Guests

Homepage guests (`POST /v1/guest/chat`) pick from the network models plus `guest.allowedTiers`
(default `["open", "fast"]`); a frontier model returns `403 model_not_allowed_for_guests` and does
not spend a free message. The treasury pays for guest traffic and it never feeds engine 2.

## 5. Website copy

> **Frontier models at a discount, open models on Macs, and a token that earns from both.**
> Mesh gives you Claude, GPT-5, Gemini, Grok and DeepSeek through one OpenAI-compatible key at or
> below list price, routed only to zero-data-retention providers, and runs Llama and Qwen on a
> network of Macs for a flat $0.08 per million tokens. Your credits come from trading fees every
> hour, and a share of the margin on every paid request flows back into the next hour's pool. Holders earn when people use the network, not only
> when they trade it.
