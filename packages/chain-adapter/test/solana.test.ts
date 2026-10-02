import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { SolanaAdapter, USDC_DEVNET } from '../src/solana.js';
import { fakeRpc } from '../src/rpc.js';
import { b64, encodeMint, encodeTokenAccount } from './helpers/token2022.js';

const DEC = 6;
const u = (n: number) => BigInt(Math.round(n * 10 ** DEC));

function world() {
  const signer = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const alice = Keypair.generate().publicKey;
  const bob = Keypair.generate().publicKey;
  const carol = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const T = 1_700_000_000; // window end
  const now = T + 60;

  const balances: Array<[PublicKey, bigint, bigint]> = [
    [alice, u(10_000), 500_000n],
    [bob, u(5_000), 250_000n],
    [carol, u(500), 0n],
    [pool, u(100_000), 0n],
  ];
  const sent: Buffer[] = [];
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_DEVNET), signer.publicKey, true);
  let usdcBalance = 0n;

  const rpc = fakeRpc({
    getAccountInfo: () => ({
      value: {
        data: [b64(encodeMint({ decimals: DEC, supply: u(1_000_000), authority: signer.publicKey, feeBps: 150, maxFee: u(1000), withheld: 1_000n })), 'base64'],
        owner: TOKEN_2022_PROGRAM_ID.toBase58(),
      },
    }),
    getProgramAccounts: () =>
      balances.map(([owner, amount, withheld]) => ({
        pubkey: getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID).toBase58(),
        account: { data: [b64(encodeTokenAccount({ mint, owner, amount, withheld })), 'base64'], owner: TOKEN_2022_PROGRAM_ID.toBase58() },
      })),
    getTokenAccounts: (params) => {
      const p = params as { page: number; limit: number };
      const all = balances.map(([owner, amount]) => ({
        address: getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID).toBase58(),
        mint: mint.toBase58(),
        owner: owner.toBase58(),
        amount: amount.toString(),
      }));
      const start = (p.page - 1) * p.limit;
      return { total: all.length, token_accounts: all.slice(start, start + p.limit) };
    },
    getLatestBlockhash: () => ({ value: { blockhash: bs58.encode(nacl.randomBytes(32)), lastValidBlockHeight: 1000 } }),
    sendTransaction: (params) => {
      const [raw] = params as [string];
      sent.push(Buffer.from(raw, 'base64'));
      // the swap credits USDC
      if (sent.length >= 1) usdcBalance = 3_755n;
      return bs58.encode(nacl.randomBytes(64));
    },
    getSignatureStatuses: () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    getTokenAccountBalance: (params) => {
      const [addr] = params as [string];
      if (addr === usdcAta.toBase58()) return { value: { amount: usdcBalance.toString() } };
      return { value: { amount: '0' } };
    },
  });

  const heliusTxs = [
    // after the window: alice → bob 1000 (must be undone to get balances at T)
    { signature: 'sig-after', timestamp: T + 30, tokenTransfers: [{ fromUserAccount: alice.toBase58(), toUserAccount: bob.toBase58(), mint: mint.toBase58(), tokenAmount: 1000 }] },
    // mid-window: bob → alice 2000
    { signature: 'sig-mid', timestamp: T - 1800, tokenTransfers: [{ fromUserAccount: bob.toBase58(), toUserAccount: alice.toBase58(), mint: mint.toBase58(), tokenAmount: 2000 }] },
    // other mint, ignored
    { signature: 'sig-other', timestamp: T - 1900, tokenTransfers: [{ fromUserAccount: bob.toBase58(), toUserAccount: alice.toBase58(), mint: 'other', tokenAmount: 999 }] },
    // before the window: stops the walk
    { signature: 'sig-old', timestamp: T - 7200, tokenTransfers: [{ fromUserAccount: null, toUserAccount: alice.toBase58(), mint: mint.toBase58(), tokenAmount: 9000 }] },
  ];
  const fetched: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    fetched.push(url);
    if (url.includes('/v0/addresses/')) {
      const before = new URL(url).searchParams.get('before');
      const body = before ? [] : heliusTxs;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes('/quote')) {
      const amount = BigInt(new URL(url).searchParams.get('amount')!);
      // $0.01 per MESH: 1e6 raw MESH → 10_000 raw USDC
      return new Response(JSON.stringify({ inputMint: mint.toBase58(), outputMint: USDC_DEVNET, inAmount: amount.toString(), outAmount: (amount / 100n).toString(), otherAmountThreshold: '0', slippageBps: 100 }));
    }
    if (url.includes('/swap')) {
      const body = JSON.parse(String(init?.body)) as { userPublicKey: string };
      const msg = new TransactionMessage({ payerKey: new PublicKey(body.userPublicKey), recentBlockhash: bs58.encode(nacl.randomBytes(32)), instructions: [] }).compileToV0Message();
      return new Response(JSON.stringify({ swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64') }));
    }
    return new Response('not found', { status: 404 });
  };

  const make = (extra: Partial<ConstructorParameters<typeof SolanaAdapter>[0]> = {}) =>
    new SolanaAdapter({
      rpc,
      fetch,
      signer,
      mint: mint.toBase58(),
      decimals: DEC,
      treasury: treasury.toBase58(),
      usdcMint: USDC_DEVNET,
      excludeWallets: [pool.toBase58()],
      holderShareBps: 5000,
      heliusApiKey: 'test-key',
      now: () => now,
      ...extra,
    });

  return { signer, treasury, alice, bob, carol, pool, mint, T, now, rpc, sent, fetched, make };
}

describe('SolanaAdapter.collectFees', () => {
  it('harvests withheld fees, swaps the holder share via Jupiter, forwards the treasury share', async () => {
    const w = world();
    const a = w.make();
    const res = await a.collectFees();
    const d = a.lastSweep!;
    // 1_000 (mint) + 500_000 + 250_000 withheld = 0.751 MESH
    expect(d.feeTokens).toBeCloseTo(0.751, 9);
    expect(d.swappedTokens).toBeCloseTo(0.3755, 9);
    expect(d.treasuryTokens).toBeCloseTo(0.3755, 9);
    expect(d.usdcReceived).toBeCloseTo(0.003755, 9); // measured from the USDC ATA delta
    expect(d.priceUsd).toBeCloseTo(0.01, 9);
    expect(res.amountUsd).toBeCloseTo(0.00751, 9);
    expect(res.txId).toBe(d.txIds[0]);
    // txs: 1 withdraw batch (ATA create + from-mint + from-accounts), 1 swap, 1 treasury transfer
    expect(w.sent).toHaveLength(3);
    const first = Transaction.from(w.sent[0]);
    expect(first.instructions).toHaveLength(3);
    expect(first.instructions.slice(1).every((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
    // withdraw-from-accounts lists the 2 accounts with withheld > 0 (alice, bob) after mint/dest/authority
    expect(first.instructions[2].keys.length).toBe(3 + 2);
    const treasuryTx = Transaction.from(w.sent[2]);
    expect(treasuryTx.instructions).toHaveLength(2);
    expect(w.fetched.some((u) => u.includes('/quote'))).toBe(true);
    expect(w.fetched.some((u) => u.includes('/swap'))).toBe(true);
  });

  it('dry run quotes but sends nothing', async () => {
    const w = world();
    const a = w.make({ dryRun: true });
    const res = await a.collectFees();
    expect(w.sent).toHaveLength(0);
    expect(res.txId).toBe('dry-run');
    expect(res.amountUsd).toBeCloseTo(0.00751, 9); // quote: 375_500 / 100 = 3_755 raw USDC
    expect(a.lastSweep?.dryRun).toBe(true);
  });

  it('returns 0 with no tx when nothing is withheld', async () => {
    const w = world();
    const a = w.make({
      rpc: fakeRpc({
        getAccountInfo: () => ({
          value: { data: [b64(encodeMint({ decimals: DEC, supply: 0n, authority: w.signer.publicKey, feeBps: 150, maxFee: 1n })), 'base64'], owner: TOKEN_2022_PROGRAM_ID.toBase58() },
        }),
        getProgramAccounts: () => [],
      }),
    });
    expect(await a.collectFees()).toEqual({ amountUsd: 0, txId: '' });
    expect(w.sent).toHaveLength(0);
  });

  it('pendingFeesUsd prices the withheld total', async () => {
    const a = world().make();
    expect(await a.pendingFeesUsd()).toBeCloseTo(0.00751, 9);
  });

  it('batches withdraw instructions', async () => {
    const w = world();
    const a = w.make({ harvestBatchSize: 1 });
    await a.collectFees();
    // batch 1 is in the first tx, batch 2 its own tx, then swap, then treasury
    expect(w.sent).toHaveLength(4);
  });
});

describe('SolanaAdapter.getHolderBalances', () => {
  it('time-weights with Helius transfers and derives holdSinceTs for in-window moves', async () => {
    const w = world();
    const a = w.make();
    const r = await a.getHolderBalances({ from: w.T - 3600, to: w.T });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h]));
    expect(by[w.pool.toBase58()]).toBeUndefined(); // excluded
    expect(by[w.treasury.toBase58()]).toBeUndefined();
    // now: alice 10000, bob 5000. Undo after-window (alice→bob 1000): alice 11000, bob 4000 at T.
    // Undo mid-window (bob→alice 2000): alice 9000, bob 6000 at from. Averages: 10000 / 5000.
    expect(by[w.alice.toBase58()].timeWeightedBalance).toBeCloseTo(10_000, 6);
    expect(by[w.bob.toBase58()].timeWeightedBalance).toBeCloseTo(5_000, 6);
    expect(by[w.carol.toBase58()].timeWeightedBalance).toBeCloseTo(500, 6);
    expect(by[w.bob.toBase58()].holdSinceTs).toBe(w.T - 1800); // transferred out → reset
    expect(by[w.alice.toBase58()].holdSinceTs).toBeUndefined(); // held since before the window: unknown
    expect(by[w.carol.toBase58()].holdSinceTs).toBeUndefined();
  });

  it('falls back to a snapshot average without a Helius key', async () => {
    const w = world();
    const store: { s?: { ts: number; balances: Map<string, bigint> } } = {
      s: { ts: w.T - 3600, balances: new Map([[w.alice.toBase58(), u(20_000)]]) },
    };
    const a = w.make({ heliusApiKey: undefined, snapshotStore: { get: () => store.s, set: (s) => void (store.s = s) } });
    const r = await a.getHolderBalances({ from: w.T - 3600, to: w.T });
    const by = Object.fromEntries(r.map((h) => [h.wallet, h.timeWeightedBalance]));
    expect(by[w.alice.toBase58()]).toBeCloseTo(15_000, 6); // (20000 + 10000) / 2
    expect(by[w.bob.toBase58()]).toBeCloseTo(2_500, 6); // (0 + 5000) / 2
    expect(store.s?.ts).toBe(w.now); // new snapshot stored for the next epoch
    expect(w.fetched.some((u) => u.includes('/v0/addresses/'))).toBe(false);
  });

  it('paginates DAS getTokenAccounts', async () => {
    const w = world();
    const a = w.make({ heliusApiKey: undefined });
    const calls = w.rpc.calls;
    await a.snapshotBalances();
    expect(calls.filter((c) => c.method === 'getTokenAccounts')).toHaveLength(1); // 4 accounts < limit
  });
});

describe('SolanaAdapter.transferTokens', () => {
  it('sends a transferChecked from the signer ATA with an idempotent ATA create', async () => {
    const w = world();
    const a = w.make();
    const sig = await a.transferTokens(w.bob.toBase58(), 12.5);
    expect(typeof sig).toBe('string');
    const tx = Transaction.from(w.sent[0]);
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[1].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // transferChecked data: [12, amount u64 LE, decimals]
    const data = tx.instructions[1].data;
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(12_500_000n);
    expect(data[9]).toBe(DEC);
  });

  it('rejects zero / negative amounts', async () => {
    const w = world();
    await expect(w.make().transferTokens(w.bob.toBase58(), 0)).rejects.toThrow(/> 0/);
  });
});

describe('SolanaAdapter.verifyWalletSignature', () => {
  it('verifies ed25519 (base58 and base64 signatures)', () => {
    const kp = Keypair.generate();
    const msg = 'mesh wants you to sign in';
    const sig = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey);
    const a = new SolanaAdapter();
    expect(a.verifyWalletSignature(kp.publicKey.toBase58(), msg, bs58.encode(sig))).toBe(true);
    expect(a.verifyWalletSignature(kp.publicKey.toBase58(), msg, Buffer.from(sig).toString('base64'))).toBe(true);
    expect(a.verifyWalletSignature(kp.publicKey.toBase58(), msg + '!', bs58.encode(sig))).toBe(false);
  });
});
