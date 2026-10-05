// Staking on the web side: discovers the EVM deploy json (config/deploy.<network>.json) at build
// time and exposes the MeshStaking contract + ABI for wagmi. Without a deploy json that carries
// a `staking` address the page renders its "available after launch" state.
import { defineChain, parseAbi, type Address, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { DEFAULT_CHAIN } from '../config';

interface EvmDeployJson {
  chain: 'evm';
  network: string;
  chainId: number;
  rpcUrl?: string;
  token: string;
  staking?: string;
  decimals?: number;
  simulated?: boolean;
}

/**
 * Robinhood Chain mainnet (Arbitrum Orbit L2, docs/CHAIN_DECISION.md): where $MESH lives. Defined here so
 * wagmi knows it even before config/deploy.robinhood.json carries the token address.
 */
export const ROBINHOOD_CHAIN: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

const ZERO = /^0x0{40}$/;
const isAddr = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !ZERO.test(v);

// Vite resolves this glob at build time; zero matches is fine (no deploy json yet → {}).
const DEPLOYS = import.meta.glob<{ default: Record<string, unknown> }>('../../../config/deploy.*.json', { eager: true });

/** The EVM deploy json the web build saw, if any (`VITE_MESH_DEPLOY_NETWORK` picks one when several exist). */
export function evmDeploy(): EvmDeployJson | null {
  const want = (import.meta.env as Record<string, string | undefined>).VITE_MESH_DEPLOY_NETWORK;
  const all = Object.entries(DEPLOYS)
    .map(([path, mod]) => ({ path, d: mod.default }))
    .filter(({ d }) => d && d.chain === 'evm' && typeof d.chainId === 'number' && isAddr(d.token) && d.simulated !== true);
  const pick = want ? all.find(({ path }) => path.endsWith(`deploy.${want}.json`)) : all[0];
  return pick ? (pick.d as unknown as EvmDeployJson) : null;
}

export interface StakingTarget {
  chain: Chain;
  token: Address;
  staking: Address;
  decimals: number;
  network: string;
}

/** Everything wagmi needs to stake, or null when the contract is not deployed for this build. */
export function stakingTarget(): StakingTarget | null {
  if (DEFAULT_CHAIN !== 'evm') return null;
  const d = evmDeploy();
  if (!d || !isAddr(d.staking) || !isAddr(d.token)) return null;
  const known = [ROBINHOOD_CHAIN, mainnet, base].find((c) => c.id === d.chainId);
  const chain =
    known ??
    defineChain({
      id: d.chainId,
      name: d.network,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [d.rpcUrl ?? ''] } },
    });
  return { chain, token: d.token as Address, staking: d.staking as Address, decimals: d.decimals ?? 18, network: d.network };
}

export const STAKING_TARGET = stakingTarget();

export const meshStakingAbi = parseAbi([
  'struct Position { uint256 amount; uint32 lockDays; uint64 lockEndsAt; }',
  'function stake(uint256 amount, uint32 lockDays)',
  'function unstake(uint256 amount)',
  'function positionOf(address wallet) view returns (Position)',
  'function stakedOf(address wallet) view returns (uint256)',
  'function lockEndsAt(address wallet) view returns (uint64)',
  'function multiplierOf(address wallet) view returns (uint32)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

/** Token units → wei, rounding down (string math so 1e18 does not lose precision). */
export function toWei(units: string | number, decimals = 18): bigint {
  const s = String(units).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error('Enter an amount');
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

export function fromWei(wei: bigint, decimals = 18): number {
  return Number(wei) / 10 ** decimals;
}
