// Wallet plumbing. EVM via wagmi/viem: every wallet that announces itself through EIP-6963 (Phantom,
// MetaMask, Rabby, Coinbase Wallet, Rainbow, Brave…) becomes a connector with its own name + icon, no
// flag sniffing on `window.ethereum`. Solana via @solana/wallet-adapter (Phantom, Solflare), kept behind
// the chain toggle for a `solana` DEFAULT_CHAIN.
import { WalletReadyState, type BaseMessageSignerWalletAdapter } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import bs58 from 'bs58';
import { numberToHex, type Chain, type Transport } from 'viem';
import { http, createConfig, type Connector } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { ROBINHOOD_CHAIN, STAKING_TARGET } from './staking';

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

// Robinhood Chain first (where $MESH lives), then mainnet + Base. The chain MeshStaking is deployed on
// (config/deploy.<network>.json) joins the list if it is none of those, so wagmi can switch to it to stake.
// Signing in never needs a switch: SIWE is a personal_sign on whatever chain the wallet is on.
const KNOWN: Chain[] = [ROBINHOOD_CHAIN, mainnet, base];
const stakingChain = STAKING_TARGET?.chain ?? null;
const extraChains: Chain[] = stakingChain && !KNOWN.some((c) => c.id === stakingChain.id) ? [stakingChain] : [];
const chains = [...KNOWN, ...extraChains] as unknown as readonly [Chain, ...Chain[]];
const transports: Record<number, Transport> = {};
for (const c of chains) transports[c.id] = http(c.rpcUrls.default.http[0] || undefined);

/** Id of the generic fallback connector (a `window.ethereum` that announces nothing over EIP-6963). */
export const GENERIC_INJECTED_ID = 'injected';

export const wagmiConfig = createConfig({
  chains,
  // EIP-6963 discovery (on by default) adds one connector per announced wallet, id = its rdns
  // ("app.phantom", "io.metamask", "io.rabby", …), with the wallet's own name and icon. The plain
  // `injected()` is the fallback for a legacy wallet that only sets `window.ethereum`.
  multiInjectedProviderDiscovery: true,
  connectors: [injected()],
  transports,
  ssr: false,
});

export interface EvmWalletOption {
  id: string;
  name: string;
  icon: string | null;
  connector: Connector;
}

/**
 * The EVM wallets to list in the connect modal: every EIP-6963-announced wallet, plus the generic
 * `window.ethereum` only when it exists and nothing announced itself (so it is never a dead button).
 * Nothing here opens an install page: a wallet that is not installed is simply not in the list.
 */
export function evmWalletOptions(connectors: readonly Connector[]): EvmWalletOption[] {
  const announced = connectors.filter((c) => c.type === 'injected' && c.id !== GENERIC_INJECTED_ID);
  if (announced.length) {
    return announced.map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? null, connector: c }));
  }
  const generic = connectors.find((c) => c.id === GENERIC_INJECTED_ID);
  if (generic && hasWindowEthereum()) return [{ id: generic.id, name: 'Browser wallet', icon: generic.icon ?? null, connector: generic }];
  return [];
}

export function hasWindowEthereum(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { ethereum?: unknown }).ethereum);
}

/** Parameters for `wallet_addEthereumChain` (EIP-3085) for the chain $MESH lives on. */
export function addChainParams(chain: Chain = ROBINHOOD_CHAIN) {
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers?.default ? [chain.blockExplorers.default.url] : undefined,
  };
}

/**
 * Optional: asks the wallet to add (and switch to) Robinhood Chain. Sign-in never requires this; the
 * Stake page needs the chain, and holders like having it in the wallet to see their $MESH.
 */
export async function addRobinhoodChain(connector: Connector, chain: Chain = ROBINHOOD_CHAIN): Promise<void> {
  const provider = (await connector.getProvider()) as { request(args: { method: string; params?: unknown[] }): Promise<unknown> } | undefined;
  if (!provider) throw new Error('Wallet not detected');
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] });
  } catch (err) {
    // 4902 = unknown chain: add it (the wallet then switches). Anything else (user rejected…) bubbles up.
    const code = (err as { code?: number })?.code;
    if (code === 4902 || /unrecognized|not added|4902/i.test((err as Error)?.message ?? '')) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(chain)] });
    } else throw err;
  }
}

let solanaAdapters: BaseMessageSignerWalletAdapter[] | null = null;
export function getSolanaAdapters(): BaseMessageSignerWalletAdapter[] {
  if (!solanaAdapters) solanaAdapters = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
  return solanaAdapters;
}

/**
 * Only an *Installed* adapter is usable. `Loadable` means "not installed, but connect() can redirect the
 * whole page to the wallet's website / in-app browser" (Solflare reports Loadable on every desktop, Phantom
 * on iOS Safari) — that redirect is exactly the "takes me to an advert for another wallet" bug, so it is
 * never treated as ready and never triggered.
 */
export function solanaReady(adapter: BaseMessageSignerWalletAdapter): boolean {
  return adapter.readyState === WalletReadyState.Installed;
}

/** Connects a Solana adapter and signs `message`; returns the base58 pubkey + base58 signature the gateway expects. */
export async function solanaSign(
  adapter: BaseMessageSignerWalletAdapter,
  getMessage: (wallet: string) => Promise<string>,
): Promise<{ wallet: string; signature: string }> {
  if (!solanaReady(adapter)) throw new Error(`${adapter.name} is not installed in this browser`);
  if (!adapter.connected) await adapter.connect();
  const pk = adapter.publicKey;
  if (!pk) throw new Error('Wallet did not expose a public key');
  const wallet = pk.toBase58();
  const message = await getMessage(wallet);
  const sig = await adapter.signMessage(new TextEncoder().encode(message));
  return { wallet, signature: bs58.encode(sig) };
}
