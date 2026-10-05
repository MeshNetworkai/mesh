# Mesh brand notes

One page for anyone writing or designing for Mesh: name, voice, the copy we shipped, and where the assets live.
The design system itself (colour, type, components) is `docs/design-system.html`; tokens are in
`packages/design-tokens/tokens.css`. Launch copy variants and the thread are in `docs/LAUNCH_COPY.md`.

## Name and ticker

| | Value | Source |
| --- | --- | --- |
| Name | **Mesh** (working name) | `config/tokenomics.json → name` |
| Ticker | **$MESH** | `config/tokenomics.json → ticker` |
| Chain | Solana (EVM adapter exists) | `config/tokenomics.json → chain` |
| Web host | `app.example.com` — placeholder | `apps/web/index.html`, `apps/web/public/robots.txt`, `sitemap.xml`, `apps/gateway/openapi.yaml` |
| API host | `api.example.com` — placeholder | `apps/gateway/openapi.yaml → servers[0]`; the gateway rewrites it to `AUTH_URI` at runtime when a real domain is configured |
| Socials | `https://x.com/mesh_placeholder`, `https://t.me/mesh_placeholder` | `apps/web/src/components/Footer.tsx → SOCIAL` |

Everything the UI prints (name, ticker, fee, split, minimum hold, epoch length, network price, node reward,
blocked regions) is read from `config/tokenomics.json`. Change it there, not in copy. Before launch: replace
the two placeholder hosts and the two placeholder social URLs (grep for `example.com` and `_placeholder`).

Write the ticker as `$MESH` in prose and `MESH` after a number ("1,000 MESH"). Write "Mesh node" and
"the Mesh network"; never "Mesh Network" capitalised, never "node network" or "DePIN".

## Voice

From the design system: short sentences, plain words, say where it runs and what it costs, never promise a return.

Say:
- "Trading fees become AI credits, every hour."
- "Served by a Mac in the Mesh network."
- "Credits are a share of fees, not a promise."
- "An hour with no trades distributes nothing."
- "You were not charged." (every failure path)

Never say:
- "points", "leaderboard", "referral bonus" in public copy while the programme is disabled (`docs/POINTS.md`)
- "guaranteed yield", "passive income", "APY", "earn while you sleep"
- "better than ChatGPT", "fully private" (say where it runs instead), "zero logs" (we log billing rows)
- "get paid in MESH" until on-chain payout ships; today rewards are a USD counter
- anything with an exclamation mark, rockets, emojis, "to the moon"

Numbers come from config and are written in full: "1.5 % fee", "$0.02 per million tokens", "1,000 MESH".
Every claim about privacy says what is kept: model, token counts, cost and latency, never the prompt.

## Hero copy (chosen)

Variant **A** from `docs/LAUNCH_COPY.md` is live on the landing page and the OG image. It is the design
system's own headline, the shortest of the three, and it survives at 56 px on a phone.

> **Trading pays for private AI.**
>
> Hold 1,000 $MESH and AI credits arrive every hour, paid for by trading fees. One API key for any model.
> Requests for the open models run on Macs in the Mesh network, with nothing stored after the reply.

The subcopy differs from the file in one place: "Your requests run on Macs… never on a provider's logs"
became "Requests for the open models run on Macs… with nothing stored after the reply", because requests
for non-network models go to OpenRouter and the old sentence overclaimed.

Alternatives, kept for ads, the docs hero and the token page:

- **B — mechanism first.** "Half of every trade becomes AI, every hour." Best where the reader already knows
  it is a token and wants the maths (stats page, launch thread post 2, exchange listings).
- **C — the API is the product.** "An API key your trading fees keep topping up." Best for developer
  channels (Hacker News, the `/api` page, OpenRouter alternatives lists). Mentions the price in the first
  three lines, which the other two do not.

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
| `/` | Hero ("Trades fund it. Macs serve it. Holders use it.") with the free guest chat and key figures, ecosystem loop, three ways in, why this is different, privacy tiers, live numbers, final CTA | `apps/web/src/pages/Landing.tsx` (chat: `components/GuestChat.tsx`) |
| `/docs` | Prose docs: what Mesh is, credits, network credits, key usage, running a node, FAQ, risk | `apps/web/src/pages/Docs.tsx` |
| `/api` | API reference rendered from `apps/gateway/openapi.yaml` (grouped, examples, curl, copy) | `apps/web/src/pages/ApiDocs.tsx` |
| `/terms`, `/privacy`, `/risk` | Plain-English drafts, marked "draft, not legal advice" | `apps/web/src/pages/Legal.tsx` |
| `/report` | Public report: fees in → credits out, weekly table and charts | `apps/web/src/pages/Report.tsx` |
| `/leaderboard` | **Hidden.** Points / leaderboard / referral programme is built but disabled (`docs/POINTS.md`); the route is a 404 and the "Ranks" nav link, footer link, Points tile and Referral card are not rendered while `GET /stats → pointsEnabled` is false | `apps/web/src/pages/Leaderboard.tsx` |
| `/404` and any unknown path | "Nothing served here." | `apps/web/src/pages/NotFound.tsx` |

The legal pages are drafts written by the operator. They must be reviewed by a lawyer before the token is
tradeable. They cover: geo-restriction (AE, US, GB from config), credits-not-a-promise, node operator
terms (your Mac, your electricity, no guarantee of jobs, rewards are a counter until payout ships), and
data handling (no prompt storage; billing rows, heartbeats 48 h, nonces 5 min, link codes 15 min).

## Assets

| Asset | Path | Notes |
| --- | --- | --- |
| Mark (five dots, third accent) | inline `.nodes` in `Nav.tsx`, `Footer.tsx`, design system | Horizontal row in the wordmark |
| Favicon | `apps/web/public/favicon.svg` | Same five dots as a quincunx (2-1-2) so it reads at 16 px; centre dot accent; dark-mode colours via `prefers-color-scheme` |
| Touch icon | `apps/web/public/apple-touch-icon.png` (180×180) | Ink square, five light dots, centre accent |
| OG / Twitter image | `apps/web/public/og.png` (1200×630) | Hero A left, readout card right, footer line "Credits are a share of fees, not a promise." |
| OG generator | `apps/web/scripts/og.mjs` → `pnpm --filter web og` | SVG rasterised with `@resvg/resvg-js`; uses the shipped Onest/Inter/JetBrains Mono files (WOFF → TTF in-script) |
| Web manifest | `apps/web/public/site.webmanifest` | |
| robots / sitemap | `apps/web/public/robots.txt`, `sitemap.xml` | `/app` and `/admin` disallowed; replace host |
| Meta tags | `apps/web/index.html` | title, description, canonical, OG, Twitter `summary_large_image`, theme-color light/dark |
| OpenAPI | `apps/gateway/openapi.yaml`, served at `GET /openapi.json` | Single source for `/api` |
| Screenshots | `docs/screens/*-1440.png`, `*-390.png` | `pnpm screenshots`; `SCREENS_ONLY=landing,api` for a subset |

Colours for anything outside the app (slides, social cards): bg `#FFFFFF`, fg `#0B1220`, fg-2 `#4B5563`,
muted `#7B8798`, line `#E6E9EE`, accent `#1F9D66` (dark mode `#4FD394`), ink `#050912`. Green appears only
where value moves toward the reader. Type: Onest 300 for display, Inter 400 for reading, JetBrains Mono for
anything a machine wrote.
