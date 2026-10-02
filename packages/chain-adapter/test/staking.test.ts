import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { EvmAdapter } from '../src/evm.js';
import { MockAdapter, DEFAULT_MOCK_STAKES } from '../src/mock.js';
import { SolanaAdapter } from '../src/solana.js';
import { NotWiredError, hasStaking } from '../src/types.js';
import { parseDeployConfig, type EvmDeployConfig } from '../src/deploy-config.js';
import { createAdapter } from '../src/index.js';

const TOKEN = '0x1000000000000000000000000000000000000001' as Address;
const STAKING = '0x9000000000000000000000000000000000000009' as Address;
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const E18 = 10n ** 18n;

describe('MockAdapter.getStakes', () => {
  it('ships a staked example for dev mode and 0 for unknown wallets', async () => {
    const m = new MockAdapter({ now: () => 1_000 });
    expect(hasStaking(m)).toBe(true);
    const [alice, bob, nobody] = await m.getStakes(['mockwallet_alice', 'mockwallet_bob', 'nobody']);
    expect(alice).toEqual({ wallet: 'mockwallet_alice', staked: DEFAULT_MOCK_STAKES.mockwallet_alice.staked, lockDays: 30, lockEndsAt: 1_000 + 30 * 86_400 });
    expect(bob).toMatchObject({ staked: 12_000, lockDays: 0, lockEndsAt: 0 });
    expect(nobody).toEqual({ wallet: 'nobody', staked: 0, lockDays: 0, lockEndsAt: 0 });
  });

  it('explicit holders start with no stakes; setStake adds and clears positions', async () => {
    const m = new MockAdapter({ holders: { a: 1 }, now: () => 500 });
    expect((await m.getStakes(['a']))[0].staked).toBe(0);
    m.setStake('a', 60_000, { lockDays: 30 });
    expect((await m.getStakes(['a']))[0]).toEqual({ wallet: 'a', staked: 60_000, lockDays: 30, lockEndsAt: 500 + 30 * 86_400 });
    m.setStake('a', 0);
    expect((await m.getStakes(['a']))[0].staked).toBe(0);
  });
});

describe('EvmAdapter.getStakes', () => {
  function client(positions: Record<string, { amount: bigint; lockDays: number; lockEndsAt: bigint }>) {
    const calls: Array<{ address: string; fn: string; args: unknown[] }> = [];
    const c = {
      async readContract({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) {
        calls.push({ address, fn: functionName, args: args ?? [] });
        if (functionName === 'decimals') return 18;
        if (functionName === 'positionOf') {
          const p = positions[String(args![0]).toLowerCase()] ?? { amount: 0n, lockDays: 0, lockEndsAt: 0n };
          return { amount: p.amount, lockDays: p.lockDays, lockEndsAt: p.lockEndsAt };
        }
        throw new Error(`unexpected read ${functionName}`);
      },
    };
    return { client: c as unknown as PublicClient, calls };
  }

  it('reads positionOf from the staking contract and converts to token units', async () => {
    const { client: c, calls } = client({ [ALICE]: { amount: 50_000n * E18, lockDays: 30, lockEndsAt: 1_900_000_000n } });
    const a = new EvmAdapter({ publicClient: c, chainId: 31337, tokenAddress: TOKEN, staking: STAKING, decimals: 18 });
    expect(a.stakingEnabled).toBe(true);
    const r = await a.getStakes([ALICE, BOB, 'not-an-address']);
    expect(r[0].staked).toBeCloseTo(50_000, 6);
    expect(r[0]).toMatchObject({ wallet: ALICE, lockDays: 30, lockEndsAt: 1_900_000_000 });
    expect(r[1]).toEqual({ wallet: BOB, staked: 0, lockDays: 0, lockEndsAt: 0 });
    expect(r[2]).toEqual({ wallet: 'not-an-address', staked: 0, lockDays: 0, lockEndsAt: 0 });
    const reads = calls.filter((x) => x.fn === 'positionOf');
    expect(reads).toHaveLength(2);
    expect(reads.every((x) => x.address === STAKING)).toBe(true);
  });

  it('is NotWired without a staking address', async () => {
    const { client: c } = client({});
    const a = new EvmAdapter({ publicClient: c, chainId: 31337, tokenAddress: TOKEN, decimals: 18 });
    expect(a.stakingEnabled).toBe(false);
    await expect(a.getStakes([ALICE])).rejects.toBeInstanceOf(NotWiredError);
  });

  it('excludes the staking contract from holder balances', () => {
    const { client: c } = client({});
    const a = new EvmAdapter({ publicClient: c, chainId: 31337, tokenAddress: TOKEN, staking: STAKING, decimals: 18 });
    // private helper; reach through for the assertion
    const excluded = (a as unknown as { excluded(): Set<string> }).excluded();
    expect(excluded.has(STAKING.toLowerCase())).toBe(true);
  });
});

describe('deploy json `staking`', () => {
  const base = {
    chain: 'evm',
    network: 'anvil',
    chainId: 31337,
    token: TOKEN,
    feeVault: '0x2000000000000000000000000000000000000002',
    treasury: '0x3000000000000000000000000000000000000003',
    usdc: '0x5000000000000000000000000000000000000005',
    excludeWallets: [],
  };

  it('is optional and a zero address means "not deployed"', () => {
    expect((parseDeployConfig(base) as EvmDeployConfig).staking).toBeUndefined();
    expect((parseDeployConfig({ ...base, staking: '0x0000000000000000000000000000000000000000' }) as EvmDeployConfig).staking).toBeUndefined();
    expect((parseDeployConfig({ ...base, staking: STAKING }) as EvmDeployConfig).staking).toBe(STAKING);
    expect(() => parseDeployConfig({ ...base, staking: 'nope' })).toThrow(/not an address/);
  });

  it('flows into the EvmAdapter through createAdapter', () => {
    const a = createAdapter({ chain: 'evm' }, { deploy: parseDeployConfig({ ...base, staking: STAKING }), env: {} }) as EvmAdapter;
    expect(a.opts.staking).toBe(STAKING);
    expect(a.stakingEnabled).toBe(true);
  });
});

describe('SolanaAdapter.getStakes', () => {
  it('reports NotWired until the Anchor program is deployed', async () => {
    const s = new SolanaAdapter();
    expect(hasStaking(s)).toBe(true);
    await expect(s.getStakes(['x'])).rejects.toBeInstanceOf(NotWiredError);
  });
});
