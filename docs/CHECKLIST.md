# Mesh Build Plan

Live checklist, exported from the shared plan. Items marked (Oliver) need Oliver; everything else is on Claude.

Every step from design system to launch, grouped by session. Tick items as they land; items marked (Oliver) are yours.

## Session 1 · Friday · foundations

- [x] Design system v1: palette, type, components, landing and app patterns, voice
- [x] Repo scaffold: gateway, credit ledger, chain adapter (Solana + EVM), node-agent stub, web shell, tokenomics config
- [x] Gateway runs locally: API key, OpenAI-compatible chat completion, credits deducted, hourly distribution job
- [x] Fake-fees harness so credits can be watched accruing before a token exists
- [x] Repo moved onto your Mac: Documents/mesh (mesh.zip beside it can be deleted)
- [x] Design system parked at the v0.2 look (Onest display, readout hero) — revisit later
- [ ] Name and ticker confirmed or replaced (Oliver) — default Mesh / $MESH
- [ ] OpenRouter account created, no credit yet (Oliver)

## Session 2 · Saturday morning · gateway end to end

- [x] Real OpenRouter upstream wired (streaming, usage-based cost, model list, timeouts, no charge on failure) — verified against the documented API shape, live key test pending
- [x] API key lifecycle: create, name, list, revoke, per-key spend limits, per-key usage
- [x] Wallet sign-in hardened: SIWE-style message, single-use nonces, 7-day sessions with refresh, both chains
- [x] Starter-credit transfer flow for friends (admin, batch, audited)
- [x] Public /stats with 24h hourly series, /epochs, /nodes summary
- [x] Node registry: register, heartbeat, online count (for week 2)
- [x] Rate limits, request logging, error handling, geo-block middleware
- [x] Tests extended to 63; demo script updated; Dockerfile + VPS deploy guide written
- [ ] VPS created from scripts/deploy-vps.md, access sent to me (Oliver)
- [ ] OpenRouter key added to the server env and one live request confirmed (Oliver + me)

## Session 3 · Saturday afternoon · the product surface

- [x] Landing page on the design system: hero with live readout, big-word rows, privacy block, how-it-works, footer
- [x] Dashboard: wallet connect (Phantom / Solflare / MetaMask / Rabby), live credit balance, hourly sparkline, ledger table
- [x] API key page: create, copy once, rename, spend limit, revoke, usage per key
- [x] Chat page: streaming replies with the "served by … · cost" line under each
- [x] Stats page: fees, credits, requests, epochs table, nodes summary
- [x] Docs page: how credits work, how to use the key, FAQ, risk note
- [x] Empty states, loading states, phone layout, light and dark, mock mode for review
- [ ] Screens reviewed and approved (Oliver) — screenshots in docs/screens
- [ ] Chain decision (Oliver) — needed before Session 4

## Session 4 · Sunday morning · the token layer

- [x] Token contracts and fee mechanics written for BOTH chains (Solana Token-2022 fee mint script; EVM MeshToken + FeeVault + TeamLock, 34 contract tests)
- [x] Fee sweeper: hourly collect, swap holder share to USDC, fund the credit pool, treasury share — both adapters, tested offline and on a local EVM chain
- [x] Holder indexer: time-weighted balances per wallet per hour, 1,000-token floor, pool and contract wallets excluded — both adapters
- [x] Distribution job switches from mock to the real adapter by config
- [x] Team allocation lock (TeamLock contract / Solana steps in runbook)
- [x] Pool seeding steps and buy/sell test documented (scripts/chain, CHAIN\_DECISION.md)
- [ ] Chain decision (Oliver)
- [ ] Deployer and treasury wallets created, public addresses sent to me (Oliver)
- [ ] Testnet dry run: deploy, buy, sweep, credits land in your dashboard (Oliver signs, I run)

## Session 5 · Sunday afternoon · production and runbook

- [x] Database backups, monitoring on failed sweeps and epochs, Telegram alerts, daily digest — built
- [x] Admin page: network view, manual epoch run, starter credits, key revocation, quarantine, waitlist/invites — built
- [x] Snapshot-gaming protections (time-weighting, min hold, excluded wallets, holding-age option) — built and tested
- [x] Launch runbook with rollback steps and first-24-hours checklist — docs/RUNBOOK.md
- [x] Launch post and thread drafted — docs/LAUNCH\_COPY.md
- [ ] Deploy gateway and web to the VPS with HTTPS and the domain (needs the VPS)
- [ ] Runbook rehearsed once on testnet end to end (Oliver + me)

## Session 6 · Monday morning · launch

- [ ] Deploy the mint on mainnet (Oliver signs)
- [ ] Lock team allocation (Oliver signs)
- [ ] Seed the pool quietly (Oliver signs)
- [ ] Point the gateway and indexer at mainnet, first live sweep confirmed
- [ ] Dashboard live on the domain, DNS flipped
- [ ] Starter credits sent to friends' wallets
- [ ] First live epoch distributes to real holders
- [ ] Public post goes out (Oliver)
- [ ] 24-hour watch: sweeps, epochs, errors, support questions

## Week 2 · Monday to Friday · the compute network

- [x] Mac node agent: one-command installer, Ollama runner, connects to the gateway, heartbeat, launchd service, pause/resume, status, logs
- [x] Link-a-Mac flow: wallet signs in the browser, Mac installs with a short code (no keys on the Mac)
- [x] Routing: our Macs first for open models, OpenRouter fallback, retry when a node drops mid-answer, reputation scoring
- [x] Node rewards: per answer served, written to the ledger in USD (paid in MESH once the token layer ships)
- [x] Node dashboard page: status, chip, RAM, models, uptime, jobs, earnings; landing "Run" row live
- [x] Network credits: $0.02/M on Mesh nodes vs list price, savings shown on dashboard and under each reply
- [x] Privacy: anonymised jobs (nodes never see who asked), agent keeps prompts in memory only, Ollama logging off, three routing tiers (trusted nodes / any node / upstream zero-retention) selectable per request and per key, operator pledge, honest docs/PRIVACY.md
- [x] Holding-age weighting on distributions (built, off by default, flag in config)
- [x] Treasury ledger + public /report page with weekly rollups and charts
- [x] Admin page: network overview, run epoch, starter credits batch, key revocation, audit log
- [x] Chain adapters: Solana (Token-2022 fee, Jupiter sweep, Helius indexer) and EVM (ERC-20 fee token + FeeVault + TeamLock contracts, Uniswap sweep, log indexer) — unit-tested, EVM run against a local chain; chain is now one config value
- [x] Staking module: EVM MeshStaking contract (34 Foundry tests), Solana Anchor program skeleton, gateway tier API, reward multiplier and routing priority, /app/stake page — live once a chain is deployed
- [x] Cookie sessions + CSRF, admin IP allowlist, peppered key hashes, proxy trust — security open items closed
- [x] Monitoring: Telegram alerts for missed epochs, failed sweeps, upstream errors, fleet drops, disk; daily digest
- [x] Security review: fixes applied; remaining items tracked in docs/SECURITY.md
- [x] Menu-bar Mac app (SwiftUI) written: status light, earnings, pause/resume, Link this Mac — not compiled here, builds in Xcode
- [x] Points / leaderboards / referrals — built, then switched OFF at your request (config flag, UI hidden)
- [x] Site completeness: final landing copy, terms/privacy/risk pages, 404, favicon, OG image, sitemap, OpenAPI spec + /api docs page, docs/BRAND.md
- [x] Engineering: git repo with commits, GitHub Actions CI, load test (p50 first token 19 ms on node path, bottlenecks in docs/LOADTEST.md), docs/ARCHITECTURE.md, CONTRIBUTING.md
- [x] 215 gateway tests, 34 node-agent, 45 chain-adapter, 34 contract, 14 browser tests passing
- [ ] First real Mac test DONE 3 Oct: Oliver's M3 Max linked via Link a Mac, served llama-3.1-8b end to end ($0.000003, 6.6 s). Fixes found on the way: Intel Node detection, better-sqlite3 for Node 24, real-wallet sign-in in mock mode, own nodes count as trusted
- [ ] First compile of the menu-bar app: tag a release so GitHub's Mac runners build the unsigned .dmg, or on your Mac run xcode-select --install then \`make run\` in apps/menubar and send me errors (Oliver + me). No Apple account needed.
- [ ] Solana devnet smoke test — blocked from my sandbox; one command from your Mac
- [ ] VPS created (Hetzner CPX21 or DO 2 vCPU/4 GB, Ubuntu 24.04), domain on Cloudflare, SSH key added (Oliver)
- [ ] OpenRouter account + key; first live request (Oliver + me)
- [ ] Chain decision, then: deploy token (Oliver signs), deploy.\<network>.json, pool seed, staking deploy, first live sweep
- [ ] Buyback floor with public NAV chart — after chain decision
- [ ] Buyer marketplace for discounted credits (if holder supply justifies it)
- [ ] Friends onboarded as nodes, 5–10 Macs (Oliver)
- [ ] Name and ticker final (Oliver) — currently Mesh / $MESH everywhere via config

**Added for the open public beta (3 Oct):**

- [x] Spot-check verification: 5% of network jobs re-run on a second node and compared; junk or mismatched answers lose the reward and hurt reputation; repeat offenders quarantined; admin can clear
- [x] Open beta: Beta badge on nav and landing, invites OFF, waitlist and invite tooling kept in admin for pacing if ever needed, beta clause in terms
- [x] Distribution without Apple: /download page (Terminal, Homebrew, unsigned .dmg with Open Anyway steps and SHA-256), Homebrew tap formula, `mesh-node update` with daily check, release workflow producing dmg + tarball + checksums + latest.json
- [x] 242 gateway tests, 46 agent, 48 adapter, 18 browser tests passing
- [ ] Create the GitHub repository and push (Oliver: a GitHub account and an org name, e.g. mesh-network; I do the rest) — needed for releases, CI and the Homebrew tap
- [ ] Legal entity for the launch (company for domain, server, token; Apple account later if ever) — Oliver, with a quick legal read

**Homepage rework (3 Oct):**

- [x] Free homepage chat: 5 messages a day per visitor with no sign-in, served by the network and paid by the treasury (cost shown on /report), 251 gateway tests passing
- [x] Homepage variant A "warm editorial" at /v2: ecosystem loop diagram, Use / Run / Hold columns, six-point "why it's different" (no rivals named), privacy tiers, live numbers, chat in the hero
- [x] Homepage variant B "clean product-first" at /v3: chat as a product window in the hero, flow cards, Use / Run / Hold cards with mock UI, checklist, metrics, developer strip
- [ ] Pick A, B, or a mix — then it becomes the homepage and the old landing retires (Oliver)
- [x] Public checklist page shared: Share → anyone with the link (Oliver)

## Open decisions and inputs

| Decision | Default if you don't say | Needed by |
| --- | --- | --- |
| Name and ticker | Mesh / $MESH | Session 3 |
| Chain | Solana | Session 4 |
| Fee split | 50% holders / 50% treasury | Session 4 |
| Launch route | Own pool, small quiet seed | Session 5 |
| Public or friends-first on Monday | Public, no push | Session 5 |
| Deployer wallet + gas | 5–10 SOL (or equivalent) | Session 4 |
| OpenRouter account + seed credit | $100–200 | Session 2 |
| Domain + VPS | $20 box, I spec it | Session 2 |
| Design references | Signed-off design system v1 | Session 3 |
