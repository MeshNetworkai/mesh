# Mesh — status after Session 4 gateway work (2026-10-03)

One page: what runs end to end today, how to run it, what is faked, and what the token layer has to deliver. The node network protocol (gateway ⇄ node agent) is specified in `docs/NODE_PROTOCOL.md` and fully implemented on the gateway side.

## What works end to end today

Fully offline, no token, no RPC, no OpenRouter key:

1. **Fees → epoch → credits.** `POST /admin/fake-fees` pushes USD fees into the `MockAdapter`; `POST /admin/run-epoch` (or the hourly cron) sweeps them, splits 50/50 holder/treasury (`config/tokenomics.json`), filters holders by `minHoldTokens`, credits eligible wallets pro-rata into `credits_ledger`, and writes an `epochs` row. Idempotent per `epochStart`.
2. **Wallet sign-in.** `POST /auth/nonce` returns a SIWE/SIWS-style message; the wallet signs that exact string; `POST /auth/verify` checks domain, nonce (single use, 5 min), issued-at and the ed25519 / EIP-191 signature and returns a 7-day JWT. `POST /auth/refresh` rotates it; the web app refreshes once on a 401 and retries.
3. **API keys.** `POST /keys {name?, spendLimitUsd?}` (secret shown once), `GET /keys`, `PATCH /keys/:id` (rename, set/clear the lifetime spend cap), `GET /keys/:id/usage` (24h / 7d / all-time requests, spend, tokens, top models), `DELETE /keys/:id`.
4. **OpenAI-compatible inference.** `POST /v1/chat/completions` (streaming or not) and `GET /v1/models` with the key as bearer. Debits `usage.cost` from the wallet balance, enforces the model policy and the per-key spend limit (`429 key_spend_limit_reached`), never charges on upstream failure. With `routing.preferNetwork` (on by default) a request for a network model (`config/model-policy.json → networkModels`, e.g. `llama-3.1-8b → llama3.1:8b`) is served by an online idle Mesh node when one advertises the tag; the client gets a continuous OpenAI SSE stream whose final chunk carries `mesh: {route:"node", nodeId, chip}`, and is billed a flat `$0.02/M` total tokens. Otherwise (or on transparent fallback after a node failure before any output) it goes to OpenRouter at passthrough cost.
5. **Public telemetry.** `GET /stats` (totals, `lastEpoch`, `feesThisEpochUsd`, 24 hourly buckets in `series24h`, `nodesOnline`, `servedByNetworkPercent`, token meta), `GET /epochs?limit=48`, `GET /nodes` (summary only), `GET /health`.
6. **Node network (gateway side).** `POST /nodes/register` → `{nodeId, nodeToken}` (sha256 stored; bearer for all `/nodes/:id/*`), `POST /nodes/:id/heartbeat` every 20 s (`heartbeats` table, 48 h retention, drives `uptimePct24h`), `GET /nodes/:id/jobs/next` long-poll (≤25 s, atomic claim), `POST …/jobs/:jobId/chunk|done|fail`. Timeouts: no first chunk in 8 s / stall > 6 s → job failed, re-queued once to another node, else fallback to OpenRouter; after partial output there is no fallback and the error is surfaced in-stream (`node_stream_failed`, not charged). Per completed job the node wallet accrues `$0.06/M` tokens in the `node_rewards` ledger (more than the user pays; see Pricing economics below). Reputation (success rate + avg first-token latency over the last 100 jobs) excludes nodes under 80 % (min 5 jobs). `GET /nodes/:id` (node token or owner session) and `GET /me/nodes` expose status, uptime, jobs/tokens/earnings 24 h and total, reputation. `GET /nodes` and `GET /stats` report `jobs24h`, `servedByNetwork24h`, and a real `servedByNetworkPercent`.
7. **Operator surface.** `GET /admin/overview` (48 epochs, totals, top holders, nodes with URLs, recent errors, audit trail), starter credits (single + atomic batch), `POST /admin/dev-login` (dev only). Every admin call is audited.
8. **Web app (`apps/web`).** Landing, Docs, and a signed-in area: Overview (balance, ledger with running balance, fees sparkline from `series24h`, "fees this epoch"), Keys (create with name + limit, edit, revoke, per-key usage, spent/limit), Chat (streams through `/v1` with a key created in this browser), Network (`/stats` tiles, 24h sparkline, `/epochs` table, `/nodes` summary). Public **Report** (`/report`): "$X in fees became $Y of AI credits", 7d/30d/all-time table, two charts (fees in vs credits out per week; Mesh nodes vs OpenRouter share), 12-week table with per-week drill-down (`/report/weekly/:isoWeek`), method footnote. **Operator** (`/admin`): ADMIN_TOKEN typed into a field (memory only), overview tiles, run epoch, fake fees (mock only), starter-credit batch, key revocation by id, recent errors, audit trail. Wallets: Phantom, Solflare, MetaMask, Rabby. Works at 390 px and 1440 px; screenshots in `docs/screens/`.
9. **Treasury ledger + report.** `treasury_ledger` (`fee_share` per epoch, negative `node_reward_accrual` per completed job; `buyback`/`ops`/`other` reserved) feeds `GET /report` (totals, `last7d`, `last30d`, `byWeek[]`, `treasuryBalanceUsd`, `servedByNetworkPercent`, `method` notes) and `GET /report/weekly/:isoWeek` (days + epochs).
10. **Holding-age weighting (off by default).** `config.distribution.holdingAge = {enabled, maxDays, minMultiplier, maxMultiplier}`. `HolderBalance.holdSinceTs` (optional) from the adapter — the MockAdapter tracks it and resets it on a transfer out — else the gateway's `holder_age` cache (first epoch seen above `minHoldTokens`; a balance drop resets; below threshold forgets). Weight = balance × linear multiplier; eligibility unchanged. Disabled reproduces today's pro-rata exactly (tested).

Quality gates: `pnpm -r typecheck`, `pnpm -r build`, `pnpm test` (13 files, 125 tests; 8 cover holding-age math/reset/cache/disabled parity, 6 cover the treasury ledger, `/report`, `/report/weekly`, admin key revocation; 20 cover the node protocol end to end with a fake node: register → heartbeat → client request → pull → chunks → done → SSE with mesh usage → reward → stats; fallback on timeout; no fallback after partial output; re-queue to a second node; reputation exclusion; atomic claim with two nodes) are green; `bash scripts/demo.sh` runs the whole flow, including a curl-simulated node serving a job, against a throwaway SQLite file.

## Pricing economics

Network-served requests are priced so credits go a long way on 8B-class models, and nodes are paid more than the user is charged:

- **User price** `requestPricing.networkPricePerMTokens` = **$0.02 per 1M total tokens** (debited from the wallet's credit balance).
- **Node reward** `nodeRewards.usdPerMTokens` = **$0.06 per 1M total tokens** (accrued to the node wallet in `node_rewards`).
- **Gap** = $0.04 per 1M tokens, covered by the treasury share of trade fees (`treasuryShareBps` 5000 of `tradeFeeBps` 150, i.e. 0.75 % of trade volume).

Break-even per 1M network tokens served:

| What has to be funded | Fee-USD needed | Trade volume needed (1.5 % fee) |
|---|---|---|
| Gap only ($0.04, from the treasury half of fees) | $0.08 of fees | **~$5.33** |
| Whole node reward ($0.06, counting both halves of the fee) | $0.06 of fees | **$4.00** |

So every $5.33 of $MESH trade volume funds the subsidy on 1M network tokens; the user-paid $0.02 itself is credits minted from the holder half of fees (`creditUsdPerFeeUsd` 1.0). If volume falls below that, the treasury runs the subsidy down and the lever is `nodeRewards.usdPerMTokens` (or the price), both hot-reloaded from `config/tokenomics.json`.

## Exact commands

```sh
pnpm install
pnpm build                 # packages + gateway + web
pnpm test                  # 125 vitest tests (gateway)
pnpm dev                   # gateway :8787 (mock adapter, mock upstream) + web :5173, one terminal
pnpm demo                  # scripted end-to-end run, prints every step
pnpm dev:mock              # web only on fake data (no gateway) — what docs/screens/ shows
pnpm screenshots           # regenerate docs/screens/*.png from mock mode
```

Seeding a holder with credits while `pnpm dev` is running (ADMIN_TOKEN defaults to `dev-admin-token`):

```sh
curl -X POST localhost:8787/admin/fake-fees -H 'x-admin-token: dev-admin-token' -H 'content-type: application/json' -d '{"amountUsd":100}'
curl -X POST localhost:8787/admin/run-epoch -H 'x-admin-token: dev-admin-token' -H 'content-type: application/json' -d '{}'
# then sign in at http://localhost:5173 with any wallet, or for a mock holder:
JWT=$(curl -s -X POST localhost:8787/admin/dev-login -H 'x-admin-token: dev-admin-token' -H 'content-type: application/json' -d '{"wallet":"mockwallet_alice"}' | jq -r .token)
```

A browser wallet that is not a mock holder will sign in fine but have a $0 balance until an epoch credits it (or `POST /admin/starter-credit`).

Real models: set `OPENROUTER_API_KEY` for the gateway; everything else stays the same.

## What is mocked or stubbed

| Piece | Today | Real version |
| --- | --- | --- |
| Holder balances, fee sweep, token transfers | `MockAdapter` (in-memory holders `mockwallet_alice/bob/carol/dust`, `pushFees`) | `SolanaAdapter` / `EvmAdapter` methods throw `NotWiredError` |
| `feesThisEpochUsd` | `MockAdapter.pendingFees()` | `null` for chain adapters until they can read the fee vault cheaply; the UI then shows "fees last epoch" |
| Upstream inference | `MockUpstream` when `OPENROUTER_API_KEY` is unset ($0.001 per request, one canned reply) | OpenRouter passthrough (implemented, needs a key) |
| P2P node network | gateway complete (jobs, relay, rewards, reputation); relays are in-process, node wallet unsigned at registration, rewards accrue in USD only | `apps/node-agent` running Ollama against `docs/NODE_PROTOCOL.md`; signed registration; on-chain reward payout; shared job store for multi-instance |
| Stake tiers | validated config, multipliers not applied | distribution job |
| Holding age | implemented; `enabled: false`; MockAdapter reports `holdSinceTs` | chain adapters return `holdSinceTs` from transfer history, or leave it undefined and let the `holder_age` cache accrue |
| Treasury `buyback` / `ops` rows | kinds exist, no endpoint | admin endpoint or on-chain reconciliation |
| Web `VITE_MOCK=1` | module-scoped fake data in `apps/web/src/lib/mock.ts`, same shapes as the gateway | — (screenshots only) |
| Sessions | JWT in `localStorage` | cookie sessions planned |
| Rate limit / stats cache | in-process | shared store for multi-instance |
| `/admin/dev-login` | mints a JWT for any wallet | must be hidden at the proxy in production |

## What Session 4 (token layer) needs

Everything above is parameterised on `ChainAdapter`; the gateway, ledger, web and tests do not change when the adapter does.

1. **Deploy $MESH and the fee vault.** Fill `config/tokenomics.json` → `meta.contractAddress`, `meta.totalSupply`, and `chain` (`solana` or `evm`). The 1.5 % trade fee (`tradeFeeBps`) must be enforced on-chain (transfer hook / tax or DEX fee tier) and land in a vault the gateway can sweep.
2. **`SolanaAdapter` (or `EvmAdapter`) — three methods:**
   - `getHolderBalances({from, to})` → time-weighted balances over the epoch window (Helius/RPC snapshots for SPL; `Transfer` log replay or an indexer for EVM). Must return token units, not raw lamports/wei. Exclude the pool, vault and treasury addresses.
   - `collectFees()` → sweep the vault, return `{amountUsd, txId}`. USD valuation needs a price source (DEX pool spot or an oracle); document which.
   - `transferTokens(to, amount)` → treasury payouts (node rewards later).
   - Optional: a cheap `pendingFeesUsd()` so `/stats.feesThisEpochUsd` is non-null on the live chain.
   - Optional: `holdSinceTs` per holder (time of the last transfer out, or first acquisition) so holding-age weighting is exact from day one; without it the gateway's `holder_age` cache starts counting at the first epoch it sees the wallet.
3. **Keys and ops.** RPC URL / Helius key / signer keypair as env vars (`apps/gateway/src/env.ts`), `MESH_ADAPTER=chain`, `EPOCH_CRON` on, `AUTH_DOMAIN` set to the public host so the sign-in message matches. Deployment path is in `scripts/deploy-vps.md` (Docker + Caddy).
4. **Launch-day data.** Seed starter credits with `POST /admin/starter-credits` if the first epoch should not be empty; confirm `geoBlock` list; set `STATS_CACHE_MS` for public load.
5. **Tests to add with the adapter:** a replayed epoch against a recorded holder snapshot (deterministic pro-rata totals), a sweep that returns 0 (epoch status `empty`), and a sweep that throws (today `runEpoch` propagates the error and writes nothing; the `epochs.status` CHECK already allows `failed`, so decide whether to record a `failed` row and retry on the next tick).

Nice-to-have, not blocking: stake-tier multipliers in `jobs/distribute.ts`, cookie sessions, node reward payouts (`node_rewards.kind='payout'`) via `transferTokens`.
