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
  /** base-sepolia | base | robinhood | robinhood-testnet | anvil ... */
  network: string;
  chainId: number;
  /** Default RPC when MESH_EVM_RPC_URL is unset (public endpoints are fine for reads). */
  rpcUrl?: string;
  /** Block explorer base URL (informative; the admin panel links to it). */
  explorer?: string;
  /**
   * Where trading fees come from. `meshToken` (default): our MeshToken transfer fee → FeeVault.sweep.
   * `pons`: the token was launched on Pons; creator fees accrue in the Pons escrow for our PonsFeeVault.
   */
  feeSource?: 'meshToken' | 'pons';
  /**
   * The token. Required for `meshToken`; for `pons` it is null in the committed template until the dev
   * launches (the gateway then stays on the mock adapter and the admin "Token" panel fills it in).
   */
  token?: `0x${string}`;
  /** FeeVault (meshToken) or PonsFeeVault (pons). Same nullability as `token`. */
  feeVault?: `0x${string}`;
  teamLock?: `0x${string}`;
  /** MeshStaking contract; absent until staking launches (adapter then reports NotWired). */
  staking?: `0x${string}`;
  /** Treasury wallet. Required for meshToken; for pons it may be null in the template (the adapter then pays the sweeper). */
  treasury?: `0x${string}`;
  /** Block the token was deployed in: Transfer scans start here. */
  deployBlock: number;
  decimals?: number;
  /** Stablecoin the sweep settles in (USDC on Base; USDG/USDC on Robinhood). Alias: `stable`. Optional for pons. */
  usdc?: `0x${string}`;
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

  // ---- feeSource: 'pons' ----
  ponsEscrow?: `0x${string}`;
  ponsFactory?: `0x${string}`;
  ponsHook?: `0x${string}`;
  launchLocker?: `0x${string}`;
  buybackVault?: `0x${string}`;
  /** Gateway pool wallet: PonsFeeVault sends the holder share here. */
  creditPool?: `0x${string}`;
  /** Assets Pons may pay creator fees in; 0x000…0 = native ETH. Default [ETH]. */
  quoteTokens?: `0x${string}`[];
  /** Same as `usdc`, named for what it is on Robinhood (USDG). Either key works. */
  stable?: `0x${string}`;
  stableDecimals?: number;
  /** `swap` via the vault's route, or `raw` (forward ETH, value off-chain) while no stable route exists. */
  sweepMode?: 'swap' | 'raw';
  /** Chainlink ETH/USD aggregator on this chain; null → `fixedEthUsd`. */
  priceFeed?: `0x${string}`;
  fixedEthUsd?: number;
  /** Pons launch facts, informative: curve + pool (also go in excludeWallets). */
  launchTx?: string;
  curve?: `0x${string}`;
  poolId?: string;
}

/** Fields the admin "Token" panel may override (chain_settings table); everything else comes from the JSON. */
export const EVM_OVERRIDABLE_FIELDS = ['token', 'feeVault', 'creditPool', 'treasury', 'stable', 'swapRouter', 'priceFeed', 'deployBlock', 'excludeWallets'] as const;
export type EvmOverridableField = (typeof EVM_OVERRIDABLE_FIELDS)[number];

/** True when the EVM config has what a live adapter needs (token + fee vault). The template ships without them. */
export function evmConfigReady(d: EvmDeployConfig | null | undefined): d is EvmDeployConfig & { token: `0x${string}`; feeVault: `0x${string}` } {
  return Boolean(d && d.token && d.feeVault);
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
    const isAddr = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
    const addr = (k: string) => {
      const v = String(req(k));
      if (!isAddr(v)) throw new Error(`deploy config: "${k}" is not an address`);
      return v;
    };
    const zero = (v: unknown) => typeof v !== 'string' || v === '' || /^0x0{40}$/.test(v);
    const optAddr = (k: string) => (zero(r[k]) ? undefined : addr(k));
    const feeSource = r.feeSource === 'pons' ? 'pons' : 'meshToken';
    const pons = feeSource === 'pons';
    // meshToken: both required. pons: null until the launch (template state).
    const token = pons ? optAddr('token') : addr('token');
    const feeVault = pons ? optAddr('feeVault') : addr('feeVault');
    const stableKey = !zero(r.stable) ? 'stable' : !zero(r.usdc) ? 'usdc' : null;
    const stable = stableKey ? addr(stableKey) : pons ? undefined : addr('usdc');
    const quoteTokens = Array.isArray(r.quoteTokens)
      ? (r.quoteTokens as unknown[]).map((q, i) => {
          if (!isAddr(q)) throw new Error(`deploy config: quoteTokens[${i}] is not an address`);
          return q;
        })
      : undefined;
    return {
      ...(r as object),
      chain: 'evm',
      network: String(req('network')),
      chainId: Number(req('chainId')),
      feeSource,
      staking: optAddr('staking'),
      token,
      feeVault,
      treasury: pons ? optAddr('treasury') : addr('treasury'),
      usdc: stable,
      stable,
      swapRouter: optAddr('swapRouter'),
      priceFeed: optAddr('priceFeed'),
      ponsEscrow: optAddr('ponsEscrow'),
      ponsFactory: optAddr('ponsFactory'),
      ponsHook: optAddr('ponsHook'),
      launchLocker: optAddr('launchLocker'),
      buybackVault: optAddr('buybackVault'),
      creditPool: optAddr('creditPool'),
      curve: optAddr('curve'),
      quoteTokens,
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

/**
 * Which `config/deploy.<network>.json` to load: MESH_DEPLOY_NETWORK, then `tokenomics.deployNetwork`,
 * then the chain's default (`devnet` / `base-sepolia`).
 */
export function defaultNetworkFor(chain: 'solana' | 'evm', env: NodeJS.ProcessEnv = process.env, configured?: string): string {
  return env.MESH_DEPLOY_NETWORK ?? configured ?? (chain === 'solana' ? 'devnet' : 'base-sepolia');
}

/**
 * Apply admin overrides (from the gateway's chain_settings table) on top of the JSON. Overrides win;
 * `null` / undefined entries leave the file value in place. Returns a new object.
 */
export function applyEvmOverrides(base: EvmDeployConfig, overrides: Partial<Record<EvmOverridableField, unknown>>): EvmDeployConfig {
  const out: EvmDeployConfig = { ...base };
  for (const k of EVM_OVERRIDABLE_FIELDS) {
    const v = overrides[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'deployBlock') out.deployBlock = Number(v);
    else if (k === 'excludeWallets') out.excludeWallets = Array.from(new Set([...(base.excludeWallets ?? []), ...(Array.isArray(v) ? v.map((w) => String(w).toLowerCase()) : [])]));
    else if (k === 'stable') {
      out.stable = v as `0x${string}`;
      out.usdc = v as `0x${string}`;
    } else (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
