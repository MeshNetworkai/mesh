import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashMessage,
  http,
  isAddress,
  parseSignature,
  type Abi,
  type Account,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { publicKeyToAddress } from 'viem/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { NotWiredError, type ChainAdapter, type ChainAdapterExtras, type HolderBalance, type StakeInfo, type SweepDetail } from './types.js';
import { assertBps, toRaw, toUnits } from './rpc.js';
import { timeWeightedBalances } from './timeweight.js';
import { erc20Abi, feeVaultAbi, meshStakingAbi, quoterV2Abi, swapRouter02Abi } from './evm/abi.js';
import {
  applyToState,
  BlockTimestamps,
  memoryStateStore,
  scanTransfers,
  toEvents,
  type EvmBalanceState,
  type EvmStateStore,
} from './evm/holders.js';

export type { EvmBalanceState, EvmStateStore } from './evm/holders.js';
export { memoryStateStore } from './evm/holders.js';

/** Pluggable DEX leg of the sweep (Uniswap v3 by default; 0x / 1inch can implement the same two calls). */
export interface Swapper {
  /** Expected USDC out (base units, 6 decimals) for `amountIn` MESH. */
  quote(amountIn: bigint): Promise<bigint>;
  /** Execute MESH → USDC to `recipient`; returns the tx hash. Caller handles the ERC-20 approval. */
  swap(amountIn: bigint, minOut: bigint, recipient: Address): Promise<Hex>;
  /** Address that must be approved to pull MESH. */
  spender: Address;
}

export interface EvmAdapterOptions {
  rpcUrl?: string;
  chainId?: number;
  tokenAddress?: Address;
  feeVault?: Address;
  /** MeshStaking (optional; getStakes throws NotWiredError without it). */
  staking?: Address;
  treasury?: Address;
  usdc?: Address;
  /** Uniswap v3 SwapRouter02 + QuoterV2 (optional; without a quoter minOut falls back to 0 + slippage check skipped). */
  swapRouter?: Address;
  quoter?: Address;
  poolFee?: number;
  deployBlock?: number;
  decimals?: number;
  excludeWallets?: string[];
  holderShareBps?: number;
  slippageBps?: number;
  logChunkBlocks?: number;
  /** Fetch exact timestamps for up to this many distinct blocks per window, else interpolate. */
  maxExactTimestampBlocks?: number;
  dryRun?: boolean;
  /** Sweeper key: FeeVault owner + treasury (or treasury-approved spender). */
  privateKey?: Hex;
  account?: Account;

  // ---- injection (tests) ----
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  swapper?: Swapper;
  stateStore?: EvmStateStore;
  now?: () => number;
}

export const KNOWN_CHAINS: Record<number, { name: string; rpc?: string; usdc?: Address; swapRouter?: Address; quoter?: Address }> = {
  8453: {
    name: 'Base',
    rpc: 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  },
  84532: {
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
  },
  // Robinhood Chain (Arbitrum Orbit L2), mainnet id 4663. No public RPC / USDC / router is hard-coded:
  // set rpcUrl + usdc + swapRouter in config/deploy.robinhood.json (testnet: parameterise chainId too).
  4663: { name: 'Robinhood Chain' },
  31337: { name: 'Anvil', rpc: 'http://127.0.0.1:8545' },
};

/**
 * EVM adapter for MeshToken + FeeVault.
 *  - fees: FeeVault.sweep → swap holder share to USDC (Uniswap v3) → treasury share to treasury
 *  - balances: Transfer-log replay (chunked eth_getLogs) with a persisted state so each epoch is incremental;
 *    time-weighted over the window, holdSinceTs from the last inbound-after-zero (reset on transfer out)
 *  - signature verification: EIP-191 personal_sign (unchanged)
 */
export class EvmAdapter implements ChainAdapter, ChainAdapterExtras {
  readonly chain = 'evm' as const;
  readonly publicClient: PublicClient;
  private walletClient?: WalletClient;
  private readonly store: EvmStateStore;
  private readonly now: () => number;
  private decimalsCache?: number;
  lastSweep?: SweepDetail;

  constructor(readonly opts: EvmAdapterOptions = {}) {
    const chainId = opts.chainId ?? 31337;
    const known = KNOWN_CHAINS[chainId];
    const chain: ViemChain = defineChain({
      id: chainId,
      name: known?.name ?? `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl ?? known?.rpc ?? 'http://127.0.0.1:8545'] } },
    });
    this.publicClient = opts.publicClient ?? createPublicClient({ chain, transport: http(opts.rpcUrl ?? known?.rpc) });
    const account = opts.account ?? (opts.privateKey ? privateKeyToAccount(opts.privateKey) : undefined);
    this.walletClient =
      opts.walletClient ?? (account ? createWalletClient({ chain, account, transport: http(opts.rpcUrl ?? known?.rpc) }) : undefined);
    this.store = opts.stateStore ?? memoryStateStore();
    this.decimalsCache = opts.decimals;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ------------------------------------------------------------------ config helpers

  private token(): Address {
    if (!this.opts.tokenAddress) throw new NotWiredError('EvmAdapter', 'tokenAddress not configured (config/deploy.<network>.json)');
    return this.opts.tokenAddress;
  }
  private vault(): Address {
    if (!this.opts.feeVault) throw new NotWiredError('EvmAdapter', 'feeVault not configured');
    return this.opts.feeVault;
  }
  private stakingAddr(): Address {
    if (!this.opts.staking) throw new NotWiredError('EvmAdapter', 'staking contract not configured (deploy json `staking`)');
    return this.opts.staking;
  }
  private wallet(): WalletClient & { account: Account } {
    if (!this.walletClient?.account) throw new NotWiredError('EvmAdapter', 'signer not configured (MESH_EVM_PRIVATE_KEY)');
    return this.walletClient as WalletClient & { account: Account };
  }
  private signerAddress(): Address {
    return this.wallet().account.address;
  }
  private treasury(): Address {
    return this.opts.treasury ?? this.signerAddress();
  }
  private usdc(): Address {
    const u = this.opts.usdc ?? KNOWN_CHAINS[this.opts.chainId ?? 0]?.usdc;
    if (!u) throw new NotWiredError('EvmAdapter', 'usdc address not configured');
    return u;
  }
  private excluded(): Set<string> {
    const s = new Set((this.opts.excludeWallets ?? []).map((w) => w.toLowerCase()));
    if (this.opts.treasury) s.add(this.opts.treasury.toLowerCase());
    if (this.opts.feeVault) s.add(this.opts.feeVault.toLowerCase());
    if (this.opts.tokenAddress) s.add(this.opts.tokenAddress.toLowerCase());
    if (this.opts.staking) s.add(this.opts.staking.toLowerCase()); // staked tokens are not "held" for distribution
    if (this.walletClient?.account) s.add(this.walletClient.account.address.toLowerCase());
    return s;
  }

  async decimals(): Promise<number> {
    if (this.decimalsCache !== undefined) return this.decimalsCache;
    this.decimalsCache = await this.publicClient.readContract({ address: this.token(), abi: erc20Abi, functionName: 'decimals' });
    return this.decimalsCache;
  }

  private swapper(): Swapper {
    if (this.opts.swapper) return this.opts.swapper;
    const known = KNOWN_CHAINS[this.opts.chainId ?? 0];
    const router = this.opts.swapRouter ?? known?.swapRouter;
    if (!router) throw new NotWiredError('EvmAdapter', 'swapRouter not configured');
    const quoter = this.opts.quoter ?? known?.quoter;
    return uniswapV3Swapper({
      publicClient: this.publicClient,
      wallet: () => this.wallet(),
      router,
      quoter,
      tokenIn: this.token(),
      tokenOut: this.usdc(),
      fee: this.opts.poolFee ?? 3000,
    });
  }

  private async write(req: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<Hex> {
    const w = this.wallet();
    const hash = await w.writeContract({ ...req, account: w.account, chain: w.chain } as unknown as Parameters<WalletClient['writeContract']>[0]);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
    return hash;
  }

  // ------------------------------------------------------------------ extras

  async pendingFeesUsd(): Promise<number | null> {
    try {
      const pending = await this.publicClient.readContract({ address: this.vault(), abi: feeVaultAbi, functionName: 'pending', args: [this.token()] });
      if (pending === 0n) return 0;
      const out = await this.swapper().quote(pending);
      return Number(out) / 1e6;
    } catch {
      return null;
    }
  }

  async treasuryBalance(): Promise<number> {
    const b = await this.publicClient.readContract({ address: this.token(), abi: erc20Abi, functionName: 'balanceOf', args: [this.treasury()] });
    return toUnits(b, await this.decimals());
  }

  // ------------------------------------------------------------------ staking

  /** Whether a MeshStaking address is configured (the gateway checks this before caching tiers). */
  get stakingEnabled(): boolean {
    return Boolean(this.opts.staking);
  }

  /**
   * Positions from MeshStaking.positionOf, one read per wallet (multicall when the client supports
   * it is a later optimisation; epochs are hourly and the gateway caches per epoch).
   */
  async getStakes(wallets: string[]): Promise<StakeInfo[]> {
    const staking = this.stakingAddr();
    const decimals = await this.decimals();
    const out: StakeInfo[] = [];
    for (const wallet of wallets) {
      if (!isAddress(wallet)) {
        out.push({ wallet, staked: 0, lockDays: 0, lockEndsAt: 0 });
        continue;
      }
      const p = await this.publicClient.readContract({ address: staking, abi: meshStakingAbi, functionName: 'positionOf', args: [wallet] });
      out.push({ wallet, staked: toUnits(p.amount, decimals), lockDays: Number(p.lockDays), lockEndsAt: Number(p.lockEndsAt) });
    }
    return out;
  }

  // ------------------------------------------------------------------ ChainAdapter

  async collectFees(): Promise<{ amountUsd: number; txId: string }> {
    const d = await this.sweep();
    this.lastSweep = d;
    return { amountUsd: d.amountUsd, txId: d.txId };
  }

  async sweep(): Promise<SweepDetail> {
    const token = this.token();
    const vault = this.vault();
    const decimals = await this.decimals();
    const dryRun = this.opts.dryRun ?? false;
    const holderBps = assertBps(this.opts.holderShareBps ?? 5000, 'holderShareBps');
    assertBps(this.opts.slippageBps ?? 100, 'slippageBps');
    const txIds: Hex[] = [];
    const total = await this.publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: 'pending', args: [token] });
    if (total === 0n) {
      return { amountUsd: 0, txId: '', feeTokens: 0, swappedTokens: 0, usdcReceived: 0, treasuryTokens: 0, priceUsd: 0, dryRun, txIds };
    }
    const me = this.signerAddress();
    const holderShare = (total * BigInt(holderBps)) / 10_000n;
    const treasuryShare = total - holderShare;
    const swapper = this.swapper();
    const quoted = holderShare > 0n ? await swapper.quote(holderShare) : 0n;
    let usdcOut = quoted;

    if (!dryRun) {
      // 1. vault → sweeper
      txIds.push(await this.write({ address: vault, abi: feeVaultAbi, functionName: 'sweep', args: [token, me] }));
      // 2. holder share → USDC
      if (holderShare > 0n) {
        const usdc = this.usdc();
        const before = await this.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
        const minOut = (quoted * BigInt(10_000 - (this.opts.slippageBps ?? 100))) / 10_000n;
        txIds.push(await this.write({ address: token, abi: erc20Abi, functionName: 'approve', args: [swapper.spender, holderShare] }));
        const h = await swapper.swap(holderShare, minOut, me);
        const r = await this.publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== 'success') throw new Error(`swap ${h} reverted`);
        txIds.push(h);
        const after = await this.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
        if (after > before) usdcOut = after - before;
      }
      // 3. treasury share → treasury
      const treasury = this.treasury();
      if (treasuryShare > 0n && treasury.toLowerCase() !== me.toLowerCase()) {
        txIds.push(await this.write({ address: token, abi: erc20Abi, functionName: 'transfer', args: [treasury, treasuryShare] }));
      }
    }

    const swappedTokens = toUnits(holderShare, decimals);
    const usdcReceived = Number(usdcOut) / 1e6;
    const priceUsd = swappedTokens > 0 ? usdcReceived / swappedTokens : 0;
    const feeTokens = toUnits(total, decimals);
    return {
      amountUsd: Math.round(feeTokens * priceUsd * 1e6) / 1e6,
      txId: txIds[0] ?? (dryRun ? 'dry-run' : ''),
      feeTokens,
      swappedTokens,
      usdcReceived,
      treasuryTokens: toUnits(treasuryShare, decimals),
      priceUsd,
      dryRun,
      txIds,
    };
  }

  async getHolderBalances(w: { from: number; to: number }): Promise<HolderBalance[]> {
    const token = this.token();
    const decimals = await this.decimals();
    const chunk = BigInt(this.opts.logChunkBlocks ?? 5000);
    const ts = new BlockTimestamps(this.publicClient);
    const latest = await this.publicClient.getBlockNumber();
    const deploy = BigInt(this.opts.deployBlock ?? 0);

    const state: EvmBalanceState = this.store.load() ?? { block: deploy - 1n, balances: new Map(), holdSince: new Map() };
    // Window end block: last block at or before `to` (never past latest).
    const toBlock = await ts.blockAtOrBefore(w.to, latest, deploy);
    if (toBlock > state.block) {
      const raw = await scanTransfers(this.publicClient, token, state.block + 1n, toBlock, chunk);
      // Window start block (first block with ts >= from) — everything before it is "history".
      const fromBlock = (await ts.get(deploy)) >= w.from ? deploy : (await ts.blockAtOrBefore(w.from - 1, toBlock, deploy)) + 1n;
      const history = raw.filter((r) => r.block < fromBlock);
      const window = raw.filter((r) => r.block >= fromBlock);
      const histTs = await ts.resolve(history.map((r) => r.block), 0); // interpolate (holdSince precision: minutes)
      const winTs = await ts.resolve(window.map((r) => r.block), this.opts.maxExactTimestampBlocks ?? 300);
      applyToState(state, toEvents(history, histTs), fromBlock - 1n);
      const startBalances = new Map(state.balances);
      const startHoldSince = new Map(state.holdSince);
      const winEvents = toEvents(window, winTs);
      const states = timeWeightedBalances({ from: w.from, to: w.to, startBalances, events: winEvents, startHoldSince });
      applyToState(state, winEvents, toBlock);
      this.store.save(state);
      return this.toHolderBalances(states, decimals);
    }
    // Nothing new on chain since the state was built (or window entirely in the past of the state):
    // constant balances → time-weighted == current.
    const states = timeWeightedBalances({ from: w.from, to: w.to, startBalances: state.balances, events: [], startHoldSince: state.holdSince });
    return this.toHolderBalances(states, decimals);
  }

  private toHolderBalances(states: Map<string, { weighted: bigint; holdSinceTs?: number }>, decimals: number): HolderBalance[] {
    const excluded = this.excluded();
    const out: HolderBalance[] = [];
    for (const [wallet, s] of states) {
      if (excluded.has(wallet) || s.weighted <= 0n) continue;
      out.push({
        wallet,
        timeWeightedBalance: toUnits(s.weighted, decimals),
        ...(s.holdSinceTs !== undefined ? { holdSinceTs: s.holdSinceTs } : {}),
      });
    }
    return out.sort((a, b) => a.wallet.localeCompare(b.wallet));
  }

  async transferTokens(to: string, amount: number): Promise<string> {
    if (!isAddress(to)) throw new Error(`invalid address ${to}`);
    const raw = toRaw(amount, await this.decimals());
    if (raw <= 0n) throw new Error('amount must be > 0');
    if (this.opts.dryRun) return 'dry-run';
    const me = this.signerAddress();
    const treasury = this.treasury();
    if (treasury.toLowerCase() === me.toLowerCase()) {
      return this.write({ address: this.token(), abi: erc20Abi, functionName: 'transfer', args: [to, raw] });
    }
    // Treasury is a separate wallet (multisig): it must have approved the sweeper.
    return this.write({ address: this.token(), abi: erc20Abi, functionName: 'transferFrom', args: [treasury, to, raw] });
  }

  /**
   * EIP-191 `personal_sign` check. Tolerant of what wallets actually send: `0X` / uppercase / lowercase /
   * checksummed addresses (compared case-insensitively, never by checksum), signatures with or without
   * `0x`, `v` as 0/1, 27/28 or EIP-155 style, and 64-byte EIP-2098 compact signatures.
   */
  verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
    try {
      const addr = normalizeEvmAddress(wallet);
      if (!addr) return false;
      const recovered = recoverMessageAddressSync(message, normalizeEvmSignature(signature));
      return recovered.toLowerCase() === addr;
    } catch {
      return false;
    }
  }
}

/** Lowercase `0x` + 40 hex, or null when the string is not an address at all. Checksum is NOT required. */
export function normalizeEvmAddress(wallet: string): `0x${string}` | null {
  const w = wallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) return null;
  return isAddress(w, { strict: false }) ? (w as `0x${string}`) : null;
}

/**
 * Canonical 65-byte `0x` hex signature with v in {27, 28}. Accepts: missing `0x`, uppercase hex, v as
 * 0/1 (Ledger, some hardware wallets), v >= 35 (chain-id folded in), and 64-byte EIP-2098 compact form.
 */
export function normalizeEvmSignature(signature: string): Hex {
  let hex = signature.trim();
  if (/^0x/i.test(hex)) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('signature is not hex');
  hex = hex.toLowerCase();
  if (hex.length === 128) {
    // EIP-2098: yParity lives in the top bit of s.
    const r = hex.slice(0, 64);
    const yParityAndS = BigInt(`0x${hex.slice(64)}`);
    const yParity = Number(yParityAndS >> 255n);
    const s = (yParityAndS & ((1n << 255n) - 1n)).toString(16).padStart(64, '0');
    return `0x${r}${s}${(27 + yParity).toString(16)}`;
  }
  // 65 bytes normally; an EIP-155 style v (35 + 2 * chainId) can take a few more bytes.
  if (hex.length < 130 || hex.length > 128 + 16) throw new Error(`signature must be 64 or 65 bytes (got ${hex.length / 2})`);
  const vRaw = Number.parseInt(hex.slice(128), 16);
  let v: number;
  if (vRaw === 0 || vRaw === 1) v = 27 + vRaw;
  else if (vRaw === 27 || vRaw === 28) v = vRaw;
  else if (vRaw >= 35) v = 27 + ((vRaw - 35) % 2);
  else throw new Error(`invalid recovery byte ${vRaw}`);
  return `0x${hex.slice(0, 128)}${v.toString(16)}`;
}

/** Uniswap v3 SwapRouter02 + QuoterV2 (works against any router with the same selector, e.g. the test MockSwapRouter). */
export function uniswapV3Swapper(p: {
  publicClient: PublicClient;
  wallet: () => WalletClient & { account: Account };
  router: Address;
  quoter?: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
}): Swapper {
  return {
    spender: p.router,
    async quote(amountIn) {
      if (!p.quoter) return 0n;
      const { result } = await p.publicClient.simulateContract({
        address: p.quoter,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    },
    async swap(amountIn, minOut, recipient) {
      const w = p.wallet();
      return w.writeContract({
        address: p.router,
        abi: swapRouter02Abi,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
        account: w.account,
        chain: w.chain,
      });
    },
  };
}

/** Synchronous equivalent of viem's recoverMessageAddress. */
export function recoverMessageAddressSync(message: string, signature: Hex): `0x${string}` {
  const digest = hashMessage(message).slice(2);
  const { r, s, yParity, v } = parseSignature(signature);
  const recovery = yParity ?? (v !== undefined ? Number(v) - 27 : undefined);
  if (recovery !== 0 && recovery !== 1) throw new Error('invalid recovery id');
  const sig = secp256k1.Signature.fromCompact(r.slice(2) + s.slice(2)).addRecoveryBit(recovery);
  const pub = sig.recoverPublicKey(digest).toHex(false);
  return publicKeyToAddress(`0x${pub}`);
}
