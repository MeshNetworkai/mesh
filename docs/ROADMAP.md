# Mesh roadmap

> Working list, not final content. Oliver designs the public roadmap content later; until then this
> page and the "Roadmap" section at the bottom of `/docs` show the same items. The web version renders
> from `apps/web/src/content/roadmap.ts` (plain strings, a `status` per item, no dates): edit that file
> and mirror the change here, or the other way round. Items come from `docs/CHECKLIST.md`.

Statuses: **done** shipped and live · **now** in the open beta, being finished or switched on ·
**next** after the token launches · **later** on the list, not scheduled · **exploring** researched,
not committed. No dates anywhere; the token launch is the one event most of the list waits for, and
the chain is decided on launch day by the team.

## Now (beta)

The open beta is live: hourly credits from a mock fee feed, the gateway, the Mac network, the
marketplace and the catalogue. What is left before launch.

| Status | Item | Detail |
| --- | --- | --- |
| done | OpenAI-compatible gateway with hourly credits | Keys, chat, streaming, spend limits, ledger, public epoch history. |
| done | Mac node network | Link a Mac with a code, one-line installer, Homebrew tap, menu-bar app, pay per million tokens, spot-check verification. |
| done | Credit marketplace | Sell unused credit at a discount, buy below face value, escrow, partial fills, public book. |
| done | Frontier catalogue | Claude, GPT, Gemini, Grok, DeepSeek and more through zero-data-retention providers, Mesh price shown next to list. |
| done | Privacy tiers | Trusted, network or upstream per request or per key; nodes never see who asked. |
| done | Starter credits on first connect | A small grant per wallet so you can send a request before holding or buying anything. |
| now | Usage share switched on | The second engine is built and audited. It switches on with the pricing decision, which sets the network price above node pay so there is a margin to share. |
| now | Cloudflare in front of the site | DNS and edge protection for the web app and the gateway. |
| now | Status page and public node explorer | Uptime, incidents, and every online node with chip, models and reputation; no wallets. |
| now | Menu-bar app, signed build | Today the DMG is unsigned and opens through "Open Anyway". A signed, notarised build removes the warning. |
| now | Web app hardening pass | Auth races, streaming abort, stale sessions, phone layouts. |

## Launch

The token is deployed by the team on launch day, on the chain decided at that point. Everything
below waits for that one event.

| Status | Item | Detail |
| --- | --- | --- |
| next | Chain decision and token deployment | The team deploys the token, the fee vault and the team lock; the gateway and indexer are pointed at it and the first live sweep is confirmed. |
| next | First live epoch | Real trading fees become credits for real holders. The mock fee feed is retired. |
| next | Staking live | Lock tokens for a bigger node multiplier, a place at the front of the queue and, with the operator pledge, trusted status. |
| next | USDC checkout for the market | Buyers top up and sellers withdraw on-chain. Replaces the team-credited prepaid balance used during the beta. |
| next | Node rewards paid out | Accrued node earnings leave the counter and reach the operator wallet on a published cadence. |

## After launch

Once fees and usage are real, the treasury can do more than pay the Macs.

| Status | Item | Detail |
| --- | --- | --- |
| later | Buyback floor with a public NAV chart | Treasury buybacks under a published rule, with the net asset value charted on the numbers page. |
| later | More models on the network | Larger open models on 32 GB and 64 GB Macs, and more frontier models in the catalogue as providers qualify for zero data retention. |
| later | Onboarding pack | First-run walkthrough, run-a-node guide with screenshots, launch thread. |

## Later

Ideas with research done and no commitment.

| Status | Item | Detail |
| --- | --- | --- |
| exploring | Agent launchpad | Tokens for agents built on the gateway, paired with $MESH, with creator fees split between stake, credits and the treasury. Due diligence done; not scheduled. |
| exploring | Mobile node | Whether a phone can serve small models well enough to join the network. |
| exploring | Points and referrals | Built and switched off. Comes back only if there is a reason. |

## Internal notes (not for the public page)

- The "now" items map to `docs/CHECKLIST.md` → Production readiness and Beating Orbio. Tick them there
  first, then flip the status here.
- Usage share: the suggested on-state is network price $0.08/M, node pay $0.06/M, 30 % of margin to
  holders (`docs/PRICING.md` §3). Public copy never quotes those numbers until the switch is flipped;
  it says "built, switches on with the pricing decision".
- Agent launchpad is the one item that mirrors the rival's product; it stays "exploring" and is never
  described as planned in public copy.
