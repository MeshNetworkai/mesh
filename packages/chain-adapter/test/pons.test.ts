import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient } from 'viem';
import { ETH_ASSET, PONS_MAINNET, PonsEvmAdapter } from '../src/pons.js';
import { applyEvmOverrides, createAdapter, evmConfigReady, parseDeployConfig, type EvmDeployConfig } from '../src/index.js';
import { EvmAdapter } from '../src/evm.js';
import { ZERO } from '../src/evm/holders.js';

const TOKEN = '0x1000000000000000000000000000000000000001' as Address;
const VAULT = '0x2000000000000000000000000000000000000002' as Address;
const TREASURY = '0x3000000000000000000000000000000000000003' as Address;
const POOL = '0x4000000000000000000000000000000000000004' as Address;
const CREDIT_POOL = '0x7000000000000000000000000000000000000007' as Address;
const USDG = '0x8000000000000000000000000000000000000008' as Address;
const FEED = '0x9000000000000000000000000000000000000009' as Address;
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const E18 = 10n ** 18n;
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** Minimal fake chain: escrow balances per asset, vault balances, a Chainlink feed, Transfer logs. */
function fakeChain(p: { escrowEth?: bigint; escrowUsdg?: bigint; vaultEth?: bigint; vaultUsdg?: bigint; poolEth?: bigint; poolUsdg?: bigint; feedAnswer?: bigint; feedAgeSec?: number; logs?: Array<{ block: bigint; from: Address; to: Address; value: bigint }> } = {}) {
  const calls: string[] = [];
  const T0 = 1_700_000_000;
  const client = {
    async getBlockNumber() {
      return 100n;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { number: blockNumber, timestamp: BigInt(T0 + Number(blockNumber) * 2) };
    },
    async getBalance({ address }: { address: Address }) {
      calls.push(`getBalance:${address}`);
      return address === VAULT ? (p.vaultEth ?? 0n) : address === CREDIT_POOL ? (p.poolEth ?? 0n) : 0n;
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      return (p.logs ?? []).filter((l) => l.block >= fromBlock && l.block <= toBlock).map((l, i) => ({ blockNumber: l.block, logIndex: i, args: l }));
    },
    async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) {
      calls.push(`read:${functionName}@${address}`);
      if (functionName === 'decimals') return address === FEED ? 8 : address === USDG ? 6 : 18;
      if (functionName === 'balanceOf' && address === PONS_MAINNET.escrow) return p.escrowEth ?? 0n;
      if (functionName === 'balanceOfToken' && address === PONS_MAINNET.escrow) return (args?.[1] as string).toLowerCase() === USDG.toLowerCase() ? (p.escrowUsdg ?? 0n) : 0n;
      if (functionName === 'balanceOf' && address === USDG) return (args?.[0] as string) === VAULT ? (p.vaultUsdg ?? 0n) : (args?.[0] as string) === CREDIT_POOL ? (p.poolUsdg ?? 0n) : 0n;
      if (functionName === 'balanceOf') return 0n;
      if (functionName === 'latestRoundData') {
        if (p.feedAnswer === undefined) throw new Error('feed down');
        const updatedAt = BigInt(Math.floor(Date.now() / 1000) - (p.feedAgeSec ?? 10));
        return [1n, p.feedAnswer, updatedAt, updatedAt, 1n];
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

function adapter(client: PublicClient, extra: Partial<ConstructorParameters<typeof PonsEvmAdapter>[0]> = {}) {
  return new PonsEvmAdapter({
    publicClient: client,
    chainId: 4663,
    tokenAddress: TOKEN,
    feeVault: VAULT,
    treasury: TREASURY,
    creditPool: CREDIT_POOL,
    ponsEscrow: PONS_MAINNET.escrow,
    ponsFactory: PONS_MAINNET.factory,
    ponsHook: PONS_MAINNET.hook,
    launchLocker: PONS_MAINNET.launchLocker,
    buybackVault: PONS_MAINNET.buybackVault,
    excludeWallets: [POOL],
    deployBlock: 10,
    decimals: 18,
    holderShareBps: 5000,
    account,
    dryRun: true,
    ...extra,
  });
}

describe('PonsEvmAdapter pricing', () => {
  it('uses the Chainlink feed when configured', async () => {
    const a = adapter(fakeChain({ feedAnswer: 3_000_00000000n }).client, { priceFeed: FEED });
    expect(await a.ethUsd()).toEqual({ price: 3000, source: 'chainlink' });
  });

  it('a configured feed that is down or stale yields no price, even with fixedEthUsd set', async () => {
    const down = adapter(fakeChain({}).client, { priceFeed: FEED, fixedEthUsd: 2500 });
    const r = await down.ethUsd();
    expect(r.price).toBeNull();
    expect(r.source).toBe('none');
    expect(r.warning).toMatch(/chainlink read failed/);
    const stale = adapter(fakeChain({ feedAnswer: 3_000_00000000n, feedAgeSec: 7200 }).client, { priceFeed: FEED, fixedEthUsd: 2500 });
    const s = await stale.ethUsd();
    expect(s).toMatchObject({ price: null, source: 'none', stale: true });
    expect(s.warning).toMatch(/old/);
    // the stale answer itself is not used either
    const staleNoFixed = adapter(fakeChain({ feedAnswer: 3_000_00000000n, feedAgeSec: 7200 }).client, { priceFeed: FEED });
    expect((await staleNoFixed.ethUsd()).price).toBeNull();
  });

  it('uses fixedEthUsd only when no feed is configured', async () => {
    expect(await adapter(fakeChain({}).client, { fixedEthUsd: 2500 }).ethUsd()).toEqual({ price: 2500, source: 'fixed' });
  });

  it('reports no price without feed or fixed', async () => {
    const r = await adapter(fakeChain({}).client).ethUsd();
    expect(r.price).toBeNull();
    expect(r.source).toBe('none');
  });
});

describe('PonsEvmAdapter.collectFees (dry run)', () => {
  it('values ETH in escrow + ETH already pulled with the fixed price', async () => {
    const { client } = fakeChain({ escrowEth: 1n * E18, vaultEth: E18 / 2n });
    const a = adapter(client, { fixedEthUsd: 2000 });
    expect(await a.pendingFeesUsd()).toBe(3000);
    const r = await a.collectFees();
    expect(r).toEqual({ amountUsd: 3000, txId: 'dry-run' });
    const d = a.lastSweep!;
    expect(d.assets).toHaveLength(1);
    expect(d.assets[0]).toMatchObject({ asset: ETH_ASSET, grossIn: 1.5, holderOut: 1500, treasuryOut: 1500, usd: 3000, mode: 'raw' });
    expect(d.priceSource).toBe('fixed');
    expect(d.ethUsd).toBe(2000);
  });

  it('values a stable quote token 1:1 and ETH by price', async () => {
    const { client } = fakeChain({ escrowEth: E18, escrowUsdg: 250_000_000n });
    const a = adapter(client, { fixedEthUsd: 1000, quoteTokens: [ETH_ASSET, USDG], stable: USDG, stableDecimals: 6 });
    expect(await a.pendingFeesUsd()).toBe(1250);
    const r = await a.collectFees();
    expect(r.amountUsd).toBe(1250);
    expect(a.lastSweep!.assets.map((x) => x.usd)).toEqual([1000, 250]);
  });

  it('returns 0 when nothing is pending and leaves ETH unswept when it cannot be priced', async () => {
    expect(await adapter(fakeChain({}).client).collectFees()).toEqual({ amountUsd: 0, txId: '' });
    const a = adapter(fakeChain({ escrowEth: E18 }).client);
    expect(await a.pendingFeesUsd()).toBeNull();
    const r = await a.collectFees();
    expect(r).toEqual({ amountUsd: 0, txId: '' });
    expect(a.lastSweep!.assets).toHaveLength(0);
    expect(a.lastSweep!.warnings.join(' ')).toMatch(/no priceFeed and no fixedEthUsd/);
    expect(a.lastSweep!.warnings.join(' ')).toMatch(/left unswept, no credits minted/);
  });

  it('a stale feed skips the ETH but still sweeps the stablecoin', async () => {
    const { client } = fakeChain({ escrowEth: E18, escrowUsdg: 250_000_000n, feedAnswer: 3_000_00000000n, feedAgeSec: 7200 });
    const a = adapter(client, { priceFeed: FEED, fixedEthUsd: 2500, quoteTokens: [ETH_ASSET, USDG], stable: USDG, stableDecimals: 6 });
    const r = await a.collectFees();
    expect(r.amountUsd).toBe(250);
    expect(a.lastSweep!.assets.map((x) => x.asset)).toEqual([USDG.toLowerCase()]);
    expect(a.lastSweep!.warnings.join(' ')).toMatch(/left unswept/);
    // the same fees are valued and swept once the feed is fresh again
    const fresh = adapter(fakeChain({ escrowEth: E18, escrowUsdg: 250_000_000n, feedAnswer: 3_000_00000000n }).client, { priceFeed: FEED, quoteTokens: [ETH_ASSET, USDG], stable: USDG, stableDecimals: 6 });
    expect((await fresh.collectFees()).amountUsd).toBe(3250);
  });

  it('reads the credit-pool wallet: the stablecoin is the reserve, ETH next to it is reported apart', async () => {
    const { client } = fakeChain({ poolUsdg: 1_234_500_000n, poolEth: E18 / 4n });
    const a = adapter(client, { stable: USDG, stableDecimals: 6, fixedEthUsd: 2000 });
    expect(await a.reserve()).toEqual({ wallet: CREDIT_POOL, stable: USDG, stableUsd: 1234.5, otherUnits: 0.25, otherUsd: 500 });
    // no price for the ETH: it is reported as unpriced, the stablecoin still counts
    const unpriced = await adapter(client, { stable: USDG, stableDecimals: 6 }).reserve();
    expect(unpriced).toMatchObject({ stableUsd: 1234.5, otherUnits: 0.25, otherUsd: null });
    await expect(adapter(client, { creditPool: undefined }).reserve()).rejects.toThrow(/creditPool not configured/);
  });

  it('throws a configuration error without the escrow address', async () => {
    const a = adapter(fakeChain({}).client, { ponsEscrow: undefined });
    await expect(a.collectFees()).rejects.toThrow(/ponsEscrow not configured/);
  });
});

describe('PonsEvmAdapter.getHolderBalances', () => {
  it('excludes the Pons contracts, the credit pool and the configured curve/pool', async () => {
    const logs = [
      { block: 10n, from: ZERO as Address, to: PONS_MAINNET.factory as Address, value: 1_000_000n * E18 },
      { block: 11n, from: PONS_MAINNET.factory as Address, to: POOL, value: 900_000n * E18 }, // bonding curve
      { block: 12n, from: POOL, to: ALICE, value: 1_000n * E18 },
      { block: 13n, from: POOL, to: CREDIT_POOL, value: 10n * E18 },
      { block: 14n, from: POOL, to: PONS_MAINNET.launchLocker as Address, value: 500n * E18 },
      { block: 15n, from: POOL, to: PONS_MAINNET.buybackVault as Address, value: 500n * E18 },
    ];
    const { client } = fakeChain({ logs });
    const r = await adapter(client, { logChunkBlocks: 1000 }).getHolderBalances({ from: 1_700_000_000 + 40, to: 1_700_000_000 + 200 });
    expect(r.map((h) => h.wallet)).toEqual([ALICE]);
    expect(r[0].timeWeightedBalance).toBeCloseTo(1000, 6);
  });
});

describe('deploy config: pons fields', () => {
  const template = {
    chain: 'evm',
    network: 'robinhood',
    chainId: 4663,
    feeSource: 'pons',
    token: null,
    feeVault: null,
    treasury: TREASURY,
    creditPool: CREDIT_POOL,
    ponsEscrow: PONS_MAINNET.escrow,
    quoteTokens: ['0x0000000000000000000000000000000000000000'],
    stable: null,
    swapRouter: null,
    priceFeed: null,
    fixedEthUsd: 3000,
    sweepMode: 'raw',
    deployBlock: null,
    excludeWallets: [PONS_MAINNET.escrow, PONS_MAINNET.factory],
  };

  it('accepts the template with token/feeVault null and reports not-ready', () => {
    const d = parseDeployConfig(template) as EvmDeployConfig;
    expect(d.feeSource).toBe('pons');
    expect(d.token).toBeUndefined();
    expect(d.feeVault).toBeUndefined();
    expect(d.stable).toBeUndefined();
    expect(d.quoteTokens).toEqual(['0x0000000000000000000000000000000000000000']);
    expect(d.excludeWallets).toEqual([PONS_MAINNET.escrow.toLowerCase(), PONS_MAINNET.factory.toLowerCase()]);
    expect(evmConfigReady(d)).toBe(false);
  });

  it('still requires token/feeVault/usdc for a meshToken launch', () => {
    expect(() => parseDeployConfig({ ...template, feeSource: 'meshToken' })).toThrow(/missing "(token|usdc)"/);
  });

  it('applies admin overrides (overrides win, exclusions merge, stable aliases usdc)', () => {
    const d = parseDeployConfig(template) as EvmDeployConfig;
    const o = applyEvmOverrides(d, { token: TOKEN, feeVault: VAULT, stable: USDG, deployBlock: '1234', excludeWallets: [POOL, PONS_MAINNET.factory], priceFeed: null });
    expect(evmConfigReady(o)).toBe(true);
    expect(o.token).toBe(TOKEN);
    expect(o.usdc).toBe(USDG);
    expect(o.deployBlock).toBe(1234);
    expect(o.excludeWallets).toEqual([PONS_MAINNET.escrow.toLowerCase(), PONS_MAINNET.factory.toLowerCase(), POOL]);
    expect(o.priceFeed).toBeUndefined();
    expect(d.token).toBeUndefined(); // base untouched
  });

  it('createAdapter picks PonsEvmAdapter for feeSource pons and honours deployNetwork', () => {
    const d = applyEvmOverrides(parseDeployConfig(template) as EvmDeployConfig, { token: TOKEN, feeVault: VAULT });
    const a = createAdapter({ chain: 'evm', holderShareBps: 5000, deployNetwork: 'robinhood' }, { deploy: d, env: { MESH_EVM_PRIVATE_KEY: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', MESH_FIXED_ETH_USD: '2222' } });
    expect(a).toBeInstanceOf(PonsEvmAdapter);
    expect(a).toBeInstanceOf(EvmAdapter);
    const p = a as PonsEvmAdapter;
    expect(p.opts.ponsEscrow).toBe(PONS_MAINNET.escrow);
    expect(p.opts.creditPool).toBe(CREDIT_POOL);
    expect(p.opts.fixedEthUsd).toBe(2222);
    expect(p.opts.sweepMode).toBe('raw');
    expect(p.opts.rpcUrl).toBeUndefined(); // KNOWN_CHAINS default is applied inside the adapter
    const plain = createAdapter({ chain: 'evm' }, { deploy: { ...d, feeSource: 'meshToken', usdc: USDG }, env: {} });
    expect(plain).not.toBeInstanceOf(PonsEvmAdapter);
  });
});
