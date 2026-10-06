import { KNOWN_CHAINS } from '@mesh/chain-adapter';
import type { TokenomicsConfig } from '@mesh/config';
import { createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hex } from 'viem';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addPrepaidEntry } from './market.js';

/**
 * Self-serve prepaid top-ups for the credit market (docs/MARKETPLACE.md "Paying in"): the buyer sends a
 * stablecoin on the EVM chain to the configured receiver, pastes the transaction hash, and the gateway
 * verifies the ERC-20 Transfer on chain before crediting `prepaid_ledger`. One credit per transaction
 * hash, ever; the sender must be the signed-in wallet; the token must be one we accept; the transfer
 * must be `confirmations` blocks behind the head.
 *
 * Verification is behind a small interface so tests (and a future Solana path) do not need an RPC.
 */

export type DepositsConfig = TokenomicsConfig['marketplace']['deposits'];

export interface VerifiedTransfer {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}
export interface VerifiedTx {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  /** Head block at the time of the check; confirmations = head − blockNumber. */
  headBlock: bigint;
  transfers: VerifiedTransfer[];
}
export interface DepositVerifier {
  /** null when the chain has not seen the transaction (yet). */
  getTransaction(txHash: Hex): Promise<VerifiedTx | null>;
}

const ERC20_TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/** viem-backed verifier for the configured chain. */
export function rpcVerifier(opts: { chainId: number; rpcUrl?: string }): DepositVerifier {
  const known = KNOWN_CHAINS[opts.chainId];
  const client = createPublicClient({
    chain: {
      id: opts.chainId,
      name: known?.name ?? `chain ${opts.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl ?? known?.rpc ?? 'http://127.0.0.1:8545'] } },
    },
    transport: http(opts.rpcUrl ?? known?.rpc),
  });
  return {
    async getTransaction(txHash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
      } catch {
        return null; // viem throws TransactionReceiptNotFoundError while pending
      }
      const headBlock = await client.getBlockNumber();
      const transfers: VerifiedTransfer[] = [];
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: ERC20_TRANSFER, data: log.data, topics: log.topics });
          if (ev.eventName === 'Transfer') transfers.push({ token: log.address, from: ev.args.from, to: ev.args.to, amount: ev.args.value });
        } catch {
          /* not a Transfer */
        }
      }
      return { status: receipt.status, blockNumber: receipt.blockNumber, headBlock, transfers };
    },
  };
}

export function depositsEnabled(cfg: DepositsConfig): boolean {
  return cfg.enabled && Boolean(cfg.receiver) && cfg.tokens.length > 0;
}

export function depositsInfo(cfg: DepositsConfig) {
  const known = KNOWN_CHAINS[cfg.chainId];
  return {
    enabled: depositsEnabled(cfg),
    chainId: cfg.chainId,
    chainName: known?.name ?? `chain ${cfg.chainId}`,
    explorer: known?.explorer ?? null,
    receiver: cfg.receiver,
    tokens: cfg.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
    minUsd: cfg.minUsd,
    confirmations: cfg.confirmations,
  };
}

export type DepositResult =
  | { ok: true; creditedMicros: number; token: string; blockNumber: number }
  | { ok: false; code: 'disabled' | 'bad_hash' | 'pending' | 'reverted' | 'unconfirmed' | 'already_credited' | 'no_transfer' | 'wrong_sender' | 'too_small'; message: string; confirmations?: number };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Verify and credit one deposit. Idempotent on txHash: a second call answers `already_credited`. */
export async function creditDeposit(
  db: Db,
  cfg: DepositsConfig,
  verifier: DepositVerifier,
  input: { wallet: string; txHash: string },
  now = nowSec(),
): Promise<DepositResult> {
  if (!depositsEnabled(cfg)) return { ok: false, code: 'disabled', message: 'deposits are not open yet; the team tops up prepaid balances by hand during the beta' };
  if (!HASH_RE.test(input.txHash)) return { ok: false, code: 'bad_hash', message: 'that is not a transaction hash (0x + 64 hex characters)' };
  const txHash = input.txHash.toLowerCase() as Hex;
  if (db.prepare(`SELECT 1 FROM market_deposits WHERE tx_hash = ?`).get(txHash)) return { ok: false, code: 'already_credited', message: 'this transaction was already credited' };

  const tx = await verifier.getTransaction(txHash);
  if (!tx) return { ok: false, code: 'pending', message: 'the chain has not confirmed this transaction yet; try again in a minute' };
  if (tx.status !== 'success') return { ok: false, code: 'reverted', message: 'this transaction reverted on chain; nothing was transferred' };
  const confirmations = Number(tx.headBlock - tx.blockNumber);
  if (confirmations < cfg.confirmations) return { ok: false, code: 'unconfirmed', message: `waiting for ${cfg.confirmations} confirmations (${confirmations} so far)`, confirmations };

  const receiver = cfg.receiver!;
  const accepted = cfg.tokens;
  const toUs = tx.transfers.filter((t) => eq(t.to, receiver) && accepted.some((a) => eq(a.address, t.token)));
  if (toUs.length === 0) return { ok: false, code: 'no_transfer', message: `no accepted stablecoin transfer to ${receiver} in this transaction` };
  const mine = toUs.filter((t) => eq(t.from, input.wallet));
  if (mine.length === 0) return { ok: false, code: 'wrong_sender', message: 'the transfer was not sent from the wallet you are signed in with' };

  // Sum to micro-USD (stablecoin units → 6 decimals), per token; credit the total, record the first token.
  let micros = 0n;
  for (const t of mine) {
    const dec = accepted.find((a) => eq(a.address, t.token))!.decimals;
    micros += dec >= 6 ? t.amount / 10n ** BigInt(dec - 6) : t.amount * 10n ** BigInt(6 - dec);
  }
  const creditedMicros = Number(micros);
  if (creditedMicros < Math.round(cfg.minUsd * 1_000_000)) return { ok: false, code: 'too_small', message: `deposits start at $${cfg.minUsd}` };

  const tokenSymbol = accepted.find((a) => eq(a.address, mine[0].token))!.symbol;
  const write = db.transaction(() => {
    db.prepare(`INSERT INTO market_deposits (tx_hash, wallet, token, amount_micros, block_number, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      txHash,
      input.wallet,
      tokenSymbol,
      creditedMicros,
      Number(tx.blockNumber),
      now,
    );
    addPrepaidEntry(db, { wallet: input.wallet, deltaMicros: creditedMicros, kind: 'topup', ref: `deposit:${txHash}` }, now);
  });
  try {
    write();
  } catch (err) {
    if (/UNIQUE|PRIMARY KEY/i.test((err as Error).message)) return { ok: false, code: 'already_credited', message: 'this transaction was already credited' };
    throw err;
  }
  return { ok: true, creditedMicros, token: tokenSymbol, blockNumber: Number(tx.blockNumber) };
}
