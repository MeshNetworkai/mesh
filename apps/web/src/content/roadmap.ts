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
 * Keep the four phases; move items between them rather than adding phases. The founder designs the
 * final content; this is the working list.
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
      { title: 'Starter credits on first connect', detail: 'A small grant per wallet so you can send a request before holding or buying anything.', status: 'done' },
      { title: 'Usage share switched on', detail: 'The second engine is built and audited. It switches on with the pricing decision, which sets the network price above node pay so there is a margin to share.', status: 'now' },
      { title: 'Cloudflare in front of the site', detail: 'DNS and edge protection for the web app and the gateway.', status: 'now' },
      { title: 'Status page and public node explorer', detail: 'Uptime, incidents, and every online node with chip, models and reputation; no wallets.', status: 'now' },
      { title: 'Menu-bar app, signed build', detail: 'Today the DMG is unsigned and opens through "Open Anyway". A signed, notarised build removes the warning.', status: 'now' },
      { title: 'Web app hardening pass', detail: 'Auth races, streaming abort, stale sessions, phone layouts.', status: 'now' },
    ],
  },
  {
    id: 'launch',
    name: 'Launch',
    summary: 'The token launches on Robinhood Chain via Pons on launch day. Everything below waits for that one event.',
    items: [
      { title: 'Token launch on Robinhood Chain (Pons)', detail: 'The team launches the token on Pons with our fee vault as the creator-fee recipient; the token address is pasted into the gateway, the indexer is pointed at it and the first live sweep is confirmed.', status: 'next' },
      { title: 'First live epoch', detail: 'Real trading fees become credits for real holders. The mock fee feed is retired.', status: 'next' },
      { title: 'Staking live', detail: 'Lock tokens for a bigger node multiplier, a place at the front of the queue and, with the operator pledge, trusted status.', status: 'next' },
      { title: 'USDC checkout for the market', detail: 'Buyers top up and sellers withdraw on-chain. Replaces the team-credited prepaid balance used during the beta.', status: 'next' },
      { title: 'Node rewards paid out', detail: 'Accrued node earnings leave the counter and reach the operator wallet on a published cadence.', status: 'next' },
    ],
  },
  {
    id: 'after',
    name: 'After launch',
    summary: 'Once fees and usage are real, the treasury can do more than pay the Macs.',
    items: [
      { title: 'More models on the network', detail: 'Larger open models on 32 GB and 64 GB Macs, and more frontier models in the catalogue as providers qualify for zero data retention.', status: 'later' },
      { title: 'Onboarding pack', detail: 'First-run walkthrough, run-a-node guide with screenshots, launch thread.', status: 'later' },
    ],
  },
  {
    id: 'later',
    name: 'Later',
    summary: 'Ideas with research done and no commitment.',
    items: [
      { title: 'Agent launchpad', detail: 'Tokens for agents built on the gateway, paired with the Mesh token, with creator fees split between stake, credits and the treasury. Due diligence done; not scheduled.', status: 'exploring' },
      { title: 'Mobile node', detail: 'Whether a phone can serve small models well enough to join the network.', status: 'exploring' },
      { title: 'Points and referrals', detail: 'Built and switched off. Comes back only if there is a reason.', status: 'exploring' },
    ],
  },
];
