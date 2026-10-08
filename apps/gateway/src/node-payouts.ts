// Node rewards paid as AI credits (docs/NODE_PROTOCOL.md §7, config `nodeRewards.payout`).
//
// A node earns a USD-denominated reward for every job it completes (`node_rewards`, ledger.ts). Nothing
// about paying it touches a chain: once a reward has been accrued for `holdSeconds` (long enough for a
// spot check to withhold it) it is added to the operator's credit balance, one `node_payout` row in
// `credits_ledger` per wallet per run, and each reward is stamped with the row that paid it so it is paid
// exactly once. Those credits are ordinary credits: they spend on any model, can be listed on the
// marketplace for the settlement stablecoin, and expire like any other.
//
// The reserve needs no top-up for rewards on paid requests: the credit the user spent on the job (the
// network price) stops being owed at the same moment, and the reward is never more than
// `nodeRewards.maxShareOfPriceBps` of it. Rewards for treasury-paid guest messages are the exception:
// nobody spent a credit, so the treasury funds those into the credit pool.
import type { TokenomicsConfig } from '@mesh/config';
import type { Db } from './db.js';
import { nowSec } from './db.js';
import { addLedgerEntry, ensureWallet } from './ledger.js';
import { microsToUsd } from './money.js';

export type NodePayoutConfig = TokenomicsConfig['nodeRewards']['payout'];

/**
 * Rewards that may be paid now: accrued (not withheld by a spot check), not paid yet, older than the hold,
 * and not earned by a node that is quarantined (those wait until an admin clears the node).
 */
const PAYABLE = `r.kind = 'node_reward' AND r.status = 'accrued' AND r.paid_ledger_id IS NULL AND r.usd_micros > 0
  AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = r.node_id AND n.quarantined_at IS NOT NULL)`;

export interface NodePayoutRun {
  wallets: number;
  rewards: number;
  paidMicros: number;
}

/**
 * Pay every wallet what its nodes have earned and held long enough. One transaction per wallet: the
 * `node_payout` credit row and the stamp on the rewards it covers land together. A wallet below `minUsd`
 * is skipped and paid when it has accumulated enough. Idempotent: a reward that carries `paid_ledger_id`
 * is never paid again.
 */
export function payNodeRewards(db: Db, cfg: NodePayoutConfig, opts: { now?: number; chain?: string } = {}): NodePayoutRun {
  const out: NodePayoutRun = { wallets: 0, rewards: 0, paidMicros: 0 };
  if (!cfg.enabled) return out;
  const now = opts.now ?? nowSec();
  const cutoff = now - cfg.holdSeconds;
  const minMicros = Math.max(1, Math.round(cfg.minUsd * 1_000_000));
  const due = db
    .prepare(`SELECT r.wallet AS wallet, SUM(r.usd_micros) AS v FROM node_rewards r WHERE ${PAYABLE} AND r.created_at <= ? GROUP BY r.wallet HAVING SUM(r.usd_micros) >= ? ORDER BY r.wallet`)
    .all(cutoff, minMicros) as Array<{ wallet: string; v: number }>;
  const payWallet = db.transaction((wallet: string) => {
    // Re-read inside the transaction: this is what gets paid and stamped.
    const rows = db.prepare(`SELECT r.id AS id, r.usd_micros AS v FROM node_rewards r WHERE ${PAYABLE} AND r.created_at <= ? AND r.wallet = ?`).all(cutoff, wallet) as Array<{ id: number; v: number }>;
    const total = rows.reduce((a, r) => a + r.v, 0);
    if (rows.length === 0 || total < minMicros) return { rewards: 0, total: 0 };
    ensureWallet(db, wallet, opts.chain ?? 'evm');
    const ledgerId = addLedgerEntry(db, { wallet, deltaMicros: total, kind: 'node_payout', ref: `node_payout:${cutoff}` });
    const stamp = db.prepare(`UPDATE node_rewards SET paid_ledger_id = ? WHERE id = ? AND paid_ledger_id IS NULL`);
    for (const r of rows) stamp.run(ledgerId, r.id);
    return { rewards: rows.length, total };
  });
  for (const { wallet } of due) {
    const r = payWallet(wallet);
    if (r.total > 0) {
      out.wallets++;
      out.rewards += r.rewards;
      out.paidMicros += r.total;
    }
  }
  return out;
}

export interface NodePayoutView {
  enabled: boolean;
  /** How rewards are paid: AI credits in the wallet's balance, never an on-chain transfer. */
  paidAs: 'credits';
  holdSeconds: number;
  minUsd: number;
  /** Rewards already paid into the credit balance (net of any clawback), USD. */
  paidUsd: number;
  /** Earned and not paid yet: inside the hold, below the minimum, or held because a node is quarantined. */
  pendingUsd: number;
}

/** What `wallet` has been paid and what is still waiting, for GET /me/nodes. */
export function nodePayoutView(db: Db, wallet: string, cfg: NodePayoutConfig): NodePayoutView {
  const paid = (db.prepare(`SELECT COALESCE(SUM(delta_usd_micros), 0) AS v FROM credits_ledger WHERE wallet = ? AND kind = 'node_payout'`).get(wallet) as { v: number }).v;
  const pending = (
    db.prepare(`SELECT COALESCE(SUM(usd_micros), 0) AS v FROM node_rewards WHERE wallet = ? AND kind = 'node_reward' AND status = 'accrued' AND paid_ledger_id IS NULL`).get(wallet) as { v: number }
  ).v;
  return { enabled: cfg.enabled, paidAs: 'credits', holdSeconds: cfg.holdSeconds, minUsd: cfg.minUsd, paidUsd: microsToUsd(paid), pendingUsd: microsToUsd(pending) };
}

/** Network-wide totals (GET /report `totals.nodePayouts`, the daily digest). */
export function nodePayoutTotals(db: Db, sinceSec = 0): { paidMicros: number; wallets: number; pendingMicros: number } {
  const paid = db.prepare(`SELECT COALESCE(SUM(delta_usd_micros), 0) AS v, COUNT(DISTINCT wallet) AS n FROM credits_ledger WHERE kind = 'node_payout' AND created_at >= ?`).get(sinceSec) as { v: number; n: number };
  const pending = (db.prepare(`SELECT COALESCE(SUM(usd_micros), 0) AS v FROM node_rewards WHERE kind = 'node_reward' AND status = 'accrued' AND paid_ledger_id IS NULL`).get() as { v: number }).v;
  return { paidMicros: paid.v, wallets: paid.n, pendingMicros: pending };
}
