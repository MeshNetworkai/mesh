import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { JsonRpc } from '../rpc.js';
import { sleep } from '../rpc.js';

/** Everything the Solana adapter needs from the cluster, as raw JSON-RPC (injectable). */
export interface SolanaRpc extends JsonRpc {}

export interface SendOptions {
  /** Poll getSignatureStatuses until confirmed; default true. */
  confirm?: boolean;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  timeoutMs?: number;
  pollMs?: number;
  skipPreflight?: boolean;
}

export async function latestBlockhash(rpc: SolanaRpc): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  return r.value;
}

/** Build a legacy transaction, sign with `signers`, send as base64 and (optionally) confirm. */
export async function sendInstructions(
  rpc: SolanaRpc,
  payer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = [],
  opts: SendOptions = {},
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await latestBlockhash(rpc);
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  tx.sign(payer, ...extraSigners);
  return sendRaw(rpc, tx.serialize(), opts);
}

/** Sign a Jupiter-style serialized VersionedTransaction and send it. */
export async function signAndSendVersioned(
  rpc: SolanaRpc,
  signer: Keypair,
  base64Tx: string,
  opts: SendOptions = {},
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  tx.sign([signer]);
  return sendRaw(rpc, Buffer.from(tx.serialize()), opts);
}

export async function sendRaw(rpc: SolanaRpc, raw: Uint8Array, opts: SendOptions = {}): Promise<string> {
  const sig = await rpc.call<string>('sendTransaction', [
    Buffer.from(raw).toString('base64'),
    { encoding: 'base64', skipPreflight: opts.skipPreflight ?? false, preflightCommitment: 'confirmed', maxRetries: 3 },
  ]);
  if (opts.confirm !== false) await confirmSignature(rpc, sig, opts);
  return sig;
}

export async function confirmSignature(rpc: SolanaRpc, sig: string, opts: SendOptions = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const want = opts.commitment ?? 'confirmed';
  while (Date.now() < deadline) {
    const r = await rpc.call<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(
      'getSignatureStatuses',
      [[sig], { searchTransactionHistory: false }],
    );
    const st = r.value[0];
    if (st) {
      if (st.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      const rank = { processed: 0, confirmed: 1, finalized: 2 } as const;
      const got = (st.confirmationStatus ?? 'processed') as keyof typeof rank;
      if (rank[got] >= rank[want]) return;
    }
    await sleep(opts.pollMs ?? 500);
  }
  throw new Error(`transaction ${sig} not confirmed within timeout`);
}

/** Airdrop with retries (devnet faucets rate-limit aggressively). Returns false when it gives up. */
export async function requestAirdropWithRetry(
  rpc: SolanaRpc,
  to: PublicKey,
  lamports: number,
  attempts = 5,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const sig = await rpc.call<string>('requestAirdrop', [to.toBase58(), lamports]);
      await confirmSignature(rpc, sig, { timeoutMs: 45_000 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts - 1) {
        console.warn(`airdrop failed after ${attempts} attempts: ${msg}`);
        return false;
      }
      await sleep(1_500 * 2 ** i);
    }
  }
  return false;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
