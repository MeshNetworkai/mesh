# Mesh ($MESH)

Mesh is a token whose trading fees buy AI for the people who hold it.
Every hour the gateway sweeps the trading fees, splits them holder/treasury, and credits
eligible holders pro-rata with inference credits (USD-denominated, stored as micro-USD).
Holders spend credits through an OpenAI-compatible API (`/v1/chat/completions`) that is served by a
P2P network of Mac nodes running Ollama when one is online for the model, and by OpenRouter otherwise
(transparent fallback). Nodes earn per token served.

## Architecture

```
                 trades                       hourly epoch (node-cron / POST /admin/run-epoch)
  DEX pool ───────────────► fee vault ──────────────────────────────────────────┐
                                                                                 ▼
 ┌────────────────────┐  getHolderBalances / collectFees   ┌─────────────────────────────────┐
 │  packages/         │◄───────────────────────────────────│  apps/gateway  (Fastify)         │
 │  chain-adapter     │                                    │                                 │
 │  Mock | Solana | EVM│  verifyWalletSignature             │  jobs/distribute.ts             │
 └────────────────────┘◄───────────────────────────────────│   fees → holder/treasury split  │
                                                           │   → min-hold filter → pro-rata  │
 ┌────────────────────┐  tokenomics.json (zod)             │   → holding-age weight (opt)   │
                                                           │   → credits_ledger rows +       │
                                                           │     treasury_ledger fee_share   │
 │  packages/config   │───────────────────────────────────►│                                 │
 └────────────────────┘                                    │  SQLite (better-sqlite3)        │
                                                           │   wallets · api_keys ·          │
   wallet sig ──► POST /auth/nonce, /auth/verify ─► JWT ──►│   credits_ledger · epochs ·     │
   JWT ───────────► POST /keys  →  mesh_sk_…  ────────────►│   requests_log · nodes          │
                                                           │                                 │
   OpenAI SDK ────► POST /v1/chat/completions (SSE ok) ───►│  upstream.ts ───────────────────┼──► OpenRouter
                    GET  /v1/models                        │   (or offline MOCK upstream)    │     (or mock)
                                                           └───────────────┬─────────────────┘
                                                                           │ /nodes/register → nodeToken · heartbeat 20s
                                                                           │ GET /nodes/:id/jobs/next (long-poll, atomic claim)
                                                                           │ POST …/jobs/:jobId/chunk | done | fail
 ┌────────────────────┐                                    ┌───────────────▼─────────────────┐
 │  apps/web          │  /stats /epochs /nodes /me /keys   │  apps/node-agent                │
 │  Vite + React app  │◄───────────────────────────────────│  Ollama on Macs; pulls jobs,    │
 └────────────────────┘  /me/nodes /nodes/:id              │  streams chunks back            │
                                                           └─────────────────────────────────┘
   docs/NODE_PROTOCOL.md is the contract between the two.
```

## Quick start

```sh
pnpm install
pnpm build            # builds packages (config, chain-adapter) + apps (gateway, web)
pnpm test             # vitest: ledger math, distribution, auth, keys, stats, node protocol, end-to-end
pnpm dev              # gateway on :8787 (MOCK adapter + mock upstream) AND web on :5173, together via concurrently
```

Open http://localhost:5173. The web app talks to the gateway at `http://localhost:8787` (override
with `VITE_API_URL`). Sign in with Phantom/Solflare/MetaMask/Rabby, or, for a holder with a balance,
seed one via steps 1–3 below and use the dev-login JWT. Other entry points: `pnpm dev:gateway`,
`pnpm dev:web`, `pnpm dev:mock` (web only, fake data, no gateway), `pnpm screenshots`
(re-renders `docs/screens/*.png` from mock mode), `pnpm demo` (scripted end-to-end run).

Everything below works offline. `ADMIN_TOKEN` defaults to `dev-admin-token` (see `.env.example`).

```sh
# 1. fake $100 of trading fees into the MockAdapter
curl -X POST localhost:8787/admin/fake-fees -H 'x-admin-token: dev-admin-token' \
     -H 'content-type: application/json' -d '{"amountUsd":100}'

# 2. run an epoch: 50% → holders ≥ 1000 MESH pro-rata, 50% → treasury
curl -X POST localhost:8787/admin/run-epoch -H 'x-admin-token: dev-admin-token' \
     -H 'content-type: application/json' -d '{}'

# 3. log in as a mock holder (DEV ONLY shortcut; real flow is /auth/nonce → sign → /auth/verify)
JWT=$(curl -s -X POST localhost:8787/admin/dev-login -H 'x-admin-token: dev-admin-token' \
     -H 'content-type: application/json' -d '{"wallet":"mockwallet_alice"}' | jq -r .token)

# 4. create an API key (shown once; optional name + spend limit)
KEY=$(curl -s -X POST localhost:8787/keys -H "authorization: Bearer $JWT" | jq -r .key)

# 5. spend credits through the OpenAI-compatible endpoint
curl -N localhost:8787/v1/chat/completions -H "authorization: Bearer $KEY" \
     -H 'content-type: application/json' \
     -d '{"model":"mesh/mock","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# 6. watch the balance move
curl -s localhost:8787/me -H "authorization: Bearer $JWT" | jq '.balance, .ledger[0]'
curl -s localhost:8787/stats
```

Or run the whole thing in one go: `bash scripts/demo.sh`.

Using the OpenAI SDK: set `baseURL` to `http://localhost:8787/v1` and `apiKey` to your `mesh_sk_…` key.
Mock holders: `mockwallet_alice` (60k), `mockwallet_bob` (30k), `mockwallet_carol` (10k), `mockwallet_dust` (500, ineligible).

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | liveness: `db`, `lastEpoch` (start/status/age), `upstreamMode`, geo-block state; 503 if SQLite is unhealthy |
| GET | `/stats` | none | public totals + `series24h` (per-hour fees / credits / requests / spend), `lastEpoch`, `feesThisEpochUsd` (pending fees since the last epoch; `null` when the adapter cannot report it cheaply), eligible holders, `nodesOnline`, `servedByNetworkPercent` (real, 24h), `servedByNetwork24h`, `jobs24h`, `networkTokens24h`, token meta from config. Cached `STATS_CACHE_MS` (10s) |
| GET | `/epochs?limit=48` | none | epoch history newest first: `epochStart/End`, `feesUsd`, `holderPoolUsd`, `treasuryUsd`, `eligibleHolders`, `status`; plus `total`. No fee tx ids |
| GET | `/report` | none | public treasury report: `totals` (all time, incl. `treasury{feeShareUsd, nodeRewardAccrualUsd, buybackUsd, opsUsd, balanceUsd}`), `last7d`, `last30d`, `byWeek[]` (12 ISO weeks, oldest first), top-level `feesIn`, `creditsOut`, `nodeRewards`, `treasuryBalanceUsd`, `servedByNetworkPercent`, `epochsRun`, `method` notes, `lastUpdated`. Cached `STATS_CACHE_MS` |
| GET | `/report/weekly/:isoWeek` | none | one ISO week (`2026-W40`, UTC): the week's totals, `days[]`, `epochDetails[]` (public epoch views), `previous`/`next` |
| POST | `/auth/nonce` | none | `{wallet}` → SIWE/SIWS-style message (domain, URI, nonce, issued-at, expiry). Nonce lives in SQLite, 5 min, single use |
| POST | `/auth/verify` | none | `{wallet, signature, chain?, nonce?, message?}` → session JWT (7d). Checks domain, nonce, issued-at against the issued row |
| POST | `/auth/refresh` | JWT | fresh 7-day session token for the current one |
| POST | `/keys` | JWT | `{name?, spendLimitUsd?}` create (key returned once) |
| GET | `/keys` | JWT | list (masked) with `name`, `spendLimitUsd`, `spentUsd` |
| PATCH | `/keys/:id` | JWT | `{name?, spendLimitUsd?: number\|null}` rename / set / clear the per-key spend limit |
| GET | `/keys/:id/usage` | JWT | `last24h`, `last7d`, `allTime` (requests, spend, tokens), `requestCount`, `topModels` |
| DELETE | `/keys/:id` | JWT | revoke |
| GET | `/me` | JWT | wallet, balance, last 20 ledger rows, keys |
| POST | `/v1/chat/completions` | API key | OpenAI-compatible, streaming; served by a Mesh node when one is idle for the model (final chunk carries `mesh: {route, nodeId, chip}`), else OpenRouter passthrough; debits credits; enforces model policy and key spend limit; `x-mesh-route: node:<id> \| openrouter`, `x-mesh-fallback` after a node failure |
| GET | `/v1/models` | API key | upstream models filtered by `config/model-policy.json` plus the network model names, each with `mesh_network: bool` |
| POST | `/admin/run-epoch` | ADMIN_TOKEN | `{epochStart?}` run/replay an epoch (idempotent); response lists each holder's `multiplier` and `holdingAgeApplied` |
| POST | `/admin/fake-fees` | ADMIN_TOKEN | `{amountUsd}` dev harness, mock adapter only |
| POST | `/admin/starter-credit` | ADMIN_TOKEN | `{wallet, amountUsd}` |
| POST | `/admin/starter-credits` | ADMIN_TOKEN | `{items:[{wallet, amountUsd}], note?}` atomic batch, one audit row |
| GET | `/admin/overview` | ADMIN_TOKEN | last 48 epochs, totals (incl. `nodeRewardsUsd`, `treasuryBalanceUsd`), `holdingAge` config, top 20 holders, nodes (with URLs), recent errors, recent admin actions |
| DELETE | `/admin/keys/:id` | ADMIN_TOKEN | revoke any wallet's API key by id (audited; 404 unknown) |
| POST | `/admin/dev-login` | ADMIN_TOKEN | **dev only**: JWT for a wallet without a signature |
| GET | `/me/nodes` | JWT | the wallet's nodes with per-node stats (same view as `GET /nodes/:id`) + `earnedUsdTotal` |
| POST | `/nodes/register` | none | `{wallet, chip?, ramGb?, models[], agentVersion?, nodeId?}` → `{nodeId, nodeToken}` (token shown once, sha256 stored); re-registering an id needs its token |
| POST | `/nodes/:id/heartbeat` | node token | `{models?, busy?, loadAvg?, ramGb?, chip?}` every 20s; offline after 90s; rows kept 48h in `heartbeats` |
| GET | `/nodes/:id/jobs/next?wait=25000` | node token | long-poll ≤25s; `204` or one job `{jobId, model (Ollama tag), requestedModel, messages, params, maxTokens, deadlineMs, attempt}`; claim is atomic |
| POST | `/nodes/:id/jobs/:jobId/chunk` | node token | `{seq, delta}` relayed to the client as OpenAI SSE; `409 job_not_running` means stop |
| POST | `/nodes/:id/jobs/:jobId/done` | node token | `{promptTokens, completionTokens, finishReason}` → bills user, credits node reward |
| POST | `/nodes/:id/jobs/:jobId/fail` | node token | `{error}` → re-queue once / fallback (before output) or error surfaced (after partial output) |
| GET | `/nodes/:id` | node token or owner JWT | `{status, uptimePct24h, jobs24h, tokens24h, earnedUsd24h, earnedUsdTotal, reputation{successRate, avgFirstTokenMs, eligible}, lastSeen, …}` |
| GET | `/nodes` | none | public summary: online/total/busy/idle, chips, models, `jobs24h`, `servedByNetwork24h`, `tokens24h`, `servedByNetworkPercent`; no wallets or tokens |

Every `/admin/*` call is written to the `admin_actions` audit table. Errors are one JSON shape
everywhere (`{error, message, statusCode, requestId}`; OpenAI's `{error:{message,type,code}}` under
`/v1`); 5xx and upstream failures are also kept in `errors_log` for `/admin/overview`.

**Upstream failures never charge.** Network errors and timeouts (`UPSTREAM_TIMEOUT_MS`) → `502
upstream_timeout` / `upstream_network`; upstream 5xx → `502 upstream_error`; upstream 429/4xx keep
their status with a normalised body; an error object inside a 200 SSE stream is relayed and not
charged. Streaming scans OpenRouter's final `usage` chunk (comments like `: OPENROUTER PROCESSING`
are ignored) and charges `usage.cost`.

**Model policy** (`config/model-policy.json`): `allow` (empty = all), `deny` (wins), patterns may end
in `*`; `networkModels` maps client-facing names to the Ollama tags nodes advertise
(`{"llama-3.1-8b": "llama3.1:8b"}`; the tag itself is accepted as a model name too).

**Node network** (`docs/NODE_PROTOCOL.md`): with `routing.preferNetwork`, a request for a network model
becomes a job when at least one online, idle, reputable node advertises its tag. The node long-polls
`GET /nodes/:id/jobs/next`, claims the job atomically, POSTs `{seq, delta}` chunks that the gateway
relays as OpenAI SSE, and finishes with `done {promptTokens, completionTokens, finishReason}`. No first
chunk within `routing.firstTokenTimeoutMs` (8s) or a gap over `stallTimeoutMs` (6s) fails the job: it is
re-queued once to another node, else the same client request falls back to OpenRouter transparently
(`x-mesh-fallback: <reason>`). Once partial output has reached the client there is no fallback; the
error is surfaced in-stream (`node_stream_failed`) and nothing is charged. Network-served requests cost
the user `requestPricing.networkPricePerMTokens` ($0.02/M total tokens); the node's wallet accrues
`nodeRewards.usdPerMTokens` ($0.06/M) in the `node_rewards` ledger (the reward deliberately exceeds the
price; the gap is funded by the treasury share of trade fees, see `docs/STATUS.md` → Pricing economics). Nodes with < 80% success over
their last 100 jobs (min 5) are excluded from routing. Jobs persist in the `jobs` table
(`queued|running|done|failed|fallback`); unfinished jobs are failed on boot.

**Rate limits**: `V1_RATE_LIMIT`/min per API key on `/v1/*`; `AUTH_RATE_LIMIT`/min per IP shared
across `/auth/*`. **Geo-block**: when `NODE_ENV=production` (or `GEO_BLOCK_ENFORCE=true`),
requests to `/v1` and `/auth` whose `CF-IPCountry` / `X-Country` header is in `config.geoBlock`
get `451 region_blocked`. Off in dev. CORS is open. Logs are pino JSON.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | listen address |
| `MESH_DB_PATH` | `./data/mesh.db` | SQLite file (migrations run on boot) |
| `MESH_ADAPTER` | `mock` | `mock` = in-memory MockAdapter; `chain` = adapter for `config.chain` |
| `JWT_SECRET` | insecure dev default | HS256 secret for session JWTs |
| `ADMIN_TOKEN` | `dev-admin-token` | guards `/admin/*` |
| `OPENROUTER_API_KEY` | unset | unset → offline mock upstream ($0.001/request) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `UPSTREAM_TIMEOUT_MS` | `60000` | abort upstream calls (connect+headers for streams, full body otherwise) |
| `EPOCH_CRON` | `0 * * * *` | distribution schedule; `off` disables |
| `V1_RATE_LIMIT` | `120` | requests/minute per API key on `/v1` |
| `AUTH_RATE_LIMIT` | `20` | requests/minute per IP across `/auth/*` |
| `AUTH_DOMAIN` / `AUTH_URI` | `localhost:8787` / `https://$AUTH_DOMAIN` | domain + URI in the sign-in message; verify checks them |
| `STATS_CACHE_MS` | `10000` | `/stats` cache; `0` disables |
| `NODE_ENV` / `GEO_BLOCK_ENFORCE` | `development` / auto | geo-block enforced when production unless overridden |
| `LOG_LEVEL` | `info` | pino level |

## Deploy

`apps/gateway/Dockerfile` (node:20-alpine, multi-stage, runs as `node`, healthcheck) and
`docker-compose.yml` (gateway bound to `127.0.0.1:8787` + `mesh-data` volume for SQLite).
`scripts/deploy-vps.md` has the exact commands for a fresh Ubuntu 24.04 box: Docker, clone, `.env`,
`docker compose up`, Caddy for HTTPS, and the launch-day admin calls.

## Tokenomics config

`config/tokenomics.json` holds every economic parameter and is validated by a zod schema
(`packages/config`) on load; a bad value fails boot with a precise error.

- `tradeFeeBps` 150 — 1.5% fee on trades (enforced on-chain, informational here)
- `holderShareBps` / `treasuryShareBps` 5000/5000 — must sum to 10000
- `minHoldTokens` 1000 — time-weighted balance needed to be eligible
- `epochSeconds` 3600 — distribution cadence
- `creditUsdPerFeeUsd` 1.0 — how many credit-USD each fee-USD mints
- `requestPricing` — `passthrough` + `markupBps` applied to upstream cost; `networkPricePerMTokens` (0.02) flat USD per 1M total tokens when a Mesh node serves
- `nodeRewards.usdPerMTokens` 0.06 — accrued to the node wallet per 1M total tokens of completed jobs (above the user price by design; treasury share covers the gap)
- `stakeTiers` — defined and typed; multipliers are **not applied yet** (see below)
- `distribution.holdingAge` — `{enabled: false, maxDays: 30, minMultiplier: 1.0, maxMultiplier: 2.0}`. When enabled, a holder's pro-rata weight is `timeWeightedBalance × m(age)`, `m` rising linearly from `minMultiplier` (age 0) to `maxMultiplier` (age ≥ `maxDays`). Age comes from the adapter's optional `holdSinceTs` (MockAdapter simulates it; a transfer out resets it) or, when the adapter cannot report it, from the gateway's `holder_age` cache (first epoch seen ≥ `minHoldTokens`; a lower balance than last epoch resets it, dropping below the threshold forgets it). Eligibility is still on the raw balance. Disabled = identical to plain pro-rata
- `geoBlock` — ISO country codes refused on `/v1` and `/auth` in production (451)
- `routing` — `preferNetwork` (route to nodes), `firstTokenTimeoutMs` 8000, `stallTimeoutMs` 6000, `jobTimeoutMs` 120000, `defaultMaxTokens` 1024, `minSuccessRate` 0.8, `reputationMinJobs` 5
- `meta` — `website`, `description`, `contractAddress`, `totalSupply` surfaced on `/stats`

Costs: OpenRouter is called with `usage: {include: true}` and the reported `usage.cost` is
charged. If a response lacks it, `config/model-prices.json` (USD per 1M tokens) is used.

### Switching chain

Set `"chain": "evm"` (or `"solana"`) in `config/tokenomics.json` and `MESH_ADAPTER=chain`.
`createAdapter(config)` returns `SolanaAdapter` or `EvmAdapter`. With `MESH_ADAPTER=mock` the
MockAdapter is used regardless of chain (it still reports `chain` from config). Wallet login
verifies signatures for the requested `chain` even when it differs from the active adapter.

## Layout

```
config/            tokenomics.json, model-prices.json, model-policy.json
packages/config    zod schema + loaders
packages/chain-adapter  ChainAdapter interface, Mock/Solana/EVM, createAdapter
packages/design-tokens  tokens.css
apps/gateway       Fastify API, SQLite, distribution job, tests
apps/node-agent    Ollama node agent: register, heartbeat, pull jobs, stream chunks (docs/NODE_PROTOCOL.md)
apps/web           Vite + React app: landing, dashboard, keys, chat, network stats, docs
scripts/demo.sh    offline end-to-end demo (fees → epoch → key with spend limit → chat → fake node serves a job → stats)
scripts/deploy-vps.md  production runbook (Docker + Caddy on Ubuntu 24.04)
```

## Treasury report

Every epoch writes a `treasury_ledger` row (`kind='fee_share'`, the treasury half of the fees) and every
completed node job writes a negative `node_reward_accrual` row, so `treasuryBalanceUsd` = fee share in −
node rewards − buybacks − ops (the last two are kinds reserved for operator bookkeeping). `GET /report`
rolls the ledgers up all-time / 7d / 30d / per ISO week (UTC); `GET /report/weekly/:isoWeek` drills into
one week. The web app renders it at `/report` (public, in the nav as **Report**) with the statement
"$X in fees became $Y of AI credits", a weekly table, two small charts (fees in vs credits out; Mesh nodes
vs OpenRouter share) and a method footnote: credits are a share of fees already collected, not a promise.

## Operator page

`/admin` in the web app asks for `ADMIN_TOKEN` (kept in React state only; a reload forgets it) and shows
`/admin/overview`, a **Run epoch** button, **fake fees** (only when the gateway reports a mock adapter),
a starter-credits batch textarea (`wallet,amount` per line → `POST /admin/starter-credits`), key
revocation by id (`DELETE /admin/keys/:id`), recent errors and the admin-actions audit. Hide `/admin/*`
at the proxy in production, as before; the page is only as protected as the token.

## What is stubbed

- `SolanaAdapter` / `EvmAdapter`: `getHolderBalances`, `collectFees`, `transferTokens` throw
  `NotWiredError`. Signature verification is real (ed25519/bs58; EIP-191 recovery).
- Node network: the gateway side (jobs, relay, rewards, reputation) is complete and tested with a fake
  node; live relays are in-process (one gateway instance). Node wallets are self-declared at
  registration (no signature yet). Rewards accrue in USD in `node_rewards`; on-chain payout is not wired.
- `apps/web`: fully wired to the gateway (stats, epochs, nodes, keys, usage, chat); `VITE_MOCK=1` swaps in fake data for screenshots. Staking UI is a placeholder.
- `stakeTiers` multipliers are validated config but not applied. Holding-age weighting is implemented and tested but `enabled: false` by default.
- `treasury_ledger` kinds `buyback` / `ops` / `other` have no endpoint yet (insert via `addTreasuryEntry` or SQL).
- Rate limiting and the `/stats` cache are in-process (one gateway instance).
- `/admin/dev-login` exists for local development only; hide `/admin/*` at the proxy in production.

## What is next

1. Wire `SolanaAdapter` (Helius/RPC holder snapshots, fee vault sweep, SPL transfer) and `EvmAdapter` (viem clients, Transfer-log balance history).
2. Apply stake-tier multipliers in the distribution job (holding-age weighting is in; flip `distribution.holdingAge.enabled`).
3. Node network: signed node registration, reward payouts from the treasury share (`node_rewards.kind='payout'`), per-node concurrency slots, shared job store for multi-instance.
4. Session-cookie auth for the web app; shared rate-limit/cache store for multi-instance.
