/**
 * Integration test against a local anvil: deploys the real MeshToken/FeeVault + test mocks for
 * USDC and the swap router, moves tokens with controlled block timestamps, and runs the
 * adapter's three network methods for real. Skips itself when anvil or the forge artifacts
 * (contracts/evm/out, `forge build`) are missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { EvmAdapter, memoryStateStore } from '../src/evm.js';
import { erc20Abi } from '../src/evm/abi.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../contracts/evm/out');

function findAnvil(): string | null {
  const candidates = [process.env.ANVIL_PATH, join(homedir(), '.foundry/bin/anvil'), '/usr/local/bin/anvil'].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'anvil'))) return join(dir, 'anvil');
  return null;
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = join(OUT, `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const anvilPath = findAnvil();
const haveArtifacts = existsSync(join(OUT, 'MeshToken.sol/MeshToken.json')) && existsSync(join(OUT, 'MockSwapRouter.sol/MockSwapRouter.json'));
const enabled = !!anvilPath && haveArtifacts && process.env.MESH_SKIP_ANVIL !== '1';

// anvil's default mnemonic accounts
const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];

describe.skipIf(!enabled)('EvmAdapter against anvil', () => {
  let proc: ChildProcess;
  let rpc: string;
  let pub: PublicClient;
  const acct = KEYS.map((k) => privateKeyToAccount(k));
  const [deployer, treasury, alice, bob, carol, pool] = acct;
  let token: Address;
  let vault: Address;
  let usdc: Address;
  let router: Address;
  let deployBlock: bigint;
  let T: number;
  const wallet = (a: PrivateKeyAccount): WalletClient => createWalletClient({ account: a, chain: foundry, transport: http(rpc) });

  const send = async (w: WalletClient, req: { address: Address; abi: Abi; functionName: string; args: unknown[] }, ts?: number) => {
    if (ts !== undefined) await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [ts] as never });
    const hash = await w.writeContract({ ...req, account: w.account!, chain: foundry } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe('success');
    return r;
  };
  const mineAt = async (ts: number) => {
    await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [ts] as never });
    await pub.request({ method: 'evm_mine' as never, params: [] as never });
  };
  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(deployer).deployContract({ abi, bytecode, args, account: deployer, chain: foundry } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    expect(r.contractAddress).toBeTruthy();
    return { address: r.contractAddress as Address, block: r.blockNumber };
  };

  beforeAll(async () => {
    const port = 8545 + Math.floor(Math.random() * 1000);
    rpc = `http://127.0.0.1:${port}`;
    proc = spawn(anvilPath!, ['--port', String(port), '--silent', '--chain-id', '31337'], { stdio: 'ignore' });
    pub = createPublicClient({ chain: foundry, transport: http(rpc) });
    for (let i = 0; i < 100; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const genesis = await pub.getBlock();
    T = Number(genesis.timestamp) + 100;

    usdc = (await deploy('MockUSDC', [])).address;
    router = (await deploy('MockSwapRouter', [usdc, 20_000n])).address; // $0.02 per token
    vault = (await deploy('FeeVault', [deployer.address])).address;
    const tok = await deploy('MeshToken', [
      {
        name: 'Mesh',
        symbol: 'MESH',
        totalSupply: parseEther('1000000000'),
        feeBps: 150,
        owner: deployer.address,
        feeVault: vault,
        treasury: treasury.address,
        teamLock: '0x0000000000000000000000000000000000000000',
        teamAllocation: 0n,
      },
    ]);
    token = tok.address;
    deployBlock = tok.block;
    const meshAbi = artifact('MeshToken').abi;
    // pool is exempt (like a DEX pool would be), treasury/owner/vault already exempt
    await send(wallet(deployer), { address: token, abi: meshAbi, functionName: 'setFeeExempt', args: [pool.address, true] });
    // T+10: treasury → alice 10,000 (exempt, no fee) ; treasury → pool 500,000
    await send(wallet(treasury), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [alice.address, parseEther('10000')] }, T + 10);
    await send(wallet(treasury), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [pool.address, parseEther('500000')] }, T + 11);
    // T+1000: alice → bob 4,000 (1.5% fee = 60 → vault, bob gets 3,940)
    await send(wallet(alice), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [bob.address, parseEther('4000')] }, T + 1000);
    await mineAt(T + 2500);
  }, 120_000);

  afterAll(() => {
    proc?.kill();
  });

  const makeAdapter = (extra: Partial<ConstructorParameters<typeof EvmAdapter>[0]> = {}) =>
    new EvmAdapter({
      rpcUrl: rpc,
      chainId: 31337,
      tokenAddress: token,
      feeVault: vault,
      treasury: treasury.address,
      usdc,
      swapRouter: router,
      quoter: router,
      poolFee: 3000,
      deployBlock: Number(deployBlock),
      excludeWallets: [pool.address],
      holderShareBps: 5000,
      logChunkBlocks: 3,
      privateKey: KEYS[0],
      stateStore: memoryStateStore(),
      ...extra,
    });

  it('getHolderBalances: real Transfer logs, time-weighted, fee-aware, exclusions', async () => {
    const r = await makeAdapter().getHolderBalances({ from: T + 500, to: T + 2500 });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h]));
    expect(by[pool.address.toLowerCase()]).toBeUndefined();
    expect(by[treasury.address.toLowerCase()]).toBeUndefined();
    expect(by[vault.toLowerCase()]).toBeUndefined();
    // alice: 10000 for 500 s, 6000 for 1500 s → 7000 ; bob: 3940 for 1500 s / 2000 → 2955
    expect(by[alice.address.toLowerCase()].timeWeightedBalance).toBeCloseTo(7000, 6);
    expect(by[bob.address.toLowerCase()].timeWeightedBalance).toBeCloseTo(2955, 6);
    expect(by[alice.address.toLowerCase()].holdSinceTs).toBe(T + 1000);
    expect(by[bob.address.toLowerCase()].holdSinceTs).toBe(T + 1000);
  });

  it('collectFees: sweeps the vault, swaps the holder share, forwards the treasury share', async () => {
    const a = makeAdapter();
    const pendingBefore = await a.pendingFeesUsd();
    expect(pendingBefore).toBeCloseTo(1.2, 6); // 60 tokens * $0.02
    const tBefore = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [treasury.address] });
    const res = await a.collectFees();
    const d = a.lastSweep!;
    expect(d.feeTokens).toBe(60);
    expect(d.swappedTokens).toBe(30);
    expect(d.usdcReceived).toBeCloseTo(0.6, 6);
    expect(res.amountUsd).toBeCloseTo(1.2, 6);
    expect(res.txId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.txIds).toHaveLength(4); // sweep, approve, swap, treasury transfer
    const tAfter = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [treasury.address] });
    expect(tAfter - tBefore).toBe(parseEther('30'));
    expect(await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [deployer.address] })).toBe(600_000n);
    expect(await a.pendingFeesUsd()).toBe(0);
    expect(await a.collectFees()).toEqual({ amountUsd: 0, txId: '' });
  });

  it('transferTokens: treasury-approved sweeper pays out via transferFrom', async () => {
    await send(wallet(treasury), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'approve', args: [deployer.address, parseEther('1000')] });
    const a = makeAdapter();
    const tx = await a.transferTokens(carol.address, 100);
    expect(tx).toMatch(/^0x/);
    expect(await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [carol.address] })).toBe(parseEther('100'));
    expect(await a.treasuryBalance()).toBeGreaterThan(0);
  });
});

if (!enabled) {
  describe('EvmAdapter against anvil', () => {
    it.skip(`skipped: ${anvilPath ? '' : 'anvil not found; '}${haveArtifacts ? '' : 'forge artifacts missing (run forge build in contracts/evm)'}`, () => {});
  });
}
