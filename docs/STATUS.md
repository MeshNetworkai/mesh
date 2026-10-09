# Mesh — status (2026-10-08, open beta)

One page: what is live right now, what is in the repo, how it is tested, what is switched off, and what only Oliver can do. Detail lives in the linked docs; this page is the index. The roadmap is `docs/ROADMAP.md`.

## What is live now

Deployed at https://mesh-network.ai (web) and https://api.mesh-network.ai (gateway), auto-deployed from `main`. Open beta: `beta.inviteRequired: false`, anyone can connect a wallet. The token is **not** launched yet; the team launches it on launch day on Robinhood Chain via Pons (the internal docs repo, the internal docs repo) — the Pons fee path (`PonsFeeVault`, `PonsEvmAdapter`, Admin → Token panel) is built and tested — so until then fees come from the mock adapter's test feed and the credits it mints are beta credits: no stablecoin reserve stands behind them yet (`GET /report → totals.reserve.source` is `mock`).

| Live | Where | Notes |
| --- | --- | --- |
| Hourly epochs, pro-rata, time-weighted, 1,000 MESH minimum | gateway `jobs/distribute.ts`, `/stats` | engine 1; mock fee feed until the token exists |
| OpenAI-compatible gateway: keys, chat, streaming, spend limits, per-key privacy tier | `/app/keys`, `/app/chat`, `/api` | `usage.cost` is the amount charged (upstream replies are repriced under a markup or discount, with the list figure in `mesh.listCostUsd`), `x-mesh-*` headers, failed requests never charged |
| Frontier catalogue via ZDR upstream at list + 6 % (`requestPricing.upstreamMarkupBps: 600`) | `GET /v1/models`, model picker | Claude, GPT, Gemini, Grok, DeepSeek, Kimi, Llama, Qwen, Mistral; prices refreshed by script. OpenRouter charges Mesh 5.5 % on top of list (`upstreamFeeBps: 550`), so the margin is 0.5 % of list |
| Mac network at $0.08/M to the user, $0.06/M to the node, never more than 90 % of the price ($0.072/M) with a stake multiplier | `/app/node`, `/download` | link codes, Terminal / Homebrew / unsigned DMG, `mesh-node update`, `maxParallel`, queueing for busy nodes; Oliver's M3 Max served end to end on 3 Oct |
| Usage share (engine 2): 30 % of the margin on paid requests joins the next hourly pool | `usage-share.ts`, `/report → totals.usageShare` | on as shipped (`usageShare.enabled: true`); $0.006 per million network tokens to holders from an unstaked node, $0.0024 at the reward ceiling, $1.50 per $1,000 of frontier list usage (`docs/PRICING.md` §3) |
| Privacy tiers (trusted / network / upstream_zdr) and the operator pledge | every `/v1` request | `docs/PRIVACY.md` |
| Spot-check verification, 5 % of network jobs, quarantine after 2 mismatches | `verification.ts`, admin clear | `docs/NODE_PROTOCOL.md` §10 |
| Credit marketplace: 0–70 % off, 2.5 % fee half to holders, escrow, partial fills, public book | `/app/market`, `/market/*` | prepaid balances topped up and withdrawals paid by the team during the beta (`POST /admin/prepaid`); unused starter credit cannot be listed (`402 non_transferable`) |
| Credit expiry: every credit lapses 90 days after it landed, oldest spent first | `expiry.ts`, `jobs/housekeeping.ts`, `GET /me → expiry` | swept after every epoch and lazily on chat, `/me`, `/me/market` and listing; `/report → totals.creditExpiry` (`docs/PRICING.md` §6) |
| Direct credit sales: $1 of prepaid balance buys $1 of credit, $1 to $10,000 per purchase | `direct-sales.ts`, `GET /credits/config`, `POST /me/credits/buy` | the prepaid balance is topped up by the team during the beta; self-serve stablecoin deposits open once `marketplace.deposits.receiver` is set; `/report → totals.directSales` (`docs/PRICING.md` §7) |
| Credit reserve report: pool-wallet stablecoin against credits owed, read every epoch | `reserve-report.ts`, `/report → totals.reserve`, `/stats → reserve`, alert `reserve_short` | built and running; `source: mock` and nothing held until the token is live (`docs/PRICING.md` §5) |
| Starter credits: $2, holders of 1,000 MESH only, first 500 wallets, 3 per IP per day, spendable but not sellable | `starter.ts`, admin toggle | `docs/SWITCHING.md`. On the mock adapter no real wallet holds, so the sign-in grant reaches nobody until the token is live; the team can still grant by hand (`POST /admin/starter-credits`) |
| Free homepage chat: 5 messages a day per visitor, network + fast models, treasury-paid | `/`, `POST /v1/guest/chat` | cost on `/report` |
| Public stats: live network, every epoch, weekly report, treasury, marketplace, usage share | `/stats` (merges the old `/numbers` and `/report` pages) | raw: `GET /stats`, `/epochs`, `/report`, `/market/stats` |
| Homepage v2: two-engine diagram, four ways in, switch strip | `/` | `components/Engines.tsx` draws engine 2 dashed only while `usageShareEnabled` is false; it is true as shipped |
| Docs with roadmap; legal drafts with marketplace clauses | `/docs`, `/terms`, `/privacy`, `/risk` | `src/content/roadmap.ts` ↔ `docs/ROADMAP.md` |
| Release pipeline: GitHub org MeshNetworkai, v0.1.0 tagged, CI + release build green, homebrew-tap published | `.github/workflows` | menu-bar DMG unsigned (Open Anyway) |

**Built and switched off** (one config flag each): holding-age weighting, points / leaderboard / referrals, invite gating, an upstream discount (`requestPricing.upstreamDiscountBps`; it replaces the markup and is a treasury-funded loss on top of the 5.5 % upstream fee).

**Waiting for the token**: chain decision and deployment by the team, first live sweep (`sweepMode` ships as `swap`, so the stablecoin, the swap route on the vault and the Chainlink feed must be set first: `docs/RUNBOOK.md` §6), the reserve actually holding stablecoin, staking contract address (`/app/stake` shows the empty state until then), USDG checkout for the marketplace (self-serve deposits need the USDG token address and a receiver in `marketplace.deposits`), buyback floor + NAV chart. Node payouts wait for nothing: they are credits, off chain.

**Open before public launch** (the internal docs repo → Production readiness): web app bug hunt, Cloudflare in front, status page + node explorer, Telegram alert bot token, backup restore drill, legal review, Oliver's Mac linked to the live gateway, DMG opened once on a Mac, onboarding pack, starter-credit plan.

## What is in the repo, by session (history)

| Session | What landed | Where to read |
| --- | --- | --- |
| 1 — Gateway core | Fastify + SQLite gateway: fees → hourly epoch → pro-rata credits (`MockAdapter`), SIWE/SIWS wallet sign-in + JWT, API keys with spend limits, OpenAI-compatible `/v1/chat/completions` + `/v1/models` (streaming, never charged on failure), `/stats`, `/epochs`, `/health`, admin console with audit trail, treasury ledger + `/report`. | `README.md`, `docs/ARCHITECTURE.md` |
| 2 — Web app | `apps/web` (Vite + React): landing, docs, `/api` reference rendered from `apps/gateway/openapi.yaml`, signed-in Overview / Keys / Chat / Network / Node / Stake, public `/report`, operator `/admin`, legal drafts (`/terms`, `/privacy`, `/risk`), 404. Phantom, Solflare, MetaMask, Rabby. Design system in `docs/design-system.html`, tokens in `packages/design-tokens`. `VITE_MOCK=1` for fake data. | `docs/BRAND.md`, the internal docs repo |
| 3 — Node network | Gateway ⇄ Mac protocol: register, heartbeat, long-poll jobs, chunk/done/fail relay, timeouts + one re-queue + transparent fallback to OpenRouter, reputation, `$0.08/M` user price vs `$0.06/M` node reward; `apps/node-agent` (`mesh-node`, one-file bundle, Ollama, launchd service, `scripts/install-node.sh`); `apps/menubar` SwiftUI app (not yet compiled, needs a Mac); relay load test. | `docs/NODE_PROTOCOL.md`, `apps/node-agent/README.md`, `docs/MENUBAR.md`, `docs/LOADTEST.md` |
| 4 — Token layer | `packages/chain-adapter`: `SolanaAdapter` (Token-2022 transfer fee, Helius) and `EvmAdapter` (viem, `Transfer`-log balances, `FeeVault.sweep`, Uniswap swap) behind one `ChainAdapter`; `contracts/evm` (MeshToken, FeeVault, MeshStaking; 34 Foundry tests); `programs/mesh-staking` (Anchor); deploy scripts in `scripts/chain`; `config/deploy.<network>.json` loader; holding-age weighting (off); stake tiers applied to node rewards and routing. | the internal docs repo, `docs/STAKING.md`, `packages/chain-adapter/README.md` |
| 5 — Security review + ops | 21 findings, 20 fixed: signed node registration + link codes, production boot refuses default secrets, dev-login off in prod, CORS allowlist, rate limits, body limits, timing-safe compares, JWT rotation, helmet, log redaction, relay cleanup, failed-sweep alerts (Telegram / webhook). Launch runbook with pre-flight checks and incident playbooks. | `docs/SECURITY.md`, `docs/RUNBOOK.md`, `scripts/deploy-vps.md` |
| 6 — Cookie sessions + admin hardening | Session JWT moved to an `HttpOnly` cookie + CSRF double submit (bearer kept for API clients); admin cookie session + `ADMIN_IP_ALLOWLIST` enforced in-gateway + full admin audit; peppered API-key hashes (`KEY_PEPPER`, lazy rehash); `TRUSTED_PROXY_CIDRS` for `X-Forwarded-For` and geo headers; `x-request-id` everywhere. | `docs/SECURITY.md` §14, §17–21 and "Session 6" |
| 7 — Points switched off, privacy tiers, launch polish | Points / leaderboard / referral programme kept in code but **disabled** (below). Privacy tiers for node routing (in progress in `network.ts` / `routing.ts` / `v1.ts` / `nodes.ts`, node-agent, Chat / Keys / Node pages, `docs/PRIVACY.md`). Brand notes, OG image, favicon, manifest, robots, sitemap, meta tags verified; screenshots regenerated. | `docs/POINTS.md`, `docs/PRIVACY.md`, `docs/BRAND.md` |
| 8 — Mac distribution without an Apple account | Web `/download` (Terminal / Homebrew / unsigned menu-bar DMG with the macOS "Open Anyway" walkthrough, version + SHA-256 from `/downloads/latest.json`, "why the warning"); `homebrew-tap/Formula/mesh-node.rb` + `scripts/release/make-tarball.sh`; `mesh-node update` (sha256-verified atomic swap, service restart) + daily check in `start`; gateway `GET /install/latest.json`, `GET /install/mesh-node.js`, `POST /admin/release`; menu-bar "Check for updates"; `make dmg` → `MeshNode-<v>-arm64.dmg` + `.sha256`; `.github/workflows/release.yml` (bundle, tarball, DMG, GitHub Release, `latest.json`, formula commit/push). | `docs/DISTRIBUTION.md`, `docs/MENUBAR.md` §3 |
| 9 — Credit economics (8 Oct) | Fees settle in a stablecoin (`sweepMode: "swap"`) and the holder half is a published reserve (`reserve-report.ts`, `reserve_snapshots`, alert `reserve_short`); a stale price feed leaves fees unswept instead of minting against a guess; frontier pricing is list + 6 % over a 5.5 % upstream fee; node rewards stop at 90 % of the price; credits lapse after 90 days (`expiry.ts`); starter credits are for holders and not sellable; direct credit sales (`direct-sales.ts`, `routes/credits.ts`); hourly chores in `jobs/housekeeping.ts`; migration 19. | `docs/PRICING.md` §2–§7, `docs/RUNBOOK.md` §6 and §11g |

## Tests and gates

| Gate | Command | Count |
| --- | --- | --- |
| Gateway unit + HTTP | `pnpm test` | 39 files, **405** tests (incl. `node-payouts.test.ts`: rewards paid as credits once, after the hold, clawed back when withheld late, sellable on the marketplace; `market.test.ts`: every withdrawal request announced once, retried when the send fails, counted in the digest; `economics.test.ts`: credit expiry, non-transferable starter credit, direct sales, the reserve and `reserve_short`, a skipped sweep raising `failed_sweep`; `migration19.test.ts` and `migration20.test.ts`: the ledger rebuild and the withdrawal-announcement column on a populated database; `usage-share.test.ts`: the upstream fee and the reward ceiling; plus install, points, security, session-hardening, node protocol, savings, staking, holding-age, report, alerts, verification, market, deposits) |
| Chain adapter | `pnpm --filter @mesh/chain-adapter test` | 8 files, **77** tests offline (Solana, EVM, Pons incl. the stale-feed, reserve-read, partly-failed-sweep and unpriced-quote-token cases); 11 more are skipped unless a local anvil is available |
| Node agent | `pnpm --filter @mesh/node-agent test` | 6 files, **73** tests (incl. `update.test.ts` against a fake release server: good hash, bad hash, HTML body, same version, 5xx, daily loop, auto-install) |
| EVM contracts | `cd contracts/evm && forge test` | 34 Foundry tests (17 token, 17 staking) |
| Browser e2e (real gateway, mock adapter) | `pnpm e2e` | **31** Playwright tests, all passing (incl. the admin withdrawal queue and "Mark paid"; desktop flows incl. cookie session + admin cookie, `/download`; 390 px no-horizontal-scroll) |
| Types / build | `pnpm -r typecheck`, `pnpm --filter web build` | green for web, config, chain-adapter, node-agent; gateway typecheck and the node-protocol / savings / network tests go red only while the privacy-tier edits to `routes/v1.ts`, `network.ts`, `routing.ts` are mid-flight |
| Screenshots | `pnpm screenshots` → `docs/screens/` | 15 pages × 2 widths (landing, landing-beta, invite, app, keys, chat, node, market, stats, download, docs, admin, api, terms, 404), regenerated 8 Oct from the mock UI, which now prices upstream models as shipped (list + 6 %) instead of the old 20 % mock discount. `docs-1440.png` / `docs-390.png` are new; `report-*.png` is an older pair the script no longer writes |
| Release tooling | `sh -n scripts/release/*.sh apps/menubar/scripts/*.sh`, `ruby -c homebrew-tap/Formula/mesh-node.rb`, YAML parse of `.github/workflows/*.yml` | green; `make-tarball.sh` exercised end to end (tarball → wrapper → `install.sh` → `mesh-node --version`) |
| Load test | `pnpm loadtest` | 200 concurrent requests, 20 fake nodes: 0 failures, first token p95 686 ms on 2 vCPU |

## What is disabled or stubbed (and the switch)

| Piece | State | Switch / next step |
| --- | --- | --- |
| **Points, leaderboard, referrals** | **Built, disabled.** `config/tokenomics.json → points.enabled: false` (schema default). Gateway 404s `/points/*`, `/leaderboard/*`, `/referrals/*`, `/me/points`, `/me/referral`; no `points_ledger` rows are written; `GET /stats → pointsEnabled: false`; web hides Ranks nav, `/leaderboard` (404), Points tile, Referral card, footer link; `/leaderboard` removed from sitemap and screenshots. `POST /admin/points/adjust` still works (audited). | `enabled: true` + restart; backlog is awarded from the ledger cursors. `docs/POINTS.md` |
| Holding-age weighting | implemented, `distribution.holdingAge.enabled: false` | flip the flag |
| Credit reserve | reading and report built; the mock adapter has no pool wallet, so `totals.reserve.source` is `mock`, `heldUsd` is null and `reserve_short` is silent | goes live with the token: `creditPool`, `stable`, the vault route and `priceFeed` set (`docs/RUNBOOK.md` §6) |
| Self-serve prepaid deposits | built; `marketplace.deposits.receiver` is null and `tokens` is empty, so the team tops balances up by hand | fill `receiver` and `tokens` after the launch (`docs/MARKETPLACE.md`) |
| Live chain adapters | implemented and tested offline; `MESH_ADAPTER=mock` in dev; no `config/deploy.<network>.json` committed | needs a deployed token (below) |
| Node reward payout | **live, as AI credits, off chain**: hourly, after a 1-hour hold, into the operator's credit balance (`node-payouts.ts`, `credits_ledger` kind `node_payout`); operators cash in by selling credits on the marketplace for USDG | no on-chain payout is planned; the unused `transferTokens` path stays in the adapter. `nodeRewards.payout.enabled: false` turns rewards back into a counter |
| Menu-bar app | Swift source complete (incl. "Check for updates"), never compiled; `release.yml` job B runs `swift build`/`make dmg` on `macos-latest`, so the first tag is also the first compile | first `swift build` on a Mac or the first tag (`docs/MENUBAR.md`) |
| Mac distribution | unsigned DMG + Homebrew tap + `mesh-node update` built; `latest.json` on the web is the sample file; the tap repo `MeshNetworkai/homebrew-tap` does not exist yet; formula sha256 is a placeholder until the first release | push a `v*` tag; create the tap repo + `HOMEBREW_TAP_TOKEN`; deploy `latest.json` to `/downloads/` (`docs/DISTRIBUTION.md` §2) |
| App signing / notarisation | not configured; the Open Anyway path is documented and shown on `/download` | add the `MACOS_*` / `NOTARY_*` secrets when the developer account exists (`docs/DISTRIBUTION.md` §5) |
| Upstream inference | `MockUpstream` when `OPENROUTER_API_KEY` is unset | set the key |
| Multi-instance | rate limits, relays, stats cache, alert state are per process | one VPS is the plan; `docs/ARCHITECTURE.md` §9 |
| Node-token pepper | node tokens still plain sha256 (API keys are peppered) | same lazy-rehash pattern in `routes/nodes.ts` (Low) |
| Legal pages | plain-English drafts marked "not legal advice" | lawyer review before the token trades |
| Placeholders | `app.example.com`, `api.example.com`, `x.com/mesh_placeholder`, `t.me/mesh_placeholder` | grep `example.com` and `_placeholder` |

## What needs Oliver

1. **Pick the chain on launch day** (the internal docs repo): Solana Token-2022 or EVM (Base / Robinhood Chain). Set `config/tokenomics.json → chain`; the team deploys (the internal docs repo). Public copy does not name a chain until then.
2. **Deploy the token, fee vault and staking** with `scripts/chain/*` and commit `config/deploy.<network>.json` (addresses only, no keys). Fill `meta.contractAddress`, `meta.totalSupply`.
3. **Seed liquidity** (Raydium/Meteora or Uniswap v3) and, on EVM, `setFeeExempt(pool, true)`.
4. **Secrets and hosts** on the VPS: `JWT_SECRET`, `ADMIN_TOKEN`, `KEY_PEPPER`, `OPENROUTER_API_KEY`, RPC / Helius key, signer keypair, `AUTH_DOMAIN`, `CORS_ORIGINS`, `ADMIN_IP_ALLOWLIST`, `TRUSTED_PROXY_CIDRS`; replace the placeholder hosts and social URLs. Follow `docs/RUNBOOK.md` §0–§7 and its pre-flight checks.
5. **Decisions**: session TTL (7 d today), whether holding-age weighting is on at launch, `geoBlock` list (empty today: no geo-block; the web hides the clause when empty), and whether the points programme ever comes back (it is a one-line flag).
6. **Hardware**: a Mac with Xcode to compile the menu-bar app locally (CI does it on `macos-latest` too); a few friends' Macs for the first node batch (the internal docs repo). Notarisation only when the developer account exists.
8. **First release**: create `github.com/MeshNetworkai/homebrew-tap` (empty) and the `HOMEBREW_TAP_TOKEN` secret, push `v0.1.0`, deploy `latest.json` to the web host (`docs/DISTRIBUTION.md` §2), try the DMG on a clean Mac through Open Anyway.
7. **Legal review** of `/terms`, `/privacy`, `/risk` before the token is tradeable.
9. **Before the first live sweep**: set the stablecoin and the swap route on the vault and a Chainlink ETH/USD feed in Admin → Token. With `sweepMode: "swap"` the sweep reverts without the stablecoin or the route, and ETH fees stay unswept without a fresh price. Afterwards, keep the credit pool funded: move direct-sale proceeds from the deposit receiver into it, and take only the reported surplus out (`docs/RUNBOOK.md` §11g).

## Exact commands

```sh
pnpm install && pnpm build          # packages + gateway + web
pnpm test                           # gateway (405)
pnpm test:all                       # + chain-adapter (77, 11 skipped without anvil) + node-agent (73)
pnpm e2e                            # Playwright (31) against the real gateway
VERSION=0.2.0 sh scripts/release/make-tarball.sh   # release tarball + sha256 (CI does this on tag v*)
pnpm dev                            # gateway :8787 (mock adapter, mock upstream) + web :5173
pnpm demo                           # scripted end-to-end run incl. a curl-simulated node
pnpm dev:mock                       # web only on fake data (what docs/screens/ shows)
pnpm screenshots                    # regenerate docs/screens/*.png
pnpm loadtest                       # relay load test
```
