# Mesh roadmap

> The public roadmap at the end of `/docs` renders from `apps/web/src/content/roadmap.ts` (plain
> strings, a `status` per item, no dates). This file mirrors it. The working copy is Oliver's "Mesh
> roadmap" doc; when he says a version is final it is copied here and into the web file.

Statuses: **done** shipped and live · **now** in the open beta, being finished or switched on ·
**next** after the token launches · **later** on the list, not scheduled. No dates anywhere; the
token launch (Robinhood Chain, via Pons) is the one event most of the list waits for.

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
| done | Starter credits on first connect | A small grant for a wallet that holds the token, to spend on requests straight away. It cannot be sold. |
| done | Usage share switched on | The second engine: the network price sits above node pay and a share of the margin joins the hourly pool. |
| done | Every request covers its cost | Frontier models are billed list plus a markup that covers what the upstream charges, and a staked node is held below the price the user pays. |
| done | Credits that expire | A credit lapses a fixed time after it lands, oldest spent first, so unused credit does not pile up. The dashboard shows what lapses next. |
| done | Buy credits at face value | Anyone can buy credits from Mesh with a prepaid balance: no token and no seller needed. |
| done | Status page and public node explorer | Uptime, incidents, and every online node with chip, models and reputation; no wallets. |

## Launch

The token launches on Robinhood Chain via Pons on launch day. Everything below waits for that one event.

| Status | Item | Detail |
| --- | --- | --- |
| next | Token launch on Robinhood Chain (Pons) | The team launches the token on Pons. |
| next | First live epoch | Real trading fees become credits for real holders. |
| next | Fees settled in a stablecoin, reserve published | Each sweep swaps the fees on chain. The holder half is held apart from the treasury and its balance is published every epoch next to the credits it backs. |
| next | Staking live | Lock tokens for a bigger node multiplier, a place at the front of the queue and, with the operator pledge, trusted status. |
| next | USDC checkout for the market | Buyers top up and sellers withdraw on-chain. Replaces the team-credited prepaid balance used during the beta. |
| next | Node rewards paid out | Accrued node earnings leave the counter and reach the operator wallet on a published cadence. |

## After launch

Once fees and usage are real, the treasury can do more than pay the Macs.

| Status | Item | Detail |
| --- | --- | --- |
| later | More models on the network | Larger open models on 32 GB and 64 GB Macs, and more frontier models in the catalogue as providers qualify for zero data retention. |
| later | Onboarding pack | First-run walkthrough, run-a-node guide with screenshots, launch thread. |
| later | Agent launchpad | Tokens for agents built on the gateway, paired with the Mesh token. Next generation launchpad. |
| later | Mobile node | Whether a phone can serve small models well enough to join the network. |
| later | Windows application | Machines running Windows can contribute towards the network. |

## Internal notes (not for the public page)

- Cloudflare, the signed menu-bar build and the web hardening pass stay on the internal checklist
  (the internal docs repo → Production readiness); Oliver took them off the public list on 6 Oct.
- Points and referrals: built and off; removed from the public list on 6 Oct.
- 8 Oct: four items added and the starter-credit line reworded to match the economics changes in
  `docs/PRICING.md` §2 and §5–7 (markup over the upstream fee, reward ceiling, credit expiry, direct
  sales, stablecoin sweep with a published reserve). The wording has not been through Oliver's
  "Mesh roadmap" doc yet; reconcile it there.
- The agent launchpad wording is Oliver's; the fuller concept (apps not tickers, compute-backed
  tokens, proof of usage) lives in the internal notes until he publishes more.
