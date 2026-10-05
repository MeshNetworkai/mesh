import { decodeEventLog, zeroAddress, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { EvmAdapter, type EvmAdapterOptions } from './evm.js';
import { NotWiredError, type SweepDetail } from './types.js';
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
  /** `swap` (default): PonsFeeVault.sweep(asset, minOut) via its route. `raw`: sweepRaw(asset), valued off-chain. */
  sweepMode?: 'swap' | 'raw';
  /** Chainlink ETH/USD aggregator. When absent `fixedEthUsd` is used (tests / before a feed exists on the chain). */
  priceFeed?: Address;
  fixedEthUsd?: number;
  /** USD prices for non-ETH, non-stable quote tokens in raw mode (token units). */
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

  /** ETH/USD from Chainlink when configured, else `fixedEthUsd`, else null. */
  async ethUsd(): Promise<{ price: number | null; source: 'chainlink' | 'fixed' | 'none'; warning?: string }> {
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
        const price = Number(answer) / 10 ** Number(decimals);
        if (age > maxAge) {
          if (this.opts.fixedEthUsd) return { price: this.opts.fixedEthUsd, source: 'fixed', warning: `chainlink answer is ${age}s old; used fixedEthUsd` };
          return { price, source: 'chainlink', warning: `chainlink answer is ${age}s old (max ${maxAge})` };
        }
        return { price, source: 'chainlink' };
      } catch (err) {
        if (this.opts.fixedEthUsd) return { price: this.opts.fixedEthUsd, source: 'fixed', warning: `chainlink read failed (${(err as Error).message}); used fixedEthUsd` };
        return { price: null, source: 'none', warning: `chainlink read failed: ${(err as Error).message}` };
      }
    }
    if (this.opts.fixedEthUsd) return { price: this.opts.fixedEthUsd, source: 'fixed' };
    return { price: null, source: 'none', warning: 'no priceFeed and no fixedEthUsd: ETH-denominated fees cannot be valued' };
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
    });
    if (total === 0n) return empty();

    if (dryRun) {
      for (const p of pending) {
        const gross = toUnits(p.inEscrow + p.held, p.decimals);
        if (gross === 0) continue;
        const px = this.assetUsd(p.asset, ethUsd);
        if (px === null) warnings.push(`no price for ${p.asset}; valued at 0`);
        const usd = gross * (px ?? 0);
        const holderUsd = (usd * holderBps) / 10_000;
        assets.push({ asset: p.asset, grossIn: gross, holderOut: holderUsd, treasuryOut: usd - holderUsd, outAsset: p.asset, usd, mode: 'raw' });
      }
      return this.finish(assets, 'dry-run', txIds, dryRun, ethUsd, priceSource, warnings);
    }

    // 1. escrow → vault
    const needsPull = pending.some((p) => p.inEscrow > 0n);
    if (needsPull) {
      const r = await this.send({ address: vault, abi: ponsFeeVaultAbi, functionName: 'pull' });
      txIds.push(r.transactionHash);
    }
    // 2. vault → creditPool / treasury, per asset
    for (const p of pending) {
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
        if (px === null) warnings.push(`no price for ${p.asset}; raw sweep valued at 0`);
        assets.push({ asset: p.asset, grossIn: gross, holderOut, treasuryOut, outAsset: p.asset, usd: gross * (px ?? 0), mode: 'raw', txId: r.transactionHash });
      } else {
        // minOut in stable units from the off-chain price (0 when unknown: the route's price is accepted)
        const expectedUsd = px === null ? 0 : gross * px;
        const minOut = this.isStable(p.asset) ? 0n : BigInt(Math.floor(expectedUsd * (10_000 - slippageBps) * 10 ** this.stableDecimals())) / 10_000n;
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
    }
    return this.finish(assets, txIds[0] ?? '', txIds, dryRun, ethUsd, priceSource, warnings);
  }

  private finish(assets: PonsAssetSweep[], txId: string, txIds: Hex[], dryRun: boolean, ethUsd: number | null, priceSource: PonsSweepDetail['priceSource'], warnings: string[]): PonsSweepDetail {
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
