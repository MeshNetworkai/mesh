import deployRobinhood from '../../../config/deploy.robinhood.json';
import deployRobinhoodTestnet from '../../../config/deploy.robinhood-testnet.json';
import tokenomics from '../../../config/tokenomics.json';

export type Chain = 'solana' | 'evm';

const envChain = String(tokenomics.chain ?? 'solana').toLowerCase();

/** Chain the token lives on, from config/tokenomics.json. Anything not `solana` is treated as EVM. */
export const DEFAULT_CHAIN: Chain = envChain === 'solana' ? 'solana' : 'evm';

/** Which config/deploy.<network>.json the live adapter reads (`robinhood` = Robinhood Chain mainnet via Pons). */
export const DEPLOY_NETWORK: string = String((tokenomics as { deployNetwork?: string }).deployNetwork ?? (DEFAULT_CHAIN === 'solana' ? 'mainnet-beta' : 'base'));

/** Human label for the chain, for copy ("lives on Robinhood Chain"). */
export const CHAIN_LABEL: string =
  DEFAULT_CHAIN === 'solana' ? 'Solana' : DEPLOY_NETWORK.startsWith('robinhood') ? `Robinhood Chain${DEPLOY_NETWORK.endsWith('testnet') ? ' testnet' : ''}` : DEPLOY_NETWORK.startsWith('base') ? 'Base' : 'an EVM chain';

/** Block explorer for the configured network (config/deploy.<network>.json → explorer); Solana uses Solscan. */
export const EXPLORER_URL: string | null =
  DEFAULT_CHAIN === 'solana'
    ? 'https://solscan.io'
    : DEPLOY_NETWORK === 'robinhood-testnet'
      ? String((deployRobinhoodTestnet as { explorer?: string }).explorer ?? '') || null
      : DEPLOY_NETWORK === 'robinhood'
        ? String((deployRobinhood as { explorer?: string }).explorer ?? '') || null
        : null;

/** Explorer page for a wallet, by the chain the session signed in with (null when no explorer is configured). */
export function addressExplorerUrl(wallet: string, chain: string): string | null {
  if (chain === 'solana') return `https://solscan.io/account/${wallet}`;
  return EXPLORER_URL && EXPLORER_URL !== 'https://solscan.io' ? `${EXPLORER_URL}/address/${wallet}` : null;
}

export const TOKENOMICS = {
  name: tokenomics.name,
  ticker: tokenomics.ticker,
  chain: tokenomics.chain,
  tradeFeeBps: tokenomics.tradeFeeBps,
  holderShareBps: tokenomics.holderShareBps,
  treasuryShareBps: tokenomics.treasuryShareBps,
  minHoldTokens: tokenomics.minHoldTokens,
  epochSeconds: tokenomics.epochSeconds,
  geoBlock: tokenomics.geoBlock as string[],
  stakeTiers: tokenomics.stakeTiers as Array<{ name: string; minStake: number; multiplier: number; lockDays?: number }>,
  /** Flat USD per 1M total tokens billed when a Mesh node serves the request ("network credits"). */
  networkPricePerMTokens: Number(tokenomics.requestPricing?.networkPricePerMTokens ?? 0.02),
  showSavings: tokenomics.requestPricing?.showSavings !== false,
  /** USD per 1M total tokens accrued to the node that served a request (the base rate, before any stake multiplier). */
  nodeRewardUsdPerMTokens: Number(tokenomics.nodeRewards?.usdPerMTokens ?? 0.06),
  /** Most a job may pay its node, as a share of what the user was billed (bps). A stake multiplier lifts a reward up to here and no further. */
  nodeRewardMaxShareBps: Number(tokenomics.nodeRewards?.maxShareOfPriceBps ?? 10_000),
  /** Node rewards are paid as AI credits, off chain, once they have been held `holdSeconds` (docs/NODE_PROTOCOL.md §7). */
  nodePayout: {
    enabled: tokenomics.nodeRewards?.payout?.enabled === true,
    holdSeconds: Number(tokenomics.nodeRewards?.payout?.holdSeconds ?? 3600),
    minUsd: Number(tokenomics.nodeRewards?.payout?.minUsd ?? 0.01),
  },
  /** Upstream (frontier/fast) pricing: list plus this markup, or minus this discount, in bps (exactly one is non-zero). */
  upstreamDiscountBps: Number(tokenomics.requestPricing?.upstreamDiscountBps ?? 0),
  upstreamMarkupBps: Number(tokenomics.requestPricing?.upstreamMarkupBps ?? 0),
  /** What the upstream charges Mesh on top of list when it buys inference (bps). The markup covers this before anything is margin. */
  upstreamFeeBps: Number(tokenomics.requestPricing?.upstreamFeeBps ?? 0),
  /** Starter credits (docs/SWITCHING.md): what a wallet gets on its first-ever sign-in while the programme runs. */
  starterCredits: {
    enabled: tokenomics.starterCredits?.enabled === true,
    amountUsd: Number(tokenomics.starterCredits?.amountUsd ?? 0),
    maxWallets: Number(tokenomics.starterCredits?.maxWallets ?? 0),
    /** True: only a wallet holding at least `minHoldTokens` receives it. */
    requireMinHold: tokenomics.starterCredits?.requireMinHold === true,
    /** False: it can be spent on requests but not listed on the marketplace. */
    transferable: tokenomics.starterCredits?.transferable !== false,
  },
  /** Credit expiry (docs/PRICING.md §6): every credit lapses `days` after it landed, oldest spent first. */
  creditExpiry: {
    enabled: tokenomics.creditExpiry?.enabled === true,
    days: Number(tokenomics.creditExpiry?.days ?? 90),
  },
  /** Direct sales (docs/PRICING.md §7): credits bought from Mesh at face value with the prepaid balance. */
  directSales: {
    enabled: tokenomics.directSales?.enabled === true,
    minUsd: Number(tokenomics.directSales?.minUsd ?? 1),
    maxUsd: Number(tokenomics.directSales?.maxUsd ?? 10_000),
  },
  /** Credit reserve (docs/PRICING.md §5): coverage below this is reported as short. */
  reserve: {
    minCoverageBps: Number(tokenomics.reserve?.minCoverageBps ?? 10_000),
  },
  /** Credit marketplace (docs/MARKETPLACE.md). The live values are also on GET /market/config. */
  marketplace: {
    enabled: tokenomics.marketplace?.enabled !== false,
    feeBps: Number(tokenomics.marketplace?.feeBps ?? 250),
    feeToHoldersBps: Number(tokenomics.marketplace?.feeToHoldersBps ?? 5000),
    maxDiscountBps: Number(tokenomics.marketplace?.maxDiscountBps ?? 7000),
    minListingUsd: Number(tokenomics.marketplace?.minListingUsd ?? 1),
    listingTtlHours: Number(tokenomics.marketplace?.listingTtlHours ?? 168),
    /** The stablecoin the marketplace settles in: what buyers deposit and sellers withdraw. Credits stay off chain. */
    settlementSymbol: String(tokenomics.marketplace?.settlementSymbol ?? 'USDC'),
  },
  /** Engine 2 (docs/PRICING.md §3): the holder share of the margin on paid usage. Built; `enabled` is the switch. GET /stats confirms the live state. */
  usageShare: {
    enabled: tokenomics.usageShare?.enabled === true,
    holderBps: Number(tokenomics.usageShare?.holderBps ?? 3000),
    treasuryBps: Number(tokenomics.usageShare?.treasuryBps ?? 7000),
  },
  /** Spot-check verification of node answers (docs/NODE_PROTOCOL.md §10). */
  verification: {
    enabled: tokenomics.verification?.enabled !== false,
    sampleRate: Number(tokenomics.verification?.sampleRate ?? 0.05),
    minJobsBeforeTrust: Number(tokenomics.verification?.minJobsBeforeTrust ?? 20),
    quarantineAfterMismatches: Number(tokenomics.verification?.quarantineAfterMismatches ?? 2),
  },
  /** Privacy tiers (docs/PRIVACY.md): the default tier and the stake tier that, with the pledge, makes an operator trusted. */
  privacy: {
    defaultTier: String(tokenomics.privacy?.default ?? 'trusted'),
    trustedMinStakeTier: String(tokenomics.privacy?.trustedMinStakeTier ?? 'gold'),
  },
  /** Free homepage chat for visitors without a wallet, paid by the treasury. */
  guest: {
    enabled: tokenomics.guest?.enabled !== false,
    messagesPerDay: Number(tokenomics.guest?.messagesPerDay ?? 5),
  },
  /** Public beta state as configured; GET /stats → beta is the live value. */
  beta: {
    enabled: tokenomics.beta?.enabled !== false,
    label: String(tokenomics.beta?.label ?? 'Beta'),
    inviteRequired: tokenomics.beta?.inviteRequired === true,
  },
};

/** "2.5%" from bps, trimmed ("2.5%", "30%", "1.25%"). */
export const pctFromBps = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/**
 * How upstream (frontier and fast) models are priced against the upstream's list, in words: "list plus 6%",
 * "list minus 20%" or "list price". Pass the live values from GET /v1/models or GET /stats when they are in.
 */
export function frontierPriceWords(markupBps = TOKENOMICS.upstreamMarkupBps, discountBps = TOKENOMICS.upstreamDiscountBps): string {
  if (discountBps > 0) return `list minus ${pctFromBps(discountBps)}`;
  if (markupBps > 0) return `list plus ${pctFromBps(markupBps)}`;
  return 'list price';
}

/** The same as a short tag for diagrams and pills: "list + 6%", "list − 20%", "list price". */
export function frontierPriceTag(markupBps = TOKENOMICS.upstreamMarkupBps, discountBps = TOKENOMICS.upstreamDiscountBps): string {
  if (discountBps > 0) return `list − ${pctFromBps(discountBps)}`;
  if (markupBps > 0) return `list + ${pctFromBps(markupBps)}`;
  return 'list price';
}

/** The most a node can earn per 1M tokens whatever its stake: the reward ceiling applied to the network price. */
export const NODE_REWARD_CEILING_PER_M: number = Math.round(TOKENOMICS.networkPricePerMTokens * TOKENOMICS.nodeRewardMaxShareBps) / 10_000;

/** What a node with stake multiplier `m` earns per 1M tokens: the base rate × m, held at the ceiling. */
export function nodeRewardPerM(multiplier = 1): number {
  return Math.min(Math.round(TOKENOMICS.nodeRewardUsdPerMTokens * multiplier * 1e6) / 1e6, NODE_REWARD_CEILING_PER_M);
}

/** Which way the fee sweep settles on the configured network: `swap` (to the stablecoin, on chain) or `raw`. */
export const SWEEP_MODE: string = String(((DEPLOY_NETWORK === 'robinhood-testnet' ? deployRobinhoodTestnet : deployRobinhood) as { sweepMode?: string }).sweepMode ?? 'swap');

export const MOCK = import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true';

/** Gateway base URL. Defaults to the gateway's default port (see apps/gateway/src/env.ts). */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:8787';

/** Public URL shown in docs/snippets (same as API_URL unless overridden). */
export const PUBLIC_API_URL: string = (import.meta.env.VITE_PUBLIC_API_URL as string | undefined) || API_URL;

export const STORAGE = {
  session: 'mesh.session',
  theme: 'mesh.theme',
  chatKey: 'mesh.chat.key',
  chatModel: 'mesh.chat.model',
  /** Privacy tier picked in Chat (docs/PRIVACY.md); defaults to trusted. */
  chatPrivacy: 'mesh.chat.privacy',
  /** Referral code captured from a `?ref=` landing link, claimed from the dashboard once signed in. */
  referralCode: 'mesh.ref',
};
