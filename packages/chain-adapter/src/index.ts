import type { TokenomicsConfig } from '@mesh/config';
import type { Hex } from 'viem';
import { EvmAdapter, type EvmAdapterOptions } from './evm.js';
import { PonsEvmAdapter, type PonsEvmAdapterOptions } from './pons.js';
import { MockAdapter, type MockAdapterOptions } from './mock.js';
import { SolanaAdapter, keypairFromEnv, type SolanaAdapterOptions } from './solana.js';
import { defaultNetworkFor, loadDeployConfig, type DeployConfig, type EvmDeployConfig, type SolanaDeployConfig } from './deploy-config.js';
import type { Chain, ChainAdapter } from './types.js';

export * from './types.js';
export * from './deploy-config.js';
export * from './timeweight.js';
export { jsonRpc, fakeRpc, JsonRpcError, toRaw, toUnits, assertBps, type JsonRpc, type FetchLike } from './rpc.js';
export { MockAdapter, DEFAULT_MOCK_HOLDERS, DEFAULT_MOCK_STAKES } from './mock.js';
export { SolanaAdapter, keypairFromEnv, decodeSignatureCandidates, USDC_DEVNET, USDC_MAINNET, type SolanaAdapterOptions, type SnapshotStore } from './solana.js';
export { JupiterClient, DEFAULT_JUPITER_BASE, type JupiterQuote } from './solana/jupiter.js';
export { heliusTransfersForMint, dasTokenAccountsByMint, balancesByOwner } from './solana/helius.js';
export { sendInstructions, requestAirdropWithRetry, confirmSignature, type SolanaRpc } from './solana/tx.js';
export {
  EvmAdapter,
  recoverMessageAddressSync,
  normalizeEvmAddress,
  normalizeEvmSignature,
  uniswapV3Swapper,
  memoryStateStore,
  KNOWN_CHAINS,
  type EvmAdapterOptions,
  type Swapper,
  type EvmBalanceState,
  type EvmStateStore,
} from './evm.js';
export * as evmAbi from './evm/abi.js';
export { PonsEvmAdapter, PONS_MAINNET, ETH_ASSET, type PonsEvmAdapterOptions, type PonsSweepDetail, type PonsAssetSweep } from './pons.js';
export { checkPonsConfig, checksumPastedAddress, sweeperAddressFromKey, type PonsCheckReport, type PonsCheckItem } from './pons-check.js';

export interface CreateAdapterOptions {
  /** Force the in-memory MockAdapter (dev/tests). */
  mock?: boolean;
  mockOptions?: MockAdapterOptions;
  solana?: SolanaAdapterOptions;
  evm?: EvmAdapterOptions | PonsEvmAdapterOptions;
  /** `config/deploy.<network>.json` to load (default MESH_DEPLOY_NETWORK, then devnet / base-sepolia). */
  network?: string;
  /** Pre-parsed deploy config (skips the file read). */
  deploy?: DeployConfig;
  /** Env source for secrets (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Pick the adapter by `config.chain`. Live adapters are configured from
 * `config/deploy.<network>.json` (public addresses) + env (secrets), and any explicit
 * `opts.solana` / `opts.evm` override both. Missing deploy file → adapter is still constructed
 * (signature verification works) but network methods throw a clear configuration error.
 */
export function createAdapter(
  config: Pick<TokenomicsConfig, 'chain'> & Partial<Pick<TokenomicsConfig, 'holderShareBps' | 'deployNetwork'>>,
  opts: CreateAdapterOptions = {},
): ChainAdapter {
  if (opts.mock) return new MockAdapter({ chain: config.chain, ...opts.mockOptions });
  const env = opts.env ?? process.env;
  const network = opts.network ?? defaultNetworkFor(config.chain, env, config.deployNetwork);
  const deploy = opts.deploy ?? safeLoad(network);
  if (deploy && deploy.chain !== config.chain) {
    throw new Error(`config/deploy.${network}.json is for chain "${deploy.chain}" but tokenomics.chain is "${config.chain}"`);
  }
  const dryRun = /^(1|true|yes)$/i.test(env.MESH_DRY_RUN ?? '');
  switch (config.chain) {
    case 'solana':
      return new SolanaAdapter({
        ...solanaOptionsFrom(deploy as SolanaDeployConfig | null, env),
        holderShareBps: config.holderShareBps,
        dryRun,
        ...opts.solana,
      });
    case 'evm': {
      const d = deploy as EvmDeployConfig | null;
      const evmOpts = { ...evmOptionsFrom(d, env), holderShareBps: config.holderShareBps, dryRun, ...opts.evm };
      // Pons launch: creator fees come from the Pons escrow via our PonsFeeVault, not from a MeshToken transfer fee.
      return d?.feeSource === 'pons' || (opts.evm as PonsEvmAdapterOptions | undefined)?.ponsEscrow ? new PonsEvmAdapter(evmOpts) : new EvmAdapter(evmOpts);
    }
    default: {
      const never: never = config.chain;
      throw new Error(`unsupported chain: ${String(never)}`);
    }
  }
}

function safeLoad(network: string): DeployConfig | null {
  try {
    return loadDeployConfig(network);
  } catch (err) {
    throw new Error(`failed to load config/deploy.${network}.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function solanaOptionsFrom(d: SolanaDeployConfig | null, env: NodeJS.ProcessEnv): SolanaAdapterOptions {
  const heliusKey = env.MESH_HELIUS_API_KEY;
  const rpcUrl =
    env.MESH_SOLANA_RPC_URL ??
    (heliusKey ? `https://${d?.network === 'mainnet-beta' ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=${heliusKey}` : undefined);
  return {
    rpcUrl,
    mint: d?.mint,
    decimals: d?.decimals,
    treasury: d?.treasury,
    usdcMint: d?.usdcMint,
    excludeWallets: d?.excludeWallets,
    slippageBps: d?.slippageBps,
    heliusApiKey: heliusKey,
    heliusApiBaseUrl: d?.heliusApiBaseUrl,
    jupiter: { baseUrl: d?.jupiterBaseUrl ?? env.MESH_JUPITER_BASE_URL, apiKey: env.MESH_JUPITER_API_KEY },
    signer: keypairFromEnv(env.MESH_SOLANA_KEYPAIR),
    holdSinceLookbackSec: env.MESH_HOLD_SINCE_LOOKBACK_SEC ? Number(env.MESH_HOLD_SINCE_LOOKBACK_SEC) : undefined,
  };
}

export function evmOptionsFrom(d: EvmDeployConfig | null, env: NodeJS.ProcessEnv): PonsEvmAdapterOptions {
  const pk = env.MESH_EVM_PRIVATE_KEY;
  const fixedEthUsd = env.MESH_FIXED_ETH_USD ? Number(env.MESH_FIXED_ETH_USD) : d?.fixedEthUsd;
  return {
    rpcUrl: env.MESH_EVM_RPC_URL ?? d?.rpcUrl,
    chainId: env.MESH_EVM_CHAIN_ID ? Number(env.MESH_EVM_CHAIN_ID) : d?.chainId,
    tokenAddress: d?.token,
    feeVault: d?.feeVault,
    staking: d?.staking,
    treasury: d?.treasury,
    usdc: d?.usdc ?? d?.stable,
    stable: d?.stable ?? d?.usdc,
    stableDecimals: d?.stableDecimals,
    swapRouter: d?.swapRouter,
    ponsEscrow: d?.ponsEscrow,
    ponsFactory: d?.ponsFactory,
    ponsHook: d?.ponsHook,
    launchLocker: d?.launchLocker,
    buybackVault: d?.buybackVault,
    creditPool: d?.creditPool,
    quoteTokens: d?.quoteTokens,
    sweepMode: d?.sweepMode,
    priceFeed: d?.priceFeed,
    fixedEthUsd,
    poolFee: d?.poolFee,
    deployBlock: d?.deployBlock,
    decimals: d?.decimals,
    excludeWallets: d?.excludeWallets,
    // MESH_EVM_LOG_CHUNK overrides the file (free RPC tiers cap eth_getLogs ranges; the scanner also adapts on its own).
    logChunkBlocks: Number(process.env.MESH_EVM_LOG_CHUNK) > 0 ? Number(process.env.MESH_EVM_LOG_CHUNK) : d?.logChunkBlocks,
    slippageBps: d?.slippageBps,
    privateKey: pk ? ((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex) : undefined,
  };
}

/** Verifier for a specific chain, independent of the active adapter (used by /auth/verify {chain}). */
export function verifierFor(chain: Chain): ChainAdapter['verifyWalletSignature'] {
  const a = chain === 'solana' ? new SolanaAdapter() : new EvmAdapter();
  return a.verifyWalletSignature.bind(a);
}
