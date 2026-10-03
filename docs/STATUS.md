# Mesh — status after Session 8 (2026-10-03)

One page: what is in the repo after sessions 1–8, how it is tested, what is switched off, and what only Oliver can do. Detail lives in the linked docs; this page is the index.

## What is in the repo, by session

| Session | What landed | Where to read |
| --- | --- | --- |
| 1 — Gateway core | Fastify + SQLite gateway: fees → hourly epoch → pro-rata credits (`MockAdapter`), SIWE/SIWS wallet sign-in + JWT, API keys with spend limits, OpenAI-compatible `/v1/chat/completions` + `/v1/models` (streaming, never charged on failure), `/stats`, `/epochs`, `/health`, admin console with audit trail, treasury ledger + `/report`. | `README.md`, `docs/ARCHITECTURE.md` |
| 2 — Web app | `apps/web` (Vite + React): landing, docs, `/api` reference rendered from `apps/gateway/openapi.yaml`, signed-in Overview / Keys / Chat / Network / Node / Stake, public `/report`, operator `/admin`, legal drafts (`/terms`, `/privacy`, `/risk`), 404. Phantom, Solflare, MetaMask, Rabby. Design system in `docs/design-system.html`, tokens in `packages/design-tokens`. `VITE_MOCK=1` for fake data. | `docs/BRAND.md`, `docs/LAUNCH_COPY.md` |
| 3 — Node network | Gateway ⇄ Mac protocol: register, heartbeat, long-poll jobs, chunk/done/fail relay, timeouts + one re-queue + transparent fallback to OpenRouter, reputation, `$0.02/M` user price vs `$0.06/M` node reward; `apps/node-agent` (`mesh-node`, one-file bundle, Ollama, launchd service, `scripts/install-node.sh`); `apps/menubar` SwiftUI app (not yet compiled, needs a Mac); relay load test. | `docs/NODE_PROTOCOL.md`, `apps/node-agent/README.md`, `docs/MENUBAR.md`, `docs/LOADTEST.md` |
| 4 — Token layer | `packages/chain-adapter`: `SolanaAdapter` (Token-2022 transfer fee, Helius) and `EvmAdapter` (viem, `Transfer`-log balances, `FeeVault.sweep`, Uniswap swap) behind one `ChainAdapter`; `contracts/evm` (MeshToken, FeeVault, MeshStaking; 34 Foundry tests); `programs/mesh-staking` (Anchor); deploy scripts in `scripts/chain`; `config/deploy.<network>.json` loader; holding-age weighting (off); stake tiers applied to node rewards and routing. | `docs/CHAIN_DECISION.md`, `docs/STAKING.md`, `packages/chain-adapter/README.md` |
| 5 — Security review + ops | 21 findings, 20 fixed: signed node registration + link codes, production boot refuses default secrets, dev-login off in prod, CORS allowlist, rate limits, body limits, timing-safe compares, JWT rotation, helmet, log redaction, relay cleanup, failed-sweep alerts (Telegram / webhook). Launch runbook with pre-flight checks and incident playbooks. | `docs/SECURITY.md`, `docs/RUNBOOK.md`, `scripts/deploy-vps.md` |
| 6 — Cookie sessions + admin hardening | Session JWT moved to an `HttpOnly` cookie + CSRF double submit (bearer kept for API clients); admin cookie session + `ADMIN_IP_ALLOWLIST` enforced in-gateway + full admin audit; peppered API-key hashes (`KEY_PEPPER`, lazy rehash); `TRUSTED_PROXY_CIDRS` for `X-Forwarded-For` and geo headers; `x-request-id` everywhere. | `docs/SECURITY.md` §14, §17–21 and "Session 6" |
| 7 — Points switched off, privacy tiers, launch polish | Points / leaderboard / referral programme kept in code but **disabled** (below). Privacy tiers for node routing (in progress in `network.ts` / `routing.ts` / `v1.ts` / `nodes.ts`, node-agent, Chat / Keys / Node pages, `docs/PRIVACY.md`). Brand notes, OG image, favicon, manifest, robots, sitemap, meta tags verified; screenshots regenerated. | `docs/POINTS.md`, `docs/PRIVACY.md`, `docs/BRAND.md` |
| 8 — Mac distribution without an Apple account | Web `/download` (Terminal / Homebrew / unsigned menu-bar DMG with the macOS "Open Anyway" walkthrough, version + SHA-256 from `/downloads/latest.json`, "why the warning"); `homebrew-tap/Formula/mesh-node.rb` + `scripts/release/make-tarball.sh`; `mesh-node update` (sha256-verified atomic swap, service restart) + daily check in `start`; gateway `GET /install/latest.json`, `GET /install/mesh-node.js`, `POST /admin/release`; menu-bar "Check for updates"; `make dmg` → `MeshNode-<v>-arm64.dmg` + `.sha256`; `.github/workflows/release.yml` (bundle, tarball, DMG, GitHub Release, `latest.json`, formula commit/push). | `docs/DISTRIBUTION.md`, `docs/MENUBAR.md` §3 |

## Tests and gates

| Gate | Command | Count |
| --- | --- | --- |
| Gateway unit + HTTP | `pnpm test` | 22 files, **242** tests (`install.test.ts` 8: latest.json static/proxy/cache, admin release, bundle serve/redirect; `points.test.ts` 23 incl. 5 for the disabled state; `security` 28; `session-hardening` 15; node protocol, savings, staking, holding-age, report, alerts, verification) |
| Chain adapter | `pnpm --filter @mesh/chain-adapter test` | 6 files, **45** tests (Solana + EVM offline; 3 more against a local anvil) |
| Node agent | `pnpm --filter @mesh/node-agent test` | 6 files, **46** tests (`update.test.ts` 12 against a fake release server: good hash, bad hash, HTML body, same version, 5xx, daily loop, auto-install) |
| EVM contracts | `cd contracts/evm && forge test` | 34 Foundry tests (17 token, 17 staking) |
| Browser e2e (real gateway, mock adapter) | `pnpm e2e` | **18** Playwright tests (desktop flows incl. cookie session + admin cookie, `/download`; 390 px no-horizontal-scroll). Two beta tests (`waitlist CTA`, `admin waitlist`) are red since `beta.inviteRequired` was set to `false` in commit 037c4e4 (open beta) and need updating to the open-beta state |
| Types / build | `pnpm -r typecheck`, `pnpm --filter web build` | green for web, config, chain-adapter, node-agent; gateway typecheck and the node-protocol / savings / network tests go red only while the privacy-tier edits to `routes/v1.ts`, `network.ts`, `routing.ts` are mid-flight |
| Screenshots | `pnpm screenshots` → `docs/screens/` | 14 pages × 2 widths (landing, landing-beta, invite, app, keys, chat, stats, node, report, download, admin, api, terms, 404) |
| Release tooling | `sh -n scripts/release/*.sh apps/menubar/scripts/*.sh`, `ruby -c homebrew-tap/Formula/mesh-node.rb`, YAML parse of `.github/workflows/*.yml` | green; `make-tarball.sh` exercised end to end (tarball → wrapper → `install.sh` → `mesh-node --version`) |
| Load test | `pnpm loadtest` | 200 concurrent requests, 20 fake nodes: 0 failures, first token p95 686 ms on 2 vCPU |

## What is disabled or stubbed (and the switch)

| Piece | State | Switch / next step |
| --- | --- | --- |
| **Points, leaderboard, referrals** | **Built, disabled.** `config/tokenomics.json → points.enabled: false` (schema default). Gateway 404s `/points/*`, `/leaderboard/*`, `/referrals/*`, `/me/points`, `/me/referral`; no `points_ledger` rows are written; `GET /stats → pointsEnabled: false`; web hides Ranks nav, `/leaderboard` (404), Points tile, Referral card, footer link; `/leaderboard` removed from sitemap and screenshots. `POST /admin/points/adjust` still works (audited). | `enabled: true` + restart; backlog is awarded from the ledger cursors. `docs/POINTS.md` |
| Holding-age weighting | implemented, `distribution.holdingAge.enabled: false` | flip the flag |
| Live chain adapters | implemented and tested offline; `MESH_ADAPTER=mock` in dev; no `config/deploy.<network>.json` committed | needs a deployed token (below) |
| Node reward payout | rewards accrue in USD in `node_rewards`; no on-chain payout | `transferTokens` path exists; product decision on cadence |
| Menu-bar app | Swift source complete (incl. "Check for updates"), never compiled; `release.yml` job B runs `swift build`/`make dmg` on `macos-latest`, so the first tag is also the first compile | first `swift build` on a Mac or the first tag (`docs/MENUBAR.md`) |
| Mac distribution | unsigned DMG + Homebrew tap + `mesh-node update` built; `latest.json` on the web is the sample file; the tap repo `mesh-network/homebrew-tap` does not exist yet; formula sha256 is a placeholder until the first release | push a `v*` tag; create the tap repo + `HOMEBREW_TAP_TOKEN`; deploy `latest.json` to `/downloads/` (`docs/DISTRIBUTION.md` §2) |
| App signing / notarisation | not configured; the Open Anyway path is documented and shown on `/download` | add the `MACOS_*` / `NOTARY_*` secrets when the developer account exists (`docs/DISTRIBUTION.md` §5) |
| Upstream inference | `MockUpstream` when `OPENROUTER_API_KEY` is unset | set the key |
| Multi-instance | rate limits, relays, stats cache, alert state are per process | one VPS is the plan; `docs/ARCHITECTURE.md` §9 |
| Node-token pepper | node tokens still plain sha256 (API keys are peppered) | same lazy-rehash pattern in `routes/nodes.ts` (Low) |
| Legal pages | plain-English drafts marked "not legal advice" | lawyer review before the token trades |
| Placeholders | `app.example.com`, `api.example.com`, `x.com/mesh_placeholder`, `t.me/mesh_placeholder` | grep `example.com` and `_placeholder` |

## What needs Oliver

1. **Pick the chain** (`docs/CHAIN_DECISION.md`): Solana Token-2022 or EVM (Base / Robinhood Chain). Set `config/tokenomics.json → chain`.
2. **Deploy the token, fee vault and staking** with `scripts/chain/*` and commit `config/deploy.<network>.json` (addresses only, no keys). Fill `meta.contractAddress`, `meta.totalSupply`.
3. **Seed liquidity** (Raydium/Meteora or Uniswap v3) and, on EVM, `setFeeExempt(pool, true)`.
4. **Secrets and hosts** on the VPS: `JWT_SECRET`, `ADMIN_TOKEN`, `KEY_PEPPER`, `OPENROUTER_API_KEY`, RPC / Helius key, signer keypair, `AUTH_DOMAIN`, `CORS_ORIGINS`, `ADMIN_IP_ALLOWLIST`, `TRUSTED_PROXY_CIDRS`; replace the placeholder hosts and social URLs. Follow `docs/RUNBOOK.md` §0–§7 and its pre-flight checks.
5. **Decisions**: session TTL (7 d today), node payout cadence, whether holding-age weighting is on at launch, `geoBlock` list (AE, US, GB today), and whether the points programme ever comes back (it is a one-line flag).
6. **Hardware**: a Mac with Xcode to compile the menu-bar app locally (CI does it on `macos-latest` too); a few friends' Macs for the first node batch (`docs/LAUNCH_COPY.md` §4). Notarisation only when the developer account exists.
8. **First release**: create `github.com/mesh-network/homebrew-tap` (empty) and the `HOMEBREW_TAP_TOKEN` secret, push `v0.1.0`, deploy `latest.json` to the web host (`docs/DISTRIBUTION.md` §2), try the DMG on a clean Mac through Open Anyway.
7. **Legal review** of `/terms`, `/privacy`, `/risk` before the token is tradeable.

## Exact commands

```sh
pnpm install && pnpm build          # packages + gateway + web
pnpm test                           # gateway (242)
pnpm test:all                       # + chain-adapter (45) + node-agent (46)
pnpm e2e                            # Playwright (18) against the real gateway
VERSION=0.2.0 sh scripts/release/make-tarball.sh   # release tarball + sha256 (CI does this on tag v*)
pnpm dev                            # gateway :8787 (mock adapter, mock upstream) + web :5173
pnpm demo                           # scripted end-to-end run incl. a curl-simulated node
pnpm dev:mock                       # web only on fake data (what docs/screens/ shows)
pnpm screenshots                    # regenerate docs/screens/*.png
pnpm loadtest                       # relay load test
```
