import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, EvmAdapter, MockAdapter, SolanaAdapter, hasExtras, loadDeployConfig, parseDeployConfig, verifierFor } from '../src/index.js';

const solanaDeploy = {
  chain: 'solana',
  network: 'devnet',
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 6,
  treasury: '11111111111111111111111111111111',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  excludeWallets: ['pool1'],
} as const;

const evmDeploy = {
  chain: 'evm',
  network: 'anvil',
  chainId: 31337,
  token: '0x1000000000000000000000000000000000000001',
  feeVault: '0x2000000000000000000000000000000000000002',
  treasury: '0x3000000000000000000000000000000000000003',
  usdc: '0x5000000000000000000000000000000000000005',
  deployBlock: 12,
  excludeWallets: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
} as const;

describe('createAdapter', () => {
  it('mock wins', () => {
    expect(createAdapter({ chain: 'evm' }, { mock: true })).toBeInstanceOf(MockAdapter);
  });

  it('picks SolanaAdapter from config.chain and wires the deploy config + env', () => {
    const a = createAdapter({ chain: 'solana', holderShareBps: 7000 }, { deploy: parseDeployConfig(solanaDeploy), env: { MESH_HELIUS_API_KEY: 'k', MESH_DRY_RUN: '1' } });
    expect(a).toBeInstanceOf(SolanaAdapter);
    const s = a as SolanaAdapter;
    expect(s.opts.mint).toBe(solanaDeploy.mint);
    expect(s.opts.holderShareBps).toBe(7000);
    expect(s.opts.dryRun).toBe(true);
    expect(s.opts.heliusApiKey).toBe('k');
    expect(s.opts.rpcUrl).toContain('devnet.helius-rpc.com');
    expect(s.opts.excludeWallets).toEqual(['pool1']);
    expect(hasExtras(a)).toBe(true);
  });

  it('picks EvmAdapter and lower-cases exclusions', () => {
    const a = createAdapter({ chain: 'evm' }, { deploy: parseDeployConfig(evmDeploy), env: { MESH_EVM_PRIVATE_KEY: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' } });
    expect(a).toBeInstanceOf(EvmAdapter);
    const e = a as EvmAdapter;
    expect(e.opts.tokenAddress).toBe(evmDeploy.token);
    expect(e.opts.excludeWallets).toEqual(['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(e.opts.privateKey?.startsWith('0x')).toBe(true);
    expect(e.opts.deployBlock).toBe(12);
  });

  it('rejects a deploy config for the other chain', () => {
    expect(() => createAdapter({ chain: 'evm' }, { deploy: parseDeployConfig(solanaDeploy), network: 'devnet' })).toThrow(/for chain "solana"/);
  });

  it('constructs without a deploy file; network methods then fail with a config error', async () => {
    const a = createAdapter({ chain: 'solana' }, { network: 'does-not-exist', env: {} });
    expect(a).toBeInstanceOf(SolanaAdapter);
    await expect(a.collectFees()).rejects.toThrow(/signer keypair not configured|mint not configured/);
  });

  it('loads deploy.<network>.json from a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-deploy-'));
    writeFileSync(join(dir, 'deploy.anvil.json'), JSON.stringify(evmDeploy));
    const d = loadDeployConfig('anvil', dir);
    expect(d?.chain).toBe('evm');
    expect(loadDeployConfig('nope', dir)).toBeNull();
    expect(() => parseDeployConfig({ chain: 'evm', network: 'x', chainId: 1, token: 'bad' })).toThrow(/token/);
  });

  it('verifierFor still returns per-chain verifiers', () => {
    expect(typeof verifierFor('solana')).toBe('function');
    expect(verifierFor('evm')('0x0000000000000000000000000000000000000000', 'm', '0x')).toBe(false);
  });
});
