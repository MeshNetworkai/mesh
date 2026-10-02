import { NotWiredError, hasStaking, type ChainAdapter, type StakeInfo } from '@mesh/chain-adapter';
import type { StakeTier, TokenomicsConfig } from '@mesh/config';

/**
 * Staking tiers, resolved off-chain.
 *
 * The staking contract/program only records positions ({staked, lockDays, lockEndsAt}); the
 * gateway maps them onto `stakeTiers` from config/tokenomics.json and applies the result in two
 * places: node rewards are multiplied by the tier multiplier (routes/v1.ts) and routing candidates
 * are ordered by tier (routing.ts). Positions are read through `ChainAdapter.getStakes` and cached
 * for the current epoch, so a wallet's tier is stable within an epoch and costs one chain read
 * per wallet per epoch.
 */

export interface TierView {
  name: string;
  minStake: number;
  lockDays: number;
  multiplier: number;
}

export interface NextTier extends TierView {
  /** Tokens still to stake to reach it (0 when only the lock is missing). */
  needStake: number;
}

export interface WalletStake {
  wallet: string;
  staked: number;
  /** Lock committed to, days (0 = none). */
  lockDays: number;
  /** Unix seconds the lock ends (0 = not locked). */
  lockEndsAt: number;
  tierIndex: number;
  tier: TierView;
  /** Reward multiplier (tier.multiplier); 1 for the base tier. */
  multiplier: number;
  nextTier: NextTier | null;
  /** Epoch start the position was read in. */
  epoch: number;
  /** False when the adapter has no staking source (not wired / not supported): tier is the base tier. */
  available: boolean;
}

export function tierView(t: StakeTier): TierView {
  return { name: t.name, minStake: t.minStake, lockDays: t.lockDays ?? 0, multiplier: t.multiplier };
}

/** Tiers ascending by minStake (config order is not guaranteed). */
export function sortedTiers(config: Pick<TokenomicsConfig, 'stakeTiers'>): StakeTier[] {
  return [...config.stakeTiers].sort((a, b) => a.minStake - b.minStake);
}

/**
 * Highest tier whose minStake is met AND whose lock (if any) the wallet has committed to —
 * the same rule as MeshStaking.tierOf. Tier 0 always matches.
 */
export function tierForPosition(config: Pick<TokenomicsConfig, 'stakeTiers'>, pos: { staked: number; lockDays?: number }): { index: number; tier: StakeTier } {
  const tiers = sortedTiers(config);
  let index = 0;
  tiers.forEach((t, i) => {
    if (pos.staked >= t.minStake && (pos.lockDays ?? 0) >= (t.lockDays ?? 0)) index = i;
  });
  return { index, tier: tiers[index] };
}

export function nextTierFor(config: Pick<TokenomicsConfig, 'stakeTiers'>, pos: { staked: number; lockDays?: number }, index: number): NextTier | null {
  const tiers = sortedTiers(config);
  const next = tiers[index + 1];
  if (!next) return null;
  return { ...tierView(next), needStake: Math.max(0, next.minStake - pos.staked) };
}

export const BASE_POSITION = { staked: 0, lockDays: 0, lockEndsAt: 0 };

export interface StakeResolverDeps {
  adapter: ChainAdapter;
  config: Pick<TokenomicsConfig, 'stakeTiers' | 'epochSeconds'>;
  now?: () => number;
  log?: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void };
}

export class StakeResolver {
  private readonly cache = new Map<string, WalletStake>();
  private readonly inflight = new Map<string, Promise<WalletStake>>();
  private readonly now: () => number;
  /** Set once the adapter said it is not wired for staking; cleared on a successful read. */
  private notWired = false;
  private notWiredLogged = false;

  constructor(private readonly deps: StakeResolverDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Whether positions can be read at all (adapter implements getStakes and is wired). */
  get available(): boolean {
    return hasStaking(this.deps.adapter) && !this.notWired;
  }

  epochStart(now = this.now()): number {
    const E = this.deps.config.epochSeconds;
    return Math.floor(now / E) * E;
  }

  tiers(): TierView[] {
    return sortedTiers(this.deps.config).map(tierView);
  }

  private build(wallet: string, info: Pick<StakeInfo, 'staked' | 'lockDays' | 'lockEndsAt'>, available: boolean): WalletStake {
    const pos = { staked: info.staked, lockDays: info.lockDays ?? 0 };
    const { index, tier } = tierForPosition(this.deps.config, pos);
    return {
      wallet,
      staked: info.staked,
      lockDays: pos.lockDays,
      lockEndsAt: info.lockEndsAt ?? 0,
      tierIndex: index,
      tier: tierView(tier),
      multiplier: tier.multiplier,
      nextTier: nextTierFor(this.deps.config, pos, index),
      epoch: this.epochStart(),
      available,
    };
  }

  /** Base-tier view for a wallet with no readable position. */
  baseFor(wallet: string, available = this.available): WalletStake {
    return this.build(wallet, BASE_POSITION, available);
  }

  /** Cached value when it belongs to the current epoch. */
  cached(wallet: string): WalletStake | null {
    const c = this.cache.get(wallet);
    return c && c.epoch === this.epochStart() ? c : null;
  }

  /**
   * Synchronous read for hot paths (routing). Returns the current-epoch cache entry, else the
   * base tier while a refresh is kicked off in the background.
   */
  peek(wallet: string): WalletStake {
    const c = this.cached(wallet);
    if (c) return c;
    if (this.available) void this.resolve(wallet).catch(() => undefined);
    return this.baseFor(wallet);
  }

  /** Multiplier for a wallet from the cache (1 when unknown). */
  multiplierOf(wallet: string): number {
    return this.cached(wallet)?.multiplier ?? 1;
  }

  async resolve(wallet: string): Promise<WalletStake> {
    const c = this.cached(wallet);
    if (c) return c;
    const pending = this.inflight.get(wallet);
    if (pending) return pending;
    const p = this.fetch(wallet).finally(() => this.inflight.delete(wallet));
    this.inflight.set(wallet, p);
    return p;
  }

  async resolveMany(wallets: string[]): Promise<Map<string, WalletStake>> {
    const out = new Map<string, WalletStake>();
    const missing = [...new Set(wallets)].filter((w) => {
      const c = this.cached(w);
      if (c) out.set(w, c);
      return !c;
    });
    if (missing.length === 0) return out;
    if (!hasStaking(this.deps.adapter)) {
      for (const w of missing) out.set(w, this.baseFor(w, false));
      return out;
    }
    try {
      const infos = await this.deps.adapter.getStakes(missing);
      this.notWired = false;
      for (const info of infos) {
        const v = this.build(info.wallet, info, true);
        this.cache.set(info.wallet, v);
        out.set(info.wallet, v);
      }
      for (const w of missing) if (!out.has(w)) out.set(w, this.baseFor(w, true));
    } catch (err) {
      if (err instanceof NotWiredError) {
        this.notWired = true;
        if (!this.notWiredLogged) {
          this.notWiredLogged = true;
          this.deps.log?.info({ err: err.message }, 'staking not wired: every wallet is on the base tier');
        }
      } else {
        this.deps.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'getStakes failed; using base tier this epoch');
      }
      // Cache the fallback too, so a hot path does not hammer a failing RPC within the epoch.
      for (const w of missing) {
        const v = this.baseFor(w, false);
        this.cache.set(w, v);
        out.set(w, v);
      }
    }
    return out;
  }

  private async fetch(wallet: string): Promise<WalletStake> {
    const m = await this.resolveMany([wallet]);
    return m.get(wallet) ?? this.baseFor(wallet);
  }

  /** Drop every cached position (tests / admin after a tier change). */
  clear(): void {
    this.cache.clear();
  }
}

/** Apply a tier multiplier to a micro-USD reward (rounded to whole micros). */
export function applyMultiplier(usdMicros: number, multiplier: number): number {
  return Math.round(usdMicros * multiplier);
}
