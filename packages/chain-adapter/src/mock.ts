import type { Chain, ChainAdapter, HolderBalance, StakeInfo } from './types.js';
import { EvmAdapter } from './evm.js';
import { SolanaAdapter } from './solana.js';

export interface MockAdapterOptions {
  chain?: Chain;
  holders?: Record<string, number>;
  /** Unix seconds each holder has held since; defaults to `now` at construction for every holder. */
  holdSince?: Record<string, number>;
  /** When false, `getHolderBalances` omits `holdSinceTs` (simulates an adapter that cannot report age). */
  reportHoldSince?: boolean;
  /** Clock used for hold-since bookkeeping (tests). */
  now?: () => number;
  /** Staking positions; defaults to DEFAULT_MOCK_STAKES unless `holders` is given (then empty). */
  stakes?: Record<string, { staked: number; lockEndsAt?: number; lockDays?: number }>;
  /**
   * Accept `MockAdapter.sign` test signatures in `verifyWalletSignature`. Default true (tests, demos).
   * The gateway passes false in production so the mock treasury never lets anyone sign in as any wallet.
   */
  acceptMockSignatures?: boolean;
}

/** Deterministic default holder set used by dev + tests. */
export const DEFAULT_MOCK_HOLDERS: Record<string, number> = {
  mockwallet_alice: 60_000, // 60% of eligible supply
  mockwallet_bob: 30_000, // 30%
  mockwallet_carol: 10_000, // 10%
  mockwallet_dust: 500, // below minHoldTokens, never eligible
};

/** Holding age (days) of the default holders, so dev mode shows the holding-age multiplier at work. */
export const DEFAULT_MOCK_HOLD_AGE_DAYS: Record<string, number> = {
  mockwallet_alice: 45,
  mockwallet_bob: 10,
  mockwallet_carol: 0,
  mockwallet_dust: 90,
};

/** Staking positions of the default holders: alice is gold (locked), bob silver, carol unstaked. */
export const DEFAULT_MOCK_STAKES: Record<string, { staked: number; lockDays?: number; lockEndsAt?: number }> = {
  mockwallet_alice: { staked: 50_000, lockDays: 30 },
  mockwallet_bob: { staked: 12_000 },
};

/**
 * In-memory adapter. Fees are pushed in with `pushFees()` (POST /admin/fake-fees)
 * and drained by `collectFees()`. Balances are constant over any window, so the
 * time-weighted balance equals the current balance. Each holder carries a
 * `holdSinceTs`; lowering a balance (a transfer out) resets it to `now`.
 */
export class MockAdapter implements ChainAdapter {
  readonly chain: Chain;
  private holders: Map<string, number>;
  private holdSince: Map<string, number>;
  private stakes: Map<string, StakeInfo>;
  private readonly reportHoldSince: boolean;
  private readonly acceptMockSignatures: boolean;
  private readonly clock: () => number;
  private pendingFeesUsd = 0;
  private txCounter = 0;
  public readonly transfers: Array<{ to: string; amount: number; txId: string }> = [];

  constructor(opts: MockAdapterOptions = {}) {
    this.chain = opts.chain ?? 'solana';
    this.clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.reportHoldSince = opts.reportHoldSince ?? true;
    this.acceptMockSignatures = opts.acceptMockSignatures ?? true;
    this.holders = new Map(Object.entries(opts.holders ?? DEFAULT_MOCK_HOLDERS));
    const t = this.clock();
    const defaults = opts.holders ? {} : Object.fromEntries(Object.entries(DEFAULT_MOCK_HOLD_AGE_DAYS).map(([w, d]) => [w, t - d * 86_400]));
    this.holdSince = new Map([...this.holders.keys()].map((w) => [w, opts.holdSince?.[w] ?? defaults[w] ?? t]));
    const stakes = opts.stakes ?? (opts.holders ? {} : DEFAULT_MOCK_STAKES);
    this.stakes = new Map(
      Object.entries(stakes).map(([wallet, s]) => [
        wallet,
        { wallet, staked: s.staked, lockDays: s.lockDays ?? 0, lockEndsAt: s.lockEndsAt ?? (s.lockDays ? t + s.lockDays * 86_400 : 0) },
      ]),
    );
  }

  pushFees(amountUsd: number): number {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amountUsd must be > 0');
    this.pendingFeesUsd += amountUsd;
    return this.pendingFeesUsd;
  }

  pendingFees(): number {
    return this.pendingFeesUsd;
  }

  /**
   * Set a holder's balance. A decrease counts as a transfer out and resets the holding age to
   * now; an increase keeps it; a new holder starts at now (or `holdSinceTs` when given).
   */
  setHolder(wallet: string, balance: number, holdSinceTs?: number): void {
    const prev = this.holders.get(wallet) ?? 0;
    if (balance <= 0) {
      this.holders.delete(wallet);
      this.holdSince.delete(wallet);
      return;
    }
    this.holders.set(wallet, balance);
    if (holdSinceTs !== undefined) this.holdSince.set(wallet, holdSinceTs);
    else if (prev === 0 || balance < prev || !this.holdSince.has(wallet)) this.holdSince.set(wallet, this.clock());
  }

  /** Simulate a transfer out of `amount` tokens: lowers the balance and resets the holding age. */
  transferOut(wallet: string, amount: number): void {
    const prev = this.holders.get(wallet) ?? 0;
    this.setHolder(wallet, prev - amount);
  }

  /** Current hold-since timestamp for a wallet (tests / admin). */
  holdSinceOf(wallet: string): number | undefined {
    return this.holdSince.get(wallet);
  }

  /** Set (or clear with staked 0) a wallet's staking position. */
  setStake(wallet: string, staked: number, opts: { lockDays?: number; lockEndsAt?: number } = {}): void {
    if (staked <= 0) {
      this.stakes.delete(wallet);
      return;
    }
    const lockDays = opts.lockDays ?? 0;
    this.stakes.set(wallet, { wallet, staked, lockDays, lockEndsAt: opts.lockEndsAt ?? (lockDays ? this.clock() + lockDays * 86_400 : 0) });
  }

  async getStakes(wallets: string[]): Promise<StakeInfo[]> {
    return wallets.map((wallet) => this.stakes.get(wallet) ?? { wallet, staked: 0, lockDays: 0, lockEndsAt: 0 });
  }

  async getHolderBalances(_window: { from: number; to: number }): Promise<HolderBalance[]> {
    return [...this.holders.entries()]
      .map(([wallet, timeWeightedBalance]) => {
        const row: HolderBalance = { wallet, timeWeightedBalance };
        if (this.reportHoldSince) {
          const since = this.holdSince.get(wallet);
          if (since !== undefined) row.holdSinceTs = since;
        }
        return row;
      })
      .sort((a, b) => a.wallet.localeCompare(b.wallet));
  }

  async collectFees(): Promise<{ amountUsd: number; txId: string }> {
    const amountUsd = this.pendingFeesUsd;
    this.pendingFeesUsd = 0;
    this.txCounter += 1;
    return { amountUsd, txId: `mock-fee-tx-${this.txCounter}` };
  }

  async transferTokens(to: string, amount: number): Promise<string> {
    this.txCounter += 1;
    const txId = `mock-transfer-tx-${this.txCounter}`;
    this.transfers.push({ to, amount, txId });
    return txId;
  }

  /** Mock signature = base64("<wallet>:<message>"). */
  /**
   * Accepts the mock test signature (`MockAdapter.sign`) AND real wallet signatures, so a gateway running
   * with the mock treasury before the token exists still lets Phantom / MetaMask users sign in. The real
   * verifier is picked by wallet shape: 0x-prefixed → EVM (EIP-191), otherwise Solana (ed25519 over the bytes).
   */
  verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
    if (this.acceptMockSignatures && signature === MockAdapter.sign(wallet, message)) return true;
    try {
      const real = /^0x/i.test(wallet.trim()) ? new EvmAdapter() : new SolanaAdapter();
      return real.verifyWalletSignature(wallet, message, signature);
    } catch {
      return false;
    }
  }

  static sign(wallet: string, message: string): string {
    return Buffer.from(`${wallet}:${message}`, 'utf8').toString('base64');
  }
}
