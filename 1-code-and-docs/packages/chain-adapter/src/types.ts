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

/**
 * What the credit-pool wallet holds right now (the reserve behind outstanding credits). `stableUsd` is the
 * stablecoin the sweep settles in, at $1; `otherUsd` is anything else found there (ETH left from a raw
 * sweep) valued at the current price, or null when it cannot be priced.
 */
export interface ReserveReading {
  /** The credit-pool wallet that was read. */
  wallet: string;
  /** Address of the settlement stablecoin, or null when none is configured yet. */
  stable: string | null;
  stableUsd: number;
  otherUsd: number | null;
  /** Whole units of the non-stable asset held (ETH), for the report. */
  otherUnits: number;
}

/** Adapters that can read the credit-pool wallet expose it (PonsEvmAdapter); the mock has no reserve to read. */
export interface ChainAdapterReserve {
  reserve(): Promise<ReserveReading>;
}

export function hasReserve(a: ChainAdapter): a is ChainAdapter & ChainAdapterReserve {
  return typeof (a as Partial<ChainAdapterReserve>).reserve === 'function';
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
  /**
   * Fees that were found and left where they are, one message per asset: no fresh price to value them, or
   * the sweep of that asset failed. Nothing was credited for them; a later epoch picks them up. The
   * gateway logs each as `sweep_skipped` (jobs/housekeeping.ts), which raises the failed-sweep alert.
   */
  unswept?: string[];
}
