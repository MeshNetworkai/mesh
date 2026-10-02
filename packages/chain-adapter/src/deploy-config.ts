import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configDir } from '@mesh/config';

/**
 * `config/deploy.<network>.json` — everything the live adapters need that is public
 * (addresses, decimals, exclusions). Secrets (RPC keys, signer) come from env, see README.
 */
export interface SolanaDeployConfig {
  chain: 'solana';
  /** devnet | mainnet-beta | testnet | localnet */
  network: string;
  /** Token-2022 mint with the TransferFee extension. */
  mint: string;
  decimals: number;
  /** Wallet (owner) that receives the treasury share; its ATA is derived. */
  treasury: string;
  /** USDC mint on this cluster (used for the holder-share swap). */
  usdcMint: string;
  /** Pool vaults, program-owned accounts, team lock... never credited. Owner addresses. */
  excludeWallets: string[];
  /** Jupiter swap API base (default https://lite-api.jup.ag/swap/v1). */
  jupiterBaseUrl?: string;
  /** Helius enhanced-transactions API base (default https://api.helius.xyz). */
  heliusApiBaseUrl?: string;
  /** Slippage for the holder-share swap, default 100 (1%). */
  slippageBps?: number;
  /** Optional, informative. */
  transferFeeBps?: number;
  deployedAt?: string;
}

export interface EvmDeployConfig {
  chain: 'evm';
  /** base-sepolia | base | robinhood | anvil ... */
  network: string;
  chainId: number;
  /** Default RPC when MESH_EVM_RPC_URL is unset (public endpoints are fine for reads). */
  rpcUrl?: string;
  token: `0x${string}`;
  feeVault: `0x${string}`;
  teamLock?: `0x${string}`;
  /** MeshStaking contract; absent until staking launches (adapter then reports NotWired). */
  staking?: `0x${string}`;
  treasury: `0x${string}`;
  /** Block the token was deployed in: Transfer scans start here. */
  deployBlock: number;
  decimals?: number;
  usdc: `0x${string}`;
  /** Uniswap v3 SwapRouter02 (exactInputSingle). */
  swapRouter?: `0x${string}`;
  /** Uniswap v3 pool fee tier for MESH/USDC (500, 3000, 10000). */
  poolFee?: number;
  /** Pool, vault, lock, router... never credited. Lower-cased on load. */
  excludeWallets: string[];
  /** eth_getLogs chunk size in blocks (default 5000; public RPCs often cap at 10k). */
  logChunkBlocks?: number;
  slippageBps?: number;
  deployedAt?: string;
}

export type DeployConfig = SolanaDeployConfig | EvmDeployConfig;

export function deployConfigPath(network: string, dir = configDir()): string {
  return resolve(dir, `deploy.${network}.json`);
}

export function parseDeployConfig(raw: unknown): DeployConfig {
  if (!raw || typeof raw !== 'object') throw new Error('deploy config must be an object');
  const r = raw as Record<string, unknown>;
  const req = (k: string) => {
    if (r[k] === undefined || r[k] === null || r[k] === '') throw new Error(`deploy config: missing "${k}"`);
    return r[k];
  };
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : []);
  if (r.chain === 'solana') {
    return {
      ...(r as object),
      chain: 'solana',
      network: String(req('network')),
      mint: String(req('mint')),
      decimals: Number(req('decimals')),
      treasury: String(req('treasury')),
      usdcMint: String(req('usdcMint')),
      excludeWallets: list('excludeWallets'),
    } as SolanaDeployConfig;
  }
  if (r.chain === 'evm') {
    const addr = (k: string) => {
      const v = String(req(k));
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`deploy config: "${k}" is not an address`);
      return v as `0x${string}`;
    };
    const zero = (v: unknown) => typeof v !== 'string' || v === '' || /^0x0{40}$/.test(v);
    return {
      ...(r as object),
      chain: 'evm',
      network: String(req('network')),
      chainId: Number(req('chainId')),
      staking: zero(r.staking) ? undefined : addr('staking'),
      token: addr('token'),
      feeVault: addr('feeVault'),
      treasury: addr('treasury'),
      usdc: addr('usdc'),
      deployBlock: Number(r.deployBlock ?? 0),
      excludeWallets: list('excludeWallets').map((w) => w.toLowerCase()),
    } as EvmDeployConfig;
  }
  throw new Error(`deploy config: unknown chain ${String(r.chain)}`);
}

/**
 * Load `config/deploy.<network>.json`. `network` defaults to MESH_DEPLOY_NETWORK, then
 * (by chain) `devnet` / `base-sepolia`. Returns null when the file does not exist so the
 * caller can give a precise error.
 */
export function loadDeployConfig(network: string, dir = configDir()): DeployConfig | null {
  const p = deployConfigPath(network, dir);
  if (!existsSync(p)) return null;
  return parseDeployConfig(JSON.parse(readFileSync(p, 'utf8')));
}

export function defaultNetworkFor(chain: 'solana' | 'evm', env: NodeJS.ProcessEnv = process.env): string {
  return env.MESH_DEPLOY_NETWORK ?? (chain === 'solana' ? 'devnet' : 'base-sepolia');
}
