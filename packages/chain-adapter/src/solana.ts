import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { NotWiredError, type ChainAdapter, type ChainAdapterExtras, type HolderBalance, type StakeInfo, type SweepDetail } from './types.js';
import { assertBps, jsonRpc, JsonRpcError, toRaw, toUnits, type FetchLike } from './rpc.js';
import { averageSnapshots, replayBackward, timeWeightedBalances, type TransferEvent } from './timeweight.js';
import { balancesByOwner, dasTokenAccountsByMint, heliusTransfersForMint } from './solana/helius.js';
import { JupiterClient, type JupiterOptions } from './solana/jupiter.js';
import { chunk, sendInstructions, signAndSendVersioned, type SolanaRpc } from './solana/tx.js';

export interface BalanceSnapshot {
  ts: number;
  balances: Map<string, bigint>;
}
export interface SnapshotStore {
  get(): BalanceSnapshot | undefined;
  set(s: BalanceSnapshot): void;
}

export interface SolanaAdapterOptions {
  /** Solana (ideally Helius) RPC URL. Ignored when `rpc` is injected. */
  rpcUrl?: string;
  /** Token-2022 mint with the TransferFee extension. */
  mint?: string;
  decimals?: number;
  /** Treasury wallet (owner). Defaults to the signer. */
  treasury?: string;
  usdcMint?: string;
  /** Owner addresses never credited (pool vaults, lock, programs). */
  excludeWallets?: string[];
  /** Share of swept fees swapped to USDC for holders; the rest goes to the treasury in MESH. */
  holderShareBps?: number;
  slippageBps?: number;
  jupiter?: JupiterOptions;
  /** Helius API key for enhanced transactions (time-weighting). Without it: snapshot fallback. */
  heliusApiKey?: string;
  heliusApiBaseUrl?: string;
  /** How far before the window to scan for holdSinceTs (default 0 = window only). */
  holdSinceLookbackSec?: number;
  /** Build and quote everything but send nothing. */
  dryRun?: boolean;
  /** Withdraw-withheld authority and treasury owner. Required for collectFees/transferTokens. */
  signer?: Keypair;
  /** Accounts per withdrawWithheldTokensFromAccounts instruction (default 20). */
  harvestBatchSize?: number;

  // ---- injection (tests) ----
  rpc?: SolanaRpc;
  fetch?: FetchLike;
  snapshotStore?: SnapshotStore;
  now?: () => number;
}

export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/**
 * Solana adapter for a Token-2022 mint with the TransferFee extension.
 *  - fees: harvest withheld amounts → swap holder share to USDC (Jupiter) → treasury share to treasury ATA
 *  - balances: Helius DAS snapshot + enhanced-transactions replay for time-weighting (fallback: snapshot average)
 *  - signature verification: ed25519 (unchanged)
 */
export class SolanaAdapter implements ChainAdapter, ChainAdapterExtras {
  readonly chain = 'solana' as const;
  readonly rpc: SolanaRpc;
  private readonly jup: JupiterClient;
  private readonly snapshots: SnapshotStore;
  private decimalsCache?: number;
  private readonly now: () => number;
  /** Last full sweep breakdown (for logs / admin). */
  lastSweep?: SweepDetail;

  constructor(readonly opts: SolanaAdapterOptions = {}) {
    this.rpc = opts.rpc ?? jsonRpc(opts.rpcUrl ?? 'https://api.devnet.solana.com', { fetch: opts.fetch });
    this.jup = new JupiterClient({ fetch: opts.fetch, ...opts.jupiter });
    const mem: BalanceSnapshot[] = [];
    this.snapshots = opts.snapshotStore ?? { get: () => mem[0], set: (s) => void (mem[0] = s) };
    this.decimalsCache = opts.decimals;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ------------------------------------------------------------------ config helpers

  private mint(): PublicKey {
    if (!this.opts.mint) throw new NotWiredError('SolanaAdapter', 'mint not configured (config/deploy.<network>.json)');
    return new PublicKey(this.opts.mint);
  }
  private signer(): Keypair {
    if (!this.opts.signer) throw new NotWiredError('SolanaAdapter', 'signer keypair not configured (MESH_SOLANA_KEYPAIR)');
    return this.opts.signer;
  }
  private treasury(): PublicKey {
    return this.opts.treasury ? new PublicKey(this.opts.treasury) : this.signer().publicKey;
  }
  private usdc(): PublicKey {
    return new PublicKey(this.opts.usdcMint ?? USDC_MAINNET);
  }
  private ata(owner: PublicKey, mint = this.mint()): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  }
  private usdcAta(owner: PublicKey): PublicKey {
    // USDC is a classic SPL token
    return getAssociatedTokenAddressSync(this.usdc(), owner, true);
  }

  async decimals(): Promise<number> {
    if (this.decimalsCache !== undefined) return this.decimalsCache;
    const m = await this.fetchMint();
    this.decimalsCache = m.decimals;
    return m.decimals;
  }

  private async fetchMint() {
    const mint = this.mint();
    const r = await this.rpc.call<{ value: { data: [string, string]; owner: string } | null }>('getAccountInfo', [
      mint.toBase58(),
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    if (!r.value) throw new Error(`mint ${mint.toBase58()} not found`);
    const data = Buffer.from(r.value.data[0], 'base64');
    return unpackMint(mint, { data, owner: new PublicKey(r.value.owner), executable: false, lamports: 0 }, TOKEN_2022_PROGRAM_ID);
  }

  private excluded(): Set<string> {
    const s = new Set(this.opts.excludeWallets ?? []);
    if (this.opts.treasury) s.add(this.opts.treasury);
    if (this.opts.signer) s.add(this.opts.signer.publicKey.toBase58());
    if (this.opts.mint) s.add(this.opts.mint);
    return s;
  }

  // ------------------------------------------------------------------ withheld fees

  /** Every Token-2022 account of the mint with a non-zero withheld amount, plus the mint's own. */
  async withheld(): Promise<{ accounts: Array<{ address: PublicKey; withheld: bigint }>; mintWithheld: bigint; total: bigint }> {
    const mint = this.mint();
    const raw = await this.rpc.call<Array<{ pubkey: string; account: { data: [string, string]; owner: string } }>>(
      'getProgramAccounts',
      [
        TOKEN_2022_PROGRAM_ID.toBase58(),
        { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }] },
      ],
    );
    const accounts: Array<{ address: PublicKey; withheld: bigint }> = [];
    for (const a of raw) {
      const pk = new PublicKey(a.pubkey);
      const data = Buffer.from(a.account.data[0], 'base64');
      let acc;
      try {
        acc = unpackAccount(pk, { data, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 0 }, TOKEN_2022_PROGRAM_ID);
      } catch {
        continue; // not a token account (e.g. the mint itself matches offset 0 only by accident)
      }
      const w = getTransferFeeAmount(acc)?.withheldAmount ?? 0n;
      if (w > 0n) accounts.push({ address: pk, withheld: w });
    }
    const m = await this.fetchMint();
    const mintWithheld = getTransferFeeConfig(m)?.withheldAmount ?? 0n;
    const total = accounts.reduce((s, a) => s + a.withheld, 0n) + mintWithheld;
    return { accounts, mintWithheld, total };
  }

  async pendingFeesUsd(): Promise<number | null> {
    try {
      const { total } = await this.withheld();
      if (total === 0n) return 0;
      const q = await this.jup.quote({
        inputMint: this.mint().toBase58(),
        outputMint: this.usdc().toBase58(),
        amount: total,
        slippageBps: this.opts.slippageBps ?? 100,
      });
      return Number(BigInt(q.outAmount)) / 1e6;
    } catch {
      return null;
    }
  }

  async treasuryBalance(): Promise<number> {
    const bal = await this.tokenBalance(this.ata(this.treasury()));
    return toUnits(bal, await this.decimals());
  }

  private async tokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      const r = await this.rpc.call<{ value: { amount: string } }>('getTokenAccountBalance', [ata.toBase58(), { commitment: 'confirmed' }]);
      return BigInt(r.value.amount);
    } catch (err) {
      if (err instanceof JsonRpcError) return 0n; // account does not exist yet
      throw err;
    }
  }

  // ------------------------------------------------------------------ staking

  /**
   * The Anchor `mesh-staking` program (docs/STAKING.md, programs/mesh-staking) is designed but not
   * deployed: until the program id lands in the deploy json this always reports NotWired.
   */
  async getStakes(_wallets: string[]): Promise<StakeInfo[]> {
    throw new NotWiredError('SolanaAdapter', 'mesh-staking program not deployed (see docs/STAKING.md)');
  }

  // ------------------------------------------------------------------ ChainAdapter

  async collectFees(): Promise<{ amountUsd: number; txId: string }> {
    const d = await this.sweep();
    this.lastSweep = d;
    return { amountUsd: d.amountUsd, txId: d.txId };
  }

  /** Full sweep with breakdown. Honors `dryRun` (nothing is sent; quote values are used). */
  async sweep(): Promise<SweepDetail> {
    const signer = this.signer();
    const mint = this.mint();
    const decimals = await this.decimals();
    const dryRun = this.opts.dryRun ?? false;
    const holderBps = assertBps(this.opts.holderShareBps ?? 5000, 'holderShareBps');
    assertBps(this.opts.slippageBps ?? 100, 'slippageBps');
    const txIds: string[] = [];
    const { accounts, mintWithheld, total } = await this.withheld();
    if (total === 0n) {
      return { amountUsd: 0, txId: '', feeTokens: 0, swappedTokens: 0, usdcReceived: 0, treasuryTokens: 0, priceUsd: 0, dryRun, txIds };
    }

    // 1. withdraw withheld → signer's ATA (batched)
    const sweeperAta = this.ata(signer.publicKey);
    const first: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, sweeperAta, signer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    ];
    if (mintWithheld > 0n) {
      first.push(createWithdrawWithheldTokensFromMintInstruction(mint, sweeperAta, signer.publicKey, [], TOKEN_2022_PROGRAM_ID));
    }
    const batches = chunk(
      accounts.map((a) => a.address),
      this.opts.harvestBatchSize ?? 20,
    );
    const ixBatches: TransactionInstruction[][] = [];
    batches.forEach((b, i) => {
      const ix = createWithdrawWithheldTokensFromAccountsInstruction(mint, sweeperAta, signer.publicKey, [], b, TOKEN_2022_PROGRAM_ID);
      if (i === 0) first.push(ix);
      else ixBatches.push([ix]);
    });
    ixBatches.unshift(first);
    if (!dryRun) {
      for (const ixs of ixBatches) txIds.push(await sendInstructions(this.rpc, signer, ixs));
    }

    // 2. split
    const holderShare = (total * BigInt(holderBps)) / 10_000n;
    const treasuryShare = total - holderShare;

    // 3. swap holder share → USDC via Jupiter
    let usdcOut = 0n;
    if (holderShare > 0n) {
      const quote = await this.jup.quote({
        inputMint: mint.toBase58(),
        outputMint: this.usdc().toBase58(),
        amount: holderShare,
        slippageBps: this.opts.slippageBps ?? 100,
      });
      usdcOut = BigInt(quote.outAmount);
      if (!dryRun) {
        const usdcAta = this.usdcAta(signer.publicKey);
        const before = await this.tokenBalance(usdcAta);
        const swapTx = await this.jup.swapTransaction(quote, signer.publicKey.toBase58());
        txIds.push(await signAndSendVersioned(this.rpc, signer, swapTx));
        const after = await this.tokenBalance(usdcAta);
        if (after > before) usdcOut = after - before; // realized, not quoted
      }
    }

    // 4. treasury share → treasury ATA (skipped when the signer is the treasury)
    const treasury = this.treasury();
    if (treasuryShare > 0n && !treasury.equals(signer.publicKey) && !dryRun) {
      const tAta = this.ata(treasury);
      txIds.push(
        await sendInstructions(this.rpc, signer, [
          createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, tAta, treasury, mint, TOKEN_2022_PROGRAM_ID),
          createTransferCheckedInstruction(sweeperAta, mint, tAta, signer.publicKey, treasuryShare, decimals, [], TOKEN_2022_PROGRAM_ID),
        ]),
      );
    }

    const swappedTokens = toUnits(holderShare, decimals);
    const usdcReceived = Number(usdcOut) / 1e6;
    const priceUsd = swappedTokens > 0 ? usdcReceived / swappedTokens : 0;
    const feeTokens = toUnits(total, decimals);
    return {
      amountUsd: round6(feeTokens * priceUsd),
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
    const decimals = await this.decimals();
    const mint = this.mint().toBase58();
    const now = this.now();
    const endNow = await this.snapshotBalances();

    let states: Map<string, { weighted: bigint; holdSinceTs?: number }>;
    if (this.opts.heliusApiKey) {
      const lookback = this.opts.holdSinceLookbackSec ?? 0;
      const scanStart = w.from - lookback;
      const { events } = await heliusTransfersForMint(mint, scanStart, decimals, {
        apiKey: this.opts.heliusApiKey,
        baseUrl: this.opts.heliusApiBaseUrl,
        fetch: this.opts.fetch,
      });
      // balances at window end = now-snapshot minus everything after `to`
      const afterTo = events.filter((e) => e.ts >= w.to && e.ts <= Math.max(now, w.to));
      const atTo = replayBackward(endNow, afterTo);
      const inWindow = events.filter((e) => e.ts >= w.from && e.ts < w.to);
      const atFrom = replayBackward(atTo, inWindow);
      let startHoldSince: Map<string, number> | undefined;
      if (lookback > 0) {
        const pre = events.filter((e) => e.ts >= scanStart && e.ts < w.from);
        const atScanStart = replayBackward(atFrom, pre);
        const preStates = timeWeightedBalances({ from: scanStart, to: w.from, startBalances: atScanStart, events: pre });
        startHoldSince = new Map([...preStates].flatMap(([k, v]) => (v.holdSinceTs !== undefined ? [[k, v.holdSinceTs] as const] : [])));
      }
      states = timeWeightedBalances({ from: w.from, to: w.to, startBalances: atFrom, events: inWindow, startHoldSince });
    } else {
      // Fallback: average of the previous run's snapshot (if it is near `from`) and the current one.
      const prev = this.snapshots.get();
      const tol = Math.max(60, Math.floor((w.to - w.from) / 2));
      const avg = prev && Math.abs(prev.ts - w.from) <= tol ? averageSnapshots(prev.balances, endNow) : endNow;
      states = new Map([...avg].map(([k, v]) => [k, { weighted: v }]));
    }
    this.snapshots.set({ ts: now, balances: endNow });

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

  /** Current owner → balance via Helius DAS, falling back to getProgramAccounts on plain RPCs. */
  async snapshotBalances(): Promise<Map<string, bigint>> {
    const mint = this.mint();
    try {
      return balancesByOwner(await dasTokenAccountsByMint(this.rpc, mint.toBase58()));
    } catch (err) {
      if (!(err instanceof JsonRpcError && (err.code === -32601 || /not found|unknown method/i.test(err.message)))) throw err;
    }
    const raw = await this.rpc.call<Array<{ pubkey: string; account: { data: [string, string] } }>>('getProgramAccounts', [
      TOKEN_2022_PROGRAM_ID.toBase58(),
      { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }] },
    ]);
    const m = new Map<string, bigint>();
    for (const a of raw) {
      try {
        const acc = unpackAccount(
          new PublicKey(a.pubkey),
          { data: Buffer.from(a.account.data[0], 'base64'), owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 0 },
          TOKEN_2022_PROGRAM_ID,
        );
        if (acc.amount > 0n) m.set(acc.owner.toBase58(), (m.get(acc.owner.toBase58()) ?? 0n) + acc.amount);
      } catch {
        /* skip non-account */
      }
    }
    return m;
  }

  async transferTokens(to: string, amount: number): Promise<string> {
    const signer = this.signer();
    const mint = this.mint();
    const decimals = await this.decimals();
    const raw = toRaw(amount, decimals);
    if (raw <= 0n) throw new Error('amount must be > 0');
    const dest = new PublicKey(to);
    const fromAta = this.ata(signer.publicKey);
    const toAta = this.ata(dest);
    if (this.opts.dryRun) return 'dry-run';
    return sendInstructions(this.rpc, signer, [
      createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, toAta, dest, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(fromAta, mint, toAta, signer.publicKey, raw, decimals, [], TOKEN_2022_PROGRAM_ID),
    ]);
  }

  /**
   * ed25519 over the UTF-8 message bytes. The signature may be base58 (Phantom, Solflare), base64
   * (wallets that hand back a Uint8Array which the web app serialised), hex, or a JSON byte array;
   * every decoding that yields 64 bytes is tried, so a base64 string that also happens to be valid
   * base58 cannot be rejected by picking the wrong alphabet first.
   */
  verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
    try {
      const pubkey = bs58.decode(wallet.trim());
      if (pubkey.length !== 32) return false;
      const msg = new TextEncoder().encode(message);
      for (const sig of decodeSignatureCandidates(signature)) {
        if (nacl.sign.detached.verify(msg, sig, pubkey)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export type { TransferEvent };

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Every 64-byte interpretation of `sig` (base58, base64/base64url, hex, JSON byte array), deduplicated. */
export function decodeSignatureCandidates(sig: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  const push = (b: Uint8Array | null | undefined) => {
    if (!b || b.length !== 64) return;
    const key = Buffer.from(b).toString('hex');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(b);
  };
  const s = sig.trim();
  if (!s) return out;
  if (s.startsWith('[') || s.startsWith('{')) {
    // JSON: `[1,2,...]` or `{"0":1,"1":2,...}` (a Uint8Array run through JSON.stringify) or `{signature: ...}`.
    try {
      const parsed = JSON.parse(s) as unknown;
      const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? bytesFromObject(parsed as Record<string, unknown>) : null;
      if (arr && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) push(Uint8Array.from(arr));
    } catch {
      /* not JSON */
    }
    return out;
  }
  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{128}$/.test(hex)) push(Uint8Array.from(Buffer.from(hex, 'hex')));
  try {
    push(bs58.decode(s));
  } catch {
    /* not base58 */
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) push(new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
  return out;
}

function bytesFromObject(o: Record<string, unknown>): number[] | null {
  if (Array.isArray(o.signature)) return o.signature as number[];
  if (o.signature && typeof o.signature === 'object') return bytesFromObject(o.signature as Record<string, unknown>);
  if (o.data && Array.isArray(o.data)) return o.data as number[]; // Buffer.toJSON()
  const keys = Object.keys(o);
  if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) return null;
  return keys.map((k) => Number(k)).sort((a, b) => a - b).map((k) => o[String(k)] as number);
}

/** Parse MESH_SOLANA_KEYPAIR: base58 secret key, JSON byte array, or a path to a solana-keygen file. */
export function keypairFromEnv(value: string | undefined): Keypair | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(v) as number[]));
  if (v.endsWith('.json') || v.startsWith('/') || v.startsWith('.')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(v, 'utf8')) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(v));
}
