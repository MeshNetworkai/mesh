/**
 * Integration test against a local anvil for the Pons fee path: deploys MockPonsEscrow (stand-in for the
 * Pons Fee Escrow), MockERC20 "MESH-test" (what the Pons factory mints), MockUSDC + MockSwapRouter (the
 * stable route) and the real PonsFeeVault, accrues ETH + USDG fees, then runs the adapter end to end in
 * both sweep modes. Skips itself when anvil or the forge artifacts (contracts/evm/out) are missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { memoryStateStore } from '../src/evm.js';
import { PonsEvmAdapter } from '../src/pons.js';
import { checkPonsConfig } from '../src/pons-check.js';
import { erc20Abi, ponsFeeVaultAbi } from '../src/evm/abi.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../../contracts/evm/out');

function findAnvil(): string | null {
  const candidates = [process.env.ANVIL_PATH, join(homedir(), '.foundry/bin/anvil'), '/usr/local/bin/anvil'].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'anvil'))) return join(dir, 'anvil');
  return null;
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const anvilPath = findAnvil();
const haveArtifacts = existsSync(join(OUT, 'PonsFeeVault.sol/PonsFeeVault.json')) && existsSync(join(OUT, 'MockPonsEscrow.sol/MockPonsEscrow.json'));
const enabled = !!anvilPath && haveArtifacts && process.env.MESH_SKIP_ANVIL !== '1';

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
];

describe.skipIf(!enabled)('PonsEvmAdapter against anvil', () => {
  let proc: ChildProcess;
  let rpc: string;
  let pub: PublicClient;
  const acct = KEYS.map((k) => privateKeyToAccount(k));
  const [deployer, owner, treasury, creditPool, alice, bob, curve] = acct;
  const sweeper = deployer; // gateway hot wallet = deployer in this test
  let escrow: Address;
  let token: Address;
  let usdc: Address;
  let usdg: Address;
  let weth: Address;
  let router: Address;
  let vault: Address;
  let deployBlock: bigint;
  let T: number;
  const wallet = (a: PrivateKeyAccount): WalletClient => createWalletClient({ account: a, chain: foundry, transport: http(rpc) });

  const send = async (w: WalletClient, req: { address: Address; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }, ts?: number) => {
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
    return { address: r.contractAddress as Address, block: r.blockNumber, abi };
  };

  beforeAll(async () => {
    const port = 9545 + Math.floor(Math.random() * 1000);
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
    T = Number((await pub.getBlock()).timestamp) + 100;

    escrow = (await deploy('MockPonsEscrow', [])).address;
    usdc = (await deploy('MockUSDC', [])).address;
    usdg = (await deploy('MockERC20', ['Global Dollar', 'USDG', 0n, deployer.address])).address;
    weth = (await deploy('MockERC20', ['Wrapped Ether', 'WETH', 0n, deployer.address])).address;
    router = (await deploy('MockSwapRouter', [usdc, 3_000_000_000n])).address; // $3000 / ETH
    // The "Pons-minted" token: whole supply to the curve (like the factory does), then curve → holders.
    const tok = await deploy('MockERC20', ['Mesh test', 'MESH-test', parseEther('1000000000'), curve.address]);
    token = tok.address;
    deployBlock = tok.block;
    vault = (
      await deploy('PonsFeeVault', [
        {
          owner: owner.address,
          sweeper: sweeper.address,
          escrow,
          creditPool: creditPool.address,
          treasury: treasury.address,
          stable: usdc,
          weth,
          holderShareBps: 5000,
          quoteTokens: [usdg],
        },
      ])
    ).address;
    const vaultAbi = artifact('PonsFeeVault').abi;
    await send(wallet(owner), { address: vault, abi: vaultAbi, functionName: 'setRoute', args: [zeroAddress, 1, router, 500, '0x'] });
    // the escrow knows the vault is the recipient for our token
    const escrowAbi = artifact('MockPonsEscrow').abi;
    await send(wallet(deployer), { address: escrow, abi: escrowAbi, functionName: 'setCreatorFeeRecipient', args: [token, vault] });

    // holders: T+10 curve → alice 10,000 ; T+1000 alice → bob 4,000
    await send(wallet(curve), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [alice.address, parseEther('10000')] }, T + 10);
    await send(wallet(alice), { address: token, abi: erc20Abi as unknown as Abi, functionName: 'transfer', args: [bob.address, parseEther('4000')] }, T + 1000);
    // fees accrue in the escrow for the vault: 1 ETH + 250 USDG (6 decimals mock: use 18 here, MockERC20 is 18)
    await send(wallet(deployer), { address: escrow, abi: escrowAbi, functionName: 'accrue', args: [vault], value: parseEther('1') });
    const usdgAbi = artifact('MockERC20').abi;
    await send(wallet(deployer), { address: usdg, abi: usdgAbi, functionName: 'mint', args: [deployer.address, parseEther('250')] });
    await send(wallet(deployer), { address: usdg, abi: usdgAbi, functionName: 'approve', args: [escrow, parseEther('250')] });
    await send(wallet(deployer), { address: escrow, abi: escrowAbi, functionName: 'accrueToken', args: [vault, usdg, parseEther('250')] });
    await mineAt(T + 2500);
  }, 120_000);

  afterAll(() => {
    proc?.kill();
  });

  const makeAdapter = (extra: Partial<ConstructorParameters<typeof PonsEvmAdapter>[0]> = {}) =>
    new PonsEvmAdapter({
      rpcUrl: rpc,
      chainId: 31337,
      tokenAddress: token,
      feeVault: vault,
      treasury: treasury.address,
      creditPool: creditPool.address,
      ponsEscrow: escrow,
      quoteTokens: [zeroAddress, usdg],
      stable: usdc,
      stableDecimals: 6,
      fixedEthUsd: 3000,
      fixedPrices: { [usdg.toLowerCase()]: 1 },
      deployBlock: Number(deployBlock),
      excludeWallets: [curve.address],
      holderShareBps: 5000,
      logChunkBlocks: 3,
      privateKey: KEYS[0],
      stateStore: memoryStateStore(),
      ...extra,
    });

  it('getHolderBalances: curve, vault and pool excluded; holders time-weighted', async () => {
    const r = await makeAdapter().getHolderBalances({ from: T + 500, to: T + 2500 });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h]));
    expect(by[curve.address.toLowerCase()]).toBeUndefined();
    expect(by[vault.toLowerCase()]).toBeUndefined();
    expect(by[creditPool.address.toLowerCase()]).toBeUndefined();
    expect(by[alice.address.toLowerCase()].timeWeightedBalance).toBeCloseTo(7000, 6);
    expect(by[bob.address.toLowerCase()].timeWeightedBalance).toBeCloseTo(3000, 6);
  });

  it('pendingFeesUsd + dry run value escrow balances without sending', async () => {
    const a = makeAdapter({ dryRun: true });
    expect(await a.pendingFeesUsd()).toBeCloseTo(3250, 6); // 1 ETH * 3000 + 250 USDG
    const r = await a.collectFees();
    expect(r.txId).toBe('dry-run');
    expect(r.amountUsd).toBeCloseTo(3250, 6);
    expect(await pub.getBalance({ address: vault })).toBe(0n); // nothing pulled
  });

  it('collectFees (swap mode): pull from escrow, swap ETH → USDC, split to creditPool / treasury', async () => {
    // USDG has no route in this fixture (the mock router has one price for every input), so this adapter only
    // sweeps ETH; the USDG that pull() also claims stays in the vault for the raw-mode test below.
    const a = makeAdapter({ quoteTokens: [zeroAddress] });
    const poolUsdcBefore = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [creditPool.address] });
    const res = await a.collectFees();
    const d = a.lastSweep!;
    expect(res.txId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.txIds).toHaveLength(2); // pull + sweep(ETH)
    expect(d.assets).toHaveLength(1);
    expect(d.assets[0]).toMatchObject({ asset: zeroAddress, grossIn: 1, mode: 'swap' });
    expect(d.assets[0].holderOut).toBeCloseTo(1500, 6);
    expect(d.assets[0].treasuryOut).toBeCloseTo(1500, 6);
    expect(res.amountUsd).toBeCloseTo(3000, 6);
    const poolUsdcAfter = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [creditPool.address] });
    expect(poolUsdcAfter - poolUsdcBefore).toBe(1_500_000_000n);
    expect(await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [treasury.address] })).toBe(1_500_000_000n);
    expect(await pub.getBalance({ address: vault })).toBe(0n);
    // the USDG claimed by pull() is still held in the vault (its quote token was pulled by the contract's list)
    expect(await pub.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBe(parseEther('250'));
  });

  it('collectFees (raw mode): forwards the held USDG split, valued with fixedPrices', async () => {
    const a = makeAdapter({ sweepMode: 'raw', quoteTokens: [usdg] });
    const res = await a.collectFees();
    const d = a.lastSweep!;
    expect(d.txIds).toHaveLength(1); // nothing in escrow → no pull; one sweepRaw
    expect(d.assets[0]).toMatchObject({ asset: usdg.toLowerCase(), grossIn: 250, holderOut: 125, treasuryOut: 125, mode: 'raw' });
    expect(res.amountUsd).toBeCloseTo(250, 6);
    expect(await pub.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [creditPool.address] })).toBe(parseEther('125'));
    expect(await a.collectFees()).toEqual({ amountUsd: 0, txId: '' });
  });

  it('checkPonsConfig reads token metadata, escrow balance and vault roles', async () => {
    const report = await checkPonsConfig(
      {
        chainId: 31337,
        rpcUrl: rpc,
        token,
        feeVault: vault,
        creditPool: creditPool.address,
        treasury: treasury.address,
        ponsEscrow: escrow,
        stable: usdc,
        quoteTokens: [zeroAddress, usdg],
        curve: curve.address,
        excludeWallets: [curve.address, escrow, vault, creditPool.address, treasury.address],
        deployBlock: Number(deployBlock),
        fixedEthUsd: 3000,
      },
      { sweeperAddress: sweeper.address },
    );
    const by = Object.fromEntries(report.items.map((i) => [i.check, i]));
    expect(report.rpcReachable).toBe(true);
    expect(report.rpcChainId).toBe(31337);
    expect(by['token.erc20'].status).toBe('ok');
    expect(by['token.erc20'].detail).toContain('MESH-test');
    expect(by['escrow.balance'].status).toBe('ok');
    expect(by['feeVault.owner'].value).toBe(owner.address);
    expect(by['feeVault.sweeper'].status).toBe('ok');
    expect(by['feeVault.creditPool'].status).toBe('ok');
    expect(by['feeVault.stable'].status).toBe('ok');
    expect(report.items.filter((i) => i.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);

    const bad = await checkPonsConfig({ chainId: 4663, rpcUrl: rpc, token: alice.address, feeVault: vault, treasury: treasury.address, creditPool: creditPool.address, excludeWallets: [] });
    const badBy = Object.fromEntries(bad.items.map((i) => [i.check, i]));
    expect(badBy['rpc.chainId'].status).toBe('fail');
    expect(badBy['token.code'].status).toBe('fail');
    expect(bad.ok).toBe(false);
  });

  it('reads the vault config back through the ABI', async () => {
    expect(await pub.readContract({ address: vault, abi: ponsFeeVaultAbi, functionName: 'sweeper' })).toBe(sweeper.address);
    const [assets] = await pub.readContract({ address: vault, abi: ponsFeeVaultAbi, functionName: 'pendingInEscrow' });
    expect(assets[0]).toBe(zeroAddress);
  });
});

if (!enabled) {
  describe('PonsEvmAdapter against anvil', () => {
    it.skip(`skipped: ${anvilPath ? '' : 'anvil not found; '}${haveArtifacts ? '' : 'forge artifacts missing (run forge build in contracts/evm)'}`, () => {});
  });
}
