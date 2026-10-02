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
};

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
  /** Referral code captured from a `?ref=` landing link, claimed from the dashboard once signed in. */
  referralCode: 'mesh.ref',
};
