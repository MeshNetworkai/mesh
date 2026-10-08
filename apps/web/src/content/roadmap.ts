/**
 * Roadmap rendered at the end of /docs (pages/Docs.tsx → "Roadmap") and mirrored in docs/ROADMAP.md.
 *
 * Editing rules: plain strings, no dates, no numbers that live in config/tokenomics.json. One item per
 * line of the checklist (the internal docs repo). `status` is the only thing that changes as work lands:
 *   done       shipped and live
 *   now        in the open beta, being finished or switched on
 *   next       after the token launches
 *   later      on the list, not scheduled
 *   exploring  researched, not committed
 * Keep the three phases; move items between them rather than adding phases. Content is Oliver's; the
 * working copy is the "Mesh roadmap" doc, mirrored here when he says a version is final.
 */

export type RoadmapStatus = 'done' | 'now' | 'next' | 'later' | 'exploring';

export interface RoadmapItem {
  title: string;
  detail: string;
  status: RoadmapStatus;
}

export interface RoadmapPhase {
  id: string;
  name: string;
  summary: string;
  items: RoadmapItem[];
}

export const STATUS_LABEL: Record<RoadmapStatus, string> = {
  done: 'Done',
  now: 'Now',
  next: 'Next',
  later: 'Later',
  exploring: 'Exploring',
};

export const ROADMAP: RoadmapPhase[] = [
  {
    id: 'now',
    name: 'Now (beta)',
    summary: 'The open beta is live: hourly credits from a mock fee feed, the gateway, the Mac network, the marketplace and the catalogue. What is left before launch.',
    items: [
      { title: 'OpenAI-compatible gateway with hourly credits', detail: 'Keys, chat, streaming, spend limits, ledger, public epoch history.', status: 'done' },
      { title: 'Mac node network', detail: 'Link a Mac with a code, one-line installer, Homebrew tap, menu-bar app, pay per million tokens, spot-check verification.', status: 'done' },
      { title: 'Credit marketplace', detail: 'Sell unused credit at a discount, buy below face value, escrow, partial fills, public book.', status: 'done' },
      { title: 'Frontier catalogue', detail: 'Claude, GPT, Gemini, Grok, DeepSeek and more through zero-data-retention providers, Mesh price shown next to list.', status: 'done' },
      { title: 'Privacy tiers', detail: 'Trusted, network or upstream per request or per key; nodes never see who asked.', status: 'done' },
      { title: 'Starter credits on first connect', detail: 'A small grant for a wallet that holds the token, to spend on requests straight away. It cannot be sold.', status: 'done' },
      { title: 'Usage share switched on', detail: 'The second engine: the network price sits above node pay and a share of the margin joins the hourly pool.', status: 'done' },
      { title: 'Every request covers its cost', detail: 'Frontier models are billed list plus a markup that covers what the upstream charges, and a staked node is held below the price the user pays.', status: 'done' },
      { title: 'Credits that expire', detail: 'A credit lapses a fixed time after it lands, oldest spent first, so unused credit does not pile up. The dashboard shows what lapses next.', status: 'done' },
      { title: 'Buy credits at face value', detail: 'Anyone can buy credits from Mesh with a prepaid balance: no token and no seller needed.', status: 'done' },
      { title: 'Node rewards paid in credits', detail: 'What a Mac earns lands in its owner’s credit balance every hour, off chain. Spend the credits or sell them on the marketplace.', status: 'done' },
      { title: 'Status page and public node explorer', detail: 'Uptime, incidents, and every online node with chip, models and reputation; no wallets.', status: 'done' },
    ],
  },
  {
    id: 'launch',
    name: 'Launch',
    summary: 'The token launches on Robinhood Chain via Pons on launch day. Everything below waits for that one event.',
    items: [
      { title: 'Token launch on Robinhood Chain (Pons)', detail: 'The team launches the token on Pons.', status: 'next' },
      { title: 'First live epoch', detail: 'Real trading fees become credits for real holders.', status: 'next' },
      { title: 'Fees settled in a stablecoin, reserve published', detail: 'Each sweep swaps the fees on chain. The holder half is held apart from the treasury and its balance is published every epoch next to the credits it backs.', status: 'next' },
      { title: 'Staking live', detail: 'Lock tokens for a bigger node multiplier, a place at the front of the queue and, with the operator pledge, trusted status.', status: 'next' },
      { title: 'USDG checkout for the market', detail: 'Buyers top up and sellers withdraw in USDG on chain. Replaces the team-credited prepaid balance used during the beta. Credits themselves stay off chain.', status: 'next' },
    ],
  },
  {
    id: 'after',
    name: 'After launch',
    summary: 'Once fees and usage are real, the treasury can do more than pay the Macs.',
    items: [
      { title: 'More models on the network', detail: 'Larger open models on 32 GB and 64 GB Macs, and more frontier models in the catalogue as providers qualify for zero data retention.', status: 'later' },
      { title: 'Onboarding pack', detail: 'First-run walkthrough, run-a-node guide with screenshots, launch thread.', status: 'later' },
      { title: 'Agent launchpad', detail: 'Tokens for agents built on the gateway, paired with the Mesh token. Next generation launchpad.', status: 'later' },
      { title: 'Mobile node', detail: 'Whether a phone can serve small models well enough to join the network.', status: 'later' },
      { title: 'Windows application', detail: 'Machines running Windows can contribute towards the network.', status: 'later' },
    ],
  },
];
