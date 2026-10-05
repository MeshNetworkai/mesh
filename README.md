# Mesh ($MESH)

Mesh is a token whose trading fees buy AI inference for the people who hold it, spent through an
OpenAI-compatible gateway, served by Macs and by frontier providers, and sold on a marketplace when
unused. Open beta at https://mesh-network.ai; the token launches on launch day on Robinhood Chain via
Pons (docs/CHAIN_DECISION.md); fees reach the gateway through our PonsFeeVault (docs/DEV_HANDOFF.md).

**Two engines, one hourly pool.** Every hour the gateway builds one credit pool and splits it pro rata
across wallets holding at least 1,000 $MESH, time-weighted over the hour (`config/tokenomics.json`).

1. **Trading fees** (always on): a 1.5 % fee on every trade is swept each hour; 50 % becomes US-dollar
   inference credits, 50 % goes to the treasury, which pays the Macs.
2. **Usage share** (built, off): a share of the margin on paid requests and marketplace fees goes into
   the same pool, so holders earn from usage as well as from trading. It switches on with the pricing
   decision (`usageShare.enabled`); public copy says "built, switches on with the pricing decision",
   never "live". `docs/PRICING.md` §3.

**What credits buy.** One OpenAI-compatible key (`/v1/chat/completions`, `/v1/models`). Open models the
network runs (Llama, Qwen) go to an idle, reputable Mac first at a flat $0.02 per million tokens, with
upstream fallback; the Mac is paid $0.06 per million from the treasury. Frontier and fast models
(Claude, GPT, Gemini, Grok, DeepSeek, Kimi, Mistral and more) go to OpenRouter restricted to
zero-data-retention providers at list minus the configured discount (0 as shipped). `GET /v1/models`
carries both prices per model. Three privacy tiers per request or per key (`docs/PRIVACY.md`); a sample
of node answers is re-run and compared (`docs/NODE_PROTOCOL.md` §10). The first wallet sign-in gets
starter credits (`docs/SWITCHING.md`); the homepage chat answers a few messages a day with no wallet.

**Credit marketplace** (`docs/MARKETPLACE.md`): holders list unused credit at 0–70 % off, buyers pay
from a prepaid USD balance and receive the credits at face value, 2.5 % fee split half to the next
hour's holder pool and half to the treasury. During the beta the team tops up prepaid balances and pays
withdrawals by hand; USDC checkout follows the token launch.

## Pages

| Route | What it is | File |
| --- | --- | --- |
| `/` | Hero with the free guest chat, key figures, "How the money moves" (two-engine diagram), four ways in, why it's different, switch strip, privacy tiers, live numbers | `apps/web/src/pages/Landing.tsx`, `components/Engines.tsx` |
| `/docs` | Credits (two engines, time-weighting, starter credits), using credits, the live model catalogue, marketplace, running a Mac, privacy tiers, verification, staking, numbers, FAQ, risk, roadmap | `apps/web/src/pages/Docs.tsx`, roadmap data in `src/content/roadmap.ts` |
| `/api` | "Switch in a minute" plus the OpenAPI reference rendered from `apps/gateway/openapi.yaml` | `apps/web/src/pages/ApiDocs.tsx` |
| `/stats` | Live network, every epoch, weekly report, treasury, marketplace and usage share, public | `apps/web/src/pages/StatsPage.tsx` |
| `/download` | Terminal, Homebrew and unsigned menu-bar DMG, with checksums and the "Open Anyway" steps | `apps/web/src/pages/Download.tsx` |
| `/app`, `/app/keys`, `/app/chat`, `/app/market`, `/app/node`, `/app/stake` | Signed-in: balance and ledger, keys, chat with model picker and privacy tier, credit market, run a node, staking (live once the contract is deployed) | `apps/web/src/pages/*.tsx` |
| `/terms`, `/privacy`, `/risk` | Plain-English drafts incl. marketplace clauses; lawyer review before the token trades | `apps/web/src/pages/Legal.tsx` |
| `/admin` | Operator console: epochs, starter credits, prepaid top-ups, withdrawals, quarantine, audit | `apps/web/src/pages/Admin.tsx` |

Design rules (`docs/BRAND.md`): Onest and Inter only, sentence-case labels, no monospace labels, every
number read from `config/tokenomics.json`. Roadmap: `docs/ROADMAP.md`. Status: `docs/STATUS.md`.

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
| GET | `/v1/models` | optional API key | the catalogue: network models (`served: network\|both`, short aliases) plus the curated frontier/fast/open upstream list, each with `displayName`, `vendor`, `tier`, `served`, `listPrice`, `meshPrice`, `privacy`, `online`, `guestAllowed`; top-level `pricing` knobs; `?guest=1` narrows to the guest set (`docs/PRICING.md`) |
| GET/POST | `/v1/guest/quota`, `/v1/guest/chat` | none | free homepage chat: `guest.messagesPerDay` per IP, network + `guest.allowedTiers` models, paid by the treasury |
| GET | `/market/config`, `/market/book`, `/market/listings`, `/market/stats`, `/market/quote` | none | credit marketplace, public side: fee, depth by discount tier, open listings (no seller), totals, quotes |
| POST/DELETE | `/market/listings`, `/market/listings/:id`, `/market/fills`; GET `/me/market`; POST `/me/market/withdraw` | JWT | list credit at a discount (escrowed), cancel, fill from the prepaid balance, your listings/fills/prepaid ledger, request a withdrawal (`docs/MARKETPLACE.md`) |
| POST | `/admin/prepaid`, `/admin/market/withdrawals/:id/paid`; GET `/admin/market` | ADMIN_TOKEN | beta settlement: top up a prepaid balance after an off-chain payment (idempotent on `ref`), mark a withdrawal paid |
| GET/POST | `/admin/starter`, `/admin/starter/toggle` | ADMIN_TOKEN | starter-credit programme status and runtime pause |
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
| GET | `/install/latest.json` | none | current `mesh-node` release `{version, bundleUrl, bundleSha256, tarballUrl, dmgUrl, …}`; proxied from `UPDATE_LATEST_URL` (60 s cache) or the file written by `POST /admin/release`. Read by `mesh-node update` and the menu-bar app |
| GET | `/install/mesh-node.js` | none | the agent bundle (`NODE_BUNDLE_PATH`, dev default `apps/node-agent/dist/mesh-node.js`); 302 to the release `bundleUrl` when absent. What `install-node.sh` downloads |
| POST | `/admin/release` | ADMIN_TOKEN | publish/correct the release document by hand (audited; 409 while `UPDATE_LATEST_URL` is set); `GET /admin/release` shows what is served |

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
| `UPDATE_LATEST_URL` / `UPDATE_LATEST_PATH` / `NODE_BUNDLE_PATH` | unset / `data/latest.json` / `apps/node-agent/dist/mesh-node.js` | node distribution: where `/install/latest.json` and `/install/mesh-node.js` come from (`docs/DISTRIBUTION.md`) |

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
- `requestPricing` — `networkPricePerMTokens` (0.02) flat USD per 1M total tokens when a Mesh node serves; `upstreamDiscountBps` / `upstreamMarkupBps` (exactly one may be non-zero, both 0 as shipped) applied to OpenRouter list for upstream-served requests; `showSavings` (`docs/PRICING.md`)
- `nodeRewards.usdPerMTokens` 0.06 — accrued to the node wallet per 1M total tokens of completed jobs (above the user price by design; treasury share covers the gap)
- `usageShare` — engine 2: `enabled` (false as shipped), `holderBps` 3000 / `treasuryBps` 7000 of the margin on paid requests, `sources` {network, upstream, marketplaceFee}
- `marketplace` — `enabled`, `feeBps` 250, `feeToHoldersBps` 5000, `minListingUsd` 1, `maxDiscountBps` 7000, `listingTtlHours` 168 (`docs/MARKETPLACE.md`)
- `starterCredits` — `enabled`, `amountUsd` 2, `maxWallets` 500, `requireMinHold` (`docs/SWITCHING.md`)
- `privacy` — `default` tier, `fallback`, `trustedWallets`, `trustedMinStakeTier` gold, `tiers` (`docs/PRIVACY.md`)
- `verification` — `enabled`, `sampleRate` 0.05, `minJobsBeforeTrust` 20, `mismatchPenalty`, `quarantineAfterMismatches` 2
- `guest` — free homepage chat: `enabled`, `messagesPerDay` 5, `maxTokens`, `allowedTiers`
- `beta` — `enabled`, `label`, `inviteRequired` (false: open beta), `batchSize`
- `points` — built, `enabled: false` (`docs/POINTS.md`)
- `stakeTiers` — multipliers apply to node rewards and routing priority; gold + the operator pledge makes a node trusted
- `distribution.holdingAge` — `{enabled: false, maxDays: 30, minMultiplier: 1.0, maxMultiplier: 2.0}`. When enabled, a holder's pro-rata weight is `timeWeightedBalance × m(age)`, `m` rising linearly from `minMultiplier` (age 0) to `maxMultiplier` (age ≥ `maxDays`). Age comes from the adapter's optional `holdSinceTs` (MockAdapter simulates it; a transfer out resets it) or, when the adapter cannot report it, from the gateway's `holder_age` cache (first epoch seen ≥ `minHoldTokens`; a lower balance than last epoch resets it, dropping below the threshold forgets it). Eligibility is still on the raw balance. Disabled = identical to plain pro-rata
- `geoBlock` — ISO country codes refused on `/v1` and `/auth` in production (451); empty as shipped (no geo-block), and the web hides the clause when empty
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
apps/node-agent    Ollama node agent: register, heartbeat, pull jobs, stream chunks, self-update (docs/NODE_PROTOCOL.md)
apps/menubar       SwiftUI menu-bar app (status, pause, link, check for updates); unsigned DMG via make dmg (docs/MENUBAR.md)
homebrew-tap/      Homebrew formula (mirrored to MeshNetworkai/homebrew-tap by the release workflow)
scripts/release/   make-tarball.sh (bundle + wrapper -> tar.gz + sha256), update-formula.sh
scripts/install-node.sh  Terminal one-liner installer served by the web app at /install-node.sh
.github/workflows/release.yml  tag v* -> bundle, tarball, DMG, GitHub Release + latest.json (docs/DISTRIBUTION.md)
apps/web           Vite + React app: landing, dashboard, keys, chat, network stats, docs
scripts/demo.sh    offline end-to-end demo (fees → epoch → key with spend limit → chat → fake node serves a job → stats)
scripts/deploy-vps.md  production runbook (Docker + Caddy on Ubuntu 24.04)
```

## Running a node on a Mac

Three channels, no Apple developer account needed (`docs/DISTRIBUTION.md`, web page `/download`):
the Terminal one-liner (`install-node.sh`), Homebrew (`brew install meshnetworkai/tap/mesh-node`), or
the unsigned menu-bar app DMG (opened through System Settings → Privacy & Security → Open Anyway).
All install the same `mesh-node`; `mesh-node update` pulls the next release with a verified SHA-256.

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

## What is live, switched off, or waiting for the token

`docs/STATUS.md` is the detailed version. In one screen:

- **Live in the beta:** gateway, keys, chat, hourly epochs (mock fee feed until the token exists), Mac
  node network with link codes, Homebrew tap, unsigned menu-bar DMG, privacy tiers, spot-check
  verification, credit marketplace with prepaid balances, frontier catalogue via ZDR upstream, starter
  credits, guest chat, public `/stats`, admin console.
- **Built, switched off by config:** usage share (`usageShare.enabled`), holding-age weighting
  (`distribution.holdingAge.enabled`), points / leaderboard / referrals (`points.enabled`), invite
  gating (`beta.inviteRequired`), upstream discount or markup (`requestPricing`).
- **Waiting for the token launch:** chain decision and `config/deploy.<network>.json` (the team deploys;
  `docs/DEV_HANDOFF.md`), live chain adapters, staking contract address, on-chain node payouts, USDC
  checkout for the marketplace, buyback floor. Roadmap: `docs/ROADMAP.md`.
- **Single instance:** rate limits, relays, stats cache and alert state are per process (`docs/ARCHITECTURE.md` §8–9).
