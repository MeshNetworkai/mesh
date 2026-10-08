import type { Db } from './db.js';
import { nowSec } from './db.js';

/**
 * `market_*`: credit marketplace (market.ts) — escrow out of the seller's spendable balance, refund on cancel/expiry, buy into the buyer.
 * `purchase`: credit bought from Mesh at face value (direct-sales.ts). `expiry`: credit that lapsed (expiry.ts).
 * `node_payout`: node rewards paid as credits (node-payouts.ts); negative when a paid reward is clawed back.
 */
export type LedgerKind = 'distribution' | 'usage' | 'adjustment' | 'starter' | 'market_escrow' | 'market_refund' | 'market_buy' | 'purchase' | 'expiry' | 'node_payout';

export interface LedgerRow {
  id: number;
  wallet: string;
  delta_usd_micros: number;
  kind: LedgerKind;
  ref: string | null;
  created_at: number;
}

export function ensureWallet(db: Db, wallet: string, chain: string): void {
  db.prepare(
    `INSERT INTO wallets (wallet, chain, created_at) VALUES (?, ?, ?)
     ON CONFLICT(wallet) DO NOTHING`,
  ).run(wallet, chain, nowSec());
}

export function addLedgerEntry(
  db: Db,
  entry: { wallet: string; deltaMicros: number; kind: LedgerKind; ref?: string | null },
): number {
  if (!Number.isInteger(entry.deltaMicros)) throw new Error('deltaMicros must be an integer');
  const res = db
    .prepare(
      `INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(entry.wallet, entry.deltaMicros, entry.kind, entry.ref ?? null, nowSec());
  return Number(res.lastInsertRowid);
}

export function balanceMicros(db: Db, wallet: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta_usd_micros), 0) AS bal FROM credits_ledger WHERE wallet = ?`)
    .get(wallet) as { bal: number };
  return row.bal;
}

export function recentLedger(db: Db, wallet: string, limit = 20): LedgerRow[] {
  return db
    .prepare(`SELECT * FROM credits_ledger WHERE wallet = ? ORDER BY id DESC LIMIT ?`)
    .all(wallet, limit) as LedgerRow[];
}

// ---------------- node rewards (separate ledger, accrued per completed job) ----------------

export type NodeRewardKind = 'node_reward' | 'payout';
/** `withheld`: spot-check verification found a mismatch on the job (verification.ts); the row stays for the audit trail but counts for nothing. */
export type NodeRewardStatus = 'accrued' | 'withheld';

export interface NodeRewardRow {
  id: number;
  wallet: string;
  node_id: string;
  job_id: string | null;
  kind: NodeRewardKind;
  tokens: number;
  usd_micros: number;
  status: NodeRewardStatus;
  created_at: number;
  /** The credits_ledger row that paid this reward as credits (node-payouts.ts); null while it is unpaid. */
  paid_ledger_id: number | null;
}

/** Micro-USD a node earns for `tokens` total tokens at `usdPerMTokens`. */
export function nodeRewardMicros(tokens: number, usdPerMTokens: number): number {
  return Math.round(tokens * usdPerMTokens);
}

export function addNodeReward(
  db: Db,
  entry: { wallet: string; nodeId: string; jobId?: string | null; tokens: number; usdMicros: number; kind?: NodeRewardKind },
): number {
  if (!Number.isInteger(entry.usdMicros)) throw new Error('usdMicros must be an integer');
  const kind = entry.kind ?? 'node_reward';
  const ts = nowSec();
  const write = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO node_rewards (wallet, node_id, job_id, kind, tokens, usd_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.wallet, entry.nodeId, entry.jobId ?? null, kind, entry.tokens, entry.usdMicros, ts);
    const id = Number(res.lastInsertRowid);
    // Rewards are paid from the treasury share: accrue the liability against it as it is earned.
    if (kind === 'node_reward' && entry.usdMicros !== 0) {
      addTreasuryEntry(db, { kind: 'node_reward_accrual', usdMicros: -entry.usdMicros, ref: entry.jobId ? `job:${entry.jobId}` : `node_reward:${id}` }, ts);
    }
    return id;
  });
  return write();
}

/**
 * Mark a job's reward as withheld (verification mismatch) and give the accrual back to the treasury.
 * Idempotent; returns the row or null when the job has no accrued reward.
 */
export function withholdNodeReward(db: Db, jobId: string, reason: string): NodeRewardRow | null {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM node_rewards WHERE job_id = ? AND kind = 'node_reward' AND status = 'accrued'`).get(jobId) as NodeRewardRow | undefined;
    if (!row) return null;
    db.prepare(`UPDATE node_rewards SET status = 'withheld' WHERE id = ?`).run(row.id);
    if (row.usd_micros !== 0) addTreasuryEntry(db, { kind: 'node_reward_accrual', usdMicros: row.usd_micros, ref: `withheld:job:${jobId}:${reason}` });
    // Already paid out as credits (the verdict came after the hold): take the credits back. Rare, because
    // nodeRewards.payout.holdSeconds is far longer than a spot check takes.
    if (row.paid_ledger_id !== null && row.paid_ledger_id !== undefined && row.usd_micros > 0) {
      addLedgerEntry(db, { wallet: row.wallet, deltaMicros: -row.usd_micros, kind: 'node_payout', ref: `clawback:job:${jobId}:${reason}` });
    }
    return { ...row, status: 'withheld' as const };
  });
  return tx();
}

export function nodeRewardsTotal(db: Db, where: { wallet?: string; nodeId?: string }, sinceSec = 0): { usdMicros: number; tokens: number; jobs: number } {
  const conds: string[] = ["kind = 'node_reward'", "status = 'accrued'", 'created_at >= ?'];
  const args: unknown[] = [sinceSec];
  if (where.wallet) {
    conds.push('wallet = ?');
    args.push(where.wallet);
  }
  if (where.nodeId) {
    conds.push('node_id = ?');
    args.push(where.nodeId);
  }
  const row = db
    .prepare(`SELECT COALESCE(SUM(usd_micros),0) AS usd, COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS n FROM node_rewards WHERE ${conds.join(' AND ')}`)
    .get(...args) as { usd: number; tokens: number; n: number };
  return { usdMicros: row.usd, tokens: row.tokens, jobs: row.n };
}

// ---------------- treasury ledger (what the treasury share received and what it owes) ----------------

/** `guest_chat`: what a free guest message (routes/guest.ts) cost the treasury when the upstream served it. */
/** `market_fee`: the treasury's share of a credit-marketplace fee (market.ts). */
export type TreasuryKind = 'fee_share' | 'node_reward_accrual' | 'buyback' | 'ops' | 'other' | 'guest_chat' | 'market_fee';

export interface TreasuryRow {
  id: number;
  kind: TreasuryKind;
  usd_micros: number;
  ref: string | null;
  created_at: number;
}

/**
 * Append a treasury row. Positive = money into the treasury (fee share), negative = out of it
 * (node reward accruals, buybacks, ops). (kind, ref) is unique, so re-running the same epoch or
 * job is a no-op; returns null in that case.
 */
export function addTreasuryEntry(
  db: Db,
  entry: { kind: TreasuryKind; usdMicros: number; ref?: string | null },
  ts = nowSec(),
): number | null {
  if (!Number.isInteger(entry.usdMicros)) throw new Error('usdMicros must be an integer');
  const res = db
    .prepare(
      `INSERT INTO treasury_ledger (kind, usd_micros, ref, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, ref) WHERE ref IS NOT NULL DO NOTHING`,
    )
    .run(entry.kind, entry.usdMicros, entry.ref ?? null, ts);
  return res.changes === 0 ? null : Number(res.lastInsertRowid);
}

/** Net treasury position in micro-USD (fee share in, accruals and spend out). */
export function treasuryBalanceMicros(db: Db): number {
  return (db.prepare(`SELECT COALESCE(SUM(usd_micros), 0) AS v FROM treasury_ledger`).get() as { v: number }).v;
}

export function treasuryTotalsByKind(db: Db, sinceSec = 0): Record<TreasuryKind, number> {
  const out: Record<TreasuryKind, number> = { fee_share: 0, node_reward_accrual: 0, buyback: 0, ops: 0, other: 0, guest_chat: 0, market_fee: 0 };
  const rows = db
    .prepare(`SELECT kind, COALESCE(SUM(usd_micros), 0) AS v FROM treasury_ledger WHERE created_at >= ? GROUP BY kind`)
    .all(sinceSec) as Array<{ kind: TreasuryKind; v: number }>;
  for (const r of rows) out[r.kind] = r.v;
  return out;
}
