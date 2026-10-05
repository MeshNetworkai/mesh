import tokenomics from '../../../config/tokenomics.json';

export type Chain = 'solana' | 'evm';

const envChain = String(tokenomics.chain ?? 'solana').toLowerCase();

/** Chain the token lives on, from config/tokenomics.json. Anything not `solana` is treated as EVM. */
export const DEFAULT_CHAIN: Chain = envChain === 'solana' ? 'solana' : 'evm';

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
  /** USD per 1M total tokens accrued to the node that served a request (paid from the treasury share). */
  nodeRewardUsdPerMTokens: Number(tokenomics.nodeRewards?.usdPerMTokens ?? 0.06),
  /** Upstream (frontier/fast) pricing: list minus this discount, or plus this markup, in bps (exactly one is non-zero). */
  upstreamDiscountBps: Number(tokenomics.requestPricing?.upstreamDiscountBps ?? 0),
  upstreamMarkupBps: Number(tokenomics.requestPricing?.upstreamMarkupBps ?? 0),
  /** Starter credits on first connect (docs/SWITCHING.md): what a wallet gets on its first-ever sign-in while the programme runs. */
  starterCredits: {
    enabled: tokenomics.starterCredits?.enabled === true,
    amountUsd: Number(tokenomics.starterCredits?.amountUsd ?? 0),
    maxWallets: Number(tokenomics.starterCredits?.maxWallets ?? 0),
  },
  /** Credit marketplace (docs/MARKETPLACE.md). The live values are also on GET /market/config. */
  marketplace: {
    enabled: tokenomics.marketplace?.enabled !== false,
    feeBps: Number(tokenomics.marketplace?.feeBps ?? 250),
    feeToHoldersBps: Number(tokenomics.marketplace?.feeToHoldersBps ?? 5000),
    maxDiscountBps: Number(tokenomics.marketplace?.maxDiscountBps ?? 7000),
    minListingUsd: Number(tokenomics.marketplace?.minListingUsd ?? 1),
    listingTtlHours: Number(tokenomics.marketplace?.listingTtlHours ?? 168),
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
