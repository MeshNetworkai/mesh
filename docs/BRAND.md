# Mesh brand notes

One page for anyone writing or designing for Mesh: name, voice, the copy we shipped, and where the assets live.
The design system itself (colour, type, components) is `docs/design-system.html`; tokens are in
`packages/design-tokens/tokens.css`. Launch copy variants and the thread are in `docs/LAUNCH_COPY.md`.

## Name and ticker

| | Value | Source |
| --- | --- | --- |
| Name | **Mesh** (working name) | `config/tokenomics.json → name` |
| Ticker | **$MESH** | `config/tokenomics.json → ticker` |
| Chain | Decided by the team on launch day; `chain` in config is a default for the adapters, not a public commitment. Public copy never names a chain as final; the UI no longer prints it | `config/tokenomics.json → chain` |
| Web host | `mesh-network.ai` | `apps/web/index.html`, `apps/web/public/robots.txt`, `sitemap.xml` |
| API host | `api.mesh-network.ai` (`api.example.com` still in `openapi.yaml → servers[0]`; the gateway rewrites it to `AUTH_URI` at runtime) | `apps/gateway/openapi.yaml` |
| Socials | `https://x.com/mesh_placeholder`, `https://t.me/mesh_placeholder` | `apps/web/src/components/Footer.tsx → SOCIAL` |

Everything the UI prints (name, ticker, fee, split, minimum hold, epoch length, network price, node reward,
marketplace fee and discount range, usage-share split, starter credit, verification sample, blocked regions) is
read from `config/tokenomics.json` through `apps/web/src/config.ts`. Change it there, not in copy. Before
launch: replace the two placeholder social URLs (grep for `_placeholder`) and `servers[0]` in `openapi.yaml`.

Write the ticker as `$MESH` in prose and `MESH` after a number ("1,000 MESH"). Write "Mesh node" and
"the Mesh network"; never "Mesh Network" capitalised, never "node network" or "DePIN".

## Voice

From the design system: short sentences, plain words, say where it runs and what it costs, never promise a return.
Sentence case everywhere, including labels and buttons; Onest for display, Inter for everything else; no
monospace outside things a machine wrote (keys, wallets, commands, code); no uppercase tracked labels.

The one-liner, used wherever the product has to be explained in a breath:

> **Two engines, one hourly pool.** Trading fees fund it today; a share of paid usage joins when it is
> switched on. Macs serve the open models, frontier models come at list, and credits you do not use are sold on.

Say:
- "Trading fees become AI credits, every hour."
- "Two engines, one hourly pool."
- "Built, switches on with the pricing decision." (the usage share, until `usageShareEnabled` is true)
- "Served by a Mac in the Mesh network." / "Frontier models at list, through zero-data-retention providers."
- "Sell what you do not use."
- "Credits are a licence to use the gateway, not money."
- "The token is deployed by the team on launch day." (never a chain name as final)
- "Credits are a share of fees, not a promise."
- "An hour with no trades distributes nothing." (from fees; add "and no sales" where the marketplace is in view)
- "You were not charged." (every failure path)

Never say:
- "points", "leaderboard", "referral bonus" in public copy while the programme is disabled (`docs/POINTS.md`)
- "guaranteed yield", "passive income", "APY", "earn while you sleep"
- "better than ChatGPT", "fully private" (say where it runs instead), "zero logs" (we log billing rows)
- "get paid in MESH" until on-chain payout ships; today rewards are a USD counter
- "holders earn from usage" in the present tense while `usageShare.enabled` is false; it is "built, switches on with the pricing decision"
- "on Solana", "on Base" or any chain as settled; the team decides on launch day
- "invite-only", "waitlist" as the state of the product; the beta is open (`beta.inviteRequired: false`)
- "Orbio" or any rival by name in public copy; the comparison is internal (`docs/LAUNCH_COPY.md` §0)
- "/numbers", "/report" as page names; the public page is `/stats`
- anything with an exclamation mark, rockets, emojis, "to the moon"

Numbers come from config and are written in full: "1.5 % fee", "$0.02 per million tokens", "1,000 MESH".
Every claim about privacy says what is kept: model, token counts, cost and latency, never the prompt.

## Hero copy (chosen)

The homepage v2 hero is live on the landing page and the OG image (`pages/Landing.tsx`, `scripts/og.mjs`):

> **Trades fund it. Macs serve it. Holders use it.**
>
> Hold 1,000 $MESH and AI credits land in your wallet every hour, paid from the 1.5 % trading fee. Spend
> them on open models answered by Macs in the network or on frontier models at list price through
> zero-data-retention providers, and sell the credits you do not use on the marketplace.

When the gateway reports `usageShareEnabled: true` the middle line becomes "Usage funds it." and the lede
adds "and a share of what paid requests earn". The earlier hero ("Trading pays for private AI.") is retired;
its variants are kept in `docs/LAUNCH_COPY.md` §1 for ads.

Landing section copy that was changed from the first build:

| Where | Before | After | Why |
| --- | --- | --- | --- |
| Ask row | "nothing lands in a provider's logs" | "nothing is stored after the reply" + the network price | OpenRouter-routed requests do go to a provider |
| Run row | "get paid in MESH for the answers it serves" | "earn $0.06 per million tokens it serves, tracked per job… stop any time" | Rewards accrue in USD; payout is not live |
| Ink block | "with no logging and nothing stored" | "running with logging off and nothing kept after the reply. Other models go to OpenRouter at cost." | Says where it runs |
| Hero footnote | — | "Credits are a share of fees, not a promise: read the risks." | Risk link above the fold |

## Pages and what they are for

| Route | Purpose | File |
| --- | --- | --- |
| `/` | Hero ("Trades fund it. Macs serve it. Holders use it.") with the free guest chat and key figures, "How the money moves" two-engine diagram, four ways in (use, sell, run, hold), why it's different, switch strip, privacy tiers, live numbers, final CTA | `apps/web/src/pages/Landing.tsx` (chat: `components/GuestChat.tsx`, diagram: `components/Engines.tsx`) |
| `/docs` | Prose docs: what Mesh is, credits (two engines, time-weighting, starter credits), using credits, live model catalogue, marketplace, running a Mac, privacy tiers, verification, staking, the stats page, FAQ, risk, roadmap | `apps/web/src/pages/Docs.tsx`, roadmap data `src/content/roadmap.ts` (mirrored in `docs/ROADMAP.md`) |
| `/api` | "Switch in a minute" plus the API reference rendered from `apps/gateway/openapi.yaml` (grouped, examples, curl, copy) | `apps/web/src/pages/ApiDocs.tsx` |
| `/stats` | Public stats: live network, every epoch, weekly report, treasury, marketplace, usage share (`/numbers` and `/report` redirect here) | `apps/web/src/pages/StatsPage.tsx` |
| `/download` | Terminal, Homebrew, unsigned menu-bar DMG with checksums and the "Open Anyway" steps | `apps/web/src/pages/Download.tsx` |
| `/app/chat` | The chat app ("App" in the nav): full-height, rail of past conversations (this browser only), Markdown replies with the "served by · model · cost · latency" line, model and privacy pills in the composer. Works signed out on the free guest messages (counter in the composer, inline connect card when they run out or a frontier model is picked); a guest conversation carries on after sign-in | `apps/web/src/pages/Chat.tsx`, shared surface `components/ChatThread.tsx`, history `lib/chatHistory.ts` |
| `/app/market` | Credit marketplace: book, buy, sell, listings, fills, prepaid balance and withdrawals | `apps/web/src/pages/Market.tsx` |
| `/terms`, `/privacy`, `/risk` | Plain-English drafts, marked "draft, not legal advice"; marketplace clauses, usage share as "may", geo clause only when the list is non-empty | `apps/web/src/pages/Legal.tsx` |
| `/leaderboard` | **Hidden.** Points / leaderboard / referral programme is built but disabled (`docs/POINTS.md`); the route is a 404 and the "Ranks" nav link, footer link, Points tile and Referral card are not rendered while `GET /stats → pointsEnabled` is false | `apps/web/src/pages/Leaderboard.tsx` |
| `/404` and any unknown path | "Nothing served here." | `apps/web/src/pages/NotFound.tsx` |

The legal pages are drafts written by the operator. They must be reviewed by a lawyer before the token is
tradeable. They cover: credits as a licence not money, the two engines (usage share as "may"), the marketplace
(escrow, 2.5 % fee not refunded, prepaid balances topped up and withdrawals processed by the team during the
beta), node operator terms (your Mac, your electricity, no guarantee of jobs, rewards are a counter until payout
ships, spot checks), the open beta and the undeployed token, and data handling (no prompt storage; billing rows,
marketplace rows, heartbeats 48 h, nonces 5 min, link codes 15 min, starter-grant IP hash one day). The
geo-restriction clause renders only when `geoBlock` is non-empty (it is empty as shipped).

## Assets

| Asset | Path | Notes |
| --- | --- | --- |
| Mark (five dots, third accent) | inline `.nodes` in `Nav.tsx`, `Footer.tsx`, design system | Horizontal row in the wordmark |
| Favicon | `apps/web/public/favicon.svg` | Same five dots as a quincunx (2-1-2) so it reads at 16 px; centre dot accent; dark-mode colours via `prefers-color-scheme` |
| Touch icon | `apps/web/public/apple-touch-icon.png` (180×180) | Ink square, five light dots, centre accent |
| OG / Twitter image | `apps/web/public/og.png` (1200×630) | v2 hero left ("Trades fund it. Macs serve it. Holders use it."), key-figures card right with every number from config, footer line "Credits are a share of fees, not a promise." |
| OG generator | `apps/web/scripts/og.mjs` → `pnpm --filter web og` | SVG rasterised with `@resvg/resvg-js`; uses the shipped Onest/Inter files (WOFF → TTF in-script) |
| Web manifest | `apps/web/public/site.webmanifest` | |
| robots / sitemap | `apps/web/public/robots.txt`, `sitemap.xml` | `/app` and `/admin` disallowed; replace host |
| Meta tags | `apps/web/index.html` | title, description, canonical, OG, Twitter `summary_large_image`, theme-color light/dark |
| OpenAPI | `apps/gateway/openapi.yaml`, served at `GET /openapi.json` | Single source for `/api` |
| Screenshots | `docs/screens/*-1440.png`, `*-390.png` | `pnpm screenshots`; `SCREENS_ONLY=landing,api` for a subset |

Colours for anything outside the app (slides, social cards): bg `#FFFFFF`, fg `#0B1220`, fg-2 `#4B5563`,
muted `#7B8798`, line `#E6E9EE`, accent `#1F9D66` (dark mode `#4FD394`), ink `#050912`. Green appears only
where value moves toward the reader. Type: Onest 300 for display, Inter 400 for reading, Inter 500 at 13 px in
sentence case with normal tracking for labels (never uppercase, never letter-spaced, never a monospace face —
that reads as machine-generated). Figures use Inter with tabular numerals. The only monospace is the system one
(`ui-monospace`), and only for things a machine wrote: keys, wallets, commands, code.
