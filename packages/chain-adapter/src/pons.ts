import { decodeEventLog, zeroAddress, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { EvmAdapter, type EvmAdapterOptions } from './evm.js';
import { NotWiredError, type ReserveReading, type SweepDetail } from './types.js';
import { assertBps, toUnits } from './rpc.js';
import { chainlinkAggregatorAbi, erc20Abi, ponsEscrowAbi, ponsFeeVaultAbi } from './evm/abi.js';

/** Pons v2 protocol addresses on Robinhood Chain mainnet (chainId 4663). Source: docs.ponsfamily.com/docs/v2. */
export const PONS_MAINNET = {
  escrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  launchLocker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
  buybackVault: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
} as const satisfies Record<string, Address>;

export const ETH_ASSET: Address = zeroAddress;

export interface PonsEvmAdapterOptions extends EvmAdapterOptions {
  /** Pons Fee Escrow; fees accrue here for `feeVault` (our PonsFeeVault, the creatorFeeRecipient). */
  ponsEscrow?: Address;
  /** Other Pons contracts — only used to extend the holder exclusion list. */
  ponsFactory?: Address;
  ponsHook?: Address;
  launchLocker?: Address;
  buybackVault?: Address;
  /** Gateway pool wallet: PonsFeeVault sends the holder share here. Excluded from holder balances. */
  creditPool?: Address;
  /** Assets Pons may pay creator fees in. address(0) = native ETH. Default [ETH]. */
  quoteTokens?: Address[];
  /** Stablecoin the vault settles in (USDG / USDC). Needed for `sweepMode: 'swap'`. */
  stable?: Address;
  stableDecimals?: number;
  /**
   * `swap` (default, and what production runs): PonsFeeVault.sweep(asset, minOut) converts the fees to the
   * stablecoin on chain, so the holder share reaches the credit pool in dollars. `raw`: sweepRaw(asset)
   * forwards the asset and values it off-chain; the pool then carries the asset's price risk against
   * credits that are fixed in USD, so it is for rehearsals and chains without a stable route only.
   */
  sweepMode?: 'swap' | 'raw';
  /**
   * Chainlink ETH/USD aggregator. A configured feed is the only price source: when its answer is stale or
   * the read fails, ETH fees are left unswept until it is fresh (no credits are minted against a guess).
   * `fixedEthUsd` is used only when no feed is configured (tests / before a feed exists on the chain).
   */
  priceFeed?: Address;
  fixedEthUsd?: number;
  /**
   * USD prices for non-ETH, non-stable quote tokens (per whole token): the valuation in raw mode, the
   * slippage floor in swap mode. A token without one cannot be swept in raw mode; in swap mode it is
   * swapped without a floor and credited with the stablecoin the swap returns.
   */
  fixedPrices?: Record<string, number>;
  /** Max age of the Chainlink answer before it is considered stale (default 3600 s). */
  priceMaxAgeSec?: number;
}

export interface PonsAssetSweep {
  asset: Address;
  /** Token units of the asset moved out of the vault (ETH: ether). */
  grossIn: number;
  holderOut: number;
  treasuryOut: number;
  /** Units of holderOut/treasuryOut: the stable (swap) or the asset itself (raw). */
  outAsset: Address;
  usd: number;
  mode: 'swap' | 'raw' | 'stable';
  txId?: string;
}

export interface PonsSweepDetail extends SweepDetail {
  assets: PonsAssetSweep[];
  ethUsd: number | null;
  priceSource: 'chainlink' | 'fixed' | 'none';
  warnings: string[];
}

/**
 * EVM adapter for a token launched on Pons (Robinhood Chain).
 *  - fees: read the Pons escrow balance for our PonsFeeVault → `pull()` → `sweep()` / `sweepRaw()` per
 *    asset, valued in USD (stable received, or ETH × price feed)
 *  - balances: the standard Transfer-log indexer from EvmAdapter, excluding the Pons contracts
 *    (escrow, factory, hook, locker, buyback vault) + the curve / pool addresses from `excludeWallets`
 *  - signature verification: EIP-191 (unchanged)
 */
export class PonsEvmAdapter extends EvmAdapter {
  declare readonly opts: PonsEvmAdapterOptions;
  declare lastSweep?: PonsSweepDetail;

  constructor(opts: PonsEvmAdapterOptions = {}) {
    super(opts);
  }

  readonly feeSource = 'pons' as const;

  // ------------------------------------------------------------------ config helpers

  protected escrow(): Address {
    if (!this.opts.ponsEscrow) throw new NotWiredError('PonsEvmAdapter', 'ponsEscrow not configured');
    return this.opts.ponsEscrow;
  }

  quoteAssets(): Address[] {
    const q = this.opts.quoteTokens?.length ? this.opts.quoteTokens : [ETH_ASSET];
    return Array.from(new Set(q.map((a) => a.toLowerCase() as Address)));
  }

  protected override excluded(): Set<string> {
    const s = super.excluded();
    for (const a of [this.opts.ponsEscrow, this.opts.ponsFactory, this.opts.ponsHook, this.opts.launchLocker, this.opts.buybackVault, this.opts.creditPool]) {
      if (a) s.add(a.toLowerCase());
    }
    s.add(ETH_ASSET);
    return s;
  }

  private isStable(asset: Address): boolean {
    return !!this.opts.stable && asset.toLowerCase() === this.opts.stable.toLowerCase();
  }

  private stableDecimals(): number {
    return this.opts.stableDecimals ?? 6;
  }

  // ------------------------------------------------------------------ pricing

  /**
   * ETH/USD from Chainlink when a feed is configured, else `fixedEthUsd`, else null. A configured feed is
   * never replaced by the fixed price: a stale answer or a failed read yields no price (`stale: true` for
   * the former), and `sweep()` then leaves ETH fees where they are instead of minting credits against a
   * number that may be wrong.
   */
  async ethUsd(): Promise<{ price: number | null; source: 'chainlink' | 'fixed' | 'none'; stale?: boolean; warning?: string }> {
    if (this.opts.priceFeed) {
      try {
        const [decimals, round] = await Promise.all([
          this.publicClient.readContract({ address: this.opts.priceFeed, abi: chainlinkAggregatorAbi, functionName: 'decimals' }),
          this.publicClient.readContract({ address: this.opts.priceFeed, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' }),
        ]);
        const [, answer, , updatedAt] = round;
        const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
        const maxAge = this.opts.priceMaxAgeSec ?? 3600;
        if (answer <= 0n) throw new Error('non-positive answer');
        if (age > maxAge) return { price: null, source: 'none', stale: true, warning: `chainlink answer is ${age}s old (max ${maxAge}): ETH fees stay unswept until the feed is fresh` };
        return { price: Number(answer) / 10 ** Number(decimals), source: 'chainlink' };
      } catch (err) {
        return { price: null, source: 'none', warning: `chainlink read failed (${(err as Error).message}): ETH fees stay unswept until the feed answers` };
      }
    }
    if (this.opts.fixedEthUsd) return { price: this.opts.fixedEthUsd, source: 'fixed' };
    return { price: null, source: 'none', warning: 'no priceFeed and no fixedEthUsd: ETH-denominated fees cannot be valued and stay unswept' };
  }

  private async assetDecimals(asset: Address): Promise<number> {
    if (asset === ETH_ASSET) return 18;
    if (this.isStable(asset)) return this.stableDecimals();
    try {
      return await this.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' });
    } catch {
      return 18;
    }
  }

  /** USD per whole unit of `asset` for raw valuation; null when unknown. */
  private assetUsd(asset: Address, ethUsd: number | null): number | null {
    if (asset === ETH_ASSET) return ethUsd;
    if (this.isStable(asset)) return 1;
    const fixed = this.opts.fixedPrices?.[asset.toLowerCase()] ?? this.opts.fixedPrices?.[asset];
    return fixed ?? null;
  }

  // ------------------------------------------------------------------ reads

  /** Per-asset fees waiting in the Pons escrow for our vault plus anything already pulled but not swept. */
  async pendingAssets(): Promise<Array<{ asset: Address; inEscrow: bigint; held: bigint; decimals: number }>> {
    const escrow = this.escrow();
    const vault = this.vault();
    const out: Array<{ asset: Address; inEscrow: bigint; held: bigint; decimals: number }> = [];
    for (const asset of this.quoteAssets()) {
      const inEscrow =
        asset === ETH_ASSET
          ? await this.publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: 'balanceOf', args: [vault] })
          : await this.publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: 'balanceOfToken', args: [vault, asset] });
      const held =
        asset === ETH_ASSET
          ? await this.publicClient.getBalance({ address: vault })
          : await this.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [vault] });
      out.push({ asset, inEscrow, held, decimals: await this.assetDecimals(asset) });
    }
    return out;
  }

  override async pendingFeesUsd(): Promise<number | null> {
    try {
      const pending = await this.pendingAssets();
      const { price } = await this.ethUsd();
      let usd = 0;
      for (const p of pending) {
        const units = toUnits(p.inEscrow + p.held, p.decimals);
        if (units === 0) continue;
        const px = this.assetUsd(p.asset, price);
        if (px === null) return null;
        usd += units * px;
      }
      return Math.round(usd * 1e6) / 1e6;
    } catch {
      return null;
    }
  }

  /**
   * What the credit-pool wallet holds: the settlement stablecoin (the reserve behind outstanding credits)
   * and any ETH sitting next to it (left from a raw sweep, or gas money), valued at the current price.
   */
  async reserve(): Promise<ReserveReading> {
    const pool = this.opts.creditPool;
    if (!pool) throw new NotWiredError('PonsEvmAdapter', 'creditPool not configured');
    const stable = this.opts.stable ?? null;
    const [stableRaw, ethRaw, { price }] = await Promise.all([
      stable ? this.publicClient.readContract({ address: stable, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }) : Promise.resolve(0n),
      this.publicClient.getBalance({ address: pool }),
      this.ethUsd(),
    ]);
    const otherUnits = toUnits(ethRaw, 18);
    return {
      wallet: pool,
      stable,
      stableUsd: toUnits(stableRaw, this.stableDecimals()),
      otherUnits,
      otherUsd: otherUnits === 0 ? 0 : price === null ? null : Math.round(otherUnits * price * 1e6) / 1e6,
    };
  }

  // ------------------------------------------------------------------ sweep

  override async collectFees(): Promise<{ amountUsd: number; txId: string }> {
    const d = await this.sweep();
    this.lastSweep = d;
    return { amountUsd: d.amountUsd, txId: d.txId };
  }

  override async sweep(): Promise<PonsSweepDetail> {
    const vault = this.vault();
    const dryRun = this.opts.dryRun ?? false;
    const mode = this.opts.sweepMode ?? 'swap';
    const slippageBps = assertBps(this.opts.slippageBps ?? 100, 'slippageBps');
    const warnings: string[] = [];
    const unswept: string[] = [];
    const leave = (message: string) => {
      unswept.push(message);
      warnings.push(message);
    };
    const txIds: Hex[] = [];
    const assets: PonsAssetSweep[] = [];
    const pending = await this.pendingAssets();
    const { price: ethUsd, source: priceSource, warning } = await this.ethUsd();
    if (warning) warnings.push(warning);
    const holderBps = this.opts.holderShareBps ?? 5000;

    const total = pending.reduce((n, p) => n + p.inEscrow + p.held, 0n);
    const empty = (): PonsSweepDetail => ({
      amountUsd: 0,
      txId: '',
      feeTokens: 0,
      swappedTokens: 0,
      usdcReceived: 0,
      treasuryTokens: 0,
      priceUsd: ethUsd ?? 0,
      dryRun,
      txIds,
      assets,
      ethUsd,
      priceSource,
      warnings,
      unswept,
    });
    if (total === 0n) return empty();

    // What a missing price means depends on what the price is for. In raw mode it IS the credit (the asset
    // is valued off-chain), so an unpriced asset is not swept at all: it stays in the escrow (or, once
    // pulled, in the vault) and a later epoch picks it up. In swap mode the credit is the stablecoin the
    // swap returns and the price only sets the slippage floor. ETH still waits for its price there (a
    // stale feed comes back, and with it the floor). A quote token that has no price source at all, such
    // as a tokenised stock the launch is paired with, is swapped without a floor rather than never: no
    // credit is minted against a guess either way. The stablecoin itself never needs a price.
    const floorless = (asset: Address) => mode === 'swap' && asset !== ETH_ASSET && this.assetUsd(asset, ethUsd) === null;
    const sweepable = pending.filter((p) => {
      if (p.inEscrow + p.held === 0n) return false;
      if (this.assetUsd(p.asset, ethUsd) !== null) return true;
      if (floorless(p.asset)) {
        warnings.push(`no price source for ${p.asset}: swapped without a slippage floor, credited with the stablecoin the swap returns`);
        return true;
      }
      leave(`no fresh price for ${p.asset}: ${toUnits(p.inEscrow + p.held, p.decimals)} left unswept, no credits minted for it this epoch`);
      return false;
    });
    if (sweepable.length === 0) return empty();

    if (dryRun) {
      for (const p of sweepable) {
        const gross = toUnits(p.inEscrow + p.held, p.decimals);
        // A rehearsal has no swap to read the proceeds from: an asset without a price shows as $0 here.
        const usd = gross * (this.assetUsd(p.asset, ethUsd) ?? 0);
        const holderUsd = (usd * holderBps) / 10_000;
        assets.push({ asset: p.asset, grossIn: gross, holderOut: holderUsd, treasuryOut: usd - holderUsd, outAsset: p.asset, usd, mode: 'raw' });
      }
      return this.finish(assets, 'dry-run', txIds, dryRun, ethUsd, priceSource, warnings, unswept);
    }

    // 1. escrow → vault
    const needsPull = sweepable.some((p) => p.inEscrow > 0n);
    if (needsPull) {
      const r = await this.send({ address: vault, abi: ponsFeeVaultAbi, functionName: 'pull' });
      txIds.push(r.transactionHash);
    }
    // 2. vault → creditPool / treasury, per asset. Each asset stands alone: when one fails (a swap that
    // reverts on its slippage floor, an RPC error) the assets already swept have moved on chain, so the
    // sweep reports them and leaves the failed one in the vault for the next epoch. Failing the whole
    // epoch here would lose the credits for fees that did move.
    for (const p of sweepable) {
      try {
        const heldNow =
          p.asset === ETH_ASSET
            ? await this.publicClient.getBalance({ address: vault })
            : await this.publicClient.readContract({ address: p.asset, abi: erc20Abi, functionName: 'balanceOf', args: [vault] });
        if (heldNow === 0n) continue;
        const gross = toUnits(heldNow, p.decimals);
        const px = this.assetUsd(p.asset, ethUsd);
        if (mode === 'raw') {
          const r = await this.send({ address: vault, abi: ponsFeeVaultAbi, functionName: 'sweepRaw', args: [p.asset] });
          txIds.push(r.transactionHash);
          const ev = this.decodeSwept(r, 'SweptRaw');
          const holderOut = toUnits(ev?.holderOut ?? 0n, p.decimals);
          const treasuryOut = toUnits(ev?.treasuryOut ?? 0n, p.decimals);
          // px is never null here: raw mode only sweeps what it can value (see `sweepable`).
          assets.push({ asset: p.asset, grossIn: gross, holderOut, treasuryOut, outAsset: p.asset, usd: gross * (px ?? 0), mode: 'raw', txId: r.transactionHash });
        } else {
          // minOut in stable units from the off-chain price: the swap reverts rather than settle below it.
          // No floor for the stablecoin (nothing is swapped) or for a quote token without a price source.
          const minOut = this.isStable(p.asset) || px === null ? 0n : BigInt(Math.floor(gross * px * (10_000 - slippageBps) * 10 ** this.stableDecimals())) / 10_000n;
          const r = await this.send({ address: vault, abi: ponsFeeVaultAbi, functionName: 'sweep', args: [p.asset, minOut] });
          txIds.push(r.transactionHash);
          const ev = this.decodeSwept(r, 'Swept');
          const holderOut = toUnits(ev?.holderOut ?? 0n, this.stableDecimals());
          const treasuryOut = toUnits(ev?.treasuryOut ?? 0n, this.stableDecimals());
          assets.push({
            asset: p.asset,
            grossIn: gross,
            holderOut,
            treasuryOut,
            outAsset: this.opts.stable ?? p.asset,
            usd: holderOut + treasuryOut,
            mode: this.isStable(p.asset) ? 'stable' : 'swap',
            txId: r.transactionHash,
          });
        }
      } catch (err) {
        leave(`sweep of ${p.asset} failed (${(err as Error).message ?? String(err)}): left unswept in the vault, no credits minted for it this epoch`);
      }
    }
    return this.finish(assets, txIds[0] ?? '', txIds, dryRun, ethUsd, priceSource, warnings, unswept);
  }

  private finish(assets: PonsAssetSweep[], txId: string, txIds: Hex[], dryRun: boolean, ethUsd: number | null, priceSource: PonsSweepDetail['priceSource'], warnings: string[], unswept: string[]): PonsSweepDetail {
    const amountUsd = Math.round(assets.reduce((n, a) => n + a.usd, 0) * 1e6) / 1e6;
    const eth = assets.find((a) => a.asset === ETH_ASSET);
    const swapped = assets.filter((a) => a.mode === 'swap');
    return {
      amountUsd,
      txId,
      feeTokens: eth?.grossIn ?? 0, // ETH pulled (the "fee token" on Pons is the quote asset)
      swappedTokens: swapped.reduce((n, a) => n + a.grossIn, 0),
      usdcReceived: assets.filter((a) => a.mode !== 'raw').reduce((n, a) => n + a.holderOut + a.treasuryOut, 0),
      treasuryTokens: assets.reduce((n, a) => n + a.treasuryOut, 0),
      priceUsd: ethUsd ?? 0,
      dryRun,
      txIds,
      assets,
      ethUsd,
      priceSource,
      warnings,
      unswept,
    };
  }

  private decodeSwept(r: TransactionReceipt, name: 'Swept' | 'SweptRaw'): { grossIn: bigint; holderOut: bigint; treasuryOut: bigint } | null {
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: ponsFeeVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === name) return ev.args as { grossIn: bigint; holderOut: bigint; treasuryOut: bigint };
      } catch {
        /* other contract's log */
      }
    }
    return null;
  }

  private async send(req: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<TransactionReceipt> {
    const w = this.wallet();
    const hash = await w.writeContract({ ...req, account: w.account, chain: w.chain } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
    return receipt;
  }
}
