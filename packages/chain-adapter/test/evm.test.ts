import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient } from 'viem';
import { EvmAdapter, memoryStateStore, type Swapper } from '../src/evm.js';
import { ZERO } from '../src/evm/holders.js';

const TOKEN = '0x1000000000000000000000000000000000000001' as Address;
const VAULT = '0x2000000000000000000000000000000000000002' as Address;
const TREASURY = '0x3000000000000000000000000000000000000003' as Address;
const POOL = '0x4000000000000000000000000000000000000004' as Address;
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const CAROL = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const E18 = 10n ** 18n;

interface FakeLog {
  block: bigint;
  idx: number;
  from: Address;
  to: Address;
  value: bigint;
}

/** 2-second blocks starting at T0; logs placed by block number. */
function fakeChain(logs: FakeLog[], latest: bigint, T0 = 1_700_000_000, pending = 0n) {
  const calls: string[] = [];
  const tsOf = (b: bigint) => T0 + Number(b) * 2;
  const client = {
    async getBlockNumber() {
      calls.push('getBlockNumber');
      return latest;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      calls.push(`getBlock:${blockNumber}`);
      return { number: blockNumber, timestamp: BigInt(tsOf(blockNumber)) };
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.push(`getLogs:${fromBlock}-${toBlock}`);
      return logs
        .filter((l) => l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ blockNumber: l.block, logIndex: l.idx, args: { from: l.from, to: l.to, value: l.value } }));
    },
    async readContract({ functionName }: { functionName: string }) {
      calls.push(`read:${functionName}`);
      if (functionName === 'decimals') return 18;
      if (functionName === 'pending') return pending;
      if (functionName === 'balanceOf') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  return { client: client as unknown as PublicClient, calls, tsOf };
}

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

function adapter(client: PublicClient, extra: Partial<ConstructorParameters<typeof EvmAdapter>[0]> = {}) {
  return new EvmAdapter({
    publicClient: client,
    chainId: 31337,
    tokenAddress: TOKEN,
    feeVault: VAULT,
    treasury: TREASURY,
    usdc: '0x5000000000000000000000000000000000000005',
    deployBlock: 10,
    decimals: 18,
    excludeWallets: [POOL],
    holderShareBps: 5000,
    logChunkBlocks: 1000,
    account,
    ...extra,
  });
}

describe('EvmAdapter.getHolderBalances', () => {
  // deploy at block 10: mint 1,000,000 to treasury; treasury → alice 10,000, → pool 500,000 (block 11)
  // block 1000 (inside window): alice → bob 4,000 ; block 1500: bob → carol 1,000
  const logs: FakeLog[] = [
    { block: 10n, idx: 0, from: ZERO, to: TREASURY, value: 1_000_000n * E18 },
    { block: 11n, idx: 0, from: TREASURY, to: ALICE, value: 10_000n * E18 },
    { block: 11n, idx: 1, from: TREASURY, to: POOL, value: 500_000n * E18 },
    { block: 1000n, idx: 0, from: ALICE, to: BOB, value: 4_000n * E18 },
    { block: 1500n, idx: 0, from: BOB, to: CAROL, value: 1_000n * E18 },
  ];

  it('time-weights over the window with full-history holdSinceTs', async () => {
    const { client, tsOf, calls } = fakeChain(logs, 2500n);
    const a = adapter(client);
    // window = blocks [500, 2500) → ts(500)..ts(2500): 4000 s
    const from = tsOf(500n);
    const to = tsOf(2500n);
    const r = await a.getHolderBalances({ from, to });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h]));
    expect(by[TREASURY]).toBeUndefined();
    expect(by[POOL]).toBeUndefined();
    // alice: 10000 for 1000 s (blocks 500→1000), then 6000 for 3000 s → (10000*1000 + 6000*3000)/4000 = 7000
    expect(by[ALICE].timeWeightedBalance).toBeCloseTo(7000, 6);
    // bob: 0 for 1000 s, 4000 for 1000 s, 3000 for 2000 s → (4000*1000 + 3000*2000)/4000 = 2500
    expect(by[BOB].timeWeightedBalance).toBeCloseTo(2500, 6);
    // carol: 1000 for 2000 s / 4000 → 500
    expect(by[CAROL].timeWeightedBalance).toBeCloseTo(500, 6);
    expect(by[ALICE].holdSinceTs).toBe(tsOf(1000n)); // transferred out → reset
    expect(by[BOB].holdSinceTs).toBe(tsOf(1500n)); // transferred out → reset
    expect(by[CAROL].holdSinceTs).toBe(tsOf(1500n)); // inbound after zero
    // chunked scan from deployBlock, not from 0
    expect(calls.filter((c) => c.startsWith('getLogs:'))[0]).toBe('getLogs:10-1009');
  });

  it('is incremental: the next epoch only scans new blocks and keeps holdSince', async () => {
    const store = memoryStateStore();
    const { client, tsOf, calls } = fakeChain(logs, 2500n);
    const a = adapter(client, { stateStore: store });
    await a.getHolderBalances({ from: tsOf(500n), to: tsOf(2500n) });
    expect(store.load()?.block).toBe(2500n);
    calls.length = 0;
    // second epoch: blocks (2500, 4500], no new logs
    const chain2 = fakeChain(logs, 4500n);
    const b = adapter(chain2.client, { stateStore: store });
    const r = await b.getHolderBalances({ from: tsOf(2500n), to: tsOf(4500n) });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h]));
    expect(by[ALICE].timeWeightedBalance).toBeCloseTo(6000, 6);
    expect(by[ALICE].holdSinceTs).toBe(tsOf(1000n));
    expect(by[CAROL].holdSinceTs).toBe(tsOf(1500n));
    const scans = chain2.calls.filter((c) => c.startsWith('getLogs:'));
    expect(scans[0]).toBe('getLogs:2501-3500');
    expect(scans.at(-1)).toBe('getLogs:3501-4500');
  });

  it('constant balances when nothing moved', async () => {
    const { client, tsOf } = fakeChain(logs.slice(0, 3), 5000n);
    const r = await adapter(client).getHolderBalances({ from: tsOf(3000n), to: tsOf(4800n) });
    expect(r).toEqual([{ wallet: ALICE, timeWeightedBalance: 10_000, holdSinceTs: tsOf(11n) }]);
  });
});

describe('EvmAdapter.collectFees', () => {
  it('dry run values the sweep at the quoted price and sends nothing', async () => {
    const { client } = fakeChain([], 100n, 1_700_000_000, 1_000n * E18);
    const swapper: Swapper = {
      spender: '0x6000000000000000000000000000000000000006',
      quote: async (amountIn) => (amountIn * 20_000n) / E18, // $0.02 per token
      swap: async () => {
        throw new Error('must not swap in dry run');
      },
    };
    const a = adapter(client, { dryRun: true, swapper });
    const r = await a.collectFees();
    expect(r.txId).toBe('dry-run');
    // 1000 tokens * $0.02 = $20 total; holder share 500 tokens → 10 USDC quoted
    expect(r.amountUsd).toBeCloseTo(20, 6);
    expect(a.lastSweep?.usdcReceived).toBeCloseTo(10, 6);
    expect(a.lastSweep?.treasuryTokens).toBe(500);
  });

  it('returns 0 when the vault is empty', async () => {
    const { client } = fakeChain([], 100n);
    const r = await adapter(client, { dryRun: true }).collectFees();
    expect(r).toEqual({ amountUsd: 0, txId: '' });
  });

  it('pendingFeesUsd uses the swapper quote', async () => {
    const { client } = fakeChain([], 100n, 1_700_000_000, 10n * E18);
    const a = adapter(client, { swapper: { spender: ZERO, quote: async (x) => (x * 1_000_000n) / E18, swap: async () => '0x' } });
    expect(await a.pendingFeesUsd()).toBe(10);
  });
});

describe('EvmAdapter misc', () => {
  it('transferTokens validates input and honours dryRun', async () => {
    const { client } = fakeChain([], 100n);
    const a = adapter(client, { dryRun: true });
    await expect(a.transferTokens('nope', 1)).rejects.toThrow(/invalid address/);
    await expect(a.transferTokens(ALICE, 0)).rejects.toThrow(/> 0/);
    expect(await a.transferTokens(ALICE, 1)).toBe('dry-run');
  });

  it('verifies EIP-191 signatures', async () => {
    const msg = 'mesh wants you to sign in';
    const sig = await account.signMessage({ message: msg });
    const a = new EvmAdapter();
    expect(a.verifyWalletSignature(account.address, msg, sig)).toBe(true);
    expect(a.verifyWalletSignature(ALICE, msg, sig)).toBe(false);
  });

  it('throws a configuration error without a token address', async () => {
    const a = new EvmAdapter({ publicClient: fakeChain([], 1n).client });
    await expect(a.getHolderBalances({ from: 0, to: 1 })).rejects.toThrow(/tokenAddress not configured/);
  });
});
