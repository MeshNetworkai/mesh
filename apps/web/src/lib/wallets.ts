// Wallet plumbing: Solana via @solana/wallet-adapter (Phantom, Solflare), EVM via wagmi/viem (injected: MetaMask, Rabby).
import { WalletReadyState, type BaseMessageSignerWalletAdapter } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import bs58 from 'bs58';
import type { Chain, Transport } from 'viem';
import { http, createConfig } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { STAKING_TARGET } from './staking';

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

// The chain MeshStaking is deployed on (config/deploy.<network>.json) joins the list so wagmi can
// switch to it and send stake/unstake; mainnet + Base stay for signing in.
const extraChains: Chain[] = STAKING_TARGET && ![mainnet.id, base.id].includes(STAKING_TARGET.chain.id as 1 | 8453) ? [STAKING_TARGET.chain] : [];
const chains = [mainnet, base, ...extraChains] as unknown as readonly [Chain, ...Chain[]];
const transports: Record<number, Transport> = { [mainnet.id]: http(), [base.id]: http() };
for (const c of extraChains) transports[c.id] = http(c.rpcUrls.default.http[0] || undefined);

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected({ target: 'metaMask' }), injected({ target: 'rabby' })],
  transports,
  ssr: false,
});

export const EVM_WALLETS = [
  { id: 'metaMask', name: 'MetaMask' },
  { id: 'rabby', name: 'Rabby' },
] as const;

let solanaAdapters: BaseMessageSignerWalletAdapter[] | null = null;
export function getSolanaAdapters(): BaseMessageSignerWalletAdapter[] {
  if (!solanaAdapters) solanaAdapters = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
  return solanaAdapters;
}

export function solanaReady(adapter: BaseMessageSignerWalletAdapter): boolean {
  return adapter.readyState === WalletReadyState.Installed || adapter.readyState === WalletReadyState.Loadable;
}

/** Connects a Solana adapter and signs `message`; returns the base58 pubkey + base58 signature the gateway expects. */
export async function solanaSign(
  adapter: BaseMessageSignerWalletAdapter,
  getMessage: (wallet: string) => Promise<string>,
): Promise<{ wallet: string; signature: string }> {
  if (!adapter.connected) await adapter.connect();
  const pk = adapter.publicKey;
  if (!pk) throw new Error('Wallet did not expose a public key');
  const wallet = pk.toBase58();
  const message = await getMessage(wallet);
  const sig = await adapter.signMessage(new TextEncoder().encode(message));
  return { wallet, signature: bs58.encode(sig) };
}

export function evmInstalled(id: string): boolean {
  if (typeof window === 'undefined') return false;
  const eth = (window as unknown as { ethereum?: Record<string, unknown> & { providers?: Array<Record<string, unknown>> } })
    .ethereum;
  if (!eth) return false;
  const flag = id === 'metaMask' ? 'isMetaMask' : 'isRabby';
  if (eth.providers?.length) return eth.providers.some((p) => Boolean(p[flag]));
  return Boolean(eth[flag]);
}
