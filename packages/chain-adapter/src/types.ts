export type Chain = 'solana' | 'evm';

export interface HolderBalance {
  wallet: string;
  /** Average token balance over the window (token units, not raw lamports/wei). */
  timeWeightedBalance: number;
  /**
   * Unix seconds since which the wallet has held continuously (its holding age starts here).
   * A transfer OUT resets it to the time of that transfer (adapter responsibility). Adapters that
   * cannot compute it cheaply leave it undefined; the gateway then falls back to its own
   * first-seen cache (`holder_age` table) and, failing that, a multiplier of 1.
   */
  holdSinceTs?: number;
}

/** A wallet's staking position as the staking contract / program reports it. */
export interface StakeInfo {
  wallet: string;
  /** Tokens staked (token units, not raw wei/lamports). 0 when the wallet has no position. */
  staked: number;
  /** Unix seconds the lock ends; 0 / undefined when nothing is locked. */
  lockEndsAt?: number;
  /** Lock the wallet committed to, in days (locked tiers require it). */
  lockDays?: number;
}

export interface ChainAdapter {
  chain: Chain;
  /** Time-weighted holder balances over [from, to] (unix seconds). */
  getHolderBalances(atOrBetween: { from: number; to: number }): Promise<HolderBalance[]>;
  /** Sweep accrued trading fees into the treasury; returns USD value and tx id. */
  collectFees(): Promise<{ amountUsd: number; txId: string }>;
  transferTokens(to: string, amount: number): Promise<string>;
  verifyWalletSignature(wallet: string, message: string, signature: string): boolean;
  /**
   * Staking positions for `wallets` (same order; a wallet without a position comes back with
   * staked 0). Optional: adapters without a staking contract leave it undefined, and a live
   * adapter whose deploy json has no `staking` address throws NotWiredError.
   */
  getStakes?(wallets: string[]): Promise<StakeInfo[]>;
}

export function hasStaking(a: ChainAdapter): a is ChainAdapter & Required<Pick<ChainAdapter, 'getStakes'>> {
  return typeof a.getStakes === 'function';
}

/**
 * Thrown by a live adapter whose network methods are called before it has the configuration
 * they need (deploy json / env). The adapter object itself always works for signature checks.
 */
export class NotWiredError extends Error {
  constructor(adapter: string, what: string) {
    super(`${adapter} is not yet wired to a network: ${what}`);
    this.name = 'NotWiredError';
  }
}

/** Optional extras a live adapter may expose on top of ChainAdapter (checked with `in`). */
export interface ChainAdapterExtras {
  /** Fees accrued since the last sweep, in USD (null when it cannot be priced cheaply). */
  pendingFeesUsd(): Promise<number | null>;
  /** Treasury token balance in token units. */
  treasuryBalance(): Promise<number>;
}

export function hasExtras(a: ChainAdapter): a is ChainAdapter & ChainAdapterExtras {
  return typeof (a as Partial<ChainAdapterExtras>).pendingFeesUsd === 'function';
}

/** Result of a sweep with the breakdown live adapters can report (superset of collectFees()). */
export interface SweepDetail {
  amountUsd: number;
  txId: string;
  /** Tokens pulled from the fee vault / withheld accounts, token units. */
  feeTokens: number;
  /** Tokens swapped for the holder pool and the USDC received. */
  swappedTokens: number;
  usdcReceived: number;
  /** Tokens forwarded to the treasury (kept in the native token). */
  treasuryTokens: number;
  /** Realized price used to value the whole sweep (USDC per token). */
  priceUsd: number;
  dryRun: boolean;
  txIds: string[];
}
